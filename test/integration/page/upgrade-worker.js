import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import init from '@sqlite.org/sqlite-wasm';
import { answerText, openAgent, openOpfsSqliteStorage } from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const mode = params.get('mode');
const directory = params.get('directory');
const FILE = '/agent.sqlite';
const context = BACKGROUND_CONTEXT;

async function pooled(work) {
  const sqlite3 = await init();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'pi-upgrade', directory });
  try {
    return await work(pool);
  } finally {
    pool.pauseVfs();
  }
}

function tasksOf(pool) {
  const db = new pool.OpfsSAHPoolDb(FILE);
  try {
    return db.selectObjects(
      "SELECT json_extract(record, '$.kind') AS kind, status, json_extract(record, '$.version') AS version FROM tasks WHERE json_extract(record, '$.kind') LIKE 'pi.%' ORDER BY id"
    );
  } finally {
    db.close();
  }
}

async function imported() {
  const gzipped = await new Promise((resolve) => {
    self.onmessage = ({ data }) => resolve(data.fixture);
  });
  const plain = new Uint8Array(
    await new Response(
      new Blob([gzipped]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer()
  );
  return pooled(async (pool) => {
    await pool.importDb(FILE, plain);
    return { tasks: tasksOf(pool) };
  });
}

const read = () =>
  pooled(async (pool) => ({
    tasks: tasksOf(pool),
    ...(params.has('export') ? { bytes: Array.from(pool.exportFile(FILE)) } : {}),
  }));

function registryWithHold() {
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'pi-upgrade-hold',
      tools: [
        defineTool({
          name: 'hold',
          description: 'Holds until the worker restarts.',
          parameters: obj({}),
          replay: 'safe',
          async execute() {
            if (mode === 'hold') {
              self.postMessage({ holding: true });
              return new Promise(() => {});
            }
            return { output: [{ type: 'text', text: 'held' }] };
          },
        }),
      ],
    })
  );
  return registry;
}

function fauxModels(steps) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

const model = { provider: 'faux', modelId: 'faux-1' };

const live = (inspection) =>
  inspection.tasks
    .filter((task) => task.record.kind.startsWith('pi.'))
    .map((task) => ({
      kind: task.record.kind,
      version: task.record.version,
      state: task.state.kind,
      ...('migrates' in task.state ? { migrates: task.state.migrates } : {}),
      ...('reason' in task.state ? { reason: task.state.reason } : {}),
    }));

async function hold() {
  const storage = await openOpfsSqliteStorage({ directory });
  const models = fauxModels([
    fauxAssistantMessage([fauxToolCall('hold', {})], { stopReason: 'toolUse' }),
  ]);
  const agent = await openAgent({ models, model, storage, registry: registryWithHold() });
  await agent.cone().submit({ type: 'input', content: 'Hold on.' }, context);
  return new Promise(() => {});
}

const within = (promise, ms) =>
  Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

async function resume() {
  const storage = await openOpfsSqliteStorage({ directory });
  const models = fauxModels([fauxAssistantMessage([fauxText('Resumed.')])]);
  let before = [];
  const agent = await openAgent({
    models,
    model,
    storage,
    registry: registryWithHold(),
    beforeResume: async (harness, at) => {
      before = live(await harness.inspect(at));
    },
  });
  const idle = await within(agent.harness.waitForIdle(context), Number(params.get('ms') ?? 20000));
  const after = live(await agent.harness.inspect(context));
  const page = await agent.cone().entries({}, 50, undefined, context);
  const entries = [...page.items].reverse();
  const texts = (kind) =>
    entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => answerText(entry.model?.[0]?.content));
  const result = {
    idle,
    before,
    after,
    users: texts('pi.user'),
    results: texts('pi.tool-result'),
    answers: texts('pi.assistant'),
  };
  await agent.close();
  return result;
}

const modes = { import: imported, read, hold, resume };

modes[mode]().then(
  (result) => self.postMessage(result),
  (error) => self.postMessage({ error: String(error?.stack ?? error) })
);
