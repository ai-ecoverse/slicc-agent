import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const start = (query) =>
  new Promise((resolve) => {
    const worker = new Worker(`/dist-test/storage-worker.js?${query}`, { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      resolve(data);
    };
  });

test('keeps a conversation in OPFS across workers', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const first = await page.evaluate(start, 'directory=/.slicc/test-a&prompt=Hi&answer=Hello.');
  assert.equal(first.error, undefined);
  assert.equal(first.answer, 'Hello.');
  const second = await page.evaluate(start, 'directory=/.slicc/test-a');
  assert.deepEqual(second.kinds, first.kinds);
  assert.ok(second.kinds.includes('pi.user'));
  assert.ok(second.kinds.includes('pi.assistant'));
});

test('stores the pool where it is told', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(start, 'directory=/.slicc/test-b&prompt=Hi&answer=Hello.');
  const names = await page.evaluate(async () => {
    let dir = await navigator.storage.getDirectory();
    for (const part of ['.slicc', 'test-b']) dir = await dir.getDirectoryHandle(part);
    const found = [];
    for await (const name of dir.keys()) found.push(name);
    return found;
  });
  assert.ok(names.length > 0);
});

test('waits for a worker that holds the pool instead of wiping it', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const holder = new Worker(
      '/dist-test/storage-worker.js?directory=/.slicc/test-c&prompt=Hi&answer=Hello.&hold',
      {
        type: 'module',
      }
    );
    await new Promise((resolve) => {
      holder.onmessage = resolve;
    });
    const waiter = new Worker('/dist-test/storage-worker.js?directory=/.slicc/test-c', {
      type: 'module',
    });
    let early = false;
    const reply = new Promise((resolve) => {
      waiter.onmessage = ({ data }) => resolve(data);
    });
    const timer = setTimeout(() => {
      early = true;
    }, 500);
    const raced = await Promise.race([
      reply,
      new Promise((resolve) => setTimeout(() => resolve(null), 400)),
    ]);
    clearTimeout(timer);
    holder.terminate();
    const data = await reply;
    waiter.terminate();
    return { waited: raced === null && !early, data };
  });
  assert.equal(result.waited, true);
  assert.equal(result.data.error, undefined);
  assert.ok(result.data.kinds.includes('pi.assistant'));
});

test('keeps two directories apart in one worker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const data = await page.evaluate(
    start,
    'directory=/.slicc/test-d&prompt=Hi&answer=Hello.&second=/.slicc/test-e'
  );
  assert.equal(data.error, undefined);
  assert.ok(data.first.kinds.includes('pi.assistant'));
  assert.ok(!data.second.kinds.includes('pi.assistant'));
});

const profile = (path) =>
  navigator.storage
    .getDirectory()
    .then(async (root) => {
      const parts = path.split('/').filter(Boolean);
      let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return (await dir.getFileHandle(parts.at(-1))).getFile();
    })
    .then((file) => file.text())
    .then(JSON.parse, () => null);

test('the booted agent leaves its pi durable schema and version next to the session database', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(
    page,
    'the profile marker',
    async (read) => {
      await import('/dist-test/page.js');
      stage('the kernel');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      stage('the agent');
      const owner = await startAgent({
        worker: () =>
          new Worker('/dist-test/main-worker.js?default-storage&version=7.9.9&answer=Hi.', {
            type: 'module',
          }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const answer = await connection.prompt('Hello.');
      const marker = await new Function(`return (${read})`)()('/.slicc/agent-profile.json');
      await owner.release();
      return { answer, marker };
    },
    profile.toString()
  );
  assert.equal(seen.answer, 'Hi.');
  assert.deepEqual(seen.marker, { durableSchema: 2, agent: '7.9.9' });
});

test('a later open keeps a higher durableSchema someone else recorded, and names its own version', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const marker = await page.evaluate(async (read) => {
    const root = await navigator.storage.getDirectory();
    const slicc = await root.getDirectoryHandle('.slicc', { create: true });
    const file = await slicc.getFileHandle('test-f-profile.json', { create: true });
    const writable = await file.createWritable();
    await writable.write('{"durableSchema":3,"agent":"8.0.0"}');
    await writable.close();
    const data = await new Promise((resolve) => {
      const worker = new Worker(
        '/dist-test/storage-worker.js?directory=/.slicc/test-f&prompt=Hi&answer=Hello.&agent=7.1.0',
        { type: 'module' }
      );
      worker.onmessage = (event) => {
        worker.terminate();
        resolve(event.data);
      };
    });
    return {
      data,
      marker: await new Function(`return (${read})`)()('/.slicc/test-f-profile.json'),
    };
  }, profile.toString());
  assert.equal(marker.data.error, undefined);
  assert.deepEqual(marker.marker, { durableSchema: 3, agent: '7.1.0' });
});

test('a session document changed well over a hundred times reads the same after the worker restarts', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const first = await page.evaluate(start, 'directory=/.slicc/test-g&cones=150');
  assert.equal(first.error, undefined);
  assert.equal(first.cones.length, 151);
  const second = await page.evaluate(start, 'directory=/.slicc/test-g');
  assert.equal(second.error, undefined);
  assert.deepEqual(second.cones, first.cones);
});
