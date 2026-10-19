import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('Settings shows Bedrock’s region as a picker of its regions, on the region the account stored', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const until = async (check, tries = 500) => {
      for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
      return check();
    };
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          const inner = find(node.shadowRoot, selector);
          if (inner) return inner;
        }
      return null;
    };
    await import('/node_modules/@ai-ecoverse/slicc-spectrum/dist/slicc-ui.js');
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js?bedrock&vault', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const model = createAgentModel(await owner.connect(), { storage: localStorage });
    await model.agent.ready();
    const bedrock = () =>
      model.settings.accounts().find((account) => account.id === 'amazon-bedrock');
    await until(() => bedrock());
    await model.settings.connect('amazon-bedrock', undefined, { region: 'eu-central-1' });
    await until(() => bedrock()?.fields?.[0]?.value === 'eu-central-1');
    const settings = document.createElement('slicc-settings');
    settings.model = model;
    document.body.append(settings);
    await until(() =>
      find(settings.shadowRoot, '.account[data-id="amazon-bedrock"] [data-action="connect"]')
    );
    find(settings.shadowRoot, '.account[data-id="amazon-bedrock"] [data-action="connect"]').click();
    await until(() => find(settings.shadowRoot, 'sp-picker[data-account-field="region"]'));
    const picker = find(settings.shadowRoot, 'sp-picker[data-account-field="region"]');
    await picker.updateComplete;
    const items = [...picker.querySelectorAll('sp-menu-item')].map((item) => [
      item.value,
      item.textContent.trim(),
    ]);
    const result = { value: picker.value, items, stored: bedrock().fields[0].value };
    await owner.release();
    return result;
  });
  assert.equal(seen.stored, 'eu-central-1');
  assert.equal(seen.value, 'eu-central-1');
  assert.equal(seen.items.length, 21);
  assert.deepEqual(
    seen.items.find(([value]) => value === 'eu-central-1'),
    ['eu-central-1', 'Europe (Frankfurt), eu-central-1']
  );
  assert.ok(seen.items.some(([value]) => value === 'us-west-2'));
});

test('in Settings a blocked provider is shown in the picker but can’t be picked, and becomes pickable when a CORS-free route appears', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const until = async (check, tries = 500) => {
      for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
      return check();
    };
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          const inner = find(node.shadowRoot, selector);
          if (inner) return inner;
        }
      return null;
    };
    await import('/node_modules/@ai-ecoverse/slicc-spectrum/dist/slicc-ui.js');
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let worker;
    const owner = await startAgent({
      worker: () =>
        (worker = new Worker('/dist-test/main-worker.js?registry&vault&route=cors', {
          type: 'module',
        })),
      kernel: { connect: () => kernel.connect() },
    });
    const model = createAgentModel(await owner.connect(), { storage: localStorage });
    await model.agent.ready();
    await until(() => model.settings.providers().some((option) => option.id === 'nvidia'));
    const settings = document.createElement('slicc-settings');
    settings.model = model;
    document.body.append(settings);
    const root = () => settings.shadowRoot;
    await until(() => find(root(), '[data-action="add-provider"]'));
    find(root(), '[data-action="add-provider"]').click();
    const option = (id) => find(root(), `[role="option"][data-provider="${id}"]`);
    await until(() => option('nvidia') && option('groq'));
    const state = (id) => ({
      disabled: option(id).getAttribute('aria-disabled'),
      blocked: option(id).hasAttribute('data-blocked'),
      text: option(id).textContent.replace(/\s+/g, ' ').trim(),
    });
    const before = { nvidia: state('nvidia'), groq: state('groq') };
    const channel = new MessageChannel();
    const routed = new Promise((resolve) => {
      channel.port1.onmessage = () => resolve();
    });
    worker.postMessage({ traits: { crossOrigin: 'any' }, routed: channel.port2 }, [channel.port2]);
    await routed;
    await until(() => option('nvidia') && !option('nvidia').hasAttribute('data-blocked'));
    const after = state('nvidia');
    await owner.release();
    return { before, after };
  });
  assert.equal(seen.before.nvidia.disabled, 'true');
  assert.equal(seen.before.nvidia.blocked, true);
  assert.match(seen.before.nvidia.text, /Needs the SLICC extension or CLI/);
  assert.equal(seen.before.groq.disabled, 'false');
  assert.equal(seen.before.groq.blocked, false);
  assert.doesNotMatch(seen.before.groq.text, /Needs the SLICC extension or CLI/);
  assert.equal(seen.after.disabled, 'false');
  assert.equal(seen.after.blocked, false);
  assert.doesNotMatch(seen.after.text, /Needs the SLICC extension or CLI/);
});

test('an MCP token account carries its server URL, and Settings says it moved once mcp.json points the server elsewhere', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const record = {
    kind: 'mcp',
    name: 'DOCS_TOKEN',
    server: 'docs',
    placeholder: 'fnox_proxy_docs',
    value: 'docs-token-0001',
  };
  const seen = await page.evaluate(async (record) => {
    const until = async (check, tries = 1000) => {
      for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
      return check();
    };
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          const inner = find(node.shadowRoot, selector);
          if (inner) return inner;
        }
      return null;
    };
    const write = async (path, text) => {
      let dir = await navigator.storage.getDirectory();
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    };
    const config = (url) =>
      JSON.stringify({
        mcpServers: { docs: { url, headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } } },
      });
    await write('/home/.pi/agent/mcp.json', config('https://mcp.test/mcp'));
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const query = `relay=mcp.test&vault&record=${encodeURIComponent(JSON.stringify(record))}`;
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const model = createAgentModel(await owner.connect(), { storage: localStorage });
    await model.agent.ready();
    model.vault = createDummyModel({ storage: localStorage, vault: 'empty' }).vault;
    localStorage.setItem(
      'slicc-spectrum.mcp-endpoints',
      JSON.stringify({ docs: 'https://mcp.test/mcp' })
    );
    const docs = () => model.settings.accounts().find((account) => account.id === 'mcp:docs');
    await until(() => docs()?.status === 'connected' && docs()?.url);
    const settings = document.createElement('slicc-settings');
    settings.model = model;
    document.body.append(settings);
    const row = () => find(settings.shadowRoot, '.account[data-id="mcp:docs"]');
    await until(() => row());
    const moved = () => find(settings.shadowRoot, '[data-notice="moved"]');
    const before = { url: docs().url, moved: Boolean(moved()) };
    await write('/home/.pi/agent/mcp.json', config('https://mcp.test/v2/mcp'));
    await until(() => docs()?.url === 'https://mcp.test/v2/mcp' && docs()?.status === 'connected');
    await until(() => moved());
    const note = moved()?.textContent.replace(/\s+/g, ' ').trim();
    const reconnect = Boolean(row()?.querySelector('[data-action="reconnect-mcp"]'));
    await owner.release();
    return { before, after: docs().url, note, reconnect };
  }, record);
  assert.deepEqual(seen.before, { url: 'https://mcp.test/mcp', moved: false });
  assert.equal(seen.after, 'https://mcp.test/v2/mcp');
  assert.equal(
    seen.note,
    'The server moved to https://mcp.test/v2/mcp. Reconnect to send the token there.'
  );
  assert.equal(seen.reconnect, true);
});

test('adding a Cloudflare or Azure provider in Settings saves its tenant fields as the vault record’s settings', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const until = async (check, tries = 500) => {
      for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
      return check();
    };
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          const inner = find(node.shadowRoot, selector);
          if (inner) return inner;
        }
      return null;
    };
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js?registry&vault', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const model = createAgentModel(await owner.connect(), { storage: localStorage });
    await model.agent.ready();
    const vault = createDummyModel({ storage: localStorage, vault: 'empty' }).vault;
    model.vault = vault;
    await until(() =>
      model.settings.providers().some((option) => option.id === 'cloudflare-workers-ai')
    );
    const settings = document.createElement('slicc-settings');
    settings.model = model;
    document.body.append(settings);
    const root = () => settings.shadowRoot;
    const type = (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    };
    const add = async (id, values) => {
      await until(() => find(root(), '[data-action="add-provider"]'));
      find(root(), '[data-action="add-provider"]').click();
      await until(() => find(root(), `[role="option"][data-provider="${id}"]`));
      find(root(), `[role="option"][data-provider="${id}"]`).click();
      const form = () => find(root(), `form[data-id="${id}"]`);
      await until(() => form()?.querySelector('input[data-field="value"]'));
      type(form().querySelector('input[data-field="value"]'), values.key);
      for (const [name, value] of Object.entries(values.fields))
        type(form().querySelector(`[data-account-field="${name}"]`), value);
      form().requestSubmit();
      await until(() => vault.puts.some((put) => put.options?.provider === id));
      await until(() => model.settings.accounts().some((account) => account.id === id));
      return vault.puts.find((put) => put.options?.provider === id);
    };
    const cloudflare = await add('cloudflare-workers-ai', {
      key: 'cf-token-key-0001',
      fields: { account: '0123456789abcdef0123456789abcdef' },
    });
    const azure = await add('azure', {
      key: 'azure-key-00000001',
      fields: { endpoint: 'my-resource' },
    });
    const stored = (id) =>
      model.settings
        .accounts()
        .find((account) => account.id === id)
        .fields.map((field) => [field.name, field.value ?? null]);
    const result = {
      cloudflare,
      azure,
      cloudflareFields: stored('cloudflare-workers-ai'),
      azureFields: stored('azure'),
    };
    await owner.release();
    return result;
  });
  assert.equal(seen.cloudflare.name, 'CLOUDFLARE_WORKERS_AI_API_KEY');
  assert.deepEqual(seen.cloudflare.options, {
    kind: 'model',
    provider: 'cloudflare-workers-ai',
    settings: { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' },
  });
  assert.deepEqual(seen.cloudflareFields, [['account', '0123456789abcdef0123456789abcdef']]);
  assert.equal(seen.azure.name, 'AZURE_OPENAI_API_KEY');
  assert.deepEqual(seen.azure.options, {
    kind: 'model',
    provider: 'azure',
    settings: { AZURE_OPENAI_RESOURCE_NAME: 'my-resource' },
  });
  assert.deepEqual(seen.azureFields, [
    ['endpoint', 'my-resource'],
    ['deployments', null],
  ]);
});
