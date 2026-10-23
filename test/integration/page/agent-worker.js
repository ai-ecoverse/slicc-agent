import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, section } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import {
  attachApprovals,
  hostAgent,
  kernelEnvironment,
  kernelPort,
  openAgent,
  openOpfsSqliteStorage,
  serveConnections,
} from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const script = params
  .getAll('bash')
  .map((command) =>
    fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' })
  );
const seen = [];
const recorded = (message) => (context) => {
  seen.push(JSON.stringify(context.messages.at(-1)?.content ?? ''));
  return message;
};
faux.setResponses(
  [
    ...script,
    ...params.getAll('answer').map((answer) => fauxAssistantMessage([fauxText(answer)])),
  ].map(recorded)
);
const kernel = params.has('kernel');
const fakeClock = (start) => {
  let offset = 0;
  const timers = new Set();
  return {
    now: () => start + offset,
    setTimer(callback, delayMs) {
      const timer = { at: start + offset + delayMs, callback };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms) {
      offset += ms;
      for (const timer of [...timers])
        if (timer.at <= start + offset) {
          timers.delete(timer);
          timer.callback();
        }
    },
  };
};
const clock = params.has('fake-clock') ? fakeClock(Date.now()) : undefined;
const port = kernelPort(self);
let commits = 0;

const crash = params.get('crash');
const delivery = (writes) =>
  writes.some(
    (write) => write.type === 'submission' && write.value.requestId?.startsWith('guest:')
  );

function crashing(storage) {
  if (!crash) return storage;
  const commit = storage.commit.bind(storage);
  storage.commit = async (writes, context) => {
    if (!delivery(writes)) return commit(writes, context);
    if (crash === 'after') await commit(writes, context);
    self.postMessage({ crashed: crash });
    return new Promise(() => {});
  };
  return storage;
}

async function start() {
  const directory = params.get('directory');
  const storage = directory ? crashing(await openOpfsSqliteStorage({ directory })) : undefined;
  const registry = createRegistry();
  if (params.has('failing-section'))
    registry.install(
      defineExtension({
        name: 'broken-notes',
        sections: [
          section('notes', () => {
            throw new Error(params.get('failing-section'));
          }),
        ],
      })
    );
  let env;
  if (kernel) {
    registry.install(CodingTools);
    env = kernelEnvironment(await attachKernel(await port));
  }
  const agent = await openAgent({
    models,
    model: { provider: 'faux', modelId: 'faux-1' },
    storage,
    registry,
    env,
    ...(clock ? { clock } : {}),
  });
  const harness = {
    commit(...args) {
      commits += 1;
      return agent.harness.commit(...args);
    },
    documentState: (...args) => agent.harness.documentState(...args),
  };
  const ttlMs = {
    ...(params.has('ttl') ? { ttlMs: Number(params.get('ttl')) } : {}),
    ...(clock ? { now: clock.now, setTimer: clock.setTimer } : {}),
  };
  if (params.has('native')) return hostAgent(agent);
  return hostAgent(agent, { approvals: await attachApprovals({ harness, ...ttlMs }) });
}

let guestLinks = 0;
const collected = new FinalizationRegistry(() => {
  guestLinks -= 1;
});

async function collect() {
  for (let i = 0; i < 6; i++) {
    globalThis.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { gc: typeof globalThis.gc === 'function', alive: guestLinks };
}

const host = start();
self.addEventListener('message', ({ data }) => {
  if (data?.connect && data?.guest) {
    guestLinks += 1;
    collected.register(data.connect, null);
  }
  if (data?.guestLinks) void collect().then((seen) => data.guestLinks.postMessage(seen));
  if (data?.commits) data.commits.postMessage(commits);
  if (data?.advance) {
    clock?.advance(data.advance);
    data.advanced.postMessage(clock ? clock.now() : null);
  }
  if (data?.seen) data.seen.postMessage(seen);
  if (data?.reviews)
    void host.then((ready) => data.reviews.postMessage(ready.guests.reviews.value ?? null));
  if (data?.seat)
    void host.then((ready) => data.reply.postMessage(ready.guests.record(data.seat) ?? null));
  if (!data?.approve) return;
  host
    .then((ready) => ready.approvals.request(data.approve, BACKGROUND_CONTEXT))
    .then(
      (item) => data.reply.postMessage({ item }),
      (error) => data.reply.postMessage({ error: error.message })
    );
});
serveConnections(self, host);
