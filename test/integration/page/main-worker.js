import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import vectors from '@ai-ecoverse/slicc-scrub/vectors.json' with { type: 'json' };
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { adobeProvider, runAgentWorker } from '../../../src/index.ts';
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
  return message;
};
const upstream = [];
self.addEventListener('message', ({ data }) => {
  data?.requests?.postMessage(requests);
  data?.upstream?.postMessage({
    upstream,
    vault: self.fakeVault?.log.map(({ op, provider, server }) => ({ op, provider, server })) ?? [],
  });
});
const steps = [
  ...params.getAll('step').map((spec) => {
    const { tool, answer } = JSON.parse(spec);
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
const queued = steps.map(recorded);
let titles = 0;
const titling = (context) =>
  context.messages.length === 1 &&
  JSON.stringify(context.messages[0].content).includes('Give this chat a title');
const dispatch = (context, ...rest) => {
  if (titling(context)) return fauxAssistantMessage(`Title ${++titles}`);
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
  const text = `${chunk({ role: 'assistant', content: 'From the model.' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
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
void runAgentWorker(self, {
  ...(attach ? { attach } : {}),
  ...(params.has('redirect')
    ? { mcpRedirect: new URL(params.get('redirect'), self.location.origin).href }
    : {}),
  model: { provider: 'faux', modelId: 'faux-1' },
  providers: [faux.provider, ...e2e],
  storage: async () => new MemoryStorage(),
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
