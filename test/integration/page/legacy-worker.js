import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { GuestsDoc } from '../../../src/guests/seats.ts';
import { openAgent, openOpfsSqliteStorage } from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const said = params.getAll('said');
faux.setResponses(
  Array.from({ length: 4 + said.length }, (_, n) => fauxAssistantMessage(`Seeded ${n + 1}.`))
);
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
  for (const text of said) await agent.prompt(text);
  const kept = await agent.agents.createCone('kept', ctx);
  const conversation = await agent.agents.conversation(kept, ctx);
  await conversation.configure(
    { extensions: { remove: named(['slicc-images']) }, tools: named(['read']) },
    ctx
  );
  for (const seat of params.getAll('seat').map((spec) => JSON.parse(spec)))
    await agent.harness.commit(async (tx) => {
      (await tx.doc(GuestsDoc)).seats[seat.id] = seat;
    }, ctx);
  const bug = params.get('bug');
  if (bug)
    await agent.agents.update((_tx, doc) => {
      const conversation = doc.cones.cone.conversation;
      const record = (cone, name, on) => ({
        cone,
        name,
        conversation: on,
        title: 'First.',
        model: 'faux/old',
        messages: 2,
        frozenAt: 1,
        scoops: [],
      });
      if (bug === 'twin') {
        const twin = `cone-${doc.next}`;
        doc.cones[twin] = { name: 'twin', conversation };
        doc.next += 1;
        if (params.has('active')) doc.active = twin;
        return;
      }
      if (bug === 'orphan') {
        doc.cones = {};
        return;
      }
      if (bug === 'frozen') {
        doc.frozen = {
          'frozen-1': record('cone', 'sliccy', conversation),
          'frozen-2': record(kept, 'kept', doc.cones[kept].conversation),
        };
        doc.frozenNext = 3;
        doc.cones = {};
        return;
      }
      delete doc.cones[kept];
      doc.frozenNext = 2;
      doc.frozen = { 'frozen-1': record('cone', 'sliccy', conversation) };
    }, ctx);
  await agent.close();
  return { kept };
}

async function crash() {
  const storage = await openOpfsSqliteStorage({ directory: params.get('directory') });
  const state = { dead: false };
  const commit = storage.commit.bind(storage);
  storage.commit = async (batches, receive, context) => {
    if (state.dead) throw new Error('simulated crash');
    const result = await commit(batches, receive, context);
    if (batches.some((batch) => batch.some((write) => write.type === 'conversation')))
      state.dead = true;
    return result;
  };
  const opened = await openAgent({ models, model, storage }).then(
    (agent) => ({ cones: Object.keys(agent.agents.state().cones) }),
    (error) => ({ error: error.message })
  );
  return { crashed: state.dead, ...opened };
}

(params.has('crash') ? crash() : seed()).then(
  (result) => self.postMessage(result),
  (error) => self.postMessage({ error: String(error?.stack ?? error) })
);
