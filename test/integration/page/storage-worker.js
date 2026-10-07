import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openAgent, openOpfsSqliteStorage } from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(params.getAll('answer').map((answer) => fauxAssistantMessage(answer)));

async function run() {
  const storage = await openOpfsSqliteStorage({ directory: params.get('directory') });
  const agent = await openAgent({
    models,
    model: { provider: 'faux', modelId: 'faux-1' },
    storage,
  });
  const prompt = params.get('prompt');
  const answer = prompt ? await agent.prompt(prompt) : null;
  const page = await agent.root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
  const kinds = [...page.items].reverse().map((entry) => entry.kind);
  await agent.close();
  return { answer, kinds };
}

run().then(
  (result) => self.postMessage(result),
  (error) => self.postMessage({ error: String(error?.stack ?? error) })
);
