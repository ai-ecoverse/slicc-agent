import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.until = (check, what = 'the sign-in state') => when(window.sources, check, what);
  window.pageLogs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      window.pageLogs.push(
        args
          .map((arg) => {
            if (typeof arg === 'string') return arg;
            if (arg instanceof Error) return `${arg.message} ${arg.stack ?? ''}`;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(' ')
      );
      original(...args);
    };
  }
  window.opens = [];
  window.open = (url, name) => {
    const popup = {
      closed: false,
      location: { href: url },
      close() {
        popup.closed = true;
      },
    };
    window.opens.push({ url, name, popup });
    return popup;
  };
  window.openSignIns = async (query) => {
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
    const post = (message, reply) => {
      const channel = new MessageChannel();
      const done = new Promise((resolve) => {
        channel.port1.onmessage = ({ data }) => resolve(data);
      });
      worker.postMessage({ ...message, [reply]: channel.port2 }, [channel.port2]);
      return done;
    };
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    window.sources = agentSources(connection, model);
    await model.agent.ready();
    const { settings } = model;
    await window.until(() => settings.providers().length > 0, 'the providers');
    const account = (id) => settings.accounts().find((entry) => entry.id === id);
    const signIn = (id) => {
      const before = window.opens.length;
      const done = settings.connect(id, undefined, undefined, { method: 'sign-in' }).then(
        () => null,
        (error) => ({ name: error.name, message: error.message })
      );
      return { done, opened: window.opens.length - before, popup: window.opens.at(-1)?.popup };
    };
    const shown = async (id) => {
      await window.until(() => account(id)?.signIn, `the ${id} sign-in`);
      return account(id);
    };
    const leaks = async () => {
      const worker = await post({}, 'logged');
      const seen = JSON.stringify({
        worker,
        page: window.pageLogs,
        transcript: model.agent.messages(),
        agents: model.agent.list(),
        accounts: settings.accounts(),
        providers: settings.providers(),
        models: settings.models(),
        storage: { ...localStorage },
      });
      return [...new Set(seen.match(/SECRET\d+VALUE/g) ?? [])];
    };
    return {
      owner,
      ...model,
      account,
      signIn,
      shown,
      leaks,
      device: (mode) => post({ device: mode }, 'deviced'),
      revoke: (token) => post({ revoke: token }, 'deviced'),
      killGrant: (name) => post({ killGrant: name }, 'deviced'),
      polls: () => post({}, 'deviced'),
      put: (record) => post({ seal: record }, 'sealed'),
      records: () => post({}, 'vaultRecords'),
      log: () => post({}, 'upstream'),
    };
  };
  window.reply = async (agent, modelId, text) => {
    agent.setModel(agent.active(), modelId);
    await window.until(
      () => agent.list().find((row) => row.id === agent.active())?.model === modelId,
      `the cone on ${modelId}`
    );
    stage(`the answer from ${modelId}`);
    const before = agent.messages().length;
    await agent.send(agent.active(), text);
    const parts = () =>
      agent
        .messages()
        .slice(before)
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.parts ?? []);
    const answer = () =>
      parts().find((part) => (part.type === 'text' && part.text) || part.type === 'error');
    await window.until(answer, `the answer from ${modelId}`);
    const found = answer();
    return found?.type === 'text' ? found.text : `error: ${found?.message}`;
  };
};

const QUERY = 'registry&vault';
const record = (value) => `record=${encodeURIComponent(JSON.stringify(value))}`;

async function opened(t) {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  return page;
}

test('a Kimi sign-in opens its window in the click, shows the code, grants the token to the vault, and a turn uses it by placeholder', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'a Kimi sign-in',
    async (query) => {
      const it = await window.openSignIns(query);
      const listed = Boolean(it.account('kimi-coding'));
      const offered = it.settings.providers().find((option) => option.id === 'kimi-coding');
      const started = it.signIn('kimi-coding');
      const blank = started.popup.location.href;
      const shown = await it.shown('kimi-coding');
      const navigated = started.popup.location.href;
      await it.device('approve');
      const failure = await started.done;
      await window.until(() => it.account('kimi-coding')?.status === 'connected');
      const after = it.account('kimi-coding');
      const kimi = it.settings.models().find((entry) => entry.id.startsWith('kimi-coding/'));
      const reply = await window.reply(it.agent, kimi.id, 'Hello Kimi.');
      const { upstream } = await it.log();
      const records = await it.records();
      const result = {
        listed,
        offered: { auth: offered.auth, keyUrl: Boolean(offered.keyUrl) },
        opened: started.opened,
        blank,
        shown: {
          status: shown.status,
          auth: shown.auth,
          secret: shown.secret,
          signIn: shown.signIn,
        },
        navigated,
        failure,
        closed: started.popup.closed,
        after: {
          status: after.status,
          identity: after.identity,
          signIn: after.signIn ?? null,
        },
        reply,
        sent: upstream.filter((entry) => entry.url?.startsWith('https://api.kimi.com/')).at(-1)
          ?.authorization,
        sealed: records
          .filter((entry) => entry.name.startsWith('KIMI_API_KEY'))
          .map(({ kind, name, provider, source }) =>
            JSON.parse(JSON.stringify({ kind, name, provider, source }))
          ),
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    QUERY
  );
  assert.equal(seen.listed, false);
  assert.deepEqual(seen.offered, { auth: 'oauth', keyUrl: true });
  assert.equal(seen.opened, 1);
  assert.equal(seen.blank, 'about:blank');
  assert.deepEqual(seen.shown, {
    status: 'signing-in',
    auth: 'oauth',
    secret: 'api-key',
    signIn: { url: 'https://www.kimi.com/device?user_code=CODE-0001', code: 'CODE-0001' },
  });
  assert.equal(seen.navigated, 'https://www.kimi.com/device?user_code=CODE-0001');
  assert.equal(seen.failure, null);
  assert.equal(seen.closed, true);
  assert.deepEqual(seen.after, { status: 'connected', identity: 'Signed in', signIn: null });
  assert.equal(seen.reply, 'From api.kimi.com.');
  assert.equal(seen.sent, 'Bearer kimi-coding-access-SECRET1VALUE');
  assert.deepEqual(seen.sealed, [
    { kind: 'model', name: 'KIMI_API_KEY', provider: 'kimi-coding', source: 'oauth:kimi-coding' },
    { kind: 'grant', name: 'KIMI_API_KEY_GRANT' },
  ]);
  assert.deepEqual(seen.leaks, []);
});

test('Cancel ends a waiting sign-in at once, stops its polling, and a new sign-in starts clean', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'a cancelled sign-in',
    async (query) => {
      const it = await window.openSignIns(query);
      const started = it.signIn('kimi-coding');
      await it.shown('kimi-coding');
      while ((await it.polls()).polls === 0)
        await new Promise((resolve) => setTimeout(resolve, 50));
      it.settings.cancel('kimi-coding');
      const failure = await started.done;
      const after = it.account('kimi-coding');
      const { polls } = await it.polls();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const later = (await it.polls()).polls;
      const again = it.signIn('kimi-coding');
      await it.shown('kimi-coding');
      await it.device('approve');
      const second = await again.done;
      const result = {
        failure,
        closed: started.popup.closed,
        after: { status: after.status, signIn: after.signIn ?? null },
        stopped: later === polls,
        second,
        status: it.account('kimi-coding').status,
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    QUERY
  );
  assert.deepEqual(seen.failure, { name: 'AbortError', message: 'The sign-in was cancelled.' });
  assert.equal(seen.closed, true);
  assert.deepEqual(seen.after, { status: 'disconnected', signIn: null });
  assert.equal(seen.stopped, true);
  assert.equal(seen.second, null);
  assert.equal(seen.status, 'connected');
  assert.deepEqual(seen.leaks, []);
});

test('a refused code reads "The sign-in was refused.", and a malformed token answer neither connects nor shows its token anywhere', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'a refused code',
    async (query) => {
      const it = await window.openSignIns(query);
      await it.device('deny');
      const refused = it.signIn('xai');
      const failure = await refused.done;
      const afterRefusal = it.account('xai');
      await it.device('malformed');
      const malformed = it.signIn('kimi-coding');
      const broken = await malformed.done;
      const result = {
        failure,
        xai: { status: afterRefusal.status, signIn: afterRefusal.signIn ?? null },
        broken,
        kimi: it.account('kimi-coding').status,
        records: (await it.records()).map((entry) => entry.name),
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    QUERY
  );
  assert.deepEqual(seen.failure, { name: 'Error', message: 'The sign-in was refused.' });
  assert.deepEqual(seen.xai, { status: 'disconnected', signIn: null });
  assert.deepEqual(seen.broken, {
    name: 'Error',
    message: "The sign-in didn't finish. Try again.",
  });
  assert.equal(seen.kimi, 'disconnected');
  assert.deepEqual(seen.records, []);
  assert.deepEqual(seen.leaks, []);
});

test('a sign-in under a name that holds another provider’s key is refused with EEXIST’s sentence', async (t) => {
  const query = `${QUERY}&${record({
    kind: 'model',
    name: 'KIMI_API_KEY',
    provider: 'moonshotai',
    placeholder: 'fnox_proxy_moonshot',
    value: 'moonshot-key-0001',
  })}`;
  const page = await opened(t);
  const seen = await staged(
    page,
    'a sign-in under a taken name',
    async (given) => {
      const it = await window.openSignIns(given);
      await it.device('approve');
      const started = it.signIn('kimi-coding');
      const failure = await started.done;
      const result = {
        failure,
        kimi: it.account('kimi-coding').status,
        records: (await it.records()).map(({ name, provider }) => ({ name, provider })),
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    query
  );
  assert.deepEqual(seen.failure, {
    name: 'Error',
    message: "This name holds another provider's key.",
  });
  assert.equal(seen.kimi, 'disconnected');
  assert.deepEqual(seen.records, [{ name: 'KIMI_API_KEY', provider: 'moonshotai' }]);
  assert.deepEqual(seen.leaks, []);
});

test('signing in again rotates the token under the same placeholder, and after invalid_grant the account is expired until a new sign-in', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'a second sign-in',
    async (query) => {
      const it = await window.openSignIns(query);
      const placeholder = async () =>
        (await it.records()).find(
          (entry) => entry.kind === 'model' && entry.name === 'KIMI_API_KEY'
        )?.placeholder;
      const sent = async () =>
        (await it.log()).upstream
          .filter((entry) => entry.url?.startsWith('https://api.kimi.com/'))
          .at(-1)?.authorization;
      await it.device('approve');
      const first = it.signIn('kimi-coding');
      await first.done;
      await window.until(() => it.account('kimi-coding')?.status === 'connected');
      const kimi = it.settings.models().find((entry) => entry.id.startsWith('kimi-coding/')).id;
      const one = await placeholder();
      await window.reply(it.agent, kimi, 'First.');
      const firstSent = await sent();
      const second = it.signIn('kimi-coding');
      const rotated = await second.done;
      const two = await placeholder();
      await window.reply(it.agent, kimi, 'Second.');
      const secondSent = await sent();
      await it.revoke('kimi-coding-access-SECRET2VALUE');
      await it.killGrant('KIMI_API_KEY');
      const expiredReply = await window.reply(it.agent, kimi, 'Third.');
      await window.until(() => it.account('kimi-coding')?.status === 'expired');
      const expired = it.account('kimi-coding');
      const third = it.signIn('kimi-coding');
      const renewed = await third.done;
      await window.until(() => it.account('kimi-coding')?.status === 'connected');
      const fourth = await window.reply(it.agent, kimi, 'Fourth.');
      const result = {
        same: one === two && typeof one === 'string',
        firstSent,
        rotated,
        secondSent,
        expiredReply: expiredReply.startsWith('error:'),
        expired: { status: expired.status, auth: expired.auth },
        renewed,
        fourth,
        fourthSent: await sent(),
        models: (await it.records()).filter((entry) => entry.kind === 'model').length,
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    QUERY
  );
  assert.equal(seen.same, true);
  assert.equal(seen.firstSent, 'Bearer kimi-coding-access-SECRET1VALUE');
  assert.equal(seen.rotated, null);
  assert.equal(seen.secondSent, 'Bearer kimi-coding-access-SECRET2VALUE');
  assert.equal(seen.expiredReply, true);
  assert.deepEqual(seen.expired, { status: 'expired', auth: 'oauth' });
  assert.equal(seen.renewed, null);
  assert.equal(seen.fourth, 'From api.kimi.com.');
  assert.equal(seen.fourthSent, 'Bearer kimi-coding-access-SECRET3VALUE');
  assert.equal(seen.models, 1);
  assert.deepEqual(seen.leaks, []);
});

test('xAI keeps API-key entry next to sign-in, and a sign-in over a pasted key keeps its placeholder', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'an xAI sign-in over a key',
    async (query) => {
      const it = await window.openSignIns(query);
      await it.put({
        kind: 'model',
        name: 'XAI_API_KEY',
        provider: 'xai',
        placeholder: 'fnox_proxy_xai_pasted',
        value: 'xai-pasted-key-0001',
        source: 'settings',
      });
      const before = window.opens.length;
      await it.settings.connect('xai', undefined, undefined, { method: 'key' });
      const keyed = { opened: window.opens.length - before, ...it.account('xai') };
      const started = it.signIn('xai');
      const shown = await it.shown('xai');
      await it.device('approve');
      const failure = await started.done;
      await window.until(() => it.account('xai')?.identity === 'Signed in');
      const records = (await it.records()).filter((entry) => entry.name.startsWith('XAI_API_KEY'));
      const result = {
        keyed: { opened: keyed.opened, status: keyed.status, identity: keyed.identity },
        shown: shown.signIn,
        failure,
        records: records.map(({ kind, name, placeholder, source }) =>
          JSON.parse(JSON.stringify({ kind, name, placeholder, source }))
        ),
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    QUERY
  );
  assert.deepEqual(seen.keyed, { opened: 0, status: 'connected', identity: 'API key' });
  assert.deepEqual(seen.shown, {
    url: 'https://accounts.x.ai/device?user_code=CODE-0001',
    code: 'CODE-0001',
  });
  assert.equal(seen.failure, null);
  assert.deepEqual(seen.records, [
    {
      kind: 'model',
      name: 'XAI_API_KEY',
      placeholder: 'fnox_proxy_xai_pasted',
      source: 'oauth:xai',
    },
    { kind: 'grant', name: 'XAI_API_KEY_GRANT', placeholder: 'fnox_proxy_xai_grant' },
  ]);
  assert.deepEqual(seen.leaks, []);
});

test('a ChatGPT sign-in seals the account id as a setting, and a turn sends the token and chatgpt-account-id', async (t) => {
  const page = await opened(t);
  const seen = await staged(
    page,
    'a ChatGPT sign-in',
    async (query) => {
      const it = await window.openSignIns(query);
      const offered = it.settings.providers().find((option) => option.id === 'openai-codex');
      const started = it.signIn('openai-codex');
      const shown = await it.shown('openai-codex');
      await it.device('approve');
      const failure = await started.done;
      await window.until(() => it.account('openai-codex')?.status === 'connected');
      const reply = await window.reply(it.agent, 'openai-codex/gpt-5.5', 'Hello ChatGPT.');
      const turn = (await it.log()).upstream.find((entry) =>
        entry.url?.startsWith('https://chatgpt.com/')
      );
      const sealed = (await it.records()).find((entry) => entry.name === offered.vaultName);
      const result = {
        offered: { name: offered.name, auth: offered.auth, keyUrl: offered.keyUrl ?? null },
        secret: shown.secret ?? null,
        shown: shown.signIn,
        failure,
        reply,
        account: turn?.account,
        authorization: turn?.authorization?.replace(/^(Bearer e2e\.)[^.]+\./, '$1….'),
        settings: sealed?.settings,
        leaks: await it.leaks(),
      };
      await it.owner.release();
      return result;
    },
    QUERY
  );
  assert.deepEqual(seen.offered, { name: 'ChatGPT', auth: 'oauth', keyUrl: null });
  assert.equal(seen.secret, null);
  assert.deepEqual(seen.shown, { url: 'https://auth.openai.com/codex/device', code: 'CODE-0001' });
  assert.equal(seen.failure, null);
  assert.equal(seen.reply, 'From chatgpt.com.');
  assert.equal(seen.account, 'acct-e2e-0001');
  assert.equal(seen.authorization, 'Bearer e2e.….SECRET1VALUE');
  assert.deepEqual(seen.settings, { CHATGPT_ACCOUNT_ID: 'acct-e2e-0001' });
  assert.deepEqual(seen.leaks, []);
});

test('Settings shows an xAI sign-in’s code and its page link while the account is signing in', async (t) => {
  const page = await opened(t);
  const seen = await page.evaluate(async (query) => {
    await import('/node_modules/@ai-ecoverse/slicc-spectrum/dist/slicc-ui.js');
    const it = await window.openSignIns(query);
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
    const settings = document.createElement('slicc-settings');
    settings.model = it;
    document.body.append(settings);
    const started = it.signIn('xai');
    const account = await it.shown('xai');
    const details = () => find(settings.shadowRoot, '[data-sign-in]');
    await window.until(details);
    const block = details();
    const result = {
      status: account.status,
      code: block?.querySelector('[data-id="sign-in-code"]')?.textContent.trim() ?? null,
      links: [...(block?.querySelectorAll('a[data-action="open-sign-in"]') ?? [])].map(
        (link) => link.href
      ),
    };
    await it.device('approve');
    result.failure = await started.done;
    await it.owner.release();
    return result;
  }, QUERY);
  assert.equal(seen.status, 'signing-in');
  assert.equal(seen.code, 'CODE-0001');
  assert.deepEqual(seen.links, ['https://accounts.x.ai/device?user_code=CODE-0001']);
  assert.equal(seen.failure, null);
});
