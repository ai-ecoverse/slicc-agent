import type { Context } from '@earendil-works/chord';
import {
  type Conversation,
  defineDoc,
  type EntryRecord,
  type Harness,
} from '@earendil-works/pi-durable';
import type { Job, Jobs } from '../kernel/jobs.ts';
import type { Deliver } from './fswatch.ts';

type HostState = {
  cron: Record<string, { task: number }>;
  agent: string | null;
  boot: string | null;
  mark: number;
  upgrades: number;
  jobs?: Job[];
};

export const LicksHostDoc = defineDoc<HostState>({
  kind: 'slicc.licks.host',
  version: 1,
  scope: 'session',
  initial: () => ({ cron: {}, agent: null, boot: null, mark: 0, upgrades: 0 }),
});

export interface BootFacts {
  version: string;
  boot: string | null;
}

export const LISTED = 5;

interface Block {
  type?: string;
  name?: string;
  arguments?: { command?: unknown };
}

export function bashCommands(entries: readonly EntryRecord[], after: number): string[] {
  const commands: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'pi.assistant' || Number(entry.id) <= after) continue;
    const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
    for (const block of Array.isArray(content) ? (content as Block[]) : []) {
      const command = block.arguments?.command;
      if (block.type === 'toolCall' && block.name === 'bash' && typeof command === 'string')
        commands.push(command);
    }
  }
  return commands;
}

function upgraded(from: string, to: string, upgrades: number) {
  return {
    channel: 'upgrade',
    source: 'slicc-agent',
    title: `slicc-agent ${from} → ${to}`,
    text: `The agent was updated from ${from} to ${to}.`,
    body: `Release notes: https://github.com/ai-ecoverse/slicc-agent/releases/tag/v${to}`,
    target: 'cone',
    eventId: `${from}->${to}#${upgrades}`,
  } as const;
}

export function backgroundList(jobs: readonly Job[]): string[] {
  const commands = [...new Set(jobs.map((job) => job.command))];
  const more = commands.length - LISTED;
  return more > 0 ? [...commands.slice(-LISTED), `…and ${more} more`] : commands;
}

function restarted(boot: string, jobs: readonly Job[]) {
  const background = backgroundList(jobs);
  return {
    channel: 'session-reload',
    source: 'kernel',
    title: 'The kernel restarted',
    text: 'The page reloaded, so the kernel started fresh: processes from before the reload are gone.',
    body: background.length
      ? `Background commands that are no longer running:\n${background.join('\n')}`
      : 'Files are unchanged. Start again whatever you still need running.',
    target: 'cone',
    eventId: `boot:${boot}`,
  } as const;
}

export async function bootLicks(
  harness: Harness,
  cone: Conversation,
  deliver: Deliver,
  facts: BootFacts,
  context: Context,
  jobs?: Jobs,
  listen?: () => void
): Promise<void> {
  const state = await harness.snapshot(LicksHostDoc, context);
  listen?.();
  const previous = state?.agent ?? null;
  if (previous !== null && previous !== facts.version)
    await deliver(upgraded(previous, facts.version, state?.upgrades ?? 0), context);
  const { entries } = await cone.context(context);
  const before = state?.jobs ?? [];
  if (facts.boot !== null && state?.boot && facts.boot !== state.boot) {
    const commands = bashCommands(entries, state.mark);
    if (commands.length || before.length) await deliver(restarted(facts.boot, before), context);
  } else if (facts.boot !== null && facts.boot === state?.boot) jobs?.adopt(before);
  const { entries: after } = await cone.context(context);
  const mark = Number(after.at(-1)?.id ?? 0);
  await harness.commit(async (tx) => {
    const doc = await tx.doc(LicksHostDoc);
    if (doc.agent !== null && doc.agent !== facts.version) doc.upgrades += 1;
    doc.agent = facts.version;
    if (facts.boot !== null && doc.boot !== facts.boot) {
      doc.boot = facts.boot;
      doc.mark = mark;
    }
    doc.jobs = jobs?.list() ?? [];
  }, context);
}

function recordJobs(harness: Harness, jobs: Jobs, context: Context): () => void {
  let chain: Promise<void> = Promise.resolve();
  return jobs.watch(() => {
    chain = chain
      .then(() =>
        harness.commit(async (tx) => {
          (await tx.doc(LicksHostDoc)).jobs = jobs.list();
        }, context)
      )
      .catch(() => undefined);
    return chain;
  });
}

export function booting(
  harness: Harness,
  cone: () => Conversation,
  deliver: Deliver,
  jobs: Jobs | undefined
) {
  let stopped = false;
  let off = () => undefined as void;
  return {
    async boot(facts: BootFacts, context: Context): Promise<void> {
      await bootLicks(harness, cone(), deliver, facts, context, jobs, () => {
        off();
        if (jobs && !stopped) off = recordJobs(harness, jobs, context);
      });
    },
    stop() {
      stopped = true;
      off();
    },
  };
}
