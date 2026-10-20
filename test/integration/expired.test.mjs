import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const adobeRecord = (more = {}) => ({
  kind: 'model',
  name: 'ADOBE_IMS_TOKEN',
  provider: 'adobe',
  placeholder: 'fnox_proxy_adobe',
  value: 'e2e-ims-token-0001',
  ...more,
});

const helpers = () => {
  window.write = async (path, text) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.until = (check, what = 'the state') => when([changed, every(100)], check, what);
  window.openAdobe = async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let worker;
    const owner = await startTracked({
      worker: () => (worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    const seal = (record) => {
      const channel = new MessageChannel();
      const sealed = new Promise((resolve) => {
        channel.port1.onmessage = () => resolve();
      });
      worker.postMessage({ seal: record, sealed: channel.port2 }, [channel.port2]);
      return sealed;
    };
    const signIns = [];
    const login = async (providerId, signIn) => {
      const config = await signIn();
      signIns.push({ providerId, clientId: config?.clientId ?? null });
      await seal(window.nextSeal);
      return { sealed: true };
    };
    const model = createAgentModel(await owner.connect(), { storage: localStorage, login });
    await model.agent.ready();
    const adobe = () => model.settings.accounts().find((account) => account.id === 'adobe');
    const log = () => {
      const channel = new MessageChannel();
      const answer = new Promise((resolve) => {
        channel.port1.onmessage = ({ data }) => resolve(data);
      });
      worker.postMessage({ upstream: channel.port2 }, [channel.port2]);
      return answer;
    };
    return { owner, ...model, adobe, signIns, seal, log };
  };
};

const queryOf = (record, more = []) =>
  [
    'relay=mcp.test',
    'e2e',
    'vault',
    ...(record ? [`record=${encodeURIComponent(JSON.stringify(record))}`] : []),
    ...more,
  ].join('&');

for (const [what, record] of [
  ['an inert', () => adobeRecord({ state: 'inert' })],
  ['a past-expiry', () => adobeRecord({ expiresAt: Date.now() - 60_000 })],
]) {
  test(`${what} Adobe record shows the account expired, and Sign in from there connects it`, async (t) => {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    const fresh = adobeRecord({ value: 'e2e-ims-token-0002', expiresAt: Date.now() + 86_400_000 });
    const seen = await staged(
      page,
      'what Adobe record shows the',
      async ({ query, fresh }) => {
        const { owner, settings, adobe, signIns } = await window.openAdobe(query);
        await window.until(() => adobe()?.store === 'vault' && adobe()?.status !== 'disconnected');
        const before = adobe();
        window.nextSeal = fresh;
        await settings.connect('adobe');
        await window.until(() => adobe()?.status === 'connected');
        const result = { before, after: adobe(), signIns };
        await owner.release();
        return result;
      },
      { query: queryOf(record()), fresh }
    );
    assert.equal(seen.before.status, 'expired');
    assert.equal(seen.before.auth, 'oauth');
    assert.deepEqual(seen.signIns, [{ providerId: 'adobe', clientId: 'c' }]);
    assert.equal(seen.after.status, 'connected');
  });
}

test('an Adobe record that expires while the page is open turns the account expired', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(
    page,
    'an Adobe record that expires',
    async ({ query, record }) => {
      const { owner, adobe, seal } = await window.openAdobe(query);
      const expiresAt = Date.now() + 3000;
      await seal({ ...record, expiresAt });
      const connected = await window.until(() => adobe()?.status === 'connected');
      await window.until(() => adobe()?.status === 'expired', 'the expired Adobe account');
      const result = { connected, early: Date.now() < expiresAt, after: adobe()?.status };
      await owner.release();
      return result;
    },
    { query: queryOf(null), record: adobeRecord() }
  );
  assert.deepEqual(seen, { connected: true, early: false, after: 'expired' });
});

test('a 401 on an Adobe turn shows Log in, the account offers Sign in even after another account changes, and the next turn after it goes through', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const expiresAt = Date.now() + 86_400_000;
  const revoked = adobeRecord({ expiresAt });
  const fresh = adobeRecord({ value: 'e2e-ims-token-0002', expiresAt });
  const seen = await staged(
    page,
    'a 401 on an Adobe',
    async ({ query, fresh }) => {
      const { owner, agent, settings, adobe, seal } = await window.openAdobe(query);
      await window.until(() => settings.models().some((model) => model.id === 'adobe/e2e-1'));
      const before = adobe()?.status;
      agent.setModel(agent.active(), 'adobe/e2e-1');
      await window.until(
        () => agent.list().find((row) => row.id === agent.active())?.model === 'adobe/e2e-1'
      );
      await agent.send(agent.active(), 'Hello.');
      const card = () =>
        agent
          .messages()
          .flatMap((message) => message.parts ?? [])
          .find((part) => part.type === 'error');
      await window.until(() => card());
      await window.until(() => adobe()?.status === 'expired');
      await seal({
        kind: 'model',
        name: 'AWS_BEARER_TOKEN_BEDROCK',
        provider: 'amazon-bedrock',
        placeholder: 'fnox_proxy_bedrock',
        value: 'e2e-bedrock-key-0001',
      });
      const bedrock = () =>
        settings.accounts().find((account) => account.id === 'amazon-bedrock')?.status;
      await window.until(() => bedrock() === 'connected');
      const refused = { card: card(), status: adobe()?.status, bedrock: bedrock() };
      window.nextSeal = fresh;
      await settings.connect('adobe');
      await window.until(() => adobe()?.status === 'connected');
      const signedIn = adobe()?.status;
      await agent.send(agent.active(), 'Again.');
      const answered = await window.until(() =>
        agent
          .messages()
          .some(
            (m) =>
              m.role === 'assistant' && m.parts?.some((part) => part.text === 'From the model.')
          )
      );
      const result = { before, refused, signedIn, answered };
      await owner.release();
      return result;
    },
    { query: queryOf(revoked, ['bedrock', 'e2e-revoked=e2e-ims-token-0001']), fresh }
  );
  assert.equal(seen.before, 'connected');
  assert.equal(seen.refused.card.action, 'login');
  assert.equal(seen.refused.card.message, 'Your Adobe session has expired.');
  assert.equal(seen.refused.bedrock, 'connected');
  assert.equal(seen.refused.status, 'expired');
  assert.equal(seen.signedIn, 'connected');
  assert.equal(seen.answered, true);
});

test('an MCP token that expires while the page is open turns its account expired, so it offers Reconnect', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const record = {
    kind: 'mcp',
    name: 'DOCS_TOKEN',
    server: 'docs',
    placeholder: 'fnox_proxy_docs',
    value: 'e2e-docs-token-0001',
  };
  const seen = await staged(
    page,
    'an MCP token that expires',
    async ({ query, record }) => {
      await window.write(
        '/home/.pi/agent/mcp.json',
        JSON.stringify({
          mcpServers: {
            docs: {
              url: 'https://mcp.test/mcp',
              headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
            },
          },
        })
      );
      const { owner, settings, seal } = await window.openAdobe(query);
      const docs = () => settings.accounts().find((account) => account.id === 'mcp:docs');
      await window.until(() => docs());
      const expiresAt = Date.now() + 3000;
      await seal({ ...record, expiresAt });
      await window.until(() => docs()?.status === 'expired', 'the expired MCP account');
      const result = { early: Date.now() < expiresAt, after: docs()?.status, auth: docs()?.auth };
      await owner.release();
      return result;
    },
    { query: queryOf(null), record }
  );
  assert.deepEqual(seen, { early: false, after: 'expired', auth: 'api-key' });
});

test('Adobe signs in and answers a turn against a vault that has Adobe built in, and the agent registers no model URL with the vault', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const fresh = adobeRecord({ expiresAt: Date.now() + 86_400_000 });
  const seen = await staged(
    page,
    'Adobe signs in and answers',
    async ({ query, fresh }) => {
      const { owner, agent, settings, adobe, log } = await window.openAdobe(query);
      await window.until(() => adobe());
      window.nextSeal = fresh;
      await settings.connect('adobe');
      await window.until(() => adobe()?.status === 'connected');
      await window.until(() => settings.models().some((model) => model.id === 'adobe/e2e-1'));
      agent.setModel(agent.active(), 'adobe/e2e-1');
      await window.until(
        () => agent.list().find((row) => row.id === agent.active())?.model === 'adobe/e2e-1'
      );
      await agent.send(agent.active(), 'Hello.');
      const answered = await window.until(() =>
        agent
          .messages()
          .some(
            (m) =>
              m.role === 'assistant' && m.parts?.some((part) => part.text === 'From the model.')
          )
      );
      const { upstream, vault } = await log();
      const result = {
        answered,
        authorizations: upstream.map((entry) => entry.authorization).filter(Boolean),
        endpoints: vault.filter((entry) => entry.op === 'endpoints'),
      };
      await owner.release();
      return result;
    },
    { query: queryOf(null), fresh }
  );
  assert.equal(seen.answered, true);
  assert.ok(seen.authorizations.length > 0);
  assert.ok(seen.authorizations.every((value) => value === 'Bearer e2e-ims-token-0001'));
  assert.ok(seen.endpoints.length > 0);
  assert.deepEqual(
    seen.endpoints.filter((entry) => 'model' in entry),
    []
  );
});
