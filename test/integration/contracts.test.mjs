import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'contracts-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const LOCK = 'contracts.lock.json';
const committed = readFileSync(join(root, LOCK), 'utf8');
const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const CONTROL = `export const AgentControl: Contract = contract('slicc.agent.control', {
  control: { methods: CONTROL_METHODS },
  view: { methods: [...CONTROL_READS, ...OWNER_DEVICE_METHODS] },
});`;

const git = (dir, ...args) => {
  const run = spawnSync(
    'git',
    [
      '-c',
      'user.name=check',
      '-c',
      'user.email=check@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' }
  );
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

const commit = (dir, message) => {
  git(
    dir,
    'add',
    '--',
    ...['.gitignore', 'scripts', 'src', LOCK].filter((path) => existsSync(join(dir, path)))
  );
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
};

function tree(
  name,
  { lock = committed, services = (text) => text, base = committed, repo = true } = {}
) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  if (repo) {
    git(dir, 'init', '--quiet', '--initial-branch=main');
    if (base !== null) writeFileSync(join(dir, LOCK), base);
    commit(dir, 'base');
  }
  const path = join(dir, 'src/services.ts');
  writeFileSync(path, services(readFileSync(path, 'utf8')));
  writeFileSync(join(dir, LOCK), lock);
  return dir;
}

const GIT_ENV = ['CI', 'BASE_SHA', 'GITHUB_EVENT_PATH', 'GITHUB_BASE_REF'];

const lint = (dir, ...args) => {
  const given = typeof args.at(-1) === 'object' ? args.pop() : {};
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !GIT_ENV.includes(name))
  );
  const run = spawnSync(
    process.execPath,
    ['scripts/verdict.mjs', 'check-contracts', 'scripts/check-contracts.mjs', ...args],
    { cwd: dir, encoding: 'utf8', env: { ...env, ...given } }
  );
  return { status: run.status, out: run.stdout + run.stderr };
};

async function forged(dir) {
  const { printsOf } = await import(join(dir, 'scripts/check-contracts.mjs'));
  const { CONTRACTS } = await import(join(dir, 'src/services.ts'));
  const { historyOf, variantsOf } = await import(join(dir, 'src/serving.ts'));
  return `${JSON.stringify(printsOf(CONTRACTS, historyOf, variantsOf), null, 2)}\n`;
}

const lockOf = (dir) => JSON.parse(readFileSync(join(dir, LOCK), 'utf8'));

const withEcho = (text) => {
  assert.ok(text.includes(CONTROL), 'the control contract is declared as this test expects');
  return text.replace(
    '  approvalRunNotice: true,\n});',
    '  approvalRunNotice: true,\n  echo: true,\n});'
  );
};

test('npm run lint runs lint:contracts, and the committed lock matches every contract', () => {
  assert.match(scripts.lint, /npm run lint:contracts/);
  assert.equal(
    scripts['lint:contracts'],
    'node scripts/verdict.mjs check-contracts scripts/check-contracts.mjs'
  );
  const run = lint(root, { BASE_SHA: 'HEAD' });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /^check-contracts: PASS 8 contracts$/m);
});

test('a method added to a contract without a new version fails lint:contracts, and --write does not accept it', () => {
  const dir = tree('silent', { services: withEcho });
  const run = lint(dir);
  assert.notEqual(run.status, 0, run.out);
  assert.match(
    run.out,
    /slicc\.agent\.control v1 changed \(49e0d5ccf51d6e87 -> [0-9a-f]{16}\): declare the new members as v2 \(added: \{ 2: \[\.\.\.\] \}\), or start a new history above v1 \(since: 2\) for a break/
  );
  const written = lint(dir, '--write');
  assert.notEqual(written.status, 0, written.out);
  assert.deepEqual(lockOf(dir), JSON.parse(committed));
});

test('a method added as a new version passes lint:contracts once --write records it, and keeps v1 as it was', () => {
  const dir = tree('added', {
    services: (text) =>
      withEcho(text).replace(
        CONTROL,
        CONTROL.replace('\n});', "\n}, { added: { 2: ['echo'] } });")
      ),
  });
  const run = lint(dir);
  assert.notEqual(run.status, 0, run.out);
  assert.match(
    run.out,
    /slicc\.agent\.control v2 is not in contracts\.lock\.json: run node scripts\/check-contracts\.mjs --write/
  );
  const written = lint(dir, '--write');
  assert.equal(written.status, 0, written.out);
  const control = lockOf(dir)['slicc.agent.control'];
  assert.deepEqual(control['1'], JSON.parse(committed)['slicc.agent.control']['1']);
  assert.equal(control['1'].fingerprint, '49e0d5ccf51d6e87');
  assert.match(control['2'].fingerprint, /^[0-9a-f]{16}$/);
  assert.ok(control['2'].variants.control.methods.includes('echo'));
  assert.ok(!control['1'].variants.control.methods.includes('echo'));
  assert.equal(lint(dir).status, 0);
  const text = readFileSync(join(dir, LOCK), 'utf8');
  const biome = spawnSync(
    join(root, 'node_modules/.bin/biome'),
    ['format', `--stdin-file-path=${LOCK}`],
    { cwd: root, input: text, encoding: 'utf8' }
  );
  assert.equal(biome.status, 0, biome.stderr);
  assert.equal(biome.stdout, text, 'the lock --write writes is formatted as biome formats it');
});

test('a contract whose history restarts above its locked versions is an explicit break lint:contracts records, and one that reuses a locked version fails', () => {
  const restarted = tree('restarted', {
    services: (text) => text.replace(CONTROL, CONTROL.replace('\n});', '\n}, { since: 2 });')),
  });
  assert.notEqual(lint(restarted).status, 0);
  const written = lint(restarted, '--write');
  assert.equal(written.status, 0, written.out);
  const control = lockOf(restarted)['slicc.agent.control'];
  assert.deepEqual(Object.keys(control), ['1', '2']);
  const lock = JSON.parse(committed);
  lock['slicc.agent.control']['2'] = { fingerprint: '0000000000000000', variants: {} };
  const reused = tree('reused', {
    lock: JSON.stringify(lock),
    services: (text) => text.replace(CONTROL, CONTROL.replace('\n});', '\n}, { since: 2 });')),
  });
  const run = lint(reused);
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /slicc\.agent\.control v2 changed \(0000000000000000 -> /);
});

test('a locked contract that is no longer served, or a locked version that vanished, fails lint:contracts', () => {
  const lock = JSON.parse(committed);
  lock['slicc.agent.gone'] = { 1: { fingerprint: '0000000000000000', variants: {} } };
  lock['slicc.agent.control']['2'] = { fingerprint: '0000000000000000', variants: {} };
  const dir = tree('vanished', { lock: JSON.stringify(lock) });
  const run = lint(dir, '--write');
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /slicc\.agent\.gone is in contracts\.lock\.json but no longer served/);
  assert.match(run.out, /slicc\.agent\.control v2 was removed: versions are only added/);
});

test('a recorded version whose fingerprint and members are edited in the lock to match a changed contract fails lint:contracts against the base branch', async () => {
  const dir = tree('forged', { services: withEcho });
  const lock = await forged(dir);
  writeFileSync(join(dir, LOCK), lock);
  const base = git(dir, 'rev-parse', 'HEAD');
  const uncommitted = lint(dir);
  assert.notEqual(uncommitted.status, 0, uncommitted.out);
  assert.match(
    uncommitted.out,
    /slicc\.agent\.control v1 is recorded as 49e0d5ccf51d6e87 on HEAD but as [0-9a-f]{16} in contracts\.lock\.json: a recorded version is never edited/
  );
  commit(dir, 'forged');
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  const branch = lint(dir);
  assert.notEqual(branch.status, 0, branch.out);
  assert.match(
    branch.out,
    /slicc\.agent\.control v1 is recorded as 49e0d5ccf51d6e87 on origin\/main \(merge base [0-9a-f]{12}\)/
  );
  const named = lint(dir, { CI: 'true', BASE_SHA: base });
  assert.notEqual(named.status, 0, named.out);
  assert.match(
    named.out,
    new RegExp(
      `slicc\\.agent\\.control v1 is recorded as 49e0d5ccf51d6e87 on ${base} \\(BASE_SHA\\)`
    )
  );
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base } } }));
  const pulled = lint(dir, { CI: 'true', GITHUB_EVENT_PATH: event });
  assert.notEqual(pulled.status, 0, pulled.out);
  assert.match(pulled.out, /on [0-9a-f]{40} \(the GitHub event\)/);
  assert.equal(lint(dir, '--write').status, 1);
  assert.equal(readFileSync(join(dir, LOCK), 'utf8'), lock);
});

test('members edited in the lock without a fingerprint change fail lint:contracts against src and the base', () => {
  const lock = JSON.parse(committed);
  lock['slicc.agent.control']['1'].variants.control.methods.push('echo');
  const dir = tree('members', { lock: JSON.stringify(lock) });
  const run = lint(dir);
  assert.notEqual(run.status, 0, run.out);
  assert.match(
    run.out,
    /slicc\.agent\.control v1 has other members in contracts\.lock\.json than on HEAD \(\+control\.methods\.echo\): a recorded version is never edited/
  );
  assert.match(
    run.out,
    /slicc\.agent\.control v1 has other members in contracts\.lock\.json than in src \(\+control\.methods\.echo\)/
  );
});

test('a recorded version or contract removed from the lock fails lint:contracts against the base, even where src no longer has it', () => {
  const restart = (text) => text.replace(CONTROL, CONTROL.replace('\n});', '\n}, { since: 2 });'));
  const dir = tree('dropped', { services: restart });
  assert.equal(lint(dir, '--write').status, 0);
  commit(dir, 'restarted');
  const lock = lockOf(dir);
  delete lock['slicc.agent.control']['1'];
  delete lock['slicc.agent.sudo'];
  writeFileSync(join(dir, LOCK), JSON.stringify(lock));
  const run = lint(dir);
  assert.notEqual(run.status, 0, run.out);
  assert.match(
    run.out,
    /slicc\.agent\.control v1 is recorded in contracts\.lock\.json on HEAD but no longer in contracts\.lock\.json: a recorded version is never removed/
  );
  assert.match(
    run.out,
    /slicc\.agent\.sudo v1 is recorded in contracts\.lock\.json on HEAD but no longer/
  );
});

test('a new contract and a new version pass lint:contracts against a base that lacks them, and a base without a lock records nothing yet', () => {
  const dir = tree('fresh', {
    base: null,
    services: (text) =>
      withEcho(text).replace(
        CONTROL,
        CONTROL.replace('\n});', "\n}, { added: { 2: ['echo'] } });")
      ),
  });
  const lock = JSON.parse(committed);
  delete lock['slicc.agent.sudo'];
  writeFileSync(join(dir, LOCK), JSON.stringify(lock));
  const written = lint(dir, '--write', { CI: 'true', BASE_SHA: 'HEAD' });
  assert.equal(written.status, 0, written.out);
  assert.match(written.out, /check-contracts: HEAD \(BASE_SHA\) has no contracts\.lock\.json yet/);
  commit(dir, 'locked');
  writeFileSync(join(dir, LOCK), committed);
  git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD'));
  const run = lint(dir);
  assert.notEqual(run.status, 0, run.out);
  assert.match(
    run.out,
    /slicc\.agent\.control v2 is recorded in contracts\.lock\.json on origin\/main/
  );
});

test('lint:contracts passes with a note outside git and fails in CI without a base it can reach', () => {
  const dir = tree('loose', { repo: false });
  const local = lint(dir);
  assert.equal(local.status, 0, local.out);
  assert.match(
    local.out,
    /check-contracts: no git base, so the recorded versions in contracts\.lock\.json are not compared with a base/
  );
  const ci = lint(dir, { CI: 'true' });
  assert.notEqual(ci.status, 0, ci.out);
  assert.match(ci.out, /no base to compare contracts\.lock\.json with in CI: set BASE_SHA/);
  const repo = tree('unreachable');
  const missing = lint(repo, { CI: 'true', BASE_SHA: '1234567890123456789012345678901234567890' });
  assert.notEqual(missing.status, 0, missing.out);
  assert.match(
    missing.out,
    /the base 1234567890123456789012345678901234567890 from BASE_SHA is not reachable with git/
  );
  const ref = lint(repo, { CI: 'true', GITHUB_BASE_REF: 'main' });
  assert.equal(ref.status, 0, ref.out);
});
