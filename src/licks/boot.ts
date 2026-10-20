import type { Context } from '@earendil-works/chord';
import {
  type Conversation,
  defineDoc,
  type EntryRecord,
  type Harness,
} from '@earendil-works/pi-durable';
import { type Job, type Jobs, shortCommand } from '../kernel/jobs.ts';
import type { Deliver } from './fswatch.ts';
import type { LickChannel } from './lick.ts';
import { entryLick } from './state.ts';

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

const BOOT_CHANNELS: ReadonlySet<LickChannel> = new Set(['upgrade', 'session-reload']);

export const LISTED = 5;

interface Block {
  type?: string;
  id?: string;
  name?: string;
  arguments?: { command?: unknown };
}

type Call = { id: string | undefined; command: string; at: number };

function bashCalls(entries: readonly EntryRecord[], after: number): Call[] {
  const calls: Call[] = [];
  let reacting = false;
  for (const entry of entries) {
    if (entry.kind === 'pi.user') {
      const lick = entryLick(entry);
      reacting = lick !== undefined && BOOT_CHANNELS.has(lick.channel);
    }
    if (reacting || entry.kind !== 'pi.assistant' || Number(entry.id) <= after) continue;
    const message = entry.model?.[0] as { content?: unknown; timestamp?: unknown } | undefined;
    const at = typeof message?.timestamp === 'number' ? message.timestamp : 0;
    for (const block of Array.isArray(message?.content) ? (message.content as Block[]) : []) {
      const command = block.arguments?.command;
      if (block.type === 'toolCall' && block.name === 'bash' && typeof command === 'string')
        calls.push({ id: block.id, command, at });
    }
  }
  return calls;
}

export function bashCommands(entries: readonly EntryRecord[], after: number): string[] {
  return bashCalls(entries, after).map((call) => call.command);
}

function ended(entries: readonly EntryRecord[]): Set<string> {
  const done = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'pi.tool-result') continue;
    const id = (entry.model?.[0] as { toolCallId?: unknown } | undefined)?.toolCallId;
    const codes = (
      (entry.data as { diagnostics?: { code?: unknown }[] } | undefined)?.diagnostics ?? []
    ).map((diagnostic) => diagnostic.code);
    if (typeof id === 'string' && !codes.includes('interrupted')) done.add(id);
  }
  return done;
}

export function interruptedCommands(
  entries: readonly EntryRecord[],
  after: number,
  boot: string
): string[] {
  const done = ended(entries);
  const booted = (Number(boot) + 1) * 1000;
  return bashCalls(entries, after)
    .filter((call) => call.at < booted && !(call.id !== undefined && done.has(call.id)))
    .map((call) => shortCommand(call.command));
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

export function listed(all: readonly string[]): string[] {
  const commands = [...new Set(all)];
  const more = commands.length - LISTED;
  return more > 0 ? [...commands.slice(-LISTED), `…and ${more} more`] : commands;
}

export function backgroundList(jobs: readonly Job[]): string[] {
  return listed(jobs.map((job) => job.command));
}

function restartBody(interrupted: readonly string[], jobs: readonly Job[]): string {
  const cut = listed(interrupted);
  const background = backgroundList(jobs);
  const parts = [
    ...(cut.length ? [`Commands that were interrupted mid-run:\n${cut.join('\n')}`] : []),
    ...(background.length
      ? [`Background commands that are no longer running:\n${background.join('\n')}`]
      : []),
  ];
  return parts.length
    ? parts.join('\n\n')
    : 'Files are unchanged. Start again whatever you still need running.';
}

function restarted(boot: string, jobs: readonly Job[], interrupted: readonly string[]) {
  return {
    channel: 'session-reload',
    source: 'kernel',
    title: 'The kernel restarted',
    text: 'The page reloaded, so the kernel started fresh: processes from before the reload are gone.',
    body: restartBody(interrupted, jobs),
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
    if (commands.length || before.length)
      await deliver(
        restarted(facts.boot, before, interruptedCommands(entries, state.mark, facts.boot)),
        context
      );
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
