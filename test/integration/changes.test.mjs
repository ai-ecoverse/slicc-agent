import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const fakeGit = await readFile('test/integration/fixtures/changes/fake-git.sh', 'utf8');

test('changes from git in the production worker: the empty state, a repo, accept and revert', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async (script) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const client = await attachKernel(await kernel.connect());
    const params = new URLSearchParams([
      [
        'tool',
        JSON.stringify({
          name: 'bash',
          args: { command: 'chmod +x /home/.local/share/pnpm/bin/git' },
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
    const until = async (check) => {
      for (let n = 0; n < 200 && !(await check()); n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return check();
    };
    const listed = () =>
      model.changes.changes().map(({ path, repo, status, before, after }) => ({
        path,
        repo,
        status,
        before,
        after,
      }));
    listed();
    await until(() => model.changes.unavailable() !== null);
    const empty = model.changes.unavailable();
    await client.fs.mkdir('/home/.local/share/pnpm/bin', { recursive: true });
    await client.fs.writeFile('/home/.local/share/pnpm/bin/git', script);
    await client.fs.mkdir('/home/site/.git/index-files', { recursive: true });
    await client.fs.writeFile('/home/site/.git/index-files/a.txt', 'one\n');
    await client.fs.writeFile('/home/site/a.txt', 'two\n');
    await client.fs.writeFile('/home/site/new.txt', 'hello\n');
    await client.fs.writeFile('/home/site/.git/status', ' M a.txt\n?? new.txt\n');
    const answer = await connection.prompt('Make git runnable.');
    await client.fs.writeFile('/home/site/new.txt', 'hello\n');
    await until(() => listed().length === 2);
    const found = listed();
    await model.changes.revert('/home/site/a.txt');
    model.changes.accept('/home/site/new.txt');
    await until(() => listed().length === 0);
    const restored = new TextDecoder().decode(await client.fs.readFile('/home/site/a.txt'));
    await owner.release();
    return { empty, found, restored, answer };
  }, fakeGit);
  assert.match(seen.empty, /^Changes needs git and a git repository\./);
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
