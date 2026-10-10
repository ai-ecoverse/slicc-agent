import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { EncryptedCredentialStore, runAgentWorker } from '../../../src/index.ts';
import { createMcpServer } from '../fixtures/mcp-server.mjs';

const faux = fauxProvider();
const params = new URL(self.location.href).searchParams;
faux.setResponses([
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
]);
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
const relay = {
  traits: { crossOrigin: 'any' },
  async fetch(request) {
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
void runAgentWorker(self, {
  ...(attach ? { attach } : {}),
  model: { provider: 'faux', modelId: 'faux-1' },
  providers: [faux.provider],
  credentials: () => EncryptedCredentialStore.open('integration-credentials'),
  storage: async () => new MemoryStorage(),
  codemodeWorker: new URL('./codemode-worker.js', import.meta.url),
  ...(params.get('catalog')
    ? { catalog: new URL(params.get('catalog'), self.location.href).href }
    : {}),
});
