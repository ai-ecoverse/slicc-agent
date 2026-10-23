import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Message } from '@earendil-works/pi-ai';
import {
  CompactionTask,
  type ConversationId,
  defineDoc,
  defineTask,
  type EntryId,
  hook,
  type ModelRef,
  type TaskId,
} from '@earendil-works/pi-durable';
import { boundedDeltas } from '../checkpoints.ts';
import type { MemoryTag } from './format.ts';
import { MAX_BYTES, parseMemory, redactSecrets, serializeMemory } from './format.ts';
import { type Host, whoIs } from './prompt.ts';
import { type Place, placeOf } from './store.ts';

export const EXTRACT_TASK = 'slicc.memory-extract';
export const TRANSCRIPT_CHARS = 60_000;
export const DEFAULT_IDLE_MINUTES = 30;

export type ExtractState = {
  cursors: Record<string, number>;
  pending: Record<string, number>;
};

export const ExtractDoc = defineDoc<ExtractState>({
  kind: 'slicc.memory-extract',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ cursors: {}, pending: {} }),
});

export type ExtractSettings = { extract: boolean; model: ModelRef | null; idleMinutes: number };

export function extractSettings(text: string | undefined): ExtractSettings {
  let memory: { extract?: unknown; extractModel?: unknown; idleMinutes?: unknown } = {};
  try {
    const parsed = JSON.parse(text ?? '{}') as { memory?: typeof memory };
    memory = parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {};
  } catch {
    memory = {};
  }
  const named = typeof memory.extractModel === 'string' ? memory.extractModel.split('/') : [];
  const model =
    named.length >= 2 && named[0] && named.slice(1).join('/')
      ? { provider: named[0], modelId: named.slice(1).join('/') }
      : null;
  const idle =
    typeof memory.idleMinutes === 'number' && memory.idleMinutes >= 0
      ? memory.idleMinutes
      : DEFAULT_IDLE_MINUTES;
  return { extract: memory.extract !== false, model, idleMinutes: idle };
}

function textOf(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string; name?: string }) =>
      part.type === 'text'
        ? (part.text ?? '')
        : part.type === 'toolCall'
          ? `[tool ${part.name}]`
          : ''
    )
    .filter(Boolean)
    .join('\n');
}

export function transcriptOf(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = textOf(message).trim();
    if (text) lines.push(`${message.role === 'user' ? 'User' : 'Agent'}: ${text}`);
  }
  const joined = redactSecrets(lines.join('\n\n')).text;
  return joined.length > TRANSCRIPT_CHARS ? joined.slice(-TRANSCRIPT_CHARS) : joined;
}

export const EXTRACT_PROMPT = [
  'You keep the long-term memory of a personal agent. Read the conversation excerpt and the current memory file, and propose memory entries worth keeping across conversations:',
  '- who the user is (tag "user"), how they want the agent to work, including corrections (tag "feedback"), and durable facts about their projects (tag "project");',
  '- only facts that will still matter in a later conversation; nothing about this one task, no transcripts, no guesses;',
  '- never secrets: no keys, tokens, passwords, Authorization values or URLs that carry a key;',
  '- to change an entry that exists, repeat its section and title with the new body; leave entries alone that need no change.',
  'Answer with a JSON array and nothing else: [{"section": "...", "title": "...", "body": "...", "tag": "user" | "feedback" | "project"}]. An empty array is a fine answer.',
].join('\n');

export type Proposal = { section: string; title: string; body: string; tag: MemoryTag | null };

const TAGS = new Set(['user', 'feedback', 'project']);

export function proposals(text: string): Proposal[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Proposal[] = [];
  for (const item of parsed as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const { section, title, body, tag } = item;
    if (typeof section !== 'string' || typeof title !== 'string' || typeof body !== 'string')
      continue;
    if (!section.trim() || !title.trim() || !body.trim()) continue;
    out.push({
      section,
      title,
      body,
      tag: typeof tag === 'string' && TAGS.has(tag) ? (tag as MemoryTag) : null,
    });
  }
  return out.slice(0, 20);
}

type Input = { cone: string; after: number; tail: number; model: ModelRef | null };
type State = { phase: 'extract' };
export type ExtractResult = { saved: number; skipped: string | null };

async function save(host: Host, place: Place, found: Proposal[], context: Context) {
  let saved = 0;
  for (const proposal of found) {
    try {
      await host.files.change(place, { kind: 'save', ...proposal }, context);
      saved++;
    } catch {
      break;
    }
  }
  if (saved) await host.changed(context).catch(() => undefined);
  return saved;
}

export function extractTask(
  ready: Promise<Host>,
  settings: (context: Context) => Promise<ExtractSettings>
) {
  return defineTask<Input, State, ExtractResult>({
    name: EXTRACT_TASK,
    version: 1,
    initial: () => ({ phase: 'extract' }),
    phases: {
      async extract(task, runtime, context) {
        const { cone, after, tail } = task.input;
        const key = String(runtime.conversationId);
        const done = (result: ExtractResult) =>
          runtime.commit(async (tx) => {
            const doc = await tx.doc(ExtractDoc);
            doc.cursors[key] = Math.max(doc.cursors[key] ?? 0, tail);
            delete doc.pending[key];
            return { status: 'terminal', outcome: { status: 'completed', result } };
          }, context);
        if (!(await settings(context)).extract) return done({ saved: 0, skipped: 'turned off' });
        const host = await ready;
        const place = placeOf(host.home, cone);
        const view = await runtime.context(runtime.conversationId, context, {
          at: tail as EntryId,
        });
        const fresh = view.entries.flatMap((entry, index) =>
          entry.id > after ? (view.contributions[index] as readonly Message[]) : []
        );
        const transcript = transcriptOf(fresh);
        if (!place || !transcript) return done({ saved: 0, skipped: 'nothing new' });
        const ref = task.input.model ?? (await runtime.agent(context)).model;
        const model = ref ? runtime.models.getModel(ref.provider, ref.modelId) : undefined;
        if (!model) return done({ saved: 0, skipped: 'no model' });
        const current = await host.files.read(place.file, context);
        const memory = current ? serializeMemory(parseMemory(current.text)) : '';
        const now = Date.now();
        const message = await runtime.models.completeSimple(
          model,
          {
            messages: [
              { role: 'system', content: EXTRACT_PROMPT, timestamp: now } as unknown as Message,
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `<memory_file bytes_left="${MAX_BYTES - new TextEncoder().encode(memory).length}">\n${memory}</memory_file>\n\n<conversation>\n${transcript}\n</conversation>`,
                  },
                ],
                timestamp: now,
              },
            ],
          },
          { maxTokens: 2000, signal: runtime.signal, cacheRetention: 'none' }
        );
        runtime.signal.throwIfAborted();
        if (message.stopReason === 'error') return done({ saved: 0, skipped: 'model error' });
        const saved = await save(host, place, proposals(textOf(message as Message)), context);
        return done({ saved, skipped: null });
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async (tx) => {
        delete (await tx.doc(ExtractDoc)).pending[String(runtime.conversationId)];
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context),
  });
}

export type Schedule = (
  conversation: number,
  tail: number,
  context: Context,
  cone?: string
) => Promise<boolean>;

export function compactionHook(schedule: Schedule) {
  return hook(CompactionTask, {
    beforeCompact(compaction, api) {
      const tail = compaction.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
      void schedule(api.conversationId, tail, BACKGROUND_CONTEXT).catch(() => false);
      return undefined;
    },
  });
}

export function scheduler(
  ready: Promise<Host>,
  task: ReturnType<typeof extractTask>,
  settings: (context: Context) => Promise<ExtractSettings>
): Schedule {
  return async (conversation, tail, context, cone) => {
    const host = await ready;
    const chosen = await settings(context);
    const who = cone
      ? { kind: 'cone' as const, id: cone }
      : whoIs(host.agents.state(), conversation);
    if (who.kind !== 'cone') return false;
    return host.harness.commit(async (tx) => {
      const doc = await tx.doc(ExtractDoc);
      const key = String(conversation);
      const after = doc.cursors[key] ?? 0;
      if (doc.pending[key] !== undefined || tail <= after) return false;
      doc.pending[key] = (await tx.createTask(
        task,
        { cone: who.id, after, tail, model: chosen.model },
        {
          ownership: { kind: 'conversation' },
          conversationId: conversation as ConversationId,
          background: true,
        }
      )) as number;
      return true;
    }, context);
  };
}

export function settingsReader(ready: Promise<Host>) {
  return async (context: Context): Promise<ExtractSettings> => {
    const host = await ready;
    const dir = host.agentDir ?? `${host.home}/.pi/agent`;
    const read = await host.env.readTextFile(`${dir}/settings.json`, context);
    return extractSettings(read.ok ? read.value : undefined);
  };
}

export const IDLE_TASK = 'slicc.memory-idle';

export const IdleDoc = defineDoc<{ tasks: Record<string, number> }>({
  kind: 'slicc.memory-idle',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ tasks: {} }),
});

type IdleState = { phase: 'watch'; tail: number; since: number };

function changedAt(
  entries: readonly { id: number; model?: readonly { timestamp?: unknown }[] }[],
  seen: IdleState,
  now: number
): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (entry.id <= seen.tail) continue;
    for (const message of entry.model ?? [])
      if (typeof message.timestamp === 'number')
        newest = Math.max(newest, Math.min(message.timestamp, now));
  }
  if (newest === Number.NEGATIVE_INFINITY) return seen.tail < 0 ? now : seen.since;
  return Math.max(seen.since, newest);
}

export function idleTask(
  ready: Promise<Host>,
  schedule: Schedule,
  settings: (context: Context) => Promise<ExtractSettings>
) {
  return defineTask<{ cone: string }, IdleState, null>({
    name: IDLE_TASK,
    version: 1,
    initial: () => ({ phase: 'watch', tail: -1, since: 0 }),
    phases: {
      async watch(task, runtime, context) {
        const host = await ready;
        const conversation = runtime.conversationId;
        const key = String(conversation);
        const who = whoIs(host.agents.state(), conversation);
        if (who.kind !== 'cone')
          return runtime.commit(async (tx) => {
            const doc = await tx.doc(IdleDoc);
            if (doc.tasks[key] === Number(task.id)) delete doc.tasks[key];
            return { status: 'terminal', outcome: { status: 'completed', result: null } };
          }, context);
        const { extract, idleMinutes } = await settings(context);
        const on = extract && idleMinutes > 0;
        const idleMs = (on ? idleMinutes : DEFAULT_IDLE_MINUTES) * 60_000;
        const now = runtime.now();
        const view = await runtime.context(conversation, context);
        const tail = view.entries.at(-1)?.id ?? 0;
        const seen = task.state.checkpoint;
        const since = tail === seen.tail ? seen.since : changedAt(view.entries, seen, now);
        const next: IdleState = { phase: 'watch', tail, since };
        const due = since + idleMs;
        if (now < due) return runtime.sleepUntil(due, next, context);
        if (on) await schedule(conversation, tail, context, who.id);
        return runtime.sleepUntil(now + idleMs, next, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const doc = await tx.doc(IdleDoc);
        const key = String(runtime.conversationId);
        if (doc.tasks[key] === Number(task.id)) delete doc.tasks[key];
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context),
  });
}

export function idleWatch(
  host: Pick<Host, 'agents' | 'harness'>,
  task: ReturnType<typeof idleTask>,
  context: Context
): () => void {
  let stopped = false;
  let line = Promise.resolve();
  const ensure = () => {
    line = line
      .then(async () => {
        if (stopped) return;
        await host.harness.commit(async (tx) => {
          const doc = await tx.doc(IdleDoc);
          for (const [id, cone] of Object.entries(host.agents.state().cones)) {
            const key = String(cone.conversation);
            const known = doc.tasks[key];
            const record = known === undefined ? undefined : await tx.task(known as TaskId);
            if (record && record.state.status !== 'terminal') continue;
            doc.tasks[key] = (await tx.createTask(
              task,
              { cone: id },
              {
                ownership: { kind: 'conversation' },
                conversationId: cone.conversation as ConversationId,
                background: true,
              }
            )) as number;
          }
        }, context);
      })
      .catch(() => undefined);
  };
  const off = host.agents.onChange(ensure);
  ensure();
  return () => {
    stopped = true;
    off();
  };
}
