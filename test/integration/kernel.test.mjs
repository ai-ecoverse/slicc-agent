import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the page sees and kills a process the agent started', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    const { startAgent } = await import('/dist-test/page.js').then(() => globalThis);
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () =>
        new Worker('/dist-test/agent-worker.js?kernel&bash=sleep%20100&answer=stopped', {
          type: 'module',
        }),
      kernel: { connect: () => kernel.connect() },
    });
    const agent = await owner.connect();
    const answer = agent.prompt('Wait a while');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const terminal = await attachKernel(await kernel.connect());
    let sleeping;
    for (let i = 0; i < 300 && !sleeping; i++) {
      sleeping = (await terminal.ps()).find((proc) => proc.argv.includes('100'));
      if (!sleeping) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!sleeping) return { error: 'no sleep in ps' };
    await terminal.kill(sleeping.pid, 'SIGKILL');
    const text = await answer;
    const entries = agent.transcript.value.entries.map((entry) => entry.kind);
    return { text, pid: sleeping.pid, entries };
  });
  assert.equal(result.error, undefined);
  assert.equal(result.text, 'stopped');
  assert.ok(result.pid > 0);
  assert.ok(result.entries.includes('pi.tool-result'));
});
