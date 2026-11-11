import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = (command) => ({ tool: { name: 'bash', args: { command } } });

function query(turns, extra = '') {
  return turns
    .flat()
    .map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`)
    .concat(extra ? [extra] : [])
    .join('&');
}

async function run(page, turns, script, extra) {
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
        viewer: () => owner.connect({ readOnly: true }),
        live: () => connection.transcript.value?.docs['pi.live'],
      };
      try {
        return await new Function('api', `return (async () => { ${script} })()`)(api);
      } finally {
        await owner.release();
      }
    },
    { query: query(turns, extra), script }
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

test('labels: a step is labelled from its own input while it still runs, once however often it is asked', async (t) => {
  const page = await chrome.page(t);
  const seen = await run(
    page,
    [bash('echo a'), bash('sleep 3; echo b'), { answer: 'Done.' }],
    `await api.send('go');
    ${running(2)}
    const asked = [api.agent.stepLabel('cone', ids[1]), api.agent.stepLabel('cone', ids[1])];
    const running = await Promise.all(asked);
    const status = api.tools().at(-1).status;
    const first = await api.agent.stepLabel('cone', ids[0]);
    await api.until(() => api.tools().at(-1).status === 'done', 'the last run');
    const again = await api.agent.stepLabel('cone', ids[1]);
    const cluster = await api.agent.toolLabel('cone', ids);
    return { running, status, first, again, cluster };`
  );
  assert.deepEqual(seen, {
    running: ['Run sleep 3; echo b', 'Run sleep 3; echo b'],
    status: 'running',
    first: 'Run echo a',
    again: 'Run sleep 3; echo b',
    cluster: 'Label 1',
  });
});

test('labels: ids that are not a call going on get null at once, from the owner and from a viewer, and a call that still streams gets its label', async (t) => {
  const page = await chrome.page(t);
  const command = `sleep 4; echo ${'x'.repeat(400)}`;
  const seen = await run(
    page,
    [bash(command), { answer: 'Done.' }],
    `await api.send('go');
    const streaming = () => (api.live()?.generation?.message?.content ?? []).find((block) => block.type === 'toolCall');
    await api.until(() => !!streaming()?.id, 'a call that streams');
    const id = streaming().id;
    const written = () => api.tools().some((tool) => tool.id === id && tool.input === ${JSON.stringify(command)});
    const early = written();
    const label = api.agent.stepLabel('cone', id);
    const bogus = Array.from({ length: 40 }, (_, n) => 'bogus-' + n);
    const started = performance.now();
    const owned = await Promise.all(bogus.map((callId) => api.agent.stepLabel('cone', callId)));
    const ownedMs = performance.now() - started;
    const odd = await Promise.all(['', 'a b', 'x'.repeat(300)].map((callId) => api.agent.stepLabel('cone', callId)));
    const viewer = await api.viewer();
    const at = performance.now();
    const quick = [];
    const watched = bogus.map((callId) =>
      viewer.control.stepLabel('cone', callId, BACKGROUND_CONTEXT).then((value) => {
        if (performance.now() - at < 1000) quick.push(value);
        return value;
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const shown = await label;
    const viewed = await viewer.control.stepLabel('cone', id, BACKGROUND_CONTEXT);
    await viewer.close();
    void Promise.allSettled(watched);
    return { early, shown, viewed, owned: [...new Set(owned)], fast: ownedMs < 2000, odd, quick: quick.length, quickValues: [...new Set(quick)] };`,
    'tps=60'
  );
  assert.deepEqual(seen, {
    early: false,
    shown: `Run ${command}`.slice(0, 80),
    viewed: `Run ${command}`.slice(0, 80),
    owned: [null],
    fast: true,
    odd: [null, null, null],
    quick: 8,
    quickValues: [null],
  });
});
