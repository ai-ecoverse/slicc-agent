import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
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

function tree(name, { lock = committed, services = (text) => text } = {}) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  const path = join(dir, 'src/services.ts');
  writeFileSync(path, services(readFileSync(path, 'utf8')));
  writeFileSync(join(dir, LOCK), lock);
  return dir;
}

const lint = (dir, ...args) => {
  const run = spawnSync(
    process.execPath,
    ['scripts/verdict.mjs', 'check-contracts', 'scripts/check-contracts.mjs', ...args],
    { cwd: dir, encoding: 'utf8' }
  );
  return { status: run.status, out: run.stdout + run.stderr };
};

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
  const run = lint(root);
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
  assert.equal(control['1'], '49e0d5ccf51d6e87');
  assert.match(control['2'], /^[0-9a-f]{16}$/);
  assert.equal(lint(dir).status, 0);
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
  lock['slicc.agent.control']['2'] = '0000000000000000';
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
  lock['slicc.agent.gone'] = { 1: '0000000000000000' };
  lock['slicc.agent.control']['2'] = '0000000000000000';
  const dir = tree('vanished', { lock: JSON.stringify(lock) });
  const run = lint(dir, '--write');
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /slicc\.agent\.gone is in contracts\.lock\.json but no longer served/);
  assert.match(run.out, /slicc\.agent\.control v2 was removed: versions are only added/);
});
