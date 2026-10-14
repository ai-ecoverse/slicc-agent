import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('every request to a proxy that refuses requests without X-Session-Id carries it, and its refusal shows plainly', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const worker = new Worker('/dist-test/adobe-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => resolve({ failed: event.message });
      })
  );
  assert.equal(result.failed, undefined);
  assert.deepEqual(result.answers, [
    { stopReason: 'stop', text: 'Hello from Claude.' },
    { stopReason: 'stop', text: 'Hello from GPT.' },
  ]);
  const proxied = result.seen.slice(0, -1);
  assert.deepEqual(
    proxied.map(({ url }) => new URL(url).pathname),
    ['/v1/config', '/v1/messages', '/v1/chat/completions']
  );
  for (const request of proxied) {
    assert.deepEqual([request.session, request.version], ['worker-session', '1.0.0'], request.url);
  }
  assert.equal(result.seen.at(-1).session, null);
  assert.equal(result.refused.message, 'Missing required header: x-session-id');
  assert.equal(result.refused.detail, '403 missing_required_header');
  assert.equal(result.refused.action, 'retry');
});
