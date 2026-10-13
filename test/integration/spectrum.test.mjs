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

test('a view-only follower says why each refused fire-and-forget call failed, without a page error', async (t) => {
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const notices = await page.evaluate(async () => {
    const unhandled = [];
    addEventListener('unhandledrejection', (event) => unhandled.push(String(event.reason)));
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/agent-worker.js?answer=Hi.', { type: 'module' }),
    });
    const model = createAgentModel(await owner.connect({ readOnly: true }));
    const { agent } = model;
    await agent.ready();
    agent.stop();
    agent.clear();
    agent.setModel(agent.active(), 'faux/faux-1');
    agent.freeze();
    model.sprinkles.send('welcome', { action: 'go' });
    model.settings.disconnect('faux');
    agent.compact();
    const shown = () => agent.messages().filter((message) => message.kind === 'notice');
    for (let i = 0; i < 100 && shown().length < 7; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      texts: shown()
        .map((message) => message.text)
        .sort(),
      unhandled,
    };
  });
  assert.deepEqual(notices.unhandled, []);
  assert.deepEqual(
    notices.texts,
    [
      'stop agents',
      'start new chats',
      'change agent settings',
      'freeze cones',
      'send sprinkle actions',
      'disconnect accounts',
      'compact conversations',
    ]
      .map((action) => `This page is view-only, so it can't ${action}.`)
      .sort()
  );
  assert.deepEqual(errors, []);
});
