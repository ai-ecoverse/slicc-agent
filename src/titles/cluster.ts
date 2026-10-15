import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable';
import { answerText } from '../agent.ts';

const OUTPUT_LENGTH = 600;

export type Run = { name: string; input: string; output: string; done: boolean };

export type Cluster = { runs: Run[]; at: number; settled: boolean };

type Block = { type?: string; id?: string; name?: string; arguments?: unknown; text?: string };

type Said = {
  content?: unknown;
  toolCallId?: string;
  timestamp?: number;
  stopReason?: string;
};

function blocks(entry: EntryRecord): Block[] {
  const content = (entry.model?.[0] as Said | undefined)?.content;
  return entry.kind === 'pi.assistant' && Array.isArray(content) ? (content as Block[]) : [];
}

export function callIdsOf(views: readonly ConversationView[]): Set<string> {
  const ids = new Set<string>();
  for (const view of views)
    for (const entry of view.entries)
      for (const block of blocks(entry))
        if (block.type === 'toolCall' && block.id) ids.add(block.id);
  return ids;
}

function movedOn(entry: EntryRecord): boolean {
  if (entry.kind === 'pi.user') return true;
  if (entry.kind !== 'pi.assistant') return false;
  const said = entry.model?.[0] as Said | undefined;
  return (
    said?.stopReason !== 'toolUse' ||
    blocks(entry).some((block) => block.type === 'text' && block.text?.trim())
  );
}

export function clusterOf(
  entries: readonly EntryRecord[],
  callIds: readonly string[]
): Cluster | undefined {
  const calls = new Map<string, Pick<Run, 'name' | 'input'> & { at: number }>();
  const results = new Map<string, { output: string; index: number }>();
  entries.forEach((entry, index) => {
    const said = entry.model?.[0] as Said | undefined;
    for (const block of blocks(entry))
      if (block.type === 'toolCall' && block.id)
        calls.set(block.id, {
          name: block.name ?? 'tool',
          input: JSON.stringify(block.arguments ?? {}),
          at: said?.timestamp ?? 0,
        });
    if (entry.kind === 'pi.tool-result' && said?.toolCallId)
      results.set(said.toolCallId, { output: answerText(said.content), index });
  });
  const runs: Run[] = [];
  let at = 0;
  let last = -1;
  for (const id of callIds) {
    const call = calls.get(id);
    if (!call) return undefined;
    const result = results.get(id);
    runs.push({ name: call.name, input: call.input, output: result?.output ?? '', done: !!result });
    at = Math.max(at, call.at);
    last = Math.max(last, result?.index ?? Number.POSITIVE_INFINITY);
  }
  const settled = entries.slice(last + 1).some(movedOn);
  return { runs, at, settled };
}

export function describe(runs: readonly Run[]): string {
  return runs
    .map(
      (run) =>
        `${run.name}: ${run.input}\n=> ${run.done ? run.output.slice(0, OUTPUT_LENGTH) : '(running)'}`
    )
    .join('\n\n');
}
