import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test("pi-ai's Bedrock client streams through the kernel transport in a browser worker", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const worker = new Worker('/dist-test/bedrock-worker.js', { type: 'module' });
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => resolve({ failed: event.message });
      })
  );
  assert.equal(result.failed, undefined);
  assert.deepEqual(
    result.seen.map((request) => [request.method, request.authorization]),
    [
      ['POST', 'Bearer bad-token'],
      ['POST', 'Bearer good-token'],
    ]
  );
  assert.match(
    result.seen[0].url,
    /^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/us\.anthropic\.claude-sonnet-5-5\/converse-stream$/
  );
  assert.equal(result.denied.stopReason, 'error');
  assert.match(result.denied.error, /security token/);
  assert.deepEqual(result.answered, { stopReason: 'stop', text: 'Hello from Bedrock.', usage: 7 });
});
