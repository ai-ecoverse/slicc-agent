import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('answers a prompt from an agent worker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const text = await page.evaluate(async () => {
    const { connectAgent } = await import('/dist/port.js');
    const url = '/dist-test/agent-worker.js?answer=Paris.';
    const worker = new Worker(url, { type: 'module' });
    return connectAgent(worker).prompt('Capital of France?');
  });
  assert.equal(text, 'Paris.');
});

test('stays cross-origin isolated', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
});

test('rejects a prompt when the worker fails to load', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const message = await page.evaluate(async () => {
    const { connectAgent } = await import('/dist/port.js');
    const worker = new Worker('/dist-test/missing-worker.js', { type: 'module' });
    return connectAgent(worker)
      .prompt('Anyone?')
      .then(
        () => 'answered',
        (error) => error.message
      );
  });
  assert.match(message, /^agent failed/);
});
