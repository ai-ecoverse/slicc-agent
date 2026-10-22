import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.until = async (check, tries = 500) => {
    for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
    return check();
  };
  window.openRegistry = async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
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
    const model = createAgentModel(await owner.connect(), { storage: localStorage });
    await model.agent.ready();
    return {
      owner,
      ...model,
      route: (traits) => post({ traits }, 'routed'),
      put: (record) => post({ seal: record }, 'sealed'),
      unput: (name) => post({ unseal: name }, 'sealed'),
      log: () => post({}, 'upstream'),
    };
  };
  window.reply = async (agent, modelId, text) => {
    agent.setModel(agent.active(), modelId);
    await window.until(
      () => agent.list().find((row) => row.id === agent.active())?.model === modelId
    );
    const before = agent.messages().length;
    await agent.send(agent.active(), text);
    const answer = () =>
      agent
        .messages()
        .slice(before)
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === 'text' && part.text)?.text;
    await window.until(answer, 1000);
    return answer() ?? JSON.stringify(agent.messages().slice(before));
  };
};

const QUERY = 'registry&vault';

test('an API-key provider is offered, added with its key in the vault, answers a turn with that key, and is removed', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async (query) => {
    const { owner, settings, agent, put, unput, log } = await window.openRegistry(query);
    await window.until(() => settings.providers().length > 0);
    const offered = settings.providers();
    const before = settings.accounts().map((account) => account.id);
    const groq = offered.find((option) => option.id === 'groq');
    const nvidia = offered.find((option) => option.id === 'nvidia');
    const zai = offered.find((option) => option.id === 'zai');
    const zaiCodingCn = offered.find((option) => option.id === 'zai-coding-cn');
    const ids = () => settings.accounts().map((account) => account.id);
    await put({
      kind: 'model',
      name: groq.vaultName,
      provider: 'groq',
      placeholder: 'fnox_proxy_groq',
      value: 'gsk-groq-key-0001',
    });
    await settings.connect('groq');
    await window.until(
      () => settings.accounts().find((account) => account.id === 'groq')?.status === 'connected'
    );
    const added = settings.accounts().find((account) => account.id === 'groq');
    const groqReply = await window.reply(agent, 'groq/openai/gpt-oss-120b', 'Hello Groq.');
    await put({
      kind: 'model',
      name: nvidia.vaultName,
      provider: 'nvidia',
      placeholder: 'fnox_proxy_nvidia',
      value: 'nvapi-key-0001',
    });
    await settings.connect('nvidia');
    await window.until(
      () => settings.accounts().find((account) => account.id === 'nvidia')?.status === 'connected'
    );
    const nvidiaAccount = settings.accounts().find((account) => account.id === 'nvidia');
    const nvidiaReply = await window.reply(
      agent,
      'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
      'Hello NVIDIA.'
    );
    const { upstream, vault } = await log();
    await unput(groq.vaultName);
    settings.disconnect('groq');
    await window.until(
      () => settings.accounts().find((account) => account.id === 'groq')?.status === 'disconnected'
    );
    const disconnected = ids();
    await settings.remove('groq');
    await window.until(() => !ids().includes('groq'));
    const result = {
      before,
      groq,
      nvidia,
      zai,
      zaiCodingCn,
      added,
      nvidiaAccount,
      groqReply,
      nvidiaReply,
      upstream,
      registered: vault
        .filter((entry) => entry.op === 'endpoints')
        .flatMap((entry) => entry.model ?? []),
      disconnected,
      after: ids(),
      stillOffered: settings.providers().some((option) => option.id === 'groq'),
    };
    await owner.release();
    return result;
  }, QUERY);
  assert.ok(!seen.before.includes('groq') && !seen.before.includes('nvidia'));
  assert.ok(seen.before.includes('amazon-bedrock') && seen.before.includes('adobe'));
  assert.equal(seen.groq.auth, 'api-key');
  assert.equal(seen.groq.vaultName, 'GROQ_API_KEY');
  assert.equal(seen.groq.keyUrl, 'https://console.groq.com/keys');
  assert.equal(seen.groq.needs, undefined);
  assert.equal(seen.nvidia.needs, 'cors-free-transport');
  assert.equal(seen.zai.needs, 'cors-free-transport');
  assert.equal(seen.zaiCodingCn.needs, 'cors-free-transport');
  assert.equal(seen.added.store, 'vault');
  assert.equal(seen.added.vaultName, 'GROQ_API_KEY');
  assert.equal(seen.nvidiaAccount.needs, 'cors-free-transport');
  assert.equal(seen.groqReply, 'From api.groq.com.');
  assert.equal(seen.nvidiaReply, 'From integrate.api.nvidia.com.');
  const sent = (host) => seen.upstream.filter((entry) => new URL(entry.url).host === host);
  assert.ok(sent('api.groq.com').length > 0);
  assert.ok(
    sent('api.groq.com').every((entry) => entry.authorization === 'Bearer gsk-groq-key-0001')
  );
  assert.ok(
    sent('integrate.api.nvidia.com').every(
      (entry) => entry.authorization === 'Bearer nvapi-key-0001'
    )
  );
  for (const entry of sent('integrate.api.nvidia.com'))
    assert.deepEqual(entry.attribution, { 'x-billing-invoke-origin': 'SLICC' });
  for (const entry of sent('api.groq.com')) assert.deepEqual(entry.attribution, {});
  assert.deepEqual(
    seen.registered.filter((entry) => typeof entry === 'object' && entry.provider !== 'adobe'),
    []
  );
  assert.ok(seen.disconnected.includes('groq'));
  assert.ok(!seen.after.includes('groq'));
  assert.ok(seen.after.includes('nvidia'));
  assert.equal(seen.stillOffered, true);
});

test('a fields provider is added with its non-secret fields, refuses a bad one in connect, and sends its key to the URL they make', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const account = '0123456789abcdef0123456789abcdef';
  const seen = await page.evaluate(
    async ({ query, account }) => {
      const { owner, settings, agent, put, unput, log } = await window.openRegistry(query);
      await window.until(() => settings.providers().length > 0);
      const option = settings.providers().find((entry) => entry.id === 'cloudflare-workers-ai');
      const bedrock = settings.providers().find((entry) => entry.id === 'amazon-bedrock');
      const gateway = settings.providers().find((entry) => entry.id === 'cloudflare-ai-gateway');
      const azure = settings.providers().find((entry) => entry.id === 'azure');
      await put({
        kind: 'model',
        name: option.vaultName,
        provider: option.id,
        placeholder: 'fnox_proxy_cf',
        value: 'cf-token-key-0001',
      });
      const refused = await settings.connect(option.id, undefined, { account: 'nope' }).then(
        () => null,
        (error) => error.message
      );
      const empty = await settings.connect(option.id, undefined, {}).then(
        () => null,
        (error) => error.message
      );
      await window.until(() => settings.accounts().some((entry) => entry.id === option.id));
      const pending = {
        status: settings.accounts().find((entry) => entry.id === option.id)?.status,
        models: settings.models().filter((entry) => entry.id.startsWith(`${option.id}/`)).length,
      };
      const row = () => settings.accounts().find((entry) => entry.id === option.id);
      settings.disconnect(option.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const kept = row()?.status;
      await unput(option.vaultName);
      await settings.remove(option.id);
      await window.until(() => !row());
      const cleaned = row() === undefined;
      await put({
        kind: 'model',
        name: option.vaultName,
        provider: option.id,
        placeholder: 'fnox_proxy_cf',
        value: 'cf-token-key-0001',
      });
      await settings.connect(option.id, undefined, { account });
      await window.until(
        () => settings.accounts().find((entry) => entry.id === option.id)?.status === 'connected'
      );
      const added = settings.accounts().find((entry) => entry.id === option.id);
      const reply = await window.reply(
        agent,
        'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6',
        'Hello Cloudflare.'
      );
      const { upstream } = await log();
      const result = {
        option,
        bedrock,
        gateway,
        azure,
        refused,
        empty,
        pending,
        kept,
        cleaned,
        added,
        reply,
        upstream,
      };
      await owner.release();
      return result;
    },
    { query: QUERY, account }
  );
  assert.equal(seen.option.auth, 'fields');
  assert.equal(seen.option.needs, 'cors-free-transport');
  assert.equal(seen.option.vaultName, 'CLOUDFLARE_WORKERS_AI_API_KEY');
  assert.deepEqual(
    seen.option.fields.map((field) => [field.name, field.required]),
    [['account', true]]
  );
  assert.equal(seen.bedrock.auth, 'fields');
  assert.deepEqual(
    seen.bedrock.fields.map((field) => field.name),
    ['region']
  );
  assert.equal(seen.refused, 'A Cloudflare account ID is 32 characters of 0–9 and a–f.');
  assert.equal(seen.empty, 'Account ID can’t be empty.');
  assert.deepEqual(seen.pending, { status: 'disconnected', models: 0 });
  assert.equal(seen.kept, 'disconnected');
  assert.equal(seen.cleaned, true);
  assert.deepEqual(
    seen.added.fields.map((field) => [field.name, field.value, field.vaultSetting]),
    [['account', account, 'CLOUDFLARE_ACCOUNT_ID']]
  );
  assert.deepEqual(
    seen.option.fields.map((field) => field.vaultSetting),
    ['CLOUDFLARE_ACCOUNT_ID']
  );
  assert.deepEqual(
    seen.gateway.fields.map((field) => [field.name, field.vaultSetting]),
    [
      ['account', 'CLOUDFLARE_ACCOUNT_ID'],
      ['gateway', 'CLOUDFLARE_GATEWAY_ID'],
    ]
  );
  assert.deepEqual(
    seen.azure.fields.map((field) => [
      field.name,
      field.vaultSetting ?? null,
      field.customBase ?? null,
    ]),
    [
      ['endpoint', 'AZURE_OPENAI_RESOURCE_NAME', true],
      ['deployments', null, null],
    ]
  );
  assert.equal(seen.bedrock.fields[0].value, 'us-west-2');
  assert.ok(
    seen.bedrock.fields[0].options.some(
      (option) =>
        option.value === 'eu-central-1' && option.label === 'Europe (Frankfurt), eu-central-1'
    )
  );
  assert.equal(seen.reply, 'From api.cloudflare.com.');
  const sent = seen.upstream.filter((entry) => new URL(entry.url).host === 'api.cloudflare.com');
  assert.ok(sent.length > 0);
  for (const entry of sent) {
    assert.equal(
      new URL(entry.url).pathname,
      `/client/v4/accounts/${account}/ai/v1/chat/completions`
    );
    assert.equal(entry.authorization, 'Bearer cf-token-key-0001');
  }
});

test('a provider that refuses the SDK’s telemetry headers is offered as direct, and its requests go out without them', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async (query) => {
    const { owner, settings, agent, put, log } = await window.openRegistry(query);
    await window.until(() => settings.providers().length > 0);
    const option = settings.providers().find((entry) => entry.id === 'moonshotai');
    await put({
      kind: 'model',
      name: option.vaultName,
      provider: option.id,
      placeholder: 'fnox_proxy_moonshot',
      value: 'sk-moonshot-key-0001',
    });
    await settings.connect(option.id);
    await window.until(
      () => settings.accounts().find((entry) => entry.id === option.id)?.status === 'connected'
    );
    const reply = await window.reply(agent, 'moonshotai/kimi-k2.6', 'Hello Moonshot.');
    const { upstream } = await log();
    await owner.release();
    return { option, reply, upstream };
  }, QUERY);
  assert.equal(seen.option.needs, undefined);
  assert.equal(seen.reply, 'From api.moonshot.ai.');
  const sent = seen.upstream.filter((entry) => new URL(entry.url).host === 'api.moonshot.ai');
  assert.ok(sent.length > 0);
  for (const entry of sent) {
    assert.equal(entry.authorization, 'Bearer sk-moonshot-key-0001');
    assert.ok(entry.names.includes('content-type'));
    assert.deepEqual(
      entry.names.filter((name) => name.startsWith('x-stainless-')),
      []
    );
  }
});

test('a cors-free provider is shown but blocked without a CORS-free route, unblocks when one appears and blocks again, keeping its key', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async (query) => {
    const { owner, settings, agent, put, route } = await window.openRegistry(query);
    await window.until(() => settings.providers().length > 0);
    const option = () => settings.providers().find((entry) => entry.id === 'nvidia');
    const row = () => settings.accounts().find((entry) => entry.id === 'nvidia');
    const models = () => settings.models().filter((entry) => entry.id.startsWith('nvidia/')).length;
    const offered = option();
    await put({
      kind: 'model',
      name: offered.vaultName,
      provider: 'nvidia',
      placeholder: 'fnox_proxy_nvidia',
      value: 'nvapi-key-0001',
    });
    await settings.connect('nvidia');
    await window.until(() => row()?.status === 'connected');
    const before = {
      blocked: row().blocked,
      status: row().status,
      models: models(),
      groq: settings.providers().find((entry) => entry.id === 'groq').blocked ?? null,
    };
    await route({ crossOrigin: 'any' });
    await window.until(() => row() && !row().blocked && models() > 0);
    const opened = {
      blocked: row().blocked ?? null,
      option: option().blocked ?? null,
      models: models(),
    };
    const reply = await window.reply(
      agent,
      'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
      'Hello NVIDIA.'
    );
    await route({ crossOrigin: 'cors' });
    await window.until(() => row()?.blocked === 'cors-free-transport');
    const closed = {
      blocked: row().blocked,
      status: row().status,
      models: models(),
      option: option().blocked,
    };
    await owner.release();
    return { offered, before, opened, reply, closed };
  }, 'registry&vault&route=cors');
  assert.equal(seen.offered.blocked, 'cors-free-transport');
  assert.equal(seen.offered.needs, 'cors-free-transport');
  assert.deepEqual(seen.before, {
    blocked: 'cors-free-transport',
    status: 'connected',
    models: 0,
    groq: null,
  });
  assert.equal(seen.opened.blocked, null);
  assert.equal(seen.opened.option, null);
  assert.ok(seen.opened.models > 0);
  assert.equal(seen.reply, 'From integrate.api.nvidia.com.');
  assert.deepEqual(seen.closed, {
    blocked: 'cors-free-transport',
    status: 'connected',
    models: 0,
    option: 'cors-free-transport',
  });
});

test('Xiaomi offers MiMo V2.6 Pro as its default, the model pi-coding-agent 1.4.0 picks', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async (query) => {
    const { owner, settings, put } = await window.openRegistry(query);
    await window.until(() => settings.providers().length > 0);
    const option = settings.providers().find((entry) => entry.id === 'xiaomi');
    await put({
      kind: 'model',
      name: option.vaultName,
      provider: option.id,
      placeholder: 'fnox_proxy_xiaomi',
      value: 'sk-xiaomi-key-0001',
    });
    await settings.connect(option.id);
    const xiaomi = () => settings.models().filter((entry) => entry.id.startsWith('xiaomi/'));
    await window.until(() => xiaomi().length > 0);
    const defaults = xiaomi()
      .filter((entry) => entry.default)
      .map((entry) => entry.id);
    const first = xiaomi()[0]?.id;
    await owner.release();
    return { defaults, first };
  }, QUERY);
  assert.deepEqual(seen.defaults, ['xiaomi/mimo-v2.6-pro']);
  assert.notEqual(seen.first, 'xiaomi/mimo-v2.6-pro');
});

test('OpenRouter and OpenCode requests are attributed to SLICC', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async (query) => {
    const { owner, settings, agent, put, log } = await window.openRegistry(query);
    await window.until(() => settings.providers().length > 0);
    const replies = {};
    for (const [id, modelId] of [
      ['openrouter', 'openrouter/moonshotai/kimi-k2.6'],
      ['opencode', 'opencode/kimi-k2.6'],
    ]) {
      const option = settings.providers().find((entry) => entry.id === id);
      await put({
        kind: 'model',
        name: option.vaultName,
        provider: id,
        placeholder: `fnox_proxy_${id}`,
        value: `sk-${id}-key-0001`,
      });
      await settings.connect(id);
      await window.until(
        () => settings.accounts().find((entry) => entry.id === id)?.status === 'connected'
      );
      replies[id] = await window.reply(agent, modelId, `Hello ${id}.`);
    }
    const { upstream } = await log();
    await owner.release();
    return { replies, upstream };
  }, QUERY);
  assert.equal(seen.replies.openrouter, 'From openrouter.ai.');
  assert.equal(seen.replies.opencode, 'From opencode.ai.');
  const sent = (host) => seen.upstream.filter((entry) => new URL(entry.url).host === host);
  assert.ok(sent('openrouter.ai').length > 0);
  for (const entry of sent('openrouter.ai'))
    assert.deepEqual(entry.attribution, {
      'http-referer': 'https://www.sliccy.com',
      'x-openrouter-title': 'SLICC',
    });
  assert.ok(sent('opencode.ai').length > 0);
  for (const entry of sent('opencode.ai'))
    assert.deepEqual(entry.attribution, { 'x-opencode-client': 'SLICC' });
});
