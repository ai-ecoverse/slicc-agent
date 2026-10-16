import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import vectors from '@ai-ecoverse/slicc-scrub/vectors.json' with { type: 'json' };
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { createProvider } from '@earendil-works/pi-ai/models';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { adobeProvider, openOpfsSqliteStorage, runAgentWorker } from '../../../src/index.ts';
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
const recorded = (message) => (context) => {
  requests.push(JSON.stringify(context));
  return { ...message, timestamp: Date.now() };
};
const upstream = [];
self.addEventListener('message', ({ data }) => {
  data?.requests?.postMessage(requests);
  data?.upstream?.postMessage({
    upstream,
    vault: self.fakeVault?.log.map(({ op, provider, server }) => ({ op, provider, server })) ?? [],
  });
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
const steps = [
  ...params.getAll('step').map((spec) => {
    const { tool, answer, think, error, hold } = JSON.parse(spec);
    if (hold) return HOLD;
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
const queued = steps.map((step) => (step === HOLD ? held : recorded(step)));
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
  upstream.push({
    authorization:
      request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? null,
    body: new TextDecoder().decode(request.body),
  });
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
const relay = {
  traits: { crossOrigin: 'any' },
  async fetch(request) {
    if (new URL(request.url).host === MODEL_HOST && params.has('e2e')) return model(request);
    if (new URL(request.url).host !== relayed) throw new TypeError('relay: unknown host');
    const response = await fake.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
    });
    return { status: response.status, headers: [...response.headers], body: chunks(response.body) };
  },
};
const attach = relayed
  ? async (port) => Object.assign(await attachKernel(port), { transport: relay })
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
const aborts = new Map();
self.addEventListener('message', ({ data }) => {
  data?.judged?.postMessage(judged);
  if (data?.judgeTable) judgeTable = data.judgeTable;
  if (data?.abort) aborts.get(data.abort)?.abort();
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
    ...e2e,
    ...(params.has('bedrock') ? [amazonBedrockProvider()] : []),
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
  const fake = fakeVault(params.has('scrub') ? seeded(vectors).values : [], 1, { records });
  self.fakeVault = fake;
  self.dispatchEvent(new MessageEvent('message', { data: { vault: fake.port, scrub: fake.pair } }));
}
