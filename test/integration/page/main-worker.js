import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { EncryptedCredentialStore, runAgentWorker } from '../../../src/index.ts';

const faux = fauxProvider();
const params = new URL(self.location.href).searchParams;
faux.setResponses([
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
void runAgentWorker(self, {
  model: { provider: 'faux', modelId: 'faux-1' },
  providers: [faux.provider],
  credentials: () => EncryptedCredentialStore.open('integration-credentials'),
  storage: async () => new MemoryStorage(),
  codemodeWorker: new URL('./codemode-worker.js', import.meta.url),
});
