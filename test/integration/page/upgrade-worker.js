import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { answerText, openAgent, openOpfsSqliteStorage } from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage('Resumed answer.'), fauxAssistantMessage('Third answer.')]);
const model = { provider: 'faux', modelId: 'faux-1' };

async function said(agent) {
  const page = await agent.cone().entries({}, 50, undefined, ctx);
  return [...page.items]
    .reverse()
    .filter((entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant')
    .map((entry) => `${entry.kind}: ${answerText(entry.model?.[0]?.content)}`);
}

async function open() {
  const storage = await openOpfsSqliteStorage({ directory: params.get('directory') });
  const agent = await openAgent({ models, model, storage });
  await agent.cone().waitForIdle(ctx);
  const before = await said(agent);
  const third = await agent.prompt('Third.');
  const after = await said(agent);
  await agent.close();
  return { before, third, after };
}

open().then(
  (result) => self.postMessage(result),
  (error) => self.postMessage({ error: String(error?.stack ?? error) })
);
