import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the production worker entry chats and lists accounts', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const query = `answer=Ready.&vault&record=${encodeURIComponent(JSON.stringify({ kind: 'model', name: 'FAUX_API_KEY', provider: 'faux', placeholder: 'fnox_proxy_faux', value: 'faux-model-key-0001' }))}`;
  const seen = await page.evaluate(async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const { agent, settings } = createAgentModel(await owner.connect(), { storage: localStorage });
    await agent.ready();
    await agent.send(agent.active(), 'Are you there?');
    const replied = () =>
      agent.messages().some((m) => m.role === 'assistant' && m.parts?.[0]?.type === 'text');
    for (let i = 0; i < 500 && !replied(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (let i = 0; i < 100 && settings.accounts().length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await settings.connect('faux');
    for (let i = 0; i < 100 && settings.accounts()[0]?.status !== 'connected'; i++)
      await new Promise((r) => setTimeout(r, 20));
    return {
      reply: agent.messages().at(-1)?.parts?.[0]?.text,
      accounts: settings.accounts().map((account) => [account.id, account.status, account.store]),
      model: settings.get().model,
    };
  }, query);
  assert.equal(seen.reply, 'Ready.');
  assert.deepEqual(seen.accounts, [['faux', 'connected', 'vault']]);
  assert.equal(seen.model, 'faux/faux-1');
});

test("with a kernel source that has users, the worker chats through the cone's own client, and a user finds the agent commands", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const connects = [];
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js?answer=Ready.', { type: 'module' }),
      kernel: {
        connect: (options) => {
          connects.push(options ?? null);
          return kernel.connect();
        },
        users: kernel.users,
      },
    });
    const { agent } = createAgentModel(await owner.connect(), { storage: localStorage });
    await agent.ready();
    await agent.send(agent.active(), 'Are you there?');
    const replied = () =>
      agent.messages().some((m) => m.role === 'assistant' && m.parts?.[0]?.type === 'text');
    for (let i = 0; i < 500 && !replied(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await kernel.users.add({ name: 'cone' });
    let found = '';
    for (let i = 0; i < 200 && !found; i++) {
      found = (await kernel.run(['bash', '-c', 'command -v agent'], { user: 'cone' })).stdout;
      if (!found) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await owner.release();
    return { reply: agent.messages().at(-1)?.parts?.[0]?.text, found, connects };
  });
  assert.equal(seen.reply, 'Ready.');
  assert.equal(seen.found, '/usr/local/bin/agent\n');
  assert.deepEqual(seen.connects, [null, { user: 'cone', agentId: 'cone:cone' }]);
});
