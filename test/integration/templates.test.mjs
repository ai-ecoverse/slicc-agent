import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a prompt template keeps an empty quoted argument in its place', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    let handle = await navigator.storage.getDirectory();
    for (const part of ['home', '.pi', 'agent', 'prompts'])
      handle = await handle.getDirectoryHandle(part, { create: true });
    const writable = await (
      await handle.getFileHandle('pair.md', { create: true })
    ).createWritable();
    await writable.write('---\ndescription: Two values.\n---\nFirst: [$1] Second: [$2] All: [$@]');
    await writable.close();
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let worker;
    const owner = await startAgent({
      worker: () =>
        (worker = new Worker('/dist-test/main-worker.js?answer=Done.', { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    for (let n = 0; n < 200; n++) {
      if (connection.commands.value.some((command) => command.name === 'pair')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const answer = await connection.prompt(`/pair "" 'second one'`);
    const channel = new MessageChannel();
    const requests = new Promise((resolve) => {
      channel.port1.onmessage = ({ data }) => resolve(data);
    });
    worker.postMessage({ requests: channel.port2 }, [channel.port2]);
    const result = { answer, requests: await requests };
    await owner.release();
    return result;
  });
  assert.equal(seen.answer, 'Done.');
  const turn = JSON.parse(seen.requests.at(-1));
  const user = turn.messages.filter((message) => message.role === 'user').at(-1);
  assert.match(
    JSON.stringify(user.content),
    /First: \[\] Second: \[second one\] All: \[ second one\]/
  );
});
