import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import {
  hostAgent,
  openAgent,
  openOpfsSqliteStorage,
  serveConnections,
} from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(params.getAll('answer').map((answer) => fauxAssistantMessage(answer)));

async function start() {
  const directory = params.get('directory');
  const storage = directory ? await openOpfsSqliteStorage({ directory }) : undefined;
  const agent = await openAgent({
    models,
    model: { provider: 'faux', modelId: 'faux-1' },
    storage,
  });
  return hostAgent(agent);
}

serveConnections(self, start());
