import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('an agent CLI never reads an exit code the control plane has created but not yet filled', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel(
      {},
      { worker: new URL('/slow-code-kernel-worker.js', location.href) }
    );
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    await createAgentModel(await owner.connect(), { storage: localStorage }).agent.ready();
    window.sh = (command) => kernel.run(['bash', '-c', command]);
  });
  await page.within(
    60000,
    async () => (await window.sh('test -d /var/lib/slicc/agent/requests/in')).status === 0
  );
  const listed = await page.evaluate(() => window.sh('subagent list'));
  assert.deepEqual([listed.status, listed.stderr], [0, '']);
  assert.equal(listed.stdout, 'no scoops\n');
  const left = await page.within(60000, async () => {
    const out = (await window.sh('ls -A /var/lib/slicc/agent/requests/out')).stdout;
    return out === '' && 'empty';
  });
  assert.equal(left, 'empty');
});

test('an agent CLI still gets a complete exit code when rename fails and the fallback write is slow', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel(
      {},
      { worker: new URL('/fail-rename-kernel-worker.js', location.href) }
    );
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    await createAgentModel(await owner.connect(), { storage: localStorage }).agent.ready();
    window.sh = (command) => kernel.run(['bash', '-c', command]);
  });
  await page.within(
    60000,
    async () => (await window.sh('test -d /var/lib/slicc/agent/requests/in')).status === 0
  );
  const listed = await page.evaluate(() => window.sh('subagent list'));
  assert.deepEqual([listed.status, listed.stderr], [0, '']);
  assert.equal(listed.stdout, 'no scoops\n');
  const left = await page.within(60000, async () => {
    const out = (await window.sh('ls -A /var/lib/slicc/agent/requests/out')).stdout;
    return out === '' && 'empty';
  });
  assert.equal(left, 'empty');
});
