import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the production worker entry chats and lists accounts', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js?answer=Ready.', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const { agent, settings } = createAgentModel(await owner.connect(), { storage: localStorage });
    await agent.ready();
    await agent.send(agent.active(), 'Are you there?');
    for (let i = 0; i < 100 && !agent.messages().some((m) => m.role === 'assistant'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (let i = 0; i < 100 && settings.accounts().length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await settings.connect('faux', 'not-a-real-key');
    for (let i = 0; i < 100 && settings.accounts()[0]?.status !== 'connected'; i++)
      await new Promise((r) => setTimeout(r, 20));
    return {
      reply: agent.messages().at(-1)?.parts?.[0]?.text,
      accounts: settings.accounts().map((account) => [account.id, account.status]),
      model: settings.get().model,
    };
  });
  assert.equal(seen.reply, 'Ready.');
  assert.deepEqual(seen.accounts, [['faux', 'connected']]);
  assert.equal(seen.model, 'faux/faux-1');
});
