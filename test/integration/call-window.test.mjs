import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { binaryCodec } from '@earendil-works/chord';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the agent and a page client announce a call window of 256 in their link hello, as Chord 1.5.2 did', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'the call window', async () => {
    await import('/dist-test/page.js');
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/agent-worker.js?answer=Here.', { type: 'module' }),
    });
    const local = await owner.connect();
    const opened = await local.control.guestOpen(
      {
        id: 'window',
        label: 'Anna',
        agentId: 'cone',
        expiresAt: null,
        gates: { messages: 'off', tools: 'user' },
      },
      BACKGROUND_CONTEXT
    );
    if (opened.error) throw new Error(opened.error);
    const agentHello = async (options) => {
      const link = await openRawLink(await owner.port(options));
      const hello = link.received.find((message) => message.kind === 'hello');
      link.close();
      return { protocol: hello.protocol, calls: hello.calls };
    };
    stage('raw links read the agent hello');
    const ownerSeat = await agentHello({ pages: false });
    const guestSeat = await agentHello({ guest: { id: 'window', label: 'Anna' } });
    stage('a page client sends its hello');
    const port = await owner.port({ pages: false });
    let first;
    const endpoint = {
      postMessage(message, transfer) {
        if (message instanceof Uint8Array && first === undefined) first = Array.from(message);
        port.postMessage(message, transfer);
      },
      addEventListener: (type, listener) => port.addEventListener(type, listener),
      start: () => port.start(),
      close: () => port.close(),
    };
    const follower = await connectAgent(endpoint);
    const answer = await follower.prompt('Are you there?');
    await follower.close();
    await local.close();
    await owner.release();
    return { ownerSeat, guestSeat, client: first, answer };
  });
  assert.deepEqual(seen.ownerSeat, { protocol: 1, calls: 256 });
  assert.deepEqual(seen.guestSeat, { protocol: 1, calls: 256 });
  const client = binaryCodec.decode(Uint8Array.from(seen.client));
  assert.equal(client.kind, 'hello');
  assert.equal(client.protocol, 1);
  assert.equal(client.calls, 256);
  assert.equal(seen.answer, 'Here.');
});
