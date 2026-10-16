import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { GuestsDoc } from '../../../src/guests/seats.ts';
import { openAgent, openOpfsSqliteStorage } from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: 4 }, (_, n) => fauxAssistantMessage(`Seeded ${n + 1}.`)));
const model = { provider: 'faux', modelId: 'faux-1' };
const named = (names) => names.map((name) => ({ name }));
const ALL = named([
  'coding-tools',
  'slicc-images',
  'slicc-codemode',
  'slicc-licks',
  'slicc-scoops',
  'slicc-scoop-guard',
  'slicc-skills',
  'slicc-memory',
  'slicc-secrets',
  'slicc-titles',
  'slicc-guest-guard',
]);
const COPIED = ALL.filter(({ name }) => params.get('without') !== name);
const TOOLS = named(['bash', 'read', 'write', 'edit', 'codemode', 'lick_confirm', 'lick_dismiss']);

async function seed() {
  const storage = await openOpfsSqliteStorage({ directory: params.get('directory') });
  const agent = await openAgent({ models, model, storage });
  await agent.cone().configure({ extensions: COPIED, tools: TOOLS }, ctx);
  await agent.prompt('First.');
  await agent.prompt('Second.');
  const kept = await agent.agents.createCone('kept', ctx);
  const conversation = await agent.agents.conversation(kept, ctx);
  await conversation.configure(
    { extensions: { remove: named(['slicc-browser-guard']) }, tools: named(['bash']) },
    ctx
  );
  for (const seat of params.getAll('seat').map((spec) => JSON.parse(spec)))
    await agent.harness.commit(async (tx) => {
      (await tx.doc(GuestsDoc)).seats[seat.id] = seat;
    }, ctx);
  await agent.close();
  return { kept };
}

seed().then(
  (result) => self.postMessage(result),
  (error) => self.postMessage({ error: String(error?.stack ?? error) })
);
