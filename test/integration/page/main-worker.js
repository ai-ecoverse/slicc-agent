import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import vectors from '@ai-ecoverse/slicc-scrub/vectors.json' with { type: 'json' };
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { createProvider } from '@earendil-works/pi-ai/models';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { MemoryStorage } from '@earendil-works/pi-durable';
import {
  adobeProvider,
  openOpfsSqliteStorage,
  runAgentWorker,
  sliccProviders,
} from '../../../src/index.ts';
import { fakeVault } from '../fixtures/fake-vault.mjs';
import { createMcpServer } from '../fixtures/mcp-server.mjs';
import { seeded } from '../fixtures/seeds.mjs';

const params = new URL(self.location.href).searchParams;
registerBunOAuthFlows();
const logged = [];
const shown = (value) => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.message} ${value.stack ?? ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    logged.push(args.map(shown).join(' '));
    original(...args);
  };
}
const device = { mode: 'pending', issued: 0, polls: 0, revoked: new Set() };
const ACCOUNT = 'acct-e2e-0001';
const jwt = (claims, tail) => `e2e.${btoa(JSON.stringify(claims))}.${tail}`;
const issue = (provider) => {
  device.issued += 1;
  const tail = `SECRET${device.issued}VALUE`;
  return {
    access_token:
      provider === 'openai-codex'
        ? jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } }, tail)
        : `${provider}-access-${tail}`,
    refresh_token: `${provider}-refresh-${tail}`,
    expires_in: 3600,
    token_type: 'Bearer',
  };
};
const AUTH_HOSTS = new Map([
  ['auth.x.ai', 'xai'],
  ['auth.kimi.com', 'kimi-coding'],
  ['auth.openai.com', 'openai-codex'],
]);
const DEVICE_PATHS = new Set([
  '/oauth2/device/code',
  '/api/oauth/device_authorization',
  '/api/accounts/deviceauth/usercode',
]);
const VERIFY = {
  xai: 'https://accounts.x.ai/device',
  'kimi-coding': 'https://www.kimi.com/device',
};
const reply = (status, body) => ({ ...json(body), status });
function signIn(request) {
  const url = new URL(request.url);
  const provider = AUTH_HOSTS.get(url.host);
  const form = new URLSearchParams(new TextDecoder().decode(request.body ?? new Uint8Array()));
  upstream.push({ url: request.url, auth: provider });
  if (DEVICE_PATHS.has(url.pathname)) {
    if (device.mode === 'stall') return new Promise(() => {});
    if (provider === 'openai-codex')
      return reply(200, { device_auth_id: 'da-e2e', user_code: 'CODE-0001', interval: '1' });
    return reply(200, {
      device_code: `dc-${provider}`,
      user_code: 'CODE-0001',
      verification_uri: VERIFY[provider],
      verification_uri_complete: `${VERIFY[provider]}?user_code=CODE-0001`,
      interval: 1,
      expires_in: 600,
    });
  }
  if (url.pathname === '/oauth/token' && provider === 'openai-codex')
    return reply(200, issue(provider));
  if (url.pathname === '/api/accounts/deviceauth/token') {
    device.polls += 1;
    if (device.mode === 'approve')
      return reply(200, { authorization_code: 'ac-e2e', code_verifier: 'cv-e2e' });
    return reply(403, { error: { code: 'deviceauth_authorization_pending' } });
  }
  if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code')
    return reply(400, { error: 'invalid_request' });
  device.polls += 1;
  if (device.mode === 'deny') return reply(400, { error: 'access_denied' });
  if (device.mode === 'malformed') {
    const { access_token } = issue(provider);
    return reply(200, { access_token });
  }
  if (device.mode === 'approve') return reply(200, issue(provider));
  return reply(400, { error: 'authorization_pending' });
}
const GITHUB_HOSTS = new Set(['github.com', 'api.github.com']);
const COPILOT_API = 'api.business.githubcopilot.com';
function github(request) {
  const url = new URL(request.url);
  upstream.push({
    url: request.url,
    method: request.method,
    names: request.headers.map(([name]) => name.toLowerCase()),
  });
  if (url.pathname === '/login/device/code')
    return reply(200, {
      device_code: 'dc-github-copilot',
      user_code: 'CODE-0001',
      verification_uri: 'https://github.com/login/device',
      interval: 1,
      expires_in: 600,
    });
  if (url.pathname === '/login/oauth/access_token') {
    device.polls += 1;
    if (device.mode !== 'approve') return reply(200, { error: 'authorization_pending' });
    device.issued += 1;
    return reply(200, { access_token: `ghu_SECRET${device.issued}VALUE`, token_type: 'bearer' });
  }
  if (url.pathname === '/copilot_internal/v2/token') {
    device.issued += 1;
    return reply(200, {
      token: `tid=e2e;proxy-ep=proxy.business.githubcopilot.com;sig=SECRET${device.issued}VALUE`,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    });
  }
  if (url.pathname === '/models')
    return reply(200, {
      data: JSON.parse(params.get('copilot-models') ?? '["gemini-4-argon"]').map((id) => ({
        id,
        model_picker_enabled: true,
        policy: { state: 'enabled' },
        capabilities: { supports: { tool_calls: true } },
      })),
    });
  return reply(404, { message: 'Not Found' });
}
function codexTurn(request) {
  const header = (wanted) =>
    request.headers.find(([name]) => name.toLowerCase() === wanted)?.[1] ?? null;
  upstream.push({
    url: request.url,
    authorization: header('authorization'),
    account: header('chatgpt-account-id'),
  });
  const event = (body) => `event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`;
  const item = {
    type: 'message',
    id: 'msg_e2e',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'From chatgpt.com.', annotations: [] }],
  };
  const text = [
    event({ type: 'response.created', response: { id: 'resp_e2e', status: 'in_progress' } }),
    event({
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', content: [] },
    }),
    event({
      type: 'response.content_part.added',
      item_id: 'msg_e2e',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }),
    event({
      type: 'response.output_text.delta',
      item_id: 'msg_e2e',
      output_index: 0,
      content_index: 0,
      delta: 'From chatgpt.com.',
    }),
    event({ type: 'response.output_item.done', output_index: 0, item }),
    event({
      type: 'response.completed',
      response: {
        id: 'resp_e2e',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    }),
  ].join('');
  return {
    status: 200,
    headers: [['content-type', 'text/event-stream']],
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
}
self.addEventListener('message', ({ data }) => {
  if (data?.device) device.mode = data.device;
  if (data?.revoke) device.revoked.add(data.revoke);
  if (data?.killGrant) self.fakeVault?.killGrant(data.killGrant);
  data?.deviced?.postMessage({ polls: device.polls, issued: device.issued });
  data?.logged?.postMessage([...logged]);
  data?.vaultUrls?.postMessage(
    (self.fakeVault?.log ?? [])
      .filter((entry) => entry.op === 'model')
      .map((entry) => entry.request?.url ?? null)
  );
  data?.vaultRecords?.postMessage(
    (self.fakeVault?.records ?? []).map(({ value: _value, ...record }) => record)
  );
  data?.vaultMcp?.postMessage(
    (self.fakeVault?.log ?? [])
      .filter((entry) => entry.op === 'mcp')
      .map((entry) => entry.request?.headers ?? null)
  );
});
const fauxModels = [
  ...params.getAll('model').map((id) => ({ id })),
  ...params.getAll('blind').map((id) => ({ id, input: ['text'] })),
];
const faux = fauxProvider({
  ...(fauxModels.length ? { models: fauxModels } : {}),
  ...(params.has('tps') ? { tokensPerSecond: Number(params.get('tps')) } : {}),
});
const requests = [];
const served = [];
const recorded = (message) => (context, _options, _state, model) => {
  requests.push(JSON.stringify(context));
  served.push(model?.id ?? null);
  return { ...message, timestamp: Date.now() };
};
const upstream = [];
self.addEventListener('message', ({ data }) => {
  data?.requests?.postMessage(requests);
  data?.served?.postMessage(served);
  data?.upstream?.postMessage({
    upstream,
    errors: self.fakeVault?.errors ?? [],
    vault:
      self.fakeVault?.log.map(({ op, provider, server, model, oauth }) => ({
        op,
        provider,
        server,
        ...(model ? { model } : {}),
        ...(oauth ? { oauth } : {}),
      })) ?? [],
  });
  if (data?.unseal && self.fakeVault) {
    self.fakeVault.remove(data.unseal);
    self.fakeVault.publish({ needed: true, version: self.fakeVault.version });
    data.sealed?.postMessage(true);
  }
  if (data?.register && self.fakeVault) {
    self.fakeVault.registered.model.push(data.register);
    data.sealed?.postMessage(true);
  }
  if (data?.seal && self.fakeVault) {
    self.fakeVault.remove(data.seal.name);
    self.fakeVault.add(data.seal);
    self.fakeVault.publish({ needed: true, version: self.fakeVault.version });
    data.sealed?.postMessage(true);
  }
});
const HOLD = Symbol('hold');
const holding = { count: 0, ports: [] };
self.addEventListener('message', ({ data }) => {
  data?.holding?.postMessage(holding.count);
});
const held = (_context, options) =>
  new Promise((resolve) => {
    const done = () => {
      requests.push(JSON.stringify({ held: 'aborted' }));
      resolve(fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted' }));
    };
    if (options?.signal?.aborted) done();
    else {
      holding.count += 1;
      for (const port of holding.ports) port.postMessage(holding.count);
    }
    options?.signal?.addEventListener('abort', done, { once: true });
  });
const gates = new Map();
const gate = (name) => {
  if (!gates.has(name)) gates.set(name, Promise.withResolvers());
  return gates.get(name);
};
self.addEventListener('message', ({ data }) => {
  if (data?.gate) gate(data.gate).resolve();
  if (data?.holds) {
    holding.ports.push(data.holds);
    data.holds.postMessage(holding.count);
  }
});
const gated = (name, message) => async (context, options, state, model) => {
  await gate(name).promise;
  return recorded(message)(context, options, state, model);
};
const scoopSteps = params.getAll('scoop-step').map((spec) => {
  const { gate: name, answer, error, tool } = JSON.parse(spec);
  const message = error
    ? fauxAssistantMessage([], { stopReason: 'error', errorMessage: error })
    : tool
      ? fauxAssistantMessage([fauxToolCall(tool.name, tool.args)], { stopReason: 'toolUse' })
      : fauxAssistantMessage(answer);
  return name ? gated(name, message) : recorded(message);
});
const steps = [
  ...params.getAll('step').map((spec) => {
    const { tool, answer, think, error, hold, gate: name } = JSON.parse(spec);
    if (hold) return HOLD;
    const called = tool
      ? fauxAssistantMessage([fauxToolCall(tool.name, tool.args)], { stopReason: 'toolUse' })
      : fauxAssistantMessage(answer);
    if (name) return { gate: name, message: called };
    if (error) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: error });
    if (think) return fauxAssistantMessage([fauxThinking(think), fauxText(answer)]);
    return called;
  }),
  ...params
    .getAll('code')
    .map((code) =>
      fauxAssistantMessage([fauxToolCall('codemode', { code })], { stopReason: 'toolUse' })
    ),
  ...params.getAll('tool').map((spec) => {
    const { name, args } = JSON.parse(spec);
    return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
  }),
  ...params.getAll('memory').map((args) =>
    fauxAssistantMessage([fauxToolCall('memory_write', JSON.parse(args))], {
      stopReason: 'toolUse',
    })
  ),
  ...params.getAll('answer').map((answer) => fauxAssistantMessage(answer)),
];
const queued = steps.map((step) => {
  if (step === HOLD) return held;
  return step.gate ? gated(step.gate, step.message) : recorded(step);
});
let titles = 0;
const titling = (context) =>
  context.messages.length === 1 &&
  JSON.stringify(context.messages[0].content).includes('Give this chat a title');
let labels = 0;
const labelling = (context) =>
  context.messages.length === 1 &&
  JSON.stringify(context.messages[0].content).includes('Label this group of tool runs');
const stepping = (context) =>
  context.messages.length === 1 &&
  JSON.stringify(context.messages[0].content).includes('Label this tool run');
const stepInput = (context) =>
  context.messages[0].content[0].text.split('\n\n').slice(1).join('\n\n');
const stepCommand = (context) =>
  JSON.parse(
    stepInput(context)
      .split('\n')[0]
      .replace(/^\w+: /, '')
  ).command;
const labelInputs = [];
self.addEventListener('message', ({ data }) => {
  data?.labelInputs?.postMessage(labelInputs);
});
const sayStats = { active: 0, most: 0, prompts: [] };
self.addEventListener('message', ({ data }) => {
  data?.sayStats?.postMessage(sayStats);
});
const said = async (context, ...rest) => {
  const final = context.messages.at(-1);
  if (final.role === 'toolResult') {
    const result = final.content.map((part) => part.text ?? '').join('');
    return recorded(fauxAssistantMessage(`ran: ${result}`))(context, ...rest);
  }
  const last = context.messages.findLast((message) => message.role === 'user');
  const text =
    typeof last.content === 'string'
      ? last.content
      : last.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
  const line = text.split('\n')[0];
  sayStats.prompts.push(line);
  sayStats.active += 1;
  sayStats.most = Math.max(sayStats.most, sayStats.active);
  try {
    const shell = /^bash (.*)$/.exec(line);
    if (shell)
      return recorded(
        fauxAssistantMessage([fauxToolCall('bash', { command: shell[1] })], {
          stopReason: 'toolUse',
        })
      )(context, ...rest);
    const held = /^hold (\S+) (.*)$/.exec(line);
    const signal = rest[0]?.signal;
    const stopped = new Promise((resolve) => {
      if (signal?.aborted) resolve(true);
      signal?.addEventListener('abort', () => resolve(true), { once: true });
    });
    if (held && (await Promise.race([gate(held[1]).promise.then(() => false), stopped])))
      return fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted' });
    const answer = held ? held[2] : line.replace(/^say /, '');
    return recorded(fauxAssistantMessage(answer))(context, ...rest);
  } finally {
    sayStats.active -= 1;
  }
};
const spoken = [];
const sayings = params.getAll('judge-say').map((step) => JSON.parse(step));
const judging = (context) =>
  context.messages.length === 1 &&
  JSON.stringify(context.messages[0].content).includes(
    'You review a request on behalf of the owner'
  );
const pause = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
async function judgeSay(context, options, model) {
  const text = context.messages[0].content.map((part) => part.text ?? '').join('');
  const state = JSON.parse(text.slice(text.indexOf('\n\n{') + 2));
  const obeyed = text.includes('answer wants_read true') ? { wants_read: true } : {};
  if (text.includes('- forbidden:')) {
    spoken.push({
      key: 'forbidden',
      whole: true,
      text,
      state,
      model: `${model.provider}/${model.id}`,
    });
    return fauxAssistantMessage(
      JSON.stringify({ forbidden: forbiddenOf(state) >= 0.5, ...obeyed })
    );
  }
  if (!state.request) {
    spoken.push({ key: 'owner', whole: true, text, state, model: `${model.provider}/${model.id}` });
    return fauxAssistantMessage(JSON.stringify({ ...chatIntent(state), ...obeyed }));
  }
  const told = inner(state.request.untrusted);
  const key = told.split('\n')[0];
  const whole = text.includes('Answer every question above');
  spoken.push({ key, whole, text, state, model: `${model.provider}/${model.id}` });
  for (const wake of judgedWakes.splice(0)) wake();
  const entry = judgeTable[told] ?? judgeTable[key];
  const step = entry ?? sayings.shift() ?? {};
  if (step.sayDelay) await pause(step.sayDelay, options?.signal);
  if (options?.signal?.aborted)
    return fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted' });
  if (step.sayError)
    return fauxAssistantMessage([], { stopReason: 'error', errorMessage: step.sayError });
  const said =
    typeof step.say === 'string'
      ? step.say
      : whole && (step.level !== undefined || step.actions || step.say)
        ? JSON.stringify({ ...chatOf(step, state.request.kind), ...obeyed, ...step.say })
        : 'Faux reason.';
  return fauxAssistantMessage(said, {
    ...(step.sayStop ? { stopReason: step.sayStop } : {}),
  });
}
self.addEventListener('message', ({ data }) => {
  data?.judgeSaid?.postMessage(
    spoken.map(({ key, whole, text, model }) => ({ key, whole, text, model }))
  );
});
const extractions = [];
const recalling = { hold: false, fail: [], calls: 0, held: [] };
self.addEventListener('message', ({ data }) => {
  data?.extractions?.postMessage(extractions);
  if (data?.recallHold !== undefined) recalling.hold = data.recallHold;
  if (data?.recallFail) recalling.fail = data.recallFail;
  if (data?.recallRelease) for (const release of recalling.held.splice(0)) release();
  if (data?.conversations)
    void running
      .then(async (host) => ({
        items: await host.agent.harness.commit(
          async (tx) => (await tx.scanConversations({}, 1000)).items,
          BACKGROUND_CONTEXT
        ),
        agents: host.agent.agents.state(),
      }))
      .then((seen) => data.conversations.postMessage(JSON.parse(JSON.stringify(seen))));
  if (data?.extractTasks)
    void running
      .then((host) =>
        host.agent.harness.commit(
          async (tx) =>
            (await tx.scanTasks({ kind: 'slicc.memory-extract' }, 1000)).items.map((task) => ({
              id: Number(task.id),
              conversation: Number(task.conversationId),
              input: task.input,
              status: task.state.status,
              outcome: task.state.outcome?.status ?? null,
            })),
          BACKGROUND_CONTEXT
        )
      )
      .then((seen) => data.extractTasks.postMessage(JSON.parse(JSON.stringify(seen))));
});
const extracting = (context) =>
  params.has('recall') &&
  typeof context.messages[0]?.content === 'string' &&
  context.messages[0].content.startsWith('You keep the long-term memory');
const recall = (context, options) => {
  const text = context.messages[1].content[0].text;
  const between = (open, close) => {
    const start = text.indexOf('>', text.indexOf(open)) + 1;
    return text.slice(start, text.indexOf(close, start)).trim();
  };
  const conversation = between('<conversation', '</conversation>');
  extractions.push({ memory: between('<memory_file', '</memory_file>'), conversation });
  recalling.calls += 1;
  if (params.has('recall-fail') || recalling.fail.includes(recalling.calls))
    return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'recall failed' });
  const found = new Map();
  for (const [, section, title, body] of conversation.matchAll(
    /^(?:\w+: )?remember (.+?) \/ (.+?): (.+)$/gm
  )) {
    const key = `${section}\n${title}`;
    const known = found.get(key);
    found.set(key, { section, title, body: known ? `${known.body} ${body}` : body, tag: 'user' });
  }
  const answer = fauxAssistantMessage(JSON.stringify([...found.values()]));
  if (!recalling.hold) return answer;
  return new Promise((resolve) => {
    recalling.held.push(() => resolve(answer));
    options?.signal?.addEventListener(
      'abort',
      () => resolve(fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted' })),
      { once: true }
    );
  });
};
const dispatch = (context, ...rest) => {
  if (judging(context)) return judgeSay(context, rest[0], rest[2]);
  if (extracting(context)) return recall(context, rest[0]);
  if (titling(context)) return fauxAssistantMessage(`Title ${++titles}`);
  if (labelling(context) || stepping(context)) labelInputs.push(stepInput(context));
  if (labelling(context)) return fauxAssistantMessage(`Label ${++labels}`);
  if (stepping(context)) return fauxAssistantMessage(`Run ${stepCommand(context)}`);
  if (params.has('scoop-say') && JSON.stringify(context).includes('You are the scoop'))
    return said(context, ...rest);
  if (scoopSteps.length && JSON.stringify(context).includes('You are the scoop'))
    return scoopSteps.shift()(context, ...rest);
  const step = queued.shift();
  if (!step) throw new Error('No more faux responses queued');
  return step(context, ...rest);
};
faux.setResponses(Array.from({ length: 2000 }, () => dispatch));
const relayed = params.get('relay');
const fake = relayed
  ? createMcpServer({
      resources: true,
      instructions: 'Fake docs.',
      sse: params.has('sse'),
      getStream: true,
      ...(params.has('oauth') ? { oauth: JSON.parse(params.get('oauth')) } : {}),
    })
  : undefined;
self.mcpRequests = () => fake?.state.requests ?? [];
self.addEventListener('message', async ({ data }) => {
  if (!data?.authorize) return;
  const { headers } = await fake.fetch(data.authorize.url);
  const { authorizations, clients, issued } = fake.state.oauth;
  data.authorize.port.postMessage({
    location: headers.get('location'),
    authorizations,
    clients,
    issued,
  });
});
async function* chunks(body) {
  if (!body) return;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}
const MODEL_HOST = 'model.test';
const scripted = params.getAll('e2e-call').map((spec) => JSON.parse(spec));
const json = (body) => ({
  status: 200,
  headers: [['content-type', 'application/json']],
  body: (async function* () {
    yield new TextEncoder().encode(JSON.stringify(body));
  })(),
});
const json401 = () => ({
  ...json({ error: { message: 'Invalid token', type: 'authentication_error' } }),
  status: 401,
});
const holdModel = (request) =>
  new Promise((_resolve, reject) => {
    const seen = { url: request.url, held: 'holding' };
    upstream.push(seen);
    const done = () => {
      seen.held = 'aborted';
      reject(new DOMException('The request was aborted', 'AbortError'));
    };
    if (request.signal?.aborted) done();
    request.signal?.addEventListener('abort', done, { once: true });
  });
function model(request) {
  const path = new URL(request.url).pathname;
  if (path === '/v1/config')
    return json({
      clientId: 'c',
      scopes: 's',
      imsEnvironment: 'prod',
      models: [{ id: 'e2e-1', name: 'E2E', api: 'openai' }],
    });
  if (path === '/v1/usage' && params.has('resets'))
    return json({ usage: { weekly: { percent: 40, resetsAt: params.get('resets') } } });
  if (path !== '/v1/chat/completions')
    return { status: 404, headers: [], body: (async function* () {})() };
  const authorization =
    request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? null;
  upstream.push({ authorization, body: new TextDecoder().decode(request.body) });
  if (params.has('e2e-revoked') && authorization === `Bearer ${params.get('e2e-revoked')}`)
    return json401();
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const body = upstream.at(-1).body;
  const side =
    body.includes('Give this chat a title') ||
    body.includes('Label this group') ||
    body.includes('Label this tool run');
  const call = !side && scripted.length ? scripted.shift() : undefined;
  const text = call
    ? `${chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_e2e', type: 'function', function: { name: call.name, arguments: call.arguments } }] }, null)}${chunk({}, 'tool_calls')}data: [DONE]\n\n`
    : `${chunk({ role: 'assistant', content: 'From the model.' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
  return {
    status: 200,
    headers: [['content-type', 'text/event-stream']],
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
}
const GATEWAY_HOST = 'ntfy.sliccy.ai';
const gatewayFiles = {
  '/file/release.json': {
    type: 'application/json; charset=utf-8',
    chunks: ['{"action":"released",', '"tag":"v1.2.0"}'],
  },
  '/file/flood.txt': {
    type: 'text/plain; charset=utf-8',
    chunks: Array.from({ length: 300 }, () => 'x'.repeat(1024)),
  },
  '/file/logo.png': {
    type: 'image/png',
    chunks: [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  },
};
function gateway(request) {
  const path = new URL(request.url).pathname;
  upstream.push({ url: request.url, body: '' });
  if (path === '/file/moved.txt' || path === '/file/silent.txt')
    return {
      url: 'https://evil.test/secret.txt',
      ...(path === '/file/moved.txt' ? { redirected: true } : {}),
      status: 200,
      headers: [['content-type', 'text/plain']],
      body: (async function* () {
        yield new TextEncoder().encode('from elsewhere');
      })(),
    };
  const file = gatewayFiles[path];
  if (!file)
    return {
      status: 404,
      headers: [['content-type', 'application/json']],
      body: (async function* () {
        yield new TextEncoder().encode('{"code":40401,"error":"not found"}');
      })(),
    };
  return {
    status: 200,
    headers: [
      ['content-type', file.type],
      ['content-disposition', 'attachment'],
      ['x-content-type-options', 'nosniff'],
    ],
    body: (async function* () {
      for (const chunk of file.chunks)
        yield typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    })(),
  };
}
const ATTRIBUTION = new Set([
  'http-referer',
  'x-openrouter-title',
  'x-openrouter-categories',
  'x-billing-invoke-origin',
  'x-opencode-client',
]);
const registry = params.has('registry') ? sliccProviders() : [];
const GROK_HOST = 'cli-chat-proxy.grok.com';
const GROK_BILLING = `https://${GROK_HOST}/v1/billing`;
const grokPercent = Number(params.get('grok-percent') ?? 23);
function billing(request) {
  const authorization =
    request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
  const signedIn = /^Bearer xai-access-SECRET\d+VALUE$/.test(authorization);
  upstream.push({ url: request.url, billing: signedIn ? 'signed-in' : 'refused' });
  if (!signedIn) return reply(401, { error: 'invalid_token' });
  const pad = params.get('grok-billing') === 'huge' ? { pad: 'x'.repeat(70 * 1024) } : {};
  return json({
    ...pad,
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-10-20T19:03:46.999237+00:00',
        end: '2026-10-27T19:03:46.999237+00:00',
      },
      creditUsagePercent: grokPercent,
      productUsage: [{ product: 'GrokBuild', usagePercent: grokPercent }],
    },
  });
}
const completions = (request) => {
  const url = new URL(request.url);
  const authorization =
    request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? null;
  upstream.push({
    url: request.url,
    authorization,
    names: request.headers.map(([name]) => name.toLowerCase()),
    attribution: Object.fromEntries(
      request.headers
        .map(([name, value]) => [name.toLowerCase(), value])
        .filter(([name]) => ATTRIBUTION.has(name))
    ),
  });
  if (device.revoked.has(authorization?.replace(/^Bearer /, '')))
    return {
      ...json({ error: { message: 'Invalid token', type: 'authentication_error' } }),
      status: 401,
    };
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({ id: 'up', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const text = `${chunk({ role: 'assistant', content: `From ${url.host}.` }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
  return {
    status: 200,
    headers: [['content-type', 'text/event-stream']],
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  };
};
const LOCAL_HOST = 'llm.test';
const localModels = (request) => {
  const authorization =
    request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? null;
  upstream.push({ url: request.url, authorization });
  return json({ data: [{ id: 'hosted-1', context_length: 65536 }] });
};
const moves = JSON.parse(params.get('moved') ?? '{}');
const moved = (request) => {
  const url = new URL(request.url);
  upstream.push({
    url: request.url,
    method: request.method,
    redirect: request.redirect ?? null,
    headers: Object.fromEntries(
      request.headers.map(([name, value]) => [name.toLowerCase(), value])
    ),
    body: request.body ? new TextDecoder().decode(request.body) : null,
  });
  const move = moves[url.pathname];
  if (move?.opaque && (request.redirect === 'manual' || !move.location))
    return { status: 0, headers: [], opaqueRedirect: true, body: (async function* () {})() };
  return move
    ? {
        status: move.status,
        headers: [['location', move.location]],
        body: (async function* () {})(),
      }
    : undefined;
};
const own = [];
const follows = params.has('follows');
const followed = async (request, answer) => {
  const url = new URL(answer.headers[0][1], request.url).href;
  const method =
    answer.status === 303 || (answer.status < 303 && request.method === 'POST')
      ? 'GET'
      : request.method;
  const { body, ...rest } = request;
  const next = await relay.fetch({
    ...rest,
    url,
    method,
    ...(method === request.method && body ? { body } : {}),
  });
  return { ...next, url: next.url ?? url, redirected: true };
};
const proven =
  (params.has('vault') || follows || params.has('gateway')) && !params.has('unproven')
    ? { redirectPolicy: true }
    : JSON.parse(params.get('unproven') || '{}');
const relay = {
  traits: { crossOrigin: 'any', ...proven },
  async fetch(request) {
    if (new URL(request.url).origin === self.location.origin) {
      const entry = { url: request.url, method: request.method, credentials: 'omit' };
      own.push(entry);
      return {
        status: 404,
        headers: [],
        body: (async function* () {
          yield new TextEncoder().encode('not found');
          entry.read = true;
        })(),
      };
    }
    const answer = params.has('moved') ? moved(request) : undefined;
    if (answer && follows && !request.redirect && answer.status) return followed(request, answer);
    if (answer) return answer;
    if (AUTH_HOSTS.has(new URL(request.url).host)) return signIn(request);
    const { host, pathname } = new URL(request.url);
    if (GITHUB_HOSTS.has(host) || (host === COPILOT_API && !pathname.endsWith('/chat/completions')))
      return github(request);
    if (new URL(request.url).host === GROK_HOST) return billing(request);
    if (new URL(request.url).host === 'chatgpt.com') return codexTurn(request);
    if (registry.length && new URL(request.url).pathname.endsWith('/chat/completions'))
      return completions(request);
    if (registry.length && new URL(request.url).host === LOCAL_HOST) return localModels(request);
    if (new URL(request.url).host === GATEWAY_HOST && params.has('gateway'))
      return gateway(request);
    if (new URL(request.url).host === MODEL_HOST && params.has('e2e')) return model(request);
    if (new URL(request.url).host.startsWith('bedrock-runtime.') && params.has('hold-model')) {
      return holdModel(request);
    }
    if (new URL(request.url).host.startsWith('bedrock-runtime.') && params.has('bedrock-refuse')) {
      upstream.push({ url: request.url, refused: true });
      return {
        ...json({ message: 'The security token included in the request is invalid.' }),
        status: 403,
        headers: [
          ['content-type', 'application/json'],
          ['x-amzn-errortype', 'UnrecognizedClientException'],
        ],
      };
    }
    if (new URL(request.url).host !== relayed) throw new TypeError('relay: unknown host');
    const response = await fake.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
    });
    return { status: response.status, headers: [...response.headers], body: chunks(response.body) };
  },
};
const routes = new Set();
if (params.has('route')) relay.traits = { crossOrigin: params.get('route'), ...proven };
self.addEventListener('message', ({ data }) => {
  if (!data?.traits) return;
  relay.traits = { ...data.traits, ...proven };
  for (const listener of routes) listener(data.traits);
  data.routed?.postMessage(true);
});
const routed = params.has('route')
  ? {
      onTraits: (listener) => {
        routes.add(listener);
        return () => routes.delete(listener);
      },
    }
  : {};
const olderKernel = (client) =>
  new Proxy(client, {
    get(target, key) {
      if (key === 'sudoRun') return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
const bootAs = (client) =>
  new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== 'spawn') return typeof value === 'function' ? value.bind(target) : value;
      return async (argv, options) => {
        if (argv.join(' ') !== 'cat /proc/stat') return target.spawn(argv, options);
        const btime = params.get('btime');
        if (btime === 'none') throw new Error('EIO');
        options.onStdout?.(new TextEncoder().encode(`btime ${btime}\n`));
        return { pid: 0, pgid: 0, exited: Promise.resolve(0), signal: () => undefined };
      };
    },
  });
const relayedAttach =
  relayed || params.has('gateway') || registry.length || params.has('xai')
    ? async (port) => Object.assign(await attachKernel(port), { transport: relay, ...routed })
    : params.has('no-sudo-run')
      ? async (port) => olderKernel(await attachKernel(port))
      : params.has('btime')
        ? async (port) => bootAs(await attachKernel(port))
        : undefined;
const unsupported = (what) =>
  Object.assign(new Error(`this kernel speaks protocol 1.14, which has no ${what}`), {
    code: 'ENOSYS',
  });
const tracelessKernel = async (port) => {
  const client = await (relayedAttach ?? attachKernel)(port);
  const spawn = client.spawn.bind(client);
  const missing = params.get('older-kernel');
  return Object.assign(client, {
    ...(missing === 'trace'
      ? {
          trace: async () => {
            throw unsupported('trace');
          },
        }
      : {}),
    spawn: async (argv, options = {}) => {
      if (Array.isArray(options.tag)) throw unsupported('tag lists');
      return spawn(argv, options);
    },
  });
};
const chosen = params.has('older-kernel') ? tracelessKernel : relayedAttach;
const runs = new BroadcastChannel('slicc-test-sudo-runs');
const runner = crypto.randomUUID();
const heldRun = params.get('hold-sudo-run');
const never = () => new Promise(() => undefined);
const seenRuns = (client) =>
  new Proxy(client, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key === 'trace')
        return async (tag, ...rest) => {
          const made = await value.call(target, tag, ...rest);
          runs.postMessage({ runner, traced: tag });
          return made;
        };
      if (key !== 'sudoRun') return value.bind(target);
      return async (replay, options) => {
        runs.postMessage({ runner, called: options?.tag });
        if (heldRun === 'unsent') return never();
        const started = await value.call(target, replay, options);
        runs.postMessage({ runner, accepted: options?.tag, pid: started.pid });
        return heldRun === 'sent' ? never() : started;
      };
    },
  });
const attach = params.has('runs-seen')
  ? async (port) => seenRuns(await (chosen ?? attachKernel)(port))
  : chosen;
const e2e = params.has('e2e')
  ? [adobeProvider({ endpoint: `https://${MODEL_HOST}`, session: 'e2e' })]
  : [];
const judged = [];
const judgedWakes = [];
const judgedAt = (count) =>
  new Promise((resolve) => {
    const check = () => (judged.length >= count ? resolve() : judgedWakes.push(check));
    check();
  });
let judgeTable = {};
const judgeSteps = params.getAll('judge-step').map((step) => JSON.parse(step));
const inner = (fenced) => fenced.split('\n').slice(1, -1).join('\n');
const LEVEL_NAMES = ['routine', 'permissions', 'harm'];
const levelsOf = (step) => {
  if (typeof step.level === 'number')
    return Object.fromEntries(
      LEVEL_NAMES.map((name, at) => [name, at + 1 === step.level ? 0.9 : 0.05])
    );
  if (step.level) return step.level;
  return { routine: step.low, permissions: 0, harm: 1 - step.low };
};
const ACTION_NAMES = [
  'changes',
  'others',
  'system',
  'delete',
  'permissions',
  'code',
  'services',
  'send',
  'secrets',
];
const INTENT_NAMES = [
  'read',
  'write',
  'delete',
  'permissions',
  'code',
  'send',
  'secrets',
  'services',
];
const INTENT = Object.fromEntries(INTENT_NAMES.map((name) => [name, name === 'send' ? 0.1 : 0.95]));
const actionsOf = (step) => {
  const base = Object.fromEntries(ACTION_NAMES.map((name) => [name, 0.02]));
  const legacy = {};
  if (!step.actions) {
    const { permissions, harm } = levelsOf(step);
    legacy.permissions = permissions;
    legacy.delete = harm;
    legacy.changes = Math.max(permissions, harm);
    if (step.aligned !== undefined && step.aligned < 0.8) legacy.send = 0.9;
  }
  return {
    ...base,
    plain: 0.95,
    ...legacy,
    ...step.actions,
    always: step.actions?.always ?? step.more ?? (step.always === true ? 0.05 : 0.9),
  };
};
const bools = (values) =>
  Object.fromEntries(
    Object.entries(values).map(([name, probability]) => [name, { type: 'bool', probability }])
  );
const owned = [];
const remembers = (state, marker) =>
  (state.owner?.memory ?? []).some((line) => line.includes(marker));
const hears = (state, marker) =>
  (state.owner?.messages ?? []).some((line) => line.includes(marker));
const ownerTable = (state) => {
  const marker = state.owner.policy.trim().split('\n').at(-1);
  const base = judgeTable[`owner:${marker}`] ?? judgeTable.owner ?? {};
  return Object.entries(judgeTable)
    .filter(
      ([key]) =>
        (key.startsWith('memory:') && remembers(state, key.slice(7))) ||
        (key.startsWith('message:') && hears(state, key.slice(8)))
    )
    .reduce((table, [, more]) => ({ ...table, ...more }), base);
};
const forbiddenOf = (state) => {
  const told = inner(state.request.untrusted);
  const step = judgeTable[told] ?? judgeTable[told.split('\n')[0]] ?? {};
  return step.forbidden ?? ownerTable(state).forbidden ?? 0.02;
};
const chatIntent = (state) => {
  const table = ownerTable(state);
  return Object.fromEntries(
    INTENT_NAMES.map((name) => [`wants_${name}`, (table[name] ?? INTENT[name]) >= 0.8])
  );
};
const ownerAnswers = (state) => {
  const table = ownerTable(state);
  owned.push({ state, table });
  return bools(
    Object.fromEntries(INTENT_NAMES.map((name) => [`wants_${name}`, table[name] ?? INTENT[name]]))
  );
};
const chatOf = (step, kind) => {
  if (kind !== 'sudo') {
    const level = levelsOf(step);
    const choice = LEVEL_NAMES.reduce((x, y) => (level[y] > level[x] ? y : x));
    return { level: choice, aligned: (step.aligned ?? 1) >= 0.8 };
  }
  return Object.fromEntries(Object.entries(actionsOf(step)).map(([name, p]) => [name, p >= 0.5]));
};
const answers = (step, questions) => {
  if (questions.changes) return bools(actionsOf(step));
  const probabilities = levelsOf(step);
  const choice = LEVEL_NAMES.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  const more = step.more ?? (step.always === true ? 0.05 : 0.9);
  return {
    level: {
      type: 'choice',
      choice,
      probabilities,
      confidence: probabilities[choice],
    },
    aligned: { type: 'bool', probability: step.aligned },
    ...(questions.always ? { always: { type: 'bool', probability: more } } : {}),
  };
};
async function classify(model, context, options) {
  const base = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
  const usage = {
    input: 100,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 102,
    cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
  if (context.questions.wants_read)
    return { ...base, answers: ownerAnswers(context.state), usage, stopReason: 'stop' };
  if (context.questions.forbidden) {
    const p = forbiddenOf(context.state);
    return { ...base, answers: bools({ forbidden: p }), usage, stopReason: 'stop' };
  }
  const seen = {
    model: `${model.provider}/${model.id}`,
    state: context.state,
    questions: Object.keys(context.questions),
    aborted: false,
  };
  judged.push(seen);
  for (const wake of judgedWakes.splice(0)) wake();
  const told = inner(context.state.request.untrusted);
  const listed = judgeTable[told] ?? judgeTable[told.split('\n')[0]] ?? judgeSteps.shift() ?? {};
  const step =
    (listed.remembered === undefined || remembers(context.state, listed.remembered)) &&
    (listed.heard === undefined || hears(context.state, listed.heard))
      ? listed
      : { ...listed, aligned: 0.05 };
  if (step.hold) {
    await new Promise((resolve) => {
      if (options?.signal?.aborted) resolve();
      options?.signal?.addEventListener('abort', resolve, { once: true });
    });
    seen.aborted = true;
    return { ...base, answers: {}, stopReason: 'aborted', errorMessage: 'aborted' };
  }
  if (step.delay) await new Promise((resolve) => setTimeout(resolve, step.delay));
  if (step.stop) return { ...base, answers: {}, stopReason: step.stop, errorMessage: step.error };
  if (step.low === undefined && step.level === undefined && !step.actions)
    throw new Error('no judge answer queued');
  return { ...base, answers: answers(step, context.questions), usage, stopReason: 'stop' };
}
const classifier = (id) => ({
  type: 'classifier',
  id,
  name: id,
  provider: 'judge',
  api: 'judge-classify',
  baseUrl: 'https://judge.test',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
});
const judges = params.has('judge')
  ? [
      createProvider({
        id: 'judge',
        name: 'Judge',
        auth: { apiKey: { name: 'Judge', resolve: async () => ({ auth: {} }) } },
        models: [classifier('j-1'), classifier('j-2')],
        classifiers: { 'judge-classify': { classify } },
      }),
    ]
  : [];
const accounts = [
  ...(params.has('anthropic') ? [anthropicProvider()] : []),
  ...(params.has('openai') ? [openaiProvider()] : []),
];
const triaged = params.get('triage');
const clef = triaged
  ? [
      createProvider({
        id: 'adobe',
        name: 'Clef',
        auth: { apiKey: { name: 'Clef', resolve: async () => ({ auth: {} }) } },
        models: [{ ...classifier('clef-flash'), provider: 'adobe', api: 'clef-classify' }],
        classifiers: {
          'clef-classify': {
            classify: async (model) => ({
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              stopReason: 'stop',
              answers: {
                triage: {
                  type: 'choice',
                  choice: triaged,
                  confidence: 0.9,
                  probabilities:
                    triaged === 'ignore' ? { ignore: 0.9, act: 0.1 } : { act: 0.9, ignore: 0.1 },
                },
              },
            }),
          },
        },
      }),
    ]
  : [];
const aborts = new Map();
self.addEventListener('message', ({ data }) => {
  data?.judged?.postMessage(judged);
  data?.owned?.postMessage(owned);
  if (data?.items) void running.then((host) => data.items.postMessage(host.approvals.state.value));
  if (data?.judgeTable) judgeTable = data.judgeTable;
  if (data?.prompted)
    running
      .then((host) => host.agent.prompt(data.text))
      .then(
        (text) => data.prompted.postMessage(text),
        (error) => data.prompted.postMessage(error.message)
      );
  if (data?.abort) aborts.get(data.abort)?.abort();
  if (data?.close)
    running
      .then((host) => host.close())
      .then(
        () => data.close.postMessage('closed'),
        (error) => data.close.postMessage(error.message)
      );
  if (!data?.approve) return;
  const controller = new AbortController();
  if (data.key) aborts.set(data.key, controller);
  const count = judged.length + 1;
  running
    .then((host) =>
      host.approvals.request(data.approve, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
    )
    .then(async (item) => {
      if (params.has('reply-judged')) await judgedAt(count);
      return item;
    })
    .then(
      (item) => data.reply.postMessage({ item }),
      (error) => data.reply.postMessage({ error: error.message })
    );
});
const version = params.get('version');
if (version) {
  const fetched = self.fetch.bind(self);
  self.fetch = (input, init) =>
    new URL(input instanceof Request ? input.url : input, self.location.href).pathname ===
    '/package.json'
      ? Promise.resolve(Response.json({ version }))
      : fetched(input, init);
}
self.addEventListener('message', ({ data }) => data?.own?.postMessage(own));
self.addEventListener('message', ({ data }) => {
  if (!data?.fetched) return;
  self.fetch(data.url, data.init).then(
    (response) => data.fetched.postMessage({ status: response.status }),
    (error) => data.fetched.postMessage({ error: error.message })
  );
});
if (params.has('own')) {
  const fetched = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === self.location.origin && /^\/(own|\.well-known)\//.test(url.pathname))
      own.push({ url: request.url, method: request.method, credentials: request.credentials });
    return fetched(request);
  };
}
if (params.has('at')) Object.defineProperty(self, 'location', { value: new URL(params.get('at')) });
if (params.has('abandon-abort')) globalThis.sliccAbandonOnAbort = true;
const running = runAgentWorker(self, {
  ...(attach ? { attach } : {}),
  ...(params.has('redirect')
    ? { mcpRedirect: new URL(params.get('redirect'), self.location.origin).href }
    : {}),
  ...(params.has('boot-default') ? {} : { model: { provider: 'faux', modelId: 'faux-1' } }),
  ...(params.has('ttl') ? { approvalMs: Number(params.get('ttl')) } : {}),
  ...(params.has('staged-ms') ? { stagedMs: Number(params.get('staged-ms')) } : {}),
  ...(params.has('run-times') ? { runTimes: JSON.parse(params.get('run-times')) } : {}),
  ...(params.get('hold-lease') === 'published' ? { holdLease: 'published' } : {}),
  providers: [
    faux.provider,
    ...judges,
    ...clef,
    ...e2e,
    ...accounts,
    ...(params.has('bedrock') ? [amazonBedrockProvider()] : []),
    ...(params.has('xai') ? [xaiProvider()] : []),
    ...registry,
  ],
  ...(params.has('default-storage')
    ? {}
    : {
        storage: params.has('persist')
          ? () => openOpfsSqliteStorage({ directory: params.get('persist') })
          : async () => new MemoryStorage(),
      }),
  codemodeWorker: new URL('./codemode-worker.js', import.meta.url),
  ...(params.get('catalog')
    ? { catalog: new URL(params.get('catalog'), self.location.href).href }
    : {}),
});
if (params.has('vault')) {
  const records = params.getAll('record').map((record) => JSON.parse(record));
  const models = [
    ...(params.has('e2e') ? [{ provider: 'adobe', url: `https://${MODEL_HOST}` }] : []),
    ...(params.has('bedrock')
      ? [{ provider: 'amazon-bedrock', url: 'https://bedrock-runtime.us-west-2.amazonaws.com' }]
      : []),
    ...(params.has('xai') ? [{ provider: 'xai', url: 'https://api.x.ai/v1' }] : []),
    ...(params.has('grok-billing') ? [{ provider: 'xai', url: GROK_BILLING }] : []),
    ...registry.flatMap((provider) =>
      provider.getModels().map((model) => ({ provider: provider.id, url: model.baseUrl }))
    ),
    ...(registry.length ? [{ provider: 'github-copilot', url: `https://${COPILOT_API}` }] : []),
  ];
  const fake = fakeVault(params.has('scrub') ? seeded(vectors).values : [], 1, {
    records,
    models,
    ...(params.has('vault-mcp') ? { mcp: JSON.parse(params.get('vault-mcp')) } : {}),
    ...(params.has('vault-http') ? { httpModels: true } : {}),
  });
  self.fakeVault = fake;
  self.dispatchEvent(new MessageEvent('message', { data: { vault: fake.port, scrub: fake.pair } }));
  if (params.has('vault-release'))
    fake.welcome({ version: params.get('vault-release'), scrub: fake.pair, locked: false });
}
