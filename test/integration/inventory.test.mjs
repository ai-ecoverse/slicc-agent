import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const PROMPT = 'PROMPT-SENTINEL-7Q';
const SCOOP_PROMPT = 'SCOOP-PROMPT-SENTINEL-7Q';
const FAILURE = 'FAILURE-SENTINEL-7Q';
const DEPLOYMENT = 'DEPLOYMENT-SENTINEL-7Q';
const PROVIDER = 'PROVIDER-SENTINEL-7Q';

const helpers = () => {
  window.setup = async (query) => {
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    window.kernel = await bootKernel();
    stage('the agent');
    window.owner = await startAgent({
      worker: () => {
        window.worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' });
        return window.worker;
      },
      kernel: { connect: () => window.kernel.connect() },
    });
    window.connection = await window.owner.connect();
    window.remote = remoteControl(window.connection);
    window.sh = (command) => window.kernel.run(['bash', '-c', command]);
    await when(
      [files(window.kernel, ['/usr/local/bin'])],
      async () => (await window.sh('test -x /usr/local/bin/agent')).status === 0,
      'the agent command'
    );
  };
  window.collect = async () => {
    const opened = await window.remote.inventory({ watch: true });
    const seen = [opened.snapshot];
    window.looks = new Set();
    void (async () => {
      for await (const snapshot of opened.events) {
        seen.push(snapshot);
        for (const look of window.looks) look();
      }
    })();
    window.seen = seen;
    window.stop = () => opened.events[Symbol.asyncIterator]().return();
    return seen;
  };
  window.until = (check, what) =>
    when(
      [
        (look) => {
          window.looks.add(look);
          return () => window.looks.delete(look);
        },
      ],
      () => check(window.seen.at(-1)),
      what
    );
  window.agent = (snapshot, id) => snapshot.agents.find((agent) => agent.id === id);
};

const step = (value) => ['step', JSON.stringify(value)];

test('the owner follows the inventory of the cone and its scoop as they run, with no prompt or title in it', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const spawn = `SLICC_AGENT=cone:cone subagent spawn --name helper --prompt "${SCOOP_PROMPT}"`;
  const query = new URLSearchParams([
    step({ tool: { name: 'bash', args: { command: spawn } } }),
    step({ answer: 'Spawned.' }),
    step({ gate: 'notify', answer: 'Noted.' }),
    ['scoop-step', JSON.stringify({ gate: 'scoop', answer: 'Scoop done.' })],
  ]).toString();
  await staged(
    page,
    'the first snapshot',
    async (query) => {
      await window.setup(query);
      window.first = await window.remote.inventory();
      await window.collect();
    },
    query
  );
  await staged(
    page,
    'the cone runs',
    async (text) => {
      window.prompted = await window.remote.prompt({ text });
      await window.until(
        (last) => window.agent(last, 'scoop:helper')?.status === 'running',
        'scoop running'
      );
    },
    PROMPT
  );
  await staged(page, 'everything settles', async () => {
    for await (const _ of window.prompted.events);
    window.worker.postMessage({ gate: 'scoop' });
    await window.until((last) => window.agent(last, 'cone')?.status === 'running', 'cone running');
    window.worker.postMessage({ gate: 'notify' });
    await window.until(
      (last) =>
        last.agents.length === 2 &&
        last.agents.every((agent) => agent.status === 'idle') &&
        last.counts.idle === 2,
      'all idle'
    );
  });
  const seen = await page.evaluate(async () => {
    const titles = window.connection.agents.value.agents.map((agent) => agent.name);
    await window.stop();
    await window.owner.release();
    return { first: window.first, seen: window.seen, titles };
  });
  assert.equal(seen.first.events, undefined);
  assert.deepEqual(seen.first.snapshot.agents, [
    {
      id: 'cone',
      kind: 'cone',
      status: 'idle',
      queued: 0,
      provider: 'faux',
      model: 'faux-1',
      since: seen.first.snapshot.agents[0].since,
    },
  ]);
  assert.deepEqual(seen.first.snapshot.counts, {
    running: 0,
    queued: 0,
    waiting: 0,
    error: 0,
    idle: 1,
  });
  const seqs = seen.seen.map((snapshot) => snapshot.seq);
  assert.ok(
    seqs.every((seq, at) => at === 0 || seq > seqs[at - 1]),
    JSON.stringify(seqs)
  );
  for (const snapshot of seen.seen) {
    assert.equal(
      Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0),
      snapshot.agents.length
    );
    assert.equal(typeof snapshot.changedAt, 'number');
    assert.deepEqual(
      Object.keys(snapshot).sort(),
      ['agents', 'changedAt', 'counts', 'seq'],
      JSON.stringify(snapshot)
    );
    for (const agent of snapshot.agents)
      assert.deepEqual(
        Object.keys(agent).filter(
          (key) =>
            !['id', 'kind', 'parent', 'status', 'queued', 'provider', 'model', 'since'].includes(
              key
            )
        ),
        []
      );
  }
  assert.ok(seen.seen.some((snapshot) => snapshot.agents[0].status === 'running'));
  const running = seen.seen.find((snapshot) => snapshot.agents[1]?.status === 'running');
  assert.deepEqual(
    { ...running.agents[1], since: 0 },
    {
      id: 'scoop:helper',
      kind: 'scoop',
      parent: 'cone',
      status: 'running',
      queued: 0,
      provider: 'faux',
      model: 'faux-1',
      since: 0,
    }
  );
  assert.ok(running.counts.running >= 1);
  const last = seen.seen.at(-1);
  assert.ok(last.agents[0].since >= seen.first.snapshot.agents[0].since);
  const all = JSON.stringify(seen.seen);
  for (const secret of [PROMPT, SCOOP_PROMPT, 'Spawned.', 'Noted.', 'Scoop done.', 'bash'])
    assert.equal(all.includes(secret), false, secret);
  for (const title of seen.titles.filter((name) => name !== 'helper'))
    assert.equal(all.includes(title), false, title);
  const unnamed = JSON.stringify(
    seen.seen.map((snapshot) => snapshot.agents.map(({ id: _, parent: __, ...rest }) => rest))
  );
  assert.equal(unnamed.includes('helper'), false);
});

test('a failed turn shows as error, a model outside the catalog drops the model, and only the owner seat gets the inventory', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = new URLSearchParams([step({ error: FAILURE })]).toString();
  await staged(
    page,
    'the failed turn',
    async (query) => {
      await window.setup(query);
      await window.collect();
      const prompted = await window.remote.prompt({ text: 'Fail.' });
      for await (const _ of prompted.events);
      await window.until((last) => window.agent(last, 'cone')?.status === 'error', 'cone error');
    },
    query
  );
  await staged(
    page,
    'the other models',
    async (names) => {
      const configure = (model) =>
        window.connection.control.configure({ model, thinkingLevel: null }, BACKGROUND_CONTEXT);
      await configure({ provider: 'faux', modelId: names.deployment });
      await window.until(
        (last) => !('model' in window.agent(last, 'cone')),
        'the deployment without a model'
      );
      window.deployment = window.seen.at(-1);
      await configure({ provider: names.provider, modelId: 'gpt-x' });
      await window.until(
        (last) => !('provider' in window.agent(last, 'cone')),
        'the unknown provider'
      );
    },
    { deployment: DEPLOYMENT, provider: PROVIDER }
  );
  const seen = await page.evaluate(async () => {
    await window.stop();
    const refusal = async (connection) => {
      const control = remoteControl(connection);
      return control.inventory().then(
        () => 'served',
        (error) => error.code
      );
    };
    const view = await window.owner.connect({ readOnly: true });
    const control = await window.owner.connect({ pages: false });
    const seats = {
      view: ['inventory' in view, await refusal(view)],
      control: ['inventory' in control, await refusal(control)],
    };
    await view.close();
    await control.close();
    await window.connection.control.guestOpen(
      {
        id: 'peek',
        label: 'Peek',
        agentId: 'cone',
        expiresAt: null,
        gates: { messages: 'off', tools: 'user' },
      },
      BACKGROUND_CONTEXT
    );
    const guest = await connectGuest(
      await window.owner.port({ guest: { id: 'peek', label: 'Peek' } })
    );
    seats.guest = ['inventory' in guest, await refusal(guest)];
    await guest.close();
    const owned = await window.remote.inventory();
    await window.owner.release();
    return { seen: window.seen, deployment: window.deployment, seats, owned };
  });
  const failed = seen.seen.find((snapshot) => snapshot.agents[0].status === 'error');
  assert.equal(failed.counts.error, 1);
  assert.deepEqual(
    { ...seen.deployment.agents[0], since: 0 },
    { id: 'cone', kind: 'cone', status: 'error', queued: 0, provider: 'faux', since: 0 }
  );
  assert.deepEqual(
    { ...seen.seen.at(-1).agents[0], since: 0 },
    { id: 'cone', kind: 'cone', status: 'error', queued: 0, since: 0 }
  );
  assert.deepEqual(seen.seats, {
    view: [false, 'EOPNOTSUPP'],
    control: [false, 'EOPNOTSUPP'],
    guest: [false, 'EOPNOTSUPP'],
  });
  assert.equal(seen.owned.snapshot.agents.length, 1);
  const all = JSON.stringify(seen.seen);
  for (const secret of [FAILURE, DEPLOYMENT, PROVIDER, 'Fail.'])
    assert.equal(all.includes(secret), false, secret);
});
