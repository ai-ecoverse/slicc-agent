import { openAgent, openOpfsSqliteStorage } from 'slicc-agent-6';
import { BACKGROUND_CONTEXT as ctx } from '../../../node_modules/slicc-agent-6/node_modules/@earendil-works/chord/dist/context/index.js';
import { createModels } from '../../../node_modules/slicc-agent-6/node_modules/@earendil-works/pi-ai/dist/models.js';
import {
  fauxAssistantMessage,
  fauxProvider,
} from '../../../node_modules/slicc-agent-6/node_modules/@earendil-works/pi-ai/dist/providers/faux.js';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: 'faux', modelId: 'faux-1' };

async function write() {
  let asked;
  const reached = new Promise((resolve) => {
    asked = resolve;
  });
  faux.setResponses([
    fauxAssistantMessage('Old answer.'),
    () => {
      asked();
      return new Promise(() => {});
    },
  ]);
  const storage = await openOpfsSqliteStorage({ directory: params.get('directory') });
  const agent = await openAgent({ models, model, storage });
  const answer = await agent.prompt('First.');
  await agent.cone().submit({ type: 'input', content: 'Second.' }, ctx);
  await reached;
  self.postMessage({ answer, holding: true });
}

async function reopen() {
  const storage = await openOpfsSqliteStorage({ directory: params.get('directory') });
  const agent = await openAgent({ models, model, storage });
  await agent.close();
  self.postMessage({ opened: true });
}

(params.has('reopen') ? reopen() : write()).catch((error) =>
  self.postMessage({ error: String(error?.message ?? error) })
);
