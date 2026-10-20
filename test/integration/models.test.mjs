import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const script = [
  'models use faux/faux-2 --thinking high',
  'models',
  'models current --json',
  'models use faux/faux-3; echo "exit=$?"',
].join('; ');

test("an agent's bash lists models and switches its own model in the production worker", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const query = [
    'model=faux-1',
    'model=faux-2',
    'vault',
    `record=${encodeURIComponent(JSON.stringify({ kind: 'model', name: 'FAUX_API_KEY', provider: 'faux', placeholder: 'fnox_proxy_faux', value: 'faux-model-key-0001' }))}`,
    `step=${encodeURIComponent(JSON.stringify({ tool: { name: 'bash', args: { command: script } } }))}`,
    `step=${encodeURIComponent(JSON.stringify({ answer: 'Switched.' }))}`,
  ].join('&');
  const seen = await staged(
    page,
    'an agent’s bash lists models',
    async (q) => {
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/main-worker.js?${q}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const { agent, settings } = createAgentModel(await owner.connect(), {
        storage: localStorage,
      });
      await agent.ready();
      const until = (check, what = 'the state') => when([changed, every(100)], check, what);
      await until(() => settings.accounts().length > 0);
      await settings.connect('faux');
      await until(() => settings.accounts()[0]?.status === 'connected');
      await agent.send(agent.active(), 'Switch to faux-2.');
      const tools = () =>
        agent
          .messages()
          .flatMap((message) => message.parts ?? [])
          .filter((part) => part.type === 'tool')
          .map((part) => part.tool);
      await until(
        () => tools().some((tool) => tool.status === 'done' || tool.status === 'error'),
        1000
      );
      await until(
        () => agent.list().find((row) => row.id === agent.active())?.model === 'faux/faux-2'
      );
      const row = agent.list().find((entry) => entry.id === agent.active());
      const output = tools()[0]?.output;
      const status = tools()[0]?.status;
      await owner.release();
      return {
        output: typeof output === 'string' ? output : JSON.stringify(output),
        status,
        model: row?.model,
        thinking: row?.thinking,
      };
    },
    query
  );
  assert.equal(seen.status, 'done');
  assert.match(seen.output, /now using faux\/faux-2 \(.*\), thinking high/);
  assert.match(seen.output, / {2}faux\/faux-1\t/);
  assert.match(seen.output, /\* faux\/faux-2\t/);
  assert.match(seen.output, /"id": "faux\/faux-2"/);
  assert.match(seen.output, /"thinking": "high"/);
  assert.match(
    seen.output,
    /models: there is no model faux\/faux-3; the closest are faux\/faux-1, faux\/faux-2/
  );
  assert.match(seen.output, /exit=1/);
  assert.equal(seen.model, 'faux/faux-2');
});
