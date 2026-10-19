import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import vectors from '@ai-ecoverse/slicc-scrub/vectors.json' with { type: 'json' };
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
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
const fauxModels = [
  ...params.getAll('model').map((id) => ({ id })),
  ...params.getAll('blind').map((id) => ({ id, input: ['text'] })),
];
const faux = fauxProvider(fauxModels.length ? { models: fauxModels } : {});
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
    vault:
      self.fakeVault?.log.map(({ op, provider, server, model }) => ({
        op,
        provider,
        server,
        ...(model ? { model } : {}),
      })) ?? [],
  });
  if (data?.unseal && self.fakeVault) {
    self.fakeVault.remove(data.unseal);
    self.fakeVault.publish({ needed: true, version: self.fakeVault.version });
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
const held = (_context, options) =>
  new Promise((resolve) => {
    const done = () => {
      requests.push(JSON.stringify({ held: 'aborted' }));
      resolve(fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted' }));
    };
    if (options?.signal?.aborted) done();
    options?.signal?.addEventListener('abort', done, { once: true });
  });
const gates = new Map();
const gate = (name) => {
  if (!gates.has(name)) gates.set(name, Promise.withResolvers());
  return gates.get(name);
};
self.addEventListener('message', ({ data }) => {
  if (data?.gate) gate(data.gate).resolve();
});
const gated = (name, message) => async (context, options, state, model) => {
  await gate(name).promise;
  return recorded(message)(context, options, state, model);
};
const scoopSteps = params.getAll('scoop-step').map((spec) => {
  const { gate: name, answer } = JSON.parse(spec);
  const message = fauxAssistantMessage(answer);
  return name ? gated(name, message) : recorded(message);
});
const steps = [
  ...params.getAll('step').map((spec) => {
    const { tool, answer, think, error, hold, gate: name } = JSON.parse(spec);
    if (hold) return HOLD;
    if (name) return { gate: name, message: fauxAssistantMessage(answer) };
    if (error) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: error });
    if (think) return fauxAssistantMessage([fauxThinking(think), fauxText(answer)]);
    return tool
      ? fauxAssistantMessage([fauxToolCall(tool.name, tool.args)], { stopReason: 'toolUse' })
      : fauxAssistantMessage(answer);
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
const dispatch = (context, ...rest) => {
  if (titling(context)) return fauxAssistantMessage(`Title ${++titles}`);
  if (labelling(context)) return fauxAssistantMessage(`Label ${++labels}`);
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
    })
  : undefined;
self.mcpRequests = () => fake?.state.requests ?? [];
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
  const side = body.includes('Give this chat a title') || body.includes('Label this group');
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
const registry = params.has('registry') ? sliccProviders() : [];
const completions = (request) => {
  const url = new URL(request.url);
  const authorization =
    request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? null;
  upstream.push({
    url: request.url,
    authorization,
    names: request.headers.map(([name]) => name.toLowerCase()),
  });
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
const relay = {
  traits: { crossOrigin: 'any' },
  async fetch(request) {
    if (registry.length && new URL(request.url).pathname.endsWith('/chat/completions'))
      return completions(request);
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
if (params.has('route')) relay.traits = { crossOrigin: params.get('route') };
self.addEventListener('message', ({ data }) => {
  if (!data?.traits) return;
  relay.traits = data.traits;
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
const attach =
  relayed || params.has('gateway') || registry.length
    ? async (port) => Object.assign(await attachKernel(port), { transport: relay, ...routed })
    : undefined;
const e2e = params.has('e2e')
  ? [adobeProvider({ endpoint: `https://${MODEL_HOST}`, session: 'e2e' })]
  : [];
const judged = [];
let judgeTable = {};
const judgeSteps = params.getAll('judge-step').map((step) => JSON.parse(step));
const inner = (fenced) => fenced.split('\n').slice(1, -1).join('\n');
const answers = (low, aligned) => ({
  risk: {
    type: 'choice',
    choice: low >= 0.5 ? 'low' : 'high',
    probabilities: { low, high: 1 - low },
    confidence: Math.max(low, 1 - low),
  },
  aligned: { type: 'bool', probability: aligned },
});
async function classify(model, context, options) {
  const seen = { model: `${model.provider}/${model.id}`, state: context.state, aborted: false };
  judged.push(seen);
  const step = judgeTable[inner(context.state.request.untrusted)] ?? judgeSteps.shift() ?? {};
  const base = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
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
  if (step.low === undefined) throw new Error('no judge answer queued');
  const usage = {
    input: 100,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 102,
    cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
  return { ...base, answers: answers(step.low, step.aligned), usage, stopReason: 'stop' };
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
  if (data?.judgeTable) judgeTable = data.judgeTable;
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
  running
    .then((host) =>
      host.approvals.request(data.approve, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
    )
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
const running = runAgentWorker(self, {
  ...(attach ? { attach } : {}),
  ...(params.has('redirect')
    ? { mcpRedirect: new URL(params.get('redirect'), self.location.origin).href }
    : {}),
  model: { provider: 'faux', modelId: 'faux-1' },
  ...(params.has('ttl') ? { approvalMs: Number(params.get('ttl')) } : {}),
  providers: [
    faux.provider,
    ...judges,
    ...clef,
    ...e2e,
    ...accounts,
    ...(params.has('bedrock') ? [amazonBedrockProvider()] : []),
    ...registry,
  ],
  storage: params.has('persist')
    ? () => openOpfsSqliteStorage({ directory: params.get('persist') })
    : async () => new MemoryStorage(),
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
    ...registry.flatMap((provider) =>
      provider.getModels().map((model) => ({ provider: provider.id, url: model.baseUrl }))
    ),
  ];
  const fake = fakeVault(params.has('scrub') ? seeded(vectors).values : [], 1, {
    records,
    models,
  });
  self.fakeVault = fake;
  self.dispatchEvent(new MessageEvent('message', { data: { vault: fake.port, scrub: fake.pair } }));
}
