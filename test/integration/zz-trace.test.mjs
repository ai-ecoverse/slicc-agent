import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const script = [
  'models use faux/faux-2 --thinking high',
  'models',
  'models current --json',
  'models use faux/faux-3; echo "exit=$?"',
].join('; ');

for (const round of [1, 2, 3]) test(`trace ${round}: an agent's bash lists models and switches its own model in the production worker`, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const query = [
    'model=faux-1',
    'model=faux-2',
    `step=${encodeURIComponent(JSON.stringify({ tool: { name: 'bash', args: { command: script } } }))}`,
    `step=${encodeURIComponent(JSON.stringify({ answer: 'Switched.' }))}`,
  ].join('&');
  const seen = await page.evaluate(async (q) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${q}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const { agent, settings } = createAgentModel(await owner.connect(), { storage: localStorage });
    await agent.ready();
    const until = async (check) => {
      for (let n = 0; n < 500 && !check(); n++) await new Promise((r) => setTimeout(r, 20));
      return check();
    };
    await until(() => settings.accounts().length > 0);
    await settings.connect('faux', 'not-a-real-key');
    await until(() => settings.accounts()[0]?.status === 'connected');
    const tsend = performance.now();
    await agent.send(agent.active(), 'Switch to faux-2.');
    const tools = () =>
      agent
        .messages()
        .flatMap((message) => message.parts ?? [])
        .filter((part) => part.type === 'tool')
        .map((part) => part.tool);
    const t0 = Date.now();
    const trace = [];
    let lastLen = -1, lastStatus = '';
    const probe = setInterval(() => {
      const tool = tools()[0];
      const len = String(tool?.output ?? '').length;
      if (len !== lastLen || tool?.status !== lastStatus) {
        trace.push(`${Date.now() - t0}ms ${tool?.status} ${len}`);
        lastLen = len; lastStatus = tool?.status;
      }
    }, 10);
    await until(() =>
      tools().some(
        (tool) =>
          (tool.status === 'done' || tool.status === 'error') && /exit=\d/.test(String(tool.output))
      )
    );
    await until(
      () => agent.list().find((row) => row.id === agent.active())?.model === 'faux/faux-2'
    );
    const row = agent.list().find((entry) => entry.id === agent.active());
    const output = tools()[0]?.output;
    for (let n = 0; n < 1500 && !/exit=/.test(String(tools()[0]?.output)); n++) await new Promise((r) => setTimeout(r, 20));
    clearInterval(probe);
    trace.push(`setup ${Math.round(tsend - performance.timeOrigin + performance.timeOrigin)} t0-send ${Math.round(performance.now() - tsend)}`);
    trace.push(`final ${tools()[0]?.status} ${JSON.stringify(tools()[0]?.output).slice(-40)}`);

    await owner.release();
    return {
      output: typeof output === 'string' ? output : JSON.stringify(output),
      model: row?.model,
      thinking: row?.thinking, trace,
    };
  }, query);
  console.log(seen.trace.join('\n'));
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
