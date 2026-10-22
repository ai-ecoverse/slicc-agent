import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const start = (url) =>
  new Promise((resolve) => {
    const worker = new Worker(url, { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      resolve(data);
    };
  });

test('a session slicc-agent 6.19.13 wrote on pi durable 1.3 opens and resumes its cut-off run', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const directory = '/.slicc/test-upgrade';
  const old = await page.evaluate(start, `/dist-test/agent-6-worker.js?directory=${directory}`);
  assert.equal(old.error, undefined);
  assert.equal(old.answer, 'Old answer.');
  assert.equal(old.holding, true);
  const opened = await page.evaluate(start, `/dist-test/upgrade-worker.js?directory=${directory}`);
  assert.equal(opened.error, undefined);
  assert.deepEqual(opened.before, [
    'pi.user: First.',
    'pi.assistant: Old answer.',
    'pi.user: Second.',
    'pi.assistant: Resumed answer.',
  ]);
  assert.equal(opened.third, 'Third answer.');
  assert.deepEqual(opened.after.slice(-2), ['pi.user: Third.', 'pi.assistant: Third answer.']);
  const back = await page.evaluate(
    start,
    `/dist-test/agent-6-worker.js?directory=${directory}&reopen`
  );
  assert.equal(back.opened, undefined);
  assert.match(back.error, /schema version 2 is newer than supported version 1/);
});
