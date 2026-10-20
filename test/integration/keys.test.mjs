import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const LEGACY = 'slicc-agent-credentials';
const BEDROCK_MODEL = 'amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SEALED = 'sealed-dummy-bytes-0001';

const helpers = () => {
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
  window.deep = (selector) => find(document, selector);
  window.seedLegacy = async (name, keys, sealed) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('keys');
      opening.result.createObjectStore('credentials');
    };
    const db = await new Promise((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const tx = db.transaction(['keys', 'credentials'], 'readwrite');
    tx.objectStore('keys').put(key, 'aes');
    for (const id of keys) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(sealed)
      );
      db.transaction('credentials', 'readwrite').objectStore('credentials').put({ iv, data }, id);
    }
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
    });
    db.close();
  };
  window.bootAgent = async (query, width) => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    const kernel = await bootKernel();
    stage('the agent');
    let worker;
    const owner = await startAgent({
      worker: () => (worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, {
      storage: localStorage,
      ...(window.hostNotices ? { notices: window.hostNotices } : {}),
    });
    const app = document.createElement('slicc-app');
    app.style.cssText = `display:block;width:${width}px;height:800px`;
    document.body.style.margin = '0';
    document.body.append(app);
    const dummy = createDummyModel({ storage: localStorage });
    delete dummy.notices;
    delete dummy.tabs;
    delete dummy.approvals;
    app.model = { ...dummy, ...model };
    await customElements.whenDefined('slicc-app');
    await model.agent.ready();
    const vaultLog = async () => {
      const channel = new MessageChannel();
      const answer = new Promise((resolve) => {
        channel.port1.onmessage = ({ data }) => resolve(data.vault);
      });
      worker.postMessage({ upstream: channel.port2 }, [channel.port2]);
      return answer;
    };
    window.keysTest = { owner, connection, model, vaultLog };
  };
  window.noticeText = () => {
    const notice = window.deep('slicc-notices')?.shadowRoot?.querySelector('[data-notice]');
    return notice ? notice.textContent.replace(/\s+/g, ' ').trim() : null;
  };
};

async function viewport(page, width) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
}

async function shoot(page, name, width) {
  if (!env.KEYS_SHOTS) return;
  await mkdir(env.KEYS_SHOTS, { recursive: true });
  await viewport(page, width);
  await page.evaluate((width) => {
    const app = document.querySelector('slicc-app');
    app.style.width = `${width}px`;
  }, width);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot(`${env.KEYS_SHOTS}/${name}-${width}.png`);
}

const QUERY = 'relay=mcp.test&e2e&bedrock&vault&persist=/.slicc/keys-wipe';

async function boot(page, width = 1280) {
  await viewport(page, width);
  await page.goto('/');
  await page.evaluate(helpers);
}

async function start(page, width = 1280, query = QUERY) {
  await staged(page, 'the keys agent', ({ query, width }) => window.bootAgent(query, width), {
    query,
    width,
  });
}

async function release(page) {
  await page.evaluate(() => window.keysTest.owner.release());
}

test('a 3.x credential store is wiped at the 4.x start, with one dismissible notice that names its accounts', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate(
    ({ name, sealed }) =>
      window.seedLegacy(name, ['adobe', 'amazon-bedrock', 'mcp:github|0a1b2c3d'], sealed),
    { name: LEGACY, sealed: SEALED }
  );
  await start(page);
  const text = await page.until(() => window.noticeText());
  assert.match(text, /Your keys moved to seven's vault\./);
  assert.match(
    text,
    /Add them again in Settings › Accounts: Adobe, Bedrock, and the MCP server github\./
  );
  assert.ok(!text.includes(SEALED));
  const databases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((database) => database.name)
  );
  assert.ok(!databases.includes(LEGACY));
  const ops = await page.evaluate(async () =>
    (await window.keysTest.vaultLog()).map((message) => message.op)
  );
  assert.ok(ops.includes('records'));
  assert.deepEqual(
    ops.filter(
      (op) =>
        ![
          'records',
          'endpoints',
          'redact',
          'redactStream',
          'push',
          'end',
          'drop',
          'model',
        ].includes(op)
    ),
    []
  );
  const accounts = await page.evaluate(() =>
    window.keysTest.model.settings
      .accounts()
      .filter((account) => ['adobe', 'amazon-bedrock'].includes(account.id))
      .map((account) => ({ id: account.id, status: account.status }))
  );
  assert.deepEqual(
    accounts.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'adobe', status: 'disconnected' },
      { id: 'amazon-bedrock', status: 'disconnected' },
    ]
  );
  await shoot(page, 'notice', 1280);
  await shoot(page, 'notice', 420);
  await viewport(page, 1280);

  for (const [model, name] of [
    [BEDROCK_MODEL, 'Bedrock'],
    ['adobe/e2e-1', 'Adobe'],
  ]) {
    const error = await staged(
      page,
      `a turn on ${name}`,
      async ({ model }) => {
        const { connection, model: adapter } = window.keysTest;
        const { agent } = adapter;
        const until = (check, what) => when(agentSources(connection, adapter), check, what);
        agent.setModel(agent.active(), model);
        await until(
          () => agent.list().find((row) => row.id === agent.active())?.model === model,
          `the cone on ${model}`
        );
        const before = agent.messages().length;
        await agent.send(agent.active(), 'Hello there.');
        const found = await until(
          () =>
            agent
              .messages()
              .slice(before)
              .flatMap((message) =>
                message.role === 'system' && message.kind === 'error'
                  ? [
                      {
                        type: 'error',
                        message: message.title,
                        detail: message.text,
                        action: message.action,
                      },
                    ]
                  : (message.parts ?? [])
              )
              .find((part) => part.type === 'error'),
          'the error'
        );
        return found;
      },
      { model }
    );
    assert.equal(error?.message, `${name} isn't connected.`, JSON.stringify(error));
    assert.equal(error.action, 'settings');
    assert.equal(error.detail, 'Connect it in Settings › Accounts.');
    assert.doesNotMatch(JSON.stringify(error), /expired|rejected/);
  }
  await page.until(() => {
    const card = window.deep('slicc-chat')?.shadowRoot?.querySelectorAll('.error-card');
    return card && [...card].some((node) => node.textContent.includes("Adobe isn't connected."));
  });
  const header = await page.evaluate(() => window.deep('slicc-chat').shadowRoot.textContent);
  assert.match(header, /Claude Haiku 4\.5 \(US\) on Bedrock/);
  assert.doesNotMatch(header, /amazon-bedrock\/us\.anthropic/);
  await shoot(page, 'not-connected', 1280);
  await shoot(page, 'not-connected', 420);
  await release(page);

  await boot(page);
  await start(page);
  assert.match(
    await page.until(() => window.noticeText()),
    /Adobe, Bedrock, and the MCP server github/
  );
  await page.evaluate(() =>
    window.deep('slicc-notices').shadowRoot.querySelector('[data-dismiss]').click()
  );
  await page.until(() => window.noticeText() === null);
  await page.until(() => {
    const value = window.keysTest.connection.settings.state.value;
    return value && !('moved' in value);
  });
  await release(page);

  await boot(page);
  await start(page);
  const shown = await page.evaluate(async () => {
    const { model, connection } = window.keysTest;
    await new Promise((r) => setTimeout(r, 1500));
    return {
      notices: model.notices.list().length,
      text: window.noticeText(),
      moved: 'moved' in connection.settings.state.value,
    };
  });
  assert.deepEqual(shown, { notices: 0, text: null, moved: false });
  await release(page);
});

test('while an open 3.x tab blocks the wipe there is no notice, and it shows once the tab lets go and the store is gone', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate(
    async ({ name, sealed }) => {
      await window.seedLegacy(name, ['amazon-bedrock'], sealed);
      window.oldTab = await new Promise((resolve, reject) => {
        const opening = indexedDB.open(name);
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
    },
    { name: LEGACY, sealed: SEALED }
  );
  await start(page, 1280, 'vault&bedrock&persist=/.slicc/keys-blocked');
  const blocked = await page.evaluate(async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return {
      notice: window.noticeText(),
      present: (await indexedDB.databases()).some((database) => database.name === name),
    };
  }, LEGACY);
  assert.deepEqual(blocked, { notice: null, present: true });
  await page.evaluate(() => window.oldTab.close());
  const text = await page.until(() => window.noticeText());
  assert.match(text, /Add them again in Settings › Accounts: Bedrock\./);
  const gone = await page.evaluate(
    async (name) => !(await indexedDB.databases()).some((database) => database.name === name),
    LEGACY
  );
  assert.equal(gone, true);
  await release(page);
});

test("bios's own notices and the agent's keys-moved notice show together, and each dismissal reaches its owner", async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  await page.evaluate(
    ({ name, sealed }) => {
      const listeners = new Set();
      const bios = {
        dismissed: [],
        shown: [
          {
            id: 'bios-update',
            tone: 'info',
            title: 'A new SLICC is ready.',
            body: 'Reload to update.',
            actions: [],
          },
          {
            id: 'bios-offline',
            tone: 'warning',
            title: 'You are offline.',
            body: 'Some tools are unavailable.',
            actions: [],
            dismissible: false,
          },
        ],
        list: () => bios.shown,
        act: async () => {},
        dismiss(id) {
          bios.dismissed.push(id);
          bios.shown = bios.shown.filter((notice) => notice.id !== id);
          for (const listener of listeners) listener(bios.shown);
        },
        on(type, listener) {
          if (type !== 'notices') return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      window.hostNotices = bios;
      return window.seedLegacy(name, ['adobe'], sealed);
    },
    { name: LEGACY, sealed: SEALED }
  );
  await start(page);
  const ids = () =>
    [...(window.deep('slicc-notices')?.shadowRoot?.querySelectorAll('[data-notice]') ?? [])].map(
      (node) => ({
        id: node.dataset.notice,
        closable: Boolean(node.querySelector('[data-dismiss]')),
      })
    );
  await page.until(
    () => window.deep('slicc-notices')?.shadowRoot?.querySelectorAll('[data-notice]').length === 3
  );
  assert.deepEqual(await page.evaluate(ids), [
    { id: 'bios-update', closable: true },
    { id: 'bios-offline', closable: false },
    { id: 'keys-moved', closable: true },
  ]);
  const dismiss = (id) =>
    page.evaluate(
      (id) =>
        window
          .deep('slicc-notices')
          .shadowRoot.querySelector(`[data-notice="${id}"] [data-dismiss]`)
          .click(),
      id
    );
  await dismiss('bios-update');
  await page.until(
    () => window.deep('slicc-notices').shadowRoot.querySelectorAll('[data-notice]').length === 2
  );
  assert.deepEqual(await page.evaluate(() => window.hostNotices.dismissed), ['bios-update']);
  await dismiss('keys-moved');
  await page.until(() => {
    const value = window.keysTest.connection.settings.state.value;
    return value && !('moved' in value);
  });
  const left = await page.evaluate(() => {
    window.keysTest.model.notices.dismiss('bios-offline');
    return {
      dismissed: window.hostNotices.dismissed,
      listed: window.keysTest.model.notices.list().map((notice) => notice.id),
    };
  });
  assert.deepEqual(left, { dismissed: ['bios-update'], listed: ['bios-offline'] });
  await page.until(
    () => window.deep('slicc-notices').shadowRoot.querySelectorAll('[data-notice]').length === 1
  );
  assert.deepEqual(await page.evaluate(ids), [{ id: 'bios-offline', closable: false }]);
  await release(page);
});
