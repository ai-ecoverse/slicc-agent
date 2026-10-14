import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import {
  type ConversationId,
  type ConversationView,
  defineDoc,
  type EntryRecord,
  type Harness,
  type Tx,
  UsageDoc,
} from '@earendil-works/pi-durable';
import { answerText } from '../agent.ts';
import type { Agents } from '../agents.ts';
import type { VaultState } from '../secrets/vault.ts';
import { vaultHold } from '../secrets/view.ts';
import { type Labeler, scrubbed } from './generate.ts';
import { labelKey, shownLabel } from './shown.ts';

export type LabelsState = { labels: Record<string, string> };

export const LabelsDoc = defineDoc<LabelsState>({
  kind: 'slicc.labels',
  version: 1,
  scope: 'session',
  initial: () => ({ labels: {} }),
});

export const LABELS_KEPT = 500;
export const LABELS_PER_MINUTE = 6;
const MINUTE = 60_000;
const LABEL_WORDS = 8;
const LABEL_LENGTH = 80;
const OUTPUT_LENGTH = 600;

export const LABEL_WAIT_MS = 30_000;

function callIdsOf(views: readonly ConversationView[]): Set<string> {
  const ids = new Set<string>();
  for (const view of views)
    for (const entry of view.entries) {
      const content = (entry.model?.[0] as Said | undefined)?.content;
      if (entry.kind === 'pi.assistant' && Array.isArray(content))
        for (const block of content as Block[])
          if (block.type === 'toolCall' && block.id) ids.add(block.id);
    }
  return ids;
}

export function visibleLabels(
  labels: ReplicatedState<Record<string, string>>,
  sources: readonly ReplicatedState<unknown>[],
  views: () => readonly ConversationView[]
) {
  const pick = () => {
    const ids = callIdsOf(views());
    return Object.fromEntries(
      Object.entries(labels.value as Record<string, string>).filter(([key]) =>
        key.split(' ').every((id) => ids.has(id))
      )
    );
  };
  const state = replicatedState<Record<string, string>>(pick());
  let queued = false;
  const update = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const next = pick();
      const before = state.value;
      const keys = Object.keys(next);
      if (
        keys.length !== Object.keys(before).length ||
        keys.some((key) => before[key] !== next[key])
      )
        state.replace(BACKGROUND_CONTEXT, next);
    });
  };
  const offs = [labels, ...sources].map((source) => source.subscribe(update));
  return {
    state,
    dispose() {
      for (const off of offs) off();
    },
  };
}

export function watchLabel(
  labels: ReplicatedState<Record<string, string>>,
  waitMs = LABEL_WAIT_MS
) {
  return (_agentId: string, callIds: readonly string[]): Promise<string | null> => {
    const found = shownLabel(labels.value, callIds);
    if (found !== undefined || !callIds.length) return Promise.resolve(found ?? null);
    return new Promise((resolve) => {
      const done = (label: string | null) => {
        clearTimeout(timer);
        off();
        resolve(label);
      };
      const timer = setTimeout(() => done(null), waitMs);
      const off = labels.subscribe(() => {
        const label = shownLabel(labels.value, callIds);
        if (label !== undefined) done(label);
      });
    });
  };
}

export function cleanLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\.+$/, '')
    .trim()
    .split(' ')
    .slice(0, LABEL_WORDS)
    .join(' ')
    .slice(0, LABEL_LENGTH);
}

export type Run = { name: string; input: string; output: string; at: number };

type Block = { type?: string; id?: string; name?: string; arguments?: unknown };

type Said = { content?: unknown; toolCallId?: string; timestamp?: number };

export function clusterOf(
  entries: readonly EntryRecord[],
  callIds: readonly string[]
): Run[] | undefined {
  const calls = new Map<string, Pick<Run, 'name' | 'input'>>();
  const results = new Map<string, Pick<Run, 'output' | 'at'>>();
  for (const entry of entries) {
    const said = entry.model?.[0] as Said | undefined;
    if (entry.kind === 'pi.assistant' && Array.isArray(said?.content))
      for (const block of said.content as Block[])
        if (block.type === 'toolCall' && block.id)
          calls.set(block.id, {
            name: block.name ?? 'tool',
            input: JSON.stringify(block.arguments ?? {}),
          });
    if (entry.kind === 'pi.tool-result' && said?.toolCallId)
      results.set(said.toolCallId, {
        output: answerText(said.content),
        at: said.timestamp ?? 0,
      });
  }
  const runs: Run[] = [];
  for (const id of callIds) {
    const call = calls.get(id);
    const result = results.get(id);
    if (!call || !result) return undefined;
    runs.push({ ...call, ...result });
  }
  return runs;
}

export function describe(runs: readonly Run[]): string {
  return runs
    .map((run) => `${run.name}: ${run.input}\n=> ${run.output.slice(0, OUTPUT_LENGTH)}`)
    .join('\n\n');
}

type Counted = Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'totalTokens', number> & {
  cost: Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total', number>;
};

async function spend(tx: Tx, conversation: ConversationId, answer: AssistantMessage) {
  const models = (await tx.doc(UsageDoc, conversation)).models as unknown as Record<
    string,
    Counted
  >;
  const key = `${answer.provider}/${answer.model}`;
  const usage = answer.usage as Usage;
  const total = Object.hasOwn(models, key) ? models[key] : undefined;
  if (!total) {
    models[key] = JSON.parse(JSON.stringify(usage)) as Counted;
    return;
  }
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
    total[field] += usage[field];
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
    total.cost[field] += usage.cost[field];
}

export interface LabelsAttach {
  harness: Pick<Harness, 'commit'>;
  agents: Pick<Agents, 'conversation'>;
  label: Labeler;
  vault?: Pick<ReplicatedState<VaultState>, 'value'>;
  now?: () => number;
  perMinute?: number;
}

export interface LabelsRuntime {
  labels: ReplicatedState<Record<string, string>>;
  label(agentId: string, callIds: readonly string[], context: Context): Promise<string | null>;
}

function modelName(model: { provider: string; modelId: string } | undefined): string {
  return model ? `${model.provider}/${model.modelId}` : '';
}

export async function attachLabels(
  options: LabelsAttach,
  context: Context = BACKGROUND_CONTEXT
): Promise<LabelsRuntime> {
  const { harness, agents } = options;
  const now = options.now ?? Date.now;
  const started = now();
  const cap = options.perMinute ?? LABELS_PER_MINUTE;
  const loaded = await harness.commit(
    async (tx) => ({ ...(await tx.doc(LabelsDoc)).labels }),
    context
  );
  const labels = replicatedState<Record<string, string>>(loaded);
  const flying = new Map<string, Promise<string | null>>();
  const spent = new Map<string, number[]>();
  const admit = (agentId: string) => () => {
    const at = now();
    const recent = (spent.get(agentId) ?? []).filter((time) => at - time < MINUTE);
    spent.set(agentId, recent);
    if (recent.length >= cap) return false;
    recent.push(at);
    return true;
  };
  const keep = (
    key: string,
    label: string,
    conversation: ConversationId,
    answer: AssistantMessage
  ) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(LabelsDoc);
      doc.labels[key] = label;
      const keys = Object.keys(doc.labels);
      for (const old of keys.slice(0, Math.max(0, keys.length - LABELS_KEPT)))
        delete doc.labels[old];
      await spend(tx, conversation, answer);
      return { ...doc.labels };
    }, BACKGROUND_CONTEXT);
  const make = async (agentId: string, callIds: readonly string[], key: string) => {
    const conversation = await agents.conversation(agentId, BACKGROUND_CONTEXT);
    if (!conversation) return null;
    const runs = clusterOf((await conversation.context(BACKGROUND_CONTEXT)).entries, callIds);
    if (!runs || Math.max(...runs.map((run) => run.at)) < started) return null;
    if (vaultHold(options.vault?.value)) return null;
    const text = await scrubbed(describe(runs));
    const model = modelName((await conversation.agent(BACKGROUND_CONTEXT)).model);
    const asked = await options.label(text, model, BACKGROUND_CONTEXT, admit(agentId));
    if (!asked) return null;
    const label = cleanLabel(asked.text);
    labels.replace(BACKGROUND_CONTEXT, await keep(key, label, conversation.id, asked.answer));
    return label || null;
  };
  return {
    labels,
    label(agentId, callIds, _context) {
      if (!callIds.length) return Promise.resolve(null);
      const key = labelKey(callIds);
      const found = shownLabel(labels.value, callIds);
      if (found !== undefined) return Promise.resolve(found);
      const known = flying.get(key);
      if (known !== undefined) return known;
      const made = make(agentId, callIds, key)
        .catch(() => null)
        .finally(() => flying.delete(key));
      flying.set(key, made);
      return made;
    },
  };
}
