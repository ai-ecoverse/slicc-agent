import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

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
  window.until = async (check, tries = 500) => {
    for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
    return check();
  };
  window.openAdobe = async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let worker;
    const owner = await startAgent({
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
    const watch = (status) => {
      const seen = [];
      const timer = setInterval(() => seen.push({ status: status(), at: Date.now() }), 20);
      return { seen, stop: () => clearInterval(timer) };
    };
    const model = createAgentModel(await owner.connect(), { storage: localStorage, login });
    await model.agent.ready();
    const adobe = () => model.settings.accounts().find((account) => account.id === 'adobe');
    return { owner, ...model, adobe, signIns, seal, watch };
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
    const seen = await page.evaluate(
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
  const seen = await page.evaluate(
    async ({ query, record }) => {
      const { owner, adobe, seal, watch } = await window.openAdobe(query);
      const expiresAt = Date.now() + 3000;
      await seal({ ...record, expiresAt });
      const watching = watch(() => adobe()?.status);
      await window.until(() => adobe()?.status === 'expired', 1000);
      watching.stop();
      const expired = watching.seen.find((item) => item.status === 'expired');
      const result = {
        connected: watching.seen.some((item) => item.status === 'connected'),
        early: expired ? expired.at < expiresAt : null,
        after: adobe()?.status,
      };
      await owner.release();
      return result;
    },
    { query: queryOf(null), record: adobeRecord() }
  );
  assert.deepEqual(seen, { connected: true, early: false, after: 'expired' });
});

test('a 401 on an Adobe turn shows Log in, the account offers Sign in, and the next turn after it goes through', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const expiresAt = Date.now() + 86_400_000;
  const revoked = adobeRecord({ expiresAt });
  const fresh = adobeRecord({ value: 'e2e-ims-token-0002', expiresAt });
  const seen = await page.evaluate(
    async ({ query, fresh }) => {
      const { owner, agent, settings, adobe } = await window.openAdobe(query);
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
      const refused = { card: card(), status: adobe()?.status };
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
    { query: queryOf(revoked, ['e2e-revoked=e2e-ims-token-0001']), fresh }
  );
  assert.equal(seen.before, 'connected');
  assert.equal(seen.refused.card.action, 'login');
  assert.equal(seen.refused.card.message, 'Your Adobe session has expired.');
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
  const seen = await page.evaluate(
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
      const { owner, settings, seal, watch } = await window.openAdobe(query);
      const docs = () => settings.accounts().find((account) => account.id === 'mcp:docs');
      await window.until(() => docs());
      const expiresAt = Date.now() + 3000;
      await seal({ ...record, expiresAt });
      const watching = watch(() => docs()?.status);
      await window.until(() => docs()?.status === 'expired', 1000);
      watching.stop();
      const expired = watching.seen.find((item) => item.status === 'expired');
      const result = {
        early: expired ? expired.at < expiresAt : null,
        after: docs()?.status,
        auth: docs()?.auth,
      };
      await owner.release();
      return result;
    },
    { query: queryOf(null), record }
  );
  assert.deepEqual(seen, { early: false, after: 'expired', auth: 'api-key' });
});
