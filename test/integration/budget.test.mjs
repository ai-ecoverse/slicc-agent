import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const DAY = 86400000;

const helpers = () => {
  const owner = new BroadcastChannel('slicc-held');
  owner.onmessage = ({ data }) => owner.postMessage({ type: 'held', marker: data.marker });
  window.open = (url) => {
    const popup = { closed: false, location: { href: url }, close: () => (popup.closed = true) };
    return popup;
  };
  window.openBudgets = async (query) => {
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    const kernel = await bootKernel();
    stage('the agent');
    let worker;
    const started = await startAgent({
      worker: () => (worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    const post = (message, reply) => {
      const channel = new MessageChannel();
      const done = new Promise((resolve) => {
        channel.port1.onmessage = ({ data }) => resolve(data);
      });
      worker.postMessage({ ...message, [reply]: channel.port2 }, [channel.port2]);
      return done;
    };
    const connection = await started.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    const sources = [...agentSources(connection, model), heard(model.tray, 'status'), every(100)];
    const until = (check, what) => when(sources, check, what);
    await model.agent.ready();
    const { settings, agent, tray, monitor } = model;
    const account = (id) => settings.accounts().find((entry) => entry.id === id);
    await until(() => account('adobe')?.status === 'connected', 'the Adobe account');
    stage('the xAI sign-in');
    const signing = settings.connect('xai', undefined, undefined, { method: 'sign-in' });
    await until(() => account('xai')?.signIn, 'the xAI device code');
    await post({ device: 'approve' }, 'deviced');
    await signing;
    await until(() => account('xai')?.status === 'connected', 'the xAI account');
    const pick = async (id) => {
      agent.setModel(agent.active(), id);
      await until(
        () => agent.list().find((row) => row.id === agent.active())?.model === id,
        `the cone on ${id}`
      );
    };
    const card = () => {
      const vital = monitor.snapshot().vitals.find((entry) => entry.id === 'budget');
      return vital
        ? { label: vital.label, value: vital.value, provider: vital.provider, window: vital.window }
        : null;
    };
    const leaks = async () => {
      const seen = JSON.stringify({
        worker: await post({}, 'logged'),
        state: connection.settings.state.value,
        tray: tray.status(),
        monitor: monitor.snapshot(),
        storage: { ...localStorage },
      });
      return [...new Set(seen.match(/SECRET\d+VALUE/g) ?? [])];
    };
    return {
      owner: started,
      until,
      pick,
      card,
      leaks,
      tray,
      state: () => connection.settings.state.value,
      log: () => post({}, 'upstream'),
      vaultUrls: () => post({}, 'vaultUrls'),
    };
  };
};

const adobe = {
  kind: 'model',
  name: 'ADOBE_IMS_TOKEN',
  provider: 'adobe',
  placeholder: 'fnox_proxy_adobe',
  value: 'budget-key-0001',
};

const queryOf = (...more) => {
  const resets = new Date((Math.floor(Date.now() / DAY) + 2) * DAY + 60000).toISOString();
  return [
    'xai',
    'e2e',
    'vault',
    `resets=${encodeURIComponent(resets)}`,
    `record=${encodeURIComponent(JSON.stringify(adobe))}`,
    ...more,
  ].join('&');
};

async function opened(t) {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  return page;
}

test('signed in to SuperGrok, the tray and the Monitor show the selected model’s provider budget, labelled by provider', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'the SuperGrok budget',
    async (query) => {
      const it = await window.openBudgets(query);
      stage('the xAI model');
      await it.pick('xai/grok-4.7');
      await it.until(() => it.tray.status().budget?.provider === 'xai', 'the SuperGrok budget');
      const grok = { tray: it.tray.status().budget, card: it.card() };
      stage('the Adobe model');
      await it.pick('adobe/e2e-1');
      await it.until(() => it.tray.status().budget?.provider === 'adobe', 'the Adobe budget');
      const adobe = { tray: it.tray.status().budget, card: it.card() };
      const { upstream } = await it.log();
      const result = {
        grok,
        adobe,
        budgets: it.state().budgets.map(({ provider, percent }) => ({ provider, percent })),
        billing: [
          ...new Set(upstream.filter((entry) => entry.billing).map((entry) => entry.billing)),
        ],
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    queryOf('grok-billing')
  );
  assert.deepEqual(seen.grok, {
    tray: { percent: 23, window: 'weekly', resets: '2026-10-27T19:03:46.999Z', provider: 'xai' },
    card: { label: 'Budget (weekly)', value: '23%', provider: 'xai', window: 'weekly' },
  });
  assert.equal(seen.adobe.tray.provider, 'adobe');
  assert.equal(seen.adobe.tray.percent, 40);
  assert.deepEqual(seen.adobe.card, {
    label: 'Budget (weekly)',
    value: '40%',
    provider: 'adobe',
    window: 'weekly',
  });
  assert.deepEqual(seen.budgets, [
    { provider: 'adobe', percent: 40 },
    { provider: 'xai', percent: 23 },
  ]);
  assert.deepEqual(seen.billing, ['signed-in']);
  assert.deepEqual(seen.leaks, []);
});

test('while the vault doesn’t fill the xAI token at the billing endpoint, nothing reaches it and Adobe’s budget stays shown', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'no SuperGrok budget',
    async (query) => {
      const it = await window.openBudgets(query);
      await it.pick('xai/grok-4.7');
      await it.until(
        async () => (await it.vaultUrls()).some((url) => url?.includes('cli-chat-proxy.grok.com')),
        'the refused billing request'
      );
      const { upstream } = await it.log();
      const result = {
        tray: it.tray.status().budget.provider,
        card: it.card()?.provider,
        budgets: it.state().budgets.map(({ provider }) => provider),
        reached: upstream.filter((entry) => entry.billing).length,
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    queryOf()
  );
  assert.equal(seen.tray, 'adobe');
  assert.equal(seen.card, 'adobe');
  assert.deepEqual(seen.budgets, ['adobe']);
  assert.equal(seen.reached, 0);
  assert.deepEqual(seen.leaks, []);
});

test('a billing answer larger than 64 KiB shows no SuperGrok budget', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'an oversized billing answer',
    async (query) => {
      const it = await window.openBudgets(query);
      await it.pick('xai/grok-4.7');
      await it.until(
        async () => (await it.log()).upstream.some((entry) => entry.billing === 'signed-in'),
        'the billing request'
      );
      const result = {
        tray: it.tray.status().budget.provider,
        budgets: it.state().budgets.map(({ provider }) => provider),
      };
      await it.owner.release();
      return result;
    },
    queryOf('grok-billing=huge')
  );
  assert.equal(seen.tray, 'adobe');
  assert.deepEqual(seen.budgets, ['adobe']);
});
