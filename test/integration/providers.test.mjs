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
  assert.deepEqual(
    seen.registered.filter((entry) => typeof entry === 'object' && entry.provider !== 'adobe'),
    []
  );
  assert.ok(seen.disconnected.includes('groq'));
  assert.ok(!seen.after.includes('groq'));
  assert.ok(seen.after.includes('nvidia'));
  assert.equal(seen.stillOffered, true);
});
