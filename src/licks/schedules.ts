import type { Context } from '@earendil-works/chord';
import {
  type Conversation,
  defineDoc,
  type Harness,
  type TaskId,
} from '@earendil-works/pi-durable';
import type { CronEntry } from './config.ts';
import type { CronInput, cronTask } from './extension.ts';

type CronRecord = {
  schedule: string;
  target: string;
  message: string;
  task: number;
};

type HostState = {
  cron: Record<string, CronRecord>;
  agent: string | null;
  boot: string | null;
  mark: number;
  upgrades: number;
};

export const LicksHostDoc = defineDoc<HostState>({
  kind: 'slicc.licks.host',
  version: 1,
  scope: 'session',
  initial: () => ({ cron: {}, agent: null, boot: null, mark: 0, upgrades: 0 }),
});

function same(entry: CronEntry | undefined, record: CronRecord): boolean {
  return (
    entry !== undefined &&
    entry.schedule === record.schedule &&
    entry.target === record.target &&
    entry.message === record.message
  );
}

async function live(harness: Harness, task: number, context: Context): Promise<boolean> {
  const record = await harness.getTask(task as TaskId, context);
  return record !== undefined && record.state.status !== 'terminal';
}

export async function reconcileCron(
  options: {
    harness: Harness;
    root: Conversation;
    cron: ReturnType<typeof cronTask>;
    now: () => number;
  },
  entries: readonly CronEntry[],
  context: Context
): Promise<void> {
  const { harness } = options;
  const wanted = new Map(entries.map((entry) => [entry.name, entry]));
  const stored: Readonly<Record<string, CronRecord>> =
    (await harness.snapshot(LicksHostDoc, context))?.cron ?? {};
  const stale: string[] = [];
  const create: CronEntry[] = entries.filter((entry) => !stored[entry.name]);
  for (const [name, record] of Object.entries(stored)) {
    const entry = wanted.get(name);
    const running = await live(harness, record.task, context);
    if (same(entry, record) && running) continue;
    stale.push(name);
    if (running) await harness.abortTask(record.task as TaskId, context);
    if (entry) create.push(entry);
  }
  if (!stale.length && !create.length) return;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(LicksHostDoc);
    for (const name of stale) delete doc.cron[name];
    for (const entry of create) {
      const input: CronInput = { ...entry, from: options.now() };
      const task = await tx.createTask(options.cron, input, {
        ownership: { kind: 'conversation' },
        conversationId: options.root.id,
        background: true,
      });
      doc.cron[entry.name] = { ...entry, task };
    }
  }, context);
}
