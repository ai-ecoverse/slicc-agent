import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { EncryptedCredentialStore, runAgentWorker } from '../../../src/index.ts';

const faux = fauxProvider();
faux.setResponses(
  new URL(self.location.href).searchParams
    .getAll('answer')
    .map((answer) => fauxAssistantMessage(answer))
);
void runAgentWorker(self, {
  model: { provider: 'faux', modelId: 'faux-1' },
  providers: [faux.provider],
  credentials: () => EncryptedCredentialStore.open('integration-credentials'),
  storage: async () => new MemoryStorage(),
});
