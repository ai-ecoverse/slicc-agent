import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const views = [
  { name: 'light-1280', width: 1280, height: 860 },
  { name: 'light-420', width: 420, height: 860 },
];

const adobeRecord = (more = {}) => ({
  kind: 'model',
  name: 'ADOBE_IMS_TOKEN',
  provider: 'adobe',
  placeholder: 'fnox_proxy_adobe',
  value: 'e2e-ims-token-0001',
  expiresAt: Date.now() + 86_400_000,
  ...more,
});

const helpers = () => {
  window.until = async (check, tries = 500) => {
    for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
    return check();
  };
  window.find = (root, selector) => {
    const found = [...root.querySelectorAll(selector)];
    for (const node of root.querySelectorAll('*'))
      if (node.shadowRoot) found.push(...window.find(node.shadowRoot, selector));
    return found;
  };
  window.opens = [];
  window.open = (url, name) => {
    const popup = {
      closed: false,
      location: { href: url },
      close() {
        popup.closed = true;
      },
    };
    window.opens.push({ url, name, gesture: navigator.userActivation.isActive, popup });
    return popup;
  };
  window.boot = async (query, entry = 'main-worker') => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let worker;
    const owner = await startAgent({
      worker: () => (worker = new Worker(`/dist-test/${entry}.js?${query}`, { type: 'module' })),
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
    const login = (_providerId, signIn, { signal }) => {
      const popup = window.open('about:blank', 'slicc-sign-in');
      return signIn().then(
        () =>
          new Promise((resolve, reject) => {
            const timer = setInterval(() => {
              if (!popup.closed) return;
              clearInterval(timer);
              reject(new Error('the sign-in window was closed before it finished'));
            }, 20);
            signal.addEventListener('abort', () => {
              clearInterval(timer);
              window.aborts = (window.aborts ?? 0) + 1;
              reject(signal.reason);
            });
            window.finishLogin = async (record) => {
              clearInterval(timer);
              await seal(record);
              resolve({ sealed: true });
            };
          })
      );
    };
    const model = createAgentModel(await owner.connect(), { storage: localStorage, login });
    const app = document.createElement('slicc-app');
    app.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.style.margin = '0';
    document.body.append(app);
    app.model = { ...createDummyModel({ storage: localStorage }), ...model };
    await customElements.whenDefined('slicc-app');
    await model.agent.ready();
    const errorPart = () =>
      model.agent
        .messages()
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === 'error');
    const card = () => window.find(document, '.error-card')[0];
    window.loginTest = { owner, model, seal, errorPart, card };
    return window.loginTest;
  };
  window.adobeTurn = async () => {
    const { model, errorPart, card } = window.loginTest;
    const { agent, settings } = model;
    await window.until(() => settings.models().some((item) => item.id === 'adobe/e2e-1'));
    agent.setModel(agent.active(), 'adobe/e2e-1');
    await window.until(
      () => agent.list().find((row) => row.id === agent.active())?.model === 'adobe/e2e-1'
    );
    await agent.send(agent.active(), 'Hello.');
    await window.until(() => errorPart() && card()?.querySelector('[data-action=login]'));
    await window.until(
      () => settings.accounts().find((account) => account.id === 'adobe')?.status === 'expired'
    );
    return errorPart();
  };
};

const adobeQuery = [
  'relay=mcp.test',
  'e2e',
  'vault',
  `record=${encodeURIComponent(JSON.stringify(adobeRecord()))}`,
  'e2e-revoked=e2e-ims-token-0001',
].join('&');

async function shoot(page, state) {
  if (!env.LOGIN_SHOTS) return;
  for (const view of views) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: view.width,
      height: view.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.evaluate(() => window.loginTest.card().scrollIntoView({ block: 'center' }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.screenshot(`${env.LOGIN_SHOTS}/login-card-${view.name}-${state}.png`);
  }
}

test('the expired-session card names the Adobe account, and its Log in opens the sign-in window inside the click, then reads Signed in', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate((query) => window.boot(query), adobeQuery);
  const part = await page.evaluate(() => window.adobeTurn());
  assert.equal(part.action, 'login');
  assert.equal(part.account, 'adobe');
  assert.equal(part.message, 'Your Adobe session has expired.');
  assert.equal(part.detail, 'Log in again to continue.');
  const expired = await page.evaluate(() =>
    window.loginTest.card().querySelector('.detail').textContent.trim()
  );
  assert.equal(expired, 'Log in again to continue.');
  const clicked = await page.evaluate(() => {
    const before = window.opens.length;
    window.loginTest.card().querySelector('[data-action=login]').click();
    return { opened: window.opens.length - before, name: window.opens.at(-1)?.name };
  });
  assert.deepEqual(clicked, { opened: 1, name: 'slicc-sign-in' });
  const signing = await page.evaluate(async () => {
    const { card, model } = window.loginTest;
    await window.until(() => card().dataset.login === 'signing-in');
    await window.until(() => typeof window.finishLogin === 'function');
    return {
      button: card().querySelector('[data-action=login]').textContent.trim(),
      detail: card().querySelector('.detail').textContent.trim(),
      status: model.settings.accounts().find((account) => account.id === 'adobe').status,
    };
  });
  assert.ok(
    ['Log in again to continue.', 'Continue in the sign-in window that opened.'].includes(
      signing.detail
    ),
    signing.detail
  );
  assert.deepEqual(
    { button: signing.button, status: signing.status },
    { button: 'Signing in…', status: 'signing-in' }
  );
  await shoot(page, 'signing-in');
  const signedIn = await page.evaluate(
    async (record) => {
      const { card, model } = window.loginTest;
      await window.finishLogin(record);
      await window.until(() => card().dataset.login === 'connected');
      return {
        detail: card().querySelector('.detail').textContent.trim(),
        retry: Boolean(card().querySelector('[data-action=retry]')),
        status: model.settings.accounts().find((account) => account.id === 'adobe').status,
      };
    },
    adobeRecord({ value: 'e2e-ims-token-0002', expiresAt: Date.now() + 86_400_000 + 1000 })
  );
  assert.deepEqual(signedIn, {
    detail: 'Signed in. Retry to send it again.',
    retry: true,
    status: 'connected',
  });
  await shoot(page, 'signed-in');
  await page.evaluate(() => window.loginTest.owner.release());
});

test('a sign-in whose window is closed rejects with a sentence, shown on the card, and a real click carries the gesture to window.open', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate((query) => window.boot(query), adobeQuery);
  await page.evaluate(() => window.adobeTurn());
  const box = await page.evaluate(() => {
    const button = window.loginTest.card().querySelector('[data-action=login]');
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, ...box, button: 'left', clickCount: 1 });
  const seen = await page.evaluate(async () => {
    const { card } = window.loginTest;
    await window.until(() => window.opens.length === 1);
    const { gesture, popup } = window.opens[0];
    await window.until(() => card().dataset.login === 'signing-in');
    popup.close();
    await window.until(() => card().querySelector('[data-error=login]'));
    const failed = {
      gesture,
      help: card().querySelector('[data-error=login] sp-help-text').textContent.trim(),
      login: Boolean(card().querySelector('[data-action=login]')),
      settings: Boolean(card().querySelector('[data-error=login] [data-action=settings]')),
    };
    const direct = window.loginTest.model.settings.connect('adobe').then(
      () => null,
      (error) => error.message
    );
    window.opens.at(-1).popup.close();
    failed.rejected = await direct;
    return failed;
  });
  assert.deepEqual(seen, {
    gesture: true,
    help: 'The sign-in window was closed before it finished.',
    login: true,
    settings: true,
    rejected: 'The sign-in window was closed before it finished.',
  });
  await page.evaluate(() => window.loginTest.owner.release());
});

test("a rejected API key's error names its account", async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const record = {
    kind: 'model',
    name: 'AWS_BEARER_TOKEN_BEDROCK',
    provider: 'amazon-bedrock',
    placeholder: 'fnox_proxy_bedrock',
    value: 'dummy-bedrock-key-0000',
  };
  const query = [
    'relay=mcp.test',
    'bedrock',
    'bedrock-refuse',
    'vault',
    `record=${encodeURIComponent(JSON.stringify(record))}`,
  ].join('&');
  await page.evaluate((query) => window.boot(query, 'bedrock-agent-worker'), query);
  const part = await page.evaluate(async () => {
    const { model, errorPart } = window.loginTest;
    const { agent, settings } = model;
    await window.until(() =>
      settings.models().some((item) => item.id.startsWith('amazon-bedrock/') && item.default)
    );
    const bedrock = settings
      .models()
      .find((item) => item.id.startsWith('amazon-bedrock/') && item.default).id;
    agent.setModel(agent.active(), bedrock);
    await window.until(
      () => agent.list().find((row) => row.id === agent.active())?.model === bedrock
    );
    await agent.send(agent.active(), 'Hello.');
    await window.until(() => errorPart());
    return errorPart();
  });
  assert.equal(part.action, 'settings');
  assert.equal(part.account, 'amazon-bedrock');
  assert.equal(part.message, 'Bedrock rejected the API key.');
  await page.evaluate(() => window.loginTest.owner.release());
});

test('Cancel during Signing in aborts the login, the account is expired again, and a new Log in opens a window at once', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate((query) => window.boot(query), adobeQuery);
  await page.evaluate(() => window.adobeTurn());
  const seen = await page.evaluate(async () => {
    const { card, model } = window.loginTest;
    const status = () => model.settings.accounts().find((account) => account.id === 'adobe').status;
    card().querySelector('[data-action=login]').click();
    await window.until(() => card().querySelector('[data-action=cancel-login]'));
    await window.until(() => typeof window.finishLogin === 'function');
    card().querySelector('[data-action=cancel-login]').click();
    await window.until(() => card().dataset.login === 'idle' && status() === 'expired');
    const cancelled = {
      aborts: window.aborts,
      status: status(),
      login: card().dataset.login,
      error: Boolean(card().querySelector('[data-error=login]')),
    };
    const before = window.opens.length;
    card().querySelector('[data-action=login]').click();
    cancelled.reopened = window.opens.length - before;
    await window.until(() => status() === 'signing-in');
    cancelled.again = status();
    model.settings.cancel('adobe');
    return cancelled;
  });
  assert.deepEqual(seen, {
    aborts: 1,
    status: 'expired',
    login: 'idle',
    error: false,
    reopened: 1,
    again: 'signing-in',
  });
  await page.evaluate(() => window.loginTest.owner.release());
});
