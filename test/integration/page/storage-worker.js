import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openAgent, openOpfsSqliteStorage } from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(params.getAll('answer').map((answer) => fauxAssistantMessage(answer)));
const model = { provider: 'faux', modelId: 'faux-1' };

async function session(directory, prompt) {
  const storage = await openOpfsSqliteStorage({ directory });
  const agent = await openAgent({ models, model, storage });
  const answer = prompt ? await agent.prompt(prompt) : null;
  const page = await agent.root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
  const kinds = [...page.items].reverse().map((entry) => entry.kind);
  if (params.has('hold')) {
    self.postMessage({ holding: true });
    return new Promise(() => {});
  }
  await agent.close();
  return { answer, kinds };
}

async function run() {
  const first = await session(params.get('directory'), params.get('prompt'));
  if (!params.has('second')) return first;
  return { first, second: await session(params.get('second'), null) };
}

run().then(
  (result) => self.postMessage(result),
  (error) => self.postMessage({ error: String(error?.stack ?? error) })
);
