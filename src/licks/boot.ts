import type { Context } from '@earendil-works/chord';
import type { Conversation, EntryRecord, Harness } from '@earendil-works/pi-durable';
import type { Deliver } from './fswatch.ts';
import { LicksHostDoc } from './schedules.ts';

export interface BootFacts {
  version: string;
  boot: string | null;
}

const BACKGROUND = /(?:&\s*$|&\s*disown\b|\bnohup\b|\bsetsid\b)/m;

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

function upgraded(from: string, to: string) {
  return {
    channel: 'upgrade',
    source: 'slicc-agent',
    title: `slicc-agent ${from} → ${to}`,
    text: `The agent was updated from ${from} to ${to}.`,
    body: `Release notes: https://github.com/ai-ecoverse/slicc-agent/releases/tag/v${to}`,
    target: 'cone',
    eventId: `${from}->${to}`,
  } as const;
}

function restarted(boot: string, commands: readonly string[]) {
  const background = commands.filter((command) => BACKGROUND.test(command)).slice(-5);
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
  context: Context
): Promise<void> {
  const state = await harness.snapshot(LicksHostDoc, context);
  const previous = state?.agent ?? null;
  if (previous !== null && previous !== facts.version)
    await deliver(upgraded(previous, facts.version), context);
  const { entries } = await cone.context(context);
  if (facts.boot !== null && state?.boot && facts.boot !== state.boot) {
    const commands = bashCommands(entries, state.mark);
    if (commands.length) await deliver(restarted(facts.boot, commands), context);
  }
  const { entries: after } = await cone.context(context);
  const mark = Number(after.at(-1)?.id ?? 0);
  await harness.commit(async (tx) => {
    const doc = await tx.doc(LicksHostDoc);
    doc.agent = facts.version;
    if (facts.boot !== null && doc.boot !== facts.boot) {
      doc.boot = facts.boot;
      doc.mark = mark;
    }
  }, context);
}
