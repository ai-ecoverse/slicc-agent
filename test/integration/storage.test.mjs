import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

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
