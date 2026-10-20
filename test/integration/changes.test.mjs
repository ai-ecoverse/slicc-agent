import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const fakeGit = await readFile('test/integration/fixtures/changes/fake-git.sh', 'utf8');

test('changes from git in the production worker: the empty state, a repo, accept and revert', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.run(
    { label: 'changes from git', marker: () => globalThis.waiting ?? null },
    async (script) => {
      globalThis.waiting = 'the kernel and the agent';
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const { attachKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      const client = await attachKernel(await kernel.connect());
      const pnpm = await (async () => {
        let out = '';
        const probe = await client.spawn(['bash', '-c', 'printf %s "$PNPM_HOME"'], {
          cwd: '/',
          onStdout: (bytes) => {
            out += new TextDecoder().decode(bytes);
          },
        });
        await probe.exited;
        return out || '/home/.local/share/pnpm';
      })();
      const params = new URLSearchParams([
        [
          'tool',
          JSON.stringify({
            name: 'bash',
            args: { command: `chmod +x ${pnpm}/bin/git` },
          }),
        ],
        ['answer', 'Done.'],
      ]);
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      await model.agent.ready();
      const until = (check, what) =>
        new Promise((resolve) => {
          globalThis.waiting = what;
          const offs = [];
          const look = () => {
            if (!offs.length || !check()) return;
            for (const off of offs.splice(0)) off();
            resolve();
          };
          offs.push(connection.changes.subscribe(look));
          look();
        });
      const listed = () =>
        model.changes.changes().map(({ path, repo, status, before, after }) => ({
          path,
          repo,
          status,
          before,
          after,
        }));
      listed();
      await until(() => model.changes.unavailable() !== null, 'the empty state');
      const empty = model.changes.unavailable();
      await client.fs.mkdir(`${pnpm}/bin`, { recursive: true });
      await client.fs.writeFile(`${pnpm}/bin/git`, script);
      await client.fs.mkdir('/home/site/.git/index-files', { recursive: true });
      await client.fs.writeFile('/home/site/.git/index-files/a.txt', 'one\n');
      await client.fs.writeFile('/home/site/a.txt', 'two\n');
      await client.fs.writeFile('/home/site/new.txt', 'hello\n');
      await client.fs.writeFile('/home/site/.git/status', ' M a.txt\n?? new.txt\n');
      globalThis.waiting = 'the prompt';
      const answer = await connection.prompt('Make git runnable.');
      await client.fs.writeFile('/home/site/new.txt', 'hello\n');
      await until(() => listed().length === 2, 'the two changes');
      const found = listed();
      globalThis.waiting = 'the revert';
      await model.changes.revert('/home/site/a.txt');
      model.changes.accept('/home/site/new.txt');
      await until(() => listed().length === 0, 'no changes left');
      const restored = new TextDecoder().decode(await client.fs.readFile('/home/site/a.txt'));
      await owner.release();
      return { empty, found, restored, answer };
    },
    fakeGit
  );
  assert.match(seen.empty, /^Changes needs git, and git isn't installed\./);
  assert.deepEqual(seen.found, [
    {
      path: '/home/site/a.txt',
      repo: '/home/site',
      status: 'modified',
      before: 'one\n',
      after: 'two\n',
    },
    {
      path: '/home/site/new.txt',
      repo: '/home/site',
      status: 'added',
      before: null,
      after: 'hello\n',
    },
  ]);
  assert.equal(seen.restored, 'one\n');
  assert.equal(seen.answer, 'Done.');
});

const WASM_GIT = 'node_modules/@ai-ecoverse/wasm-git/';
const templates = await readdir(`${WASM_GIT}share/git-core/templates`, {
  recursive: true,
  withFileTypes: true,
});
const gitFiles = [
  'package.json',
  'bin/git',
  'bin/git.wasm',
  ...templates
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath.slice(WASM_GIT.length)}/${entry.name}`),
];

test('changes with the real wasm-git: a local repo with a modified, an added and a deleted file, accept and revert', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const version = JSON.parse(await readFile(`${WASM_GIT}package.json`, 'utf8')).version;
  const pinned = JSON.parse(await readFile('package.json', 'utf8')).devDependencies[
    '@ai-ecoverse/wasm-git'
  ];
  assert.equal(version, pinned);
  await staged(
    page,
    'the wasm-git agent',
    async (dir, files) => {
      await import('/dist-test/page.js');
      stage('the kernel with wasm-git');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel({ [dir]: files });
      const { attachKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      const client = await attachKernel(await kernel.connect());
      const setup = [
        'mkdir -p /home/proj && cd /home/proj && git init -q',
        'git config user.email test@example.com && git config user.name Test',
        "printf 'one\\n' > a.txt && printf 'bye\\n' > gone.txt && git add -A && git commit -qm init",
        "printf 'two\\n' > a.txt && rm gone.txt && printf 'hi\\n' > new.txt",
      ].join(' && ');
      const params = new URLSearchParams([
        [
          'tool',
          JSON.stringify({
            name: 'bash',
            args: {
              command: 'git --version > /tmp/version.txt 2> /tmp/install.log',
            },
          }),
        ],
        ['tool', JSON.stringify({ name: 'bash', args: { command: setup } })],
        ['answer', 'Done.'],
      ]);
      stage('the agent');
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      await model.agent.ready();
      const text = async (path) =>
        (await client.fs.exists(path))
          ? new TextDecoder().decode(await client.fs.readFile(path))
          : null;
      const listed = () =>
        model.changes
          .changes()
          .map(({ path, status, before, after }) => ({ path, status, before, after }));
      const until = (check, what) =>
        when([...agentSources(connection, model), connection.changes], check, what);
      globalThis.git = { owner, model, text, listed, until, answer: null };
      listed();
      globalThis.progress = activity(connection);
      stage('the answer and three changes');
      globalThis.git.answer = await connection.prompt('Install git and make a repo.');
      await until(() => listed().length === 3, 'three changes');
    },
    WASM_GIT,
    gitFiles
  );
  const found = await page.evaluate(async () => ({
    listed: globalThis.git.listed(),
    answer: globalThis.git.answer,
    version: await globalThis.git.text('/tmp/version.txt'),
    install: await globalThis.git.text('/tmp/install.log'),
  }));
  assert.match(found.version ?? '', /^git version 2\.55/, found.install ?? '');
  assert.equal(found.answer, 'Done.');
  assert.deepEqual(found.listed, [
    { path: '/home/proj/a.txt', status: 'modified', before: 'one\n', after: 'two\n' },
    { path: '/home/proj/gone.txt', status: 'deleted', before: 'bye\n', after: null },
    { path: '/home/proj/new.txt', status: 'added', before: null, after: 'hi\n' },
  ]);
  await staged(page, 'the revert and the accept', async () => {
    const { model, until, listed } = globalThis.git;
    await model.changes.revert('/home/proj/a.txt');
    await model.changes.revert('/home/proj/gone.txt');
    model.changes.accept('/home/proj/new.txt');
    await until(() => listed().length === 0, 'no changes left');
  });
  const after = await staged(page, 'the files after', async () => {
    const { text, listed, model, owner } = globalThis.git;
    const out = {
      a: await text('/home/proj/a.txt'),
      gone: await text('/home/proj/gone.txt'),
      added: await text('/home/proj/new.txt'),
      left: listed(),
      unavailable: model.changes.unavailable(),
    };
    await owner.release();
    return out;
  });
  assert.deepEqual(after, {
    a: 'one\n',
    gone: 'bye\n',
    added: 'hi\n',
    left: [],
    unavailable: null,
  });
});
