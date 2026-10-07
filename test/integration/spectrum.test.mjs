import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the spectrum adapter shows a conversation with the agent worker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const seen = await page.evaluate(async () => {
    const owner = await startAgent({
      worker: () =>
        new Worker('/dist-test/agent-worker.js?answer=Hello%20from%20the%20worker.', {
          type: 'module',
        }),
    });
    const { agent } = createAgentModel(await owner.connect());
    await agent.ready();
    let updates = 0;
    agent.on('message', () => updates++);
    agent.on('messages', () => updates++);
    await agent.send(agent.active(), 'Hi there');
    for (let i = 0; i < 100 && !agent.messages().some((m) => m.role === 'assistant'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      roles: agent.messages().map((message) => message.role),
      reply: agent.messages().at(-1)?.parts?.[0]?.text,
      status: agent.list()[0].status,
      model: agent.list()[0].model,
      updates,
    };
  });
  assert.deepEqual(seen.roles, ['user', 'assistant']);
  assert.equal(seen.reply, 'Hello from the worker.');
  assert.equal(seen.status, 'idle');
  assert.equal(seen.model, 'faux/faux-1');
  assert.ok(seen.updates > 0);
});
