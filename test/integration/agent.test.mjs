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

test('prompts an owned agent worker over a Chord link', async (t) => {
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
    await owner.restart();
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

test('a throwing timings listener neither breaks the answer nor starves the next listener', async (t) => {
  const page = await chrome.page(t);
  await open(page);
  const result = await page.evaluate(async () => {
    let worker;
    const owner = await startAgent({
      worker: () => {
        worker = new Worker('/dist-test/agent-worker.js?throwing-timings=boom&answer=Paris.', {
          type: 'module',
        });
        return worker;
      },
    });
    const connection = await owner.connect();
    const text = await connection.prompt('Capital of France?');
    const ask = () =>
      new Promise((resolve) => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ timings: port2 }, [port2]);
      });
    let seen = await ask();
    for (let i = 0; i < 50 && !seen.heard.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      seen = await ask();
    }
    await owner.release();
    return { text, ...seen };
  });
  assert.equal(result.text, 'Paris.');
  assert.deepEqual(result.rejections, []);
  assert.equal(result.heard.length, 1);
  assert.equal(result.heard[0].provider, 'faux');
  assert.deepEqual(result.reports, [{ type: 'listener_error', message: 'boom' }]);
});
