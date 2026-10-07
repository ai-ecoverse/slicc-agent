import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

async function open(page) {
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
}

const own = (query) =>
  startAgent({
    worker: () => new Worker(`/dist-test/agent-worker.js?${query}`, { type: 'module' }),
  }).then((owner) => {
    globalThis.owner = owner;
    return true;
  });

test('prompts an owned agent worker over pi-protocol', async (t) => {
  const page = await chrome.page(t);
  await open(page);
  await page.evaluate(own, 'answer=Paris.');
  const result = await page.evaluate(async () => {
    const connection = await owner.connect();
    const text = await connection.prompt('Capital of France?');
    const kinds = () => (connection.transcript.value?.entries ?? []).map((entry) => entry.kind);
    for (let i = 0; i < 100 && !kinds().includes('pi.assistant'); i++)
      await new Promise((r) => setTimeout(r, 20));
    return { text, kinds: kinds(), serverId: connection.serverId };
  });
  assert.equal(result.text, 'Paris.');
  assert.ok(result.kinds.includes('pi.user'));
  assert.ok(result.kinds.includes('pi.assistant'));
  assert.match(result.serverId, /^[0-9a-f-]{36}$/);
});

test('resumes the conversation after a worker restart', async (t) => {
  const page = await chrome.page(t);
  await open(page);
  await page.evaluate(own, 'directory=/.slicc/restart&answer=One.&answer=Two.');
  const kinds = await page.evaluate(async () => {
    const first = await owner.connect();
    await first.prompt('First?');
    owner.restart();
    const second = await owner.connect();
    for (let i = 0; i < 100 && !(second.transcript.value?.entries ?? []).length; i++)
      await new Promise((r) => setTimeout(r, 20));
    return second.transcript.value.entries.map((entry) => entry.kind);
  });
  assert.ok(kinds.includes('pi.user'));
  assert.ok(kinds.includes('pi.assistant'));
});

test('a second tab waits until the owner lets go', async (t) => {
  const page = await chrome.page(t);
  await open(page);
  await page.evaluate(own, 'answer=Hi.');
  const other = await page.tab();
  await open(other);
  await other.evaluate(() => {
    globalThis.owned = false;
    startAgent({
      worker: () => new Worker('/dist-test/agent-worker.js?answer=Hello.', { type: 'module' }),
    }).then((owner) => {
      globalThis.owner = owner;
      globalThis.owned = true;
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await other.evaluate(() => owned), false);
  await page.evaluate(() => owner.release());
  await other.until(() => owned);
  const text = await other.evaluate(async () => (await owner.connect()).prompt('Hi?'));
  assert.equal(text, 'Hello.');
});
