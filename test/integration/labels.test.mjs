import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = (command) => ({ tool: { name: 'bash', args: { command } } });

function query(turns) {
  return turns
    .flat()
    .map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`)
    .join('&');
}

async function run(page, turns, script) {
  await page.goto('/');
  return staged(
    page,
    'the labels',
    async ({ query, script }) => {
      await import('/dist-test/page.js');
      stage('the kernel');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      stage('the agent');
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      const { agent } = model;
      await agent.ready();
      const until = (check, what) => when(agentSources(connection, model), check, what);
      const tools = () =>
        agent
          .messages('cone')
          .filter((message) => message.role === 'assistant')
          .flatMap((message) => message.parts.filter((part) => part.type === 'tool'))
          .map((part) => part.tool);
      const send = (text) =>
        connection.control.send(
          { text, whenBusy: 'followUp', requestId: null },
          BACKGROUND_CONTEXT
        );
      const api = {
        agent,
        tools,
        until,
        send,
        stage,
        prompt: (text) => connection.prompt(text),
      };
      try {
        return await new Function('api', `return (async () => { ${script} })()`)(api);
      } finally {
        await owner.release();
      }
    },
    { query: query(turns), script }
  );
}

const running = (count) => `
  await api.until(() => {
    const tools = api.tools();
    return tools.length === ${count} && tools.slice(0, -1).every((tool) => tool.status === 'done') && tools.at(-1).status === 'running';
  }, '${count} tools, the last running');
  api.stage('the labels');
  const ids = api.tools().map((tool) => tool.id);
`;

test('labels: a cluster that grows while it runs is labelled when it forms and once more when it settles', async (t) => {
  const page = await chrome.page(t);
  const seen = await run(
    page,
    [bash('echo a'), bash('echo b'), bash('echo c'), bash('sleep 3; echo d'), { answer: 'Done.' }],
    `await api.send('go');
    ${running(4)}
    const formed = await api.agent.toolLabel('cone', ids.slice(0, 3));
    const grown = [api.agent.toolLabel('cone', ids), api.agent.toolLabel('cone', ids)];
    const settled = await Promise.all(grown);
    const again = await api.agent.toolLabel('cone', ids.slice(0, 3));
    const status = api.tools().at(-1).status;
    return { formed, settled, again, status };`
  );
  assert.equal(seen.formed, 'Label 1');
  assert.deepEqual(seen.settled, ['Label 2', 'Label 2']);
  assert.equal(seen.again, 'Label 1');
  assert.equal(seen.status, 'done');
});

test('labels: a growing cluster whose first label the per-minute cap refused still gets one label once it settles', async (t) => {
  const page = await chrome.page(t);
  const first = Array.from({ length: 12 }, (_, n) => bash(`echo ${n}`));
  const seen = await run(
    page,
    [
      first,
      { answer: 'First.' },
      bash('echo x'),
      bash('echo y'),
      bash('echo z'),
      bash('sleep 3; echo w'),
      { answer: 'Second.' },
    ],
    `api.stage('the first turn');
    await api.prompt('one');
    api.stage('the first labels');
    const earlier = api.tools().map((tool) => tool.id);
    const spent = [];
    for (let n = 0; n < 12; n += 3) spent.push(await api.agent.toolLabel('cone', earlier.slice(n, n + 3)));
    await api.send('two');
    ${running(16)}
    const fresh = ids.slice(12);
    const refused = await api.agent.toolLabel('cone', fresh.slice(0, 3));
    const settled = await api.agent.toolLabel('cone', fresh);
    return { spent, refused, settled };`
  );
  assert.deepEqual(seen.spent, ['Label 1', 'Label 2', 'Label 3', 'Label 4']);
  assert.equal(seen.refused, null);
  assert.equal(seen.settled, 'Label 5');
});
