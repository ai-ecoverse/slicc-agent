import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('remote control through the production worker: a prompt streams §5.11 events, watch resumes after an id, abort reports idle', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const params = new URLSearchParams([
      ['tool', JSON.stringify({ name: 'bash', args: { command: 'printf "%s\\n" one two' } })],
      ['answer', 'Two lines.'],
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const remote = remoteControl(connection);
    const prompted = await remote.prompt({ text: 'Print two lines.' });
    const events = [];
    for await (const event of prompted.events) events.push(event);
    const text = events.find((event) => event.t === 'text');
    const resumed = await remote.watch({ since: events[0].id });
    const iterator = resumed.events[Symbol.asyncIterator]();
    const replay = [];
    for (let n = 0; n < 3; n++) replay.push((await iterator.next()).value);
    await iterator.return();
    const aborted = await remote.abort();
    await owner.release();
    return { delivered: prompted.delivered, events, text, head: resumed.head, replay, aborted };
  });
  assert.equal(seen.delivered, 'run');
  assert.deepEqual(
    seen.events.map((event) => event.t),
    ['user', 'run', 'tool', 'tool-result', 'text', 'run', 'end']
  );
  assert.equal(seen.events[0].text, 'Print two lines.');
  assert.equal(seen.events[2].summary, 'bash printf "%s\\n" one two');
  assert.deepEqual([seen.events[3].ok, seen.events[3].summary], [true, '3 lines']);
  assert.equal(seen.text.delta, 'Two lines.');
  assert.deepEqual(seen.events.at(-1), { t: 'end', reason: 'stop' });
  assert.equal(seen.head, seen.text.id);
  assert.deepEqual(
    seen.replay.map((event) => event.t),
    ['tool', 'tool-result', 'text']
  );
  assert.deepEqual(seen.aborted, { aborted: false });
});
