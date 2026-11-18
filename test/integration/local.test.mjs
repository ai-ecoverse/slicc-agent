import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const program = await readFile(new URL('./fixtures/local-llm.mjs', import.meta.url), 'utf8');
const manifest = JSON.stringify({
  name: 'local-llm',
  version: '1.0.0',
  slicc: { commands: { 'local-llm': { abi: 'js', module: 'server.mjs' } } },
});

const helpers = () => {
  window.until = async (check, tries = 1000) => {
    for (let n = 0; n < tries && !(await check()); n++) await new Promise((r) => setTimeout(r, 20));
    return check();
  };
  window.write = async (path, text) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.seen = [];
  window.boot = async (files) => {
    for (const [path, text] of Object.entries(files)) await window.write(path, text);
    const { bootKernel } = await import('/kernel.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    await import('/dist-test/page.js');
    window.kernel = await bootKernel();
    const client = await attachKernel(await window.kernel.connect());
    let out = '';
    const decoder = new TextDecoder();
    return new Promise((resolve) => {
      client.spawn(['local-llm', '8820'], {
        onStdout: (bytes) => {
          out += decoder.decode(bytes);
          const lines = out.split('\n');
          out = lines.pop();
          for (const line of lines) {
            if (line.startsWith('listening')) resolve(line);
            if (line.startsWith('seen ')) window.seen.push(JSON.parse(line.slice(5)));
          }
        },
        onStderr: (bytes) => console.error(decoder.decode(bytes)),
      });
    });
  };
  window.start = async (query) => {
    let worker;
    const owner = await startAgent({
      worker: () => (worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => window.kernel.connect() },
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
      register: (entry) => post({ register: entry }, 'sealed'),
      log: () => post({}, 'upstream'),
      approve: (draft) => post({ approve: draft }, 'reply'),
      items: () => post({}, 'items'),
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
        .find((part) => part.type === 'text' && part.text?.startsWith('From'))?.text;
    await window.until(answer, 1000);
    const tools = agent
      .messages()
      .slice(before)
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool')
      .map(({ tool }) => ({ name: tool.name, status: tool.status }));
    return { answer: answer() ?? JSON.stringify(agent.messages().slice(before)), tools };
  };
};

test('a local OpenAI-compatible server on the kernel loopback is added without a key, lists its models and a decision model as a classifier, answers a turn with a tool call, judges approvals and refuses unsafe endpoints', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const listening = await staged(page, 'the local server', (files) => window.boot(files), {
    '/node_modules/local-llm/package.json': manifest,
    '/node_modules/local-llm/server.mjs': program,
    '/home/.pi/agent/settings.json': JSON.stringify({
      approvals: { judgeModel: 'local/judge-1' },
    }),
  });
  assert.equal(listening, 'listening 8820');
  const seen = await staged(
    page,
    'the local provider',
    async (query) => {
      const { owner, settings, agent, put, unput, approve, items } = await window.start(query);
      stage('providers');
      await window.until(() => settings.providers().length > 0);
      const option = settings.providers().find((entry) => entry.id === 'local');
      const refused = async (fields) =>
        settings.connect('local', undefined, fields).then(
          () => null,
          (error) => error.message
        );
      const facade = await refused({ endpoint: 'http://9222.kernel.localhost/v1' });
      const public_ = await refused({ endpoint: 'http://example.com/v1' });
      const userinfo = await refused({ endpoint: 'https://me:pw@llm.example.com/v1' });
      stage('silent');
      const silent = await refused({ endpoint: 'http://8821.kernel.localhost/v1' });
      const context = await refused({
        endpoint: 'http://8820.kernel.localhost/v1',
        context: 'lots',
      });
      await put({
        kind: 'model',
        name: option.vaultName,
        provider: 'local',
        placeholder: 'fnox_proxy_local',
        value: 'local-key-0001',
      });
      stage('keyed');
      const keyed = await refused({ endpoint: 'http://8820.kernel.localhost/v1' });
      await unput(option.vaultName);
      const row = () => settings.accounts().find((entry) => entry.id === 'local');
      stage('connect');
      await settings.connect('local', undefined, { endpoint: 'http://8820.kernel.localhost/' });
      stage('connected');
      await window.until(
        () =>
          row()?.status === 'connected' && settings.models().some((m) => m.id.startsWith('local/'))
      );
      const account = row();
      const images = Object.fromEntries(
        settings
          .models()
          .filter((entry) => entry.id.startsWith('local/'))
          .map((entry) => [entry.id, entry.images])
      );
      const listed = await window.kernel.run(['bash', '-c', 'models list --json']);
      const models = JSON.parse(listed.stdout)
        .filter((entry) => entry.id.startsWith('local/'))
        .map(({ id, contextWindow }) => ({ id, images: images[id], contextWindow }));
      stage('turn');
      const turn = await window.reply(agent, 'local/chat-1', 'Run the local tool.');
      stage('approve');
      const asked = await approve({
        kind: 'guest-message',
        seat: 'seat-1',
        agentId: 'cone',
        requester: { kind: 'guest', name: 'Pat', seat: 'seat-1' },
        tier: 'agent',
        detail: { text: 'Fix the typo on the install page, please.', attachments: [] },
      });
      const id = asked.item?.id;
      const judged = await window.until(async () => {
        const item = (await items()).find((entry) => entry.id === id);
        return item && !item.judging && item.verdict ? item : undefined;
      });
      stage('late key');
      await put({
        kind: 'model',
        name: option.vaultName,
        provider: 'local',
        placeholder: 'fnox_proxy_local',
        value: 'local-key-0002',
      });
      const late = await refused(undefined);
      await window.until(() => row()?.status === 'disconnected');
      const lateKey = {
        late,
        status: row()?.status,
        models: settings.models().filter((entry) => entry.id.startsWith('local/')).length,
      };
      await unput(option.vaultName);
      await settings.connect('local');
      await window.until(() => row()?.status === 'connected');
      stage('disconnect');
      settings.disconnect('local');
      await window.until(() => row()?.status === 'disconnected');
      const gone = settings.models().filter((entry) => entry.id.startsWith('local/')).length;
      const result = {
        option,
        facade,
        public_,
        userinfo,
        silent,
        context,
        keyed,
        account,
        models,
        turn,
        asked: asked.error ?? null,
        verdict: judged?.verdict ?? null,
        gone,
        lateKey,
        requests: window.seen,
      };
      await owner.release();
      return result;
    },
    'registry&vault'
  );
  assert.equal(seen.option.auth, 'fields');
  assert.equal(seen.option.name, 'Local or self-hosted');
  assert.equal(seen.option.needs, undefined);
  assert.equal(seen.option.vaultName, 'LOCAL_API_KEY');
  assert.equal(seen.option.keyOptional, true);
  assert.equal(seen.account.keyOptional, true);
  assert.deepEqual(
    seen.option.fields.map((field) => [
      field.name,
      field.required ?? false,
      field.customBase ?? false,
    ]),
    [
      ['endpoint', true, true],
      ['context', false, false],
    ]
  );
  assert.match(seen.option.fields[0].help, /11434.*1234.*8080.*8000.*11435/);
  assert.match(seen.facade, /other than 9222, the CDP facade/);
  assert.match(seen.public_, /^An http:\/\/ address must be on this machine/);
  assert.match(seen.userinfo, /without a user name or password/);
  assert.match(seen.silent, /^Couldn’t reach http:\/\/8821\.kernel\.localhost\/v1\/models: /);
  assert.match(seen.silent, /OLLAMA_ORIGINS=https:\/\/seven\.sliccy\.ai/);
  assert.equal(seen.context, 'Enter the context window as a number of tokens, such as 32768.');
  assert.match(seen.keyed, /^Seven’s vault sends keys over https:\/\/ only/);
  assert.equal(seen.account.identity, 'No key, context under 16k tokens');
  assert.equal(
    seen.account.fields.find((field) => field.name === 'endpoint').value,
    'http://8820.kernel.localhost/'
  );
  assert.deepEqual(seen.models, [
    { id: 'local/chat-1', images: true, contextWindow: 131072 },
    { id: 'local/chat-2', images: false, contextWindow: 65536 },
    { id: 'local/chat-3', images: false, contextWindow: 12288 },
    { id: 'local/chat-4', images: false, contextWindow: 32768 },
  ]);
  assert.equal(seen.turn.answer, 'From the local server: local-tool');
  assert.deepEqual(seen.turn.tools, [{ name: 'bash', status: 'done' }]);
  assert.equal(seen.asked, null);
  assert.equal(seen.verdict.model, 'local/judge-1');
  assert.equal(seen.verdict.via, 'classifier');
  assert.equal(seen.verdict.level, 1);
  assert.equal(seen.gone, 0);
  assert.match(seen.lateKey.late, /^Seven’s vault sends keys over https:\/\/ only/);
  assert.equal(seen.lateKey.status, 'disconnected');
  assert.equal(seen.lateKey.models, 0);
  const chats = seen.requests.filter((entry) => entry.target === '/v1/chat/completions');
  assert.ok(chats.length >= 2);
  for (const entry of chats) {
    assert.equal(entry.model, 'chat-1');
    assert.equal(entry.authorization, 'Bearer local');
  }
  assert.ok(seen.requests.every((entry) => !entry.authorization?.includes('fnox_proxy_local')));
  assert.ok(seen.requests.some((entry) => entry.method === 'GET' && entry.target === '/v1/models'));
  const decisions = seen.requests.filter((entry) => entry.target === '/v1/systemone');
  assert.ok(decisions.length > 0);
  assert.ok(decisions.every((entry) => entry.model === 'judge-1'));
});

test('a local endpoint on https takes a key from the vault, which fills it only on the URL registered for it', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'the kernel', (files) => window.boot(files), {
    '/node_modules/local-llm/package.json': manifest,
    '/node_modules/local-llm/server.mjs': program,
  });
  const seen = await staged(
    page,
    'the keyed local provider',
    async (query) => {
      const { owner, settings, agent, put, register, log } = await window.start(query);
      await window.until(() => settings.providers().length > 0);
      const option = settings.providers().find((entry) => entry.id === 'local');
      await put({
        kind: 'model',
        name: option.vaultName,
        provider: 'local',
        placeholder: 'fnox_proxy_local',
        value: 'hosted-key-0001',
      });
      const unregistered = await settings
        .connect('local', undefined, { endpoint: 'https://llm.test' })
        .then(
          () => null,
          (error) => error.message
        );
      await register({ provider: 'local', url: 'https://llm.test/v1' });
      const row = () => settings.accounts().find((entry) => entry.id === 'local');
      await settings.connect('local', undefined, { endpoint: 'https://llm.test' });
      await window.until(
        () =>
          row()?.status === 'connected' && settings.models().some((m) => m.id === 'local/hosted-1')
      );
      const account = row();
      const turn = await window.reply(agent, 'local/hosted-1', 'Hello hosted.');
      const { upstream } = await log();
      const result = { unregistered, account, turn, upstream };
      await owner.release();
      return result;
    },
    'registry&vault'
  );
  assert.match(seen.unregistered, /llm\.test\/v1\/models: it answered 403\./);
  assert.equal(seen.account.identity, 'API key');
  assert.equal(seen.account.keyOptional, true);
  assert.equal(seen.turn.answer, 'From llm.test.');
  const sent = seen.upstream.filter((entry) => new URL(entry.url).host === 'llm.test');
  assert.ok(sent.some((entry) => new URL(entry.url).pathname === '/v1/models'));
  assert.ok(sent.some((entry) => new URL(entry.url).pathname === '/v1/chat/completions'));
  for (const entry of sent) assert.equal(entry.authorization, 'Bearer hosted-key-0001');
});
