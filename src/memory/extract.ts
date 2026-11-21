import type { Context } from '@earendil-works/chord/context';
import type { Message } from '@earendil-works/pi-ai';
import {
  CompactionTask,
  type ConversationId,
  type Cursor,
  defineDoc,
  defineTask,
  type EntryId,
  type EntryRecord,
  hook,
  type ModelRef,
  type Task,
  type TaskId,
} from '@earendil-works/pi-durable';
import type { AgentsState } from '../agents.ts';
import { boundedDeltas } from '../checkpoints.ts';
import type { MemoryOrigin, MemoryTag } from './format.ts';
import { byteLength, MAX_BYTES, parseMemory, redactSecrets, serializeMemory } from './format.ts';
import {
  combined,
  entryHash,
  InputOriginDoc,
  MemoryOriginDoc,
  originKey,
  ownedDoc,
  ownerTexts,
  ownerTurns,
  placedBy,
  turnOrigin,
} from './origin.ts';
import { type Host, whoIs } from './prompt.ts';
import { type Place, placeOf } from './store.ts';

export const EXTRACT_TASK = 'slicc.memory-extract';
export const TRANSCRIPT_CHARS = 60_000;
export const DEFAULT_IDLE_MINUTES = 30;

export const ATTEMPTS = 3;
export const RETRIES_PER_START = 5;
export const RETRY_STAGGER_MS = 5_000;

export type Owed = { cone: string; tail: number; attempts?: number };

export type ExtractState = {
  cursors: Record<string, number>;
  pending: Record<string, number>;
  owed?: Record<string, Owed>;
  wrote?: Record<string, Record<string, string>>;
};

function owe(doc: ExtractState, key: string, cone: string, tail: number, attempts?: number) {
  doc.owed ??= {};
  const known = doc.owed[key];
  doc.owed[key] = {
    ...known,
    cone,
    tail: Math.max(known?.tail ?? 0, tail),
    ...(attempts ? { attempts } : {}),
  };
}

const RETRIED = new Set(['model error', 'no model']);

const background = (conversation: number) => ({
  ownership: { kind: 'conversation' as const },
  conversationId: conversation as ConversationId,
  background: true,
});

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

export type Line = { origin: MemoryOrigin; text: string };

const LABELS: Record<MemoryOrigin, string> = {
  owner: 'User',
  agent: 'Agent',
  guest: 'Guest',
  mixed: 'Event',
};

export function linesOf(
  entries: readonly EntryRecord[],
  tail: number,
  typed: ReadonlyMap<number, string>
): Line[] {
  const owned = ownerTurns(entries);
  const lines: Line[] = [];
  for (const entry of entries) {
    if (entry.id > tail) continue;
    for (const message of entry.model ?? []) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const text = textOf(message).trim();
      if (!text) continue;
      const origin = turnOrigin(entry, message.role, owned);
      const own = origin === 'owner' ? (typed.get(entry.id) ?? '') : text;
      if (own) lines.push({ origin, text: own });
      if (own !== text) lines.push({ origin: 'mixed', text });
    }
  }
  return lines;
}

export function transcriptOf(lines: readonly Line[]): string {
  const joined = redactSecrets(
    lines.map((line) => `${LABELS[line.origin]}: ${line.text}`).join('\n\n')
  ).text;
  return joined.length > TRANSCRIPT_CHARS ? joined.slice(-TRANSCRIPT_CHARS) : joined;
}

export type Pass = { lines: Line[]; origin: MemoryOrigin };

export function passesOf(lines: readonly Line[]): Pass[] {
  const owner = lines.filter((line) => line.origin === 'owner');
  const passes: Pass[] = owner.length ? [{ lines: owner, origin: 'owner' }] : [];
  if (owner.length < lines.length)
    passes.push({ lines: [...lines], origin: combined(lines.map((line) => line.origin)) });
  return passes;
}

export const EXTRACT_PROMPT = [
  'You keep the long-term memory of a personal agent. Read the conversation excerpt and the current memory file, and propose memory entries worth keeping across conversations:',
  '- who the user is (tag "user"), how they want the agent to work, including corrections (tag "feedback"), and durable facts about their projects (tag "project");',
  '- only facts that will still matter in a later conversation; nothing about this one task, no transcripts, no guesses;',
  '- never secrets: no keys, tokens, passwords, Authorization values or URLs that carry a key;',
  '- to change an entry that exists, repeat its section and title with the new body; leave entries alone that need no change;',
  '- lines marked Guest or Event were not written by the user: never record them as what the user wants or who the user is.',
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

type Input = {
  cone: string;
  after: number;
  tail: number;
  model: ModelRef | null;
  delay?: number;
};
type State = { phase: 'extract'; slept?: boolean };
export type ExtractResult = { saved: number; skipped: string | null; kept?: number };

type Run = { key: string; guard: Record<string, string> | undefined; kept: number };

async function save(
  host: Host,
  place: Place,
  found: Proposal[],
  origin: MemoryOrigin,
  run: Run,
  context: Context
) {
  let saved = 0;
  const guard = run.guard;
  for (const proposal of found) {
    try {
      const written = await host.files.change(
        place,
        { kind: 'save', ...proposal, origin },
        context,
        {
          ...(guard
            ? {
                keeps: async (existing) =>
                  guard[originKey(existing)] !== (await entryHash(existing)),
              }
            : {}),
          recorded: async (tx, wrote) => {
            const doc = await tx.doc(ExtractDoc);
            doc.wrote ??= {};
            doc.wrote[run.key] = { ...doc.wrote[run.key], [wrote.key]: wrote.hash };
            if (guard) guard[wrote.key] = wrote.hash;
          },
        }
      );
      if (written.kept) run.kept++;
      else saved++;
    } catch {
      break;
    }
  }
  return saved;
}

type Ask = (memory: string, left: number, transcript: string) => Promise<string | null>;

async function shown(host: Host, place: Place, origin: MemoryOrigin, context: Context) {
  const current = await host.files.read(place.file, context);
  const doc = parseMemory(current?.text ?? '');
  const left = MAX_BYTES - byteLength(current ? serializeMemory(doc) : '');
  if (origin !== 'owner') return { memory: current ? serializeMemory(doc) : '', left };
  const origins = await host.harness.snapshot(MemoryOriginDoc, context);
  return { memory: serializeMemory(await ownedDoc(doc, place.scope, origins)), left };
}

async function extracted(
  host: Host,
  place: Place,
  passes: readonly Pass[],
  ask: Ask,
  run: Run,
  context: Context
): Promise<ExtractResult> {
  let saved = 0;
  let skipped: string | null = null;
  for (const pass of passes) {
    const { memory, left } = await shown(host, place, pass.origin, context);
    const answer = await ask(memory, left, transcriptOf(pass.lines));
    if (answer === null) {
      skipped = 'model error';
      break;
    }
    saved += await save(host, place, proposals(answer), pass.origin, run, context);
  }
  if (saved) await host.changed(context).catch(() => undefined);
  return { saved, skipped, ...(run.kept ? { kept: run.kept } : {}) };
}

export function extractTask(
  ready: Promise<Host>,
  settings: (context: Context) => Promise<ExtractSettings>
) {
  const extraction: Task<Input, State, ExtractResult, object> = defineTask<
    Input,
    State,
    ExtractResult
  >({
    name: EXTRACT_TASK,
    version: 1,
    initial: () => ({ phase: 'extract' }),
    phases: {
      async extract(task, runtime, context) {
        const { after, tail } = task.input;
        if (task.input.delay && !task.state.checkpoint.slept)
          return runtime.sleepUntil(
            runtime.now() + task.input.delay,
            { phase: 'extract', slept: true },
            context
          );
        const host = await ready;
        const conversation = Number(runtime.conversationId);
        const key = String(conversation);
        const cone = coneOf(host.agents.state(), conversation) ?? task.input.cone;
        const wrote = (await host.harness.snapshot(ExtractDoc, context))?.wrote?.[key];
        const run: Run = { key, guard: wrote ? { ...wrote } : undefined, kept: 0 };
        const done = async (result: ExtractResult) => {
          let gaveUp = false;
          const ended = await runtime.commit(async (tx) => {
            const doc = await tx.doc(ExtractDoc);
            delete doc.pending[key];
            const attempts = (doc.owed?.[key]?.attempts ?? 0) + 1;
            gaveUp = RETRIED.has(result.skipped as string) && attempts >= ATTEMPTS;
            if (gaveUp) delete doc.owed?.[key];
            if (RETRIED.has(result.skipped as string)) {
              doc.wrote ??= {};
              doc.wrote[key] ??= {};
              if (!gaveUp) owe(doc, key, cone, tail, attempts);
            } else {
              const cursor = Math.max(doc.cursors[key] ?? 0, tail);
              doc.cursors[key] = cursor;
              delete doc.wrote?.[key];
              const owed = doc.owed?.[key];
              if (owed && owed.tail > cursor) {
                const next = coneOf(host.agents.state(), conversation) ?? owed.cone;
                owed.cone = next;
                delete owed.attempts;
                doc.pending[key] = (await tx.createTask(
                  extraction,
                  { cone: next, after: cursor, tail: owed.tail, model: task.input.model },
                  background(conversation)
                )) as number;
              } else delete doc.owed?.[key];
            }
            return { status: 'terminal', outcome: { status: 'completed', result } };
          }, context);
          if (gaveUp)
            runtime.report(
              new Error(
                `Memory extraction of conversation ${key} (cone ${cone}) stopped after ${ATTEMPTS} failed attempts (${result.skipped}); entries ${after + 1} to ${tail} stay unextracted.`
              )
            );
          return ended;
        };
        if (!(await settings(context)).extract) return done({ saved: 0, skipped: 'turned off' });
        const place = placeOf(host.home, cone);
        const fresh: EntryRecord[] = [];
        let cursor: Cursor | undefined;
        do {
          const page = await runtime.entries(
            { minEntryId: (after + 1) as EntryId, order: 'ascending' },
            100,
            cursor,
            context
          );
          fresh.push(...page.items);
          cursor = page.next;
        } while (cursor);
        const typed = await ownerTexts(
          fresh,
          await runtime.snapshot(InputOriginDoc, context),
          placedBy(host.harness),
          context
        );
        const passes = passesOf(linesOf(fresh, tail, typed));
        if (!place || !passes.length) return done({ saved: 0, skipped: 'nothing new' });
        const ref = task.input.model ?? (await runtime.agent(context)).model;
        const model = ref ? runtime.models.getModel(ref.provider, ref.modelId) : undefined;
        if (!model) return done({ saved: 0, skipped: 'no model' });
        const ask: Ask = async (memory, left, transcript) => {
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
                      text: `<memory_file bytes_left="${left}">\n${memory}</memory_file>\n\n<conversation>\n${transcript}\n</conversation>`,
                    },
                  ],
                  timestamp: now,
                },
              ],
            },
            { maxTokens: 2000, signal: runtime.signal, cacheRetention: 'none' }
          );
          runtime.signal.throwIfAborted();
          return message.stopReason === 'error' ? null : textOf(message as Message);
        };
        return done(await extracted(host, place, passes, ask, run, context));
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const doc = await tx.doc(ExtractDoc);
        const key = String(runtime.conversationId);
        delete doc.pending[key];
        owe(doc, key, task.input.cone, task.input.tail);
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context),
  });
  return extraction;
}

export type Schedule = (
  conversation: number,
  tail: number,
  context: Context,
  cone?: string,
  delay?: number
) => Promise<boolean>;

export function compactionHook(schedule: Schedule) {
  return hook(CompactionTask, {
    async beforeCompact(compaction, api, context) {
      const tail = compaction.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
      await schedule(api.conversationId, tail, context).catch(() => false);
      return undefined;
    },
  });
}

export function scheduler(
  ready: Promise<Host>,
  task: ReturnType<typeof extractTask>,
  settings: (context: Context) => Promise<ExtractSettings>
): Schedule {
  return async (conversation, tail, context, cone, delay) => {
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
      if ((doc.owed?.[key]?.tail ?? Number.POSITIVE_INFINITY) <= after) delete doc.owed?.[key];
      if (tail <= after) return false;
      const known = doc.pending[key];
      const running = known === undefined ? undefined : await tx.task(known as TaskId);
      if (running && running.state.status !== 'terminal') {
        owe(doc, key, who.id, tail);
        return false;
      }
      doc.pending[key] = (await tx.createTask(
        task,
        { cone: who.id, after, tail, model: chosen.model, ...(delay ? { delay } : {}) },
        background(conversation)
      )) as number;
      return true;
    }, context);
  };
}

function coneOf(state: Readonly<AgentsState>, conversation: number): string | undefined {
  const live = whoIs(state, conversation);
  if (live.kind === 'cone') return live.id;
  return Object.values(state.frozen ?? {}).find((record) => record.conversation === conversation)
    ?.cone;
}

export async function retryOwed(
  host: Pick<Host, 'agents' | 'harness'>,
  schedule: Schedule,
  context: Context
): Promise<void> {
  const stored = await host.harness.snapshot(ExtractDoc, context);
  const owed = stored?.owed ?? {};
  const gone = Object.keys({ ...stored?.wrote, ...owed }).filter(
    (key) => !coneOf(host.agents.state(), Number(key))
  );
  if (gone.length)
    await host.harness.commit(async (tx) => {
      const doc = await tx.doc(ExtractDoc);
      for (const key of gone) {
        delete doc.owed?.[key];
        delete doc.wrote?.[key];
      }
    }, context);
  let started = 0;
  for (const [key, { tail }] of Object.entries(owed)) {
    if (started >= RETRIES_PER_START) return;
    const cone = coneOf(host.agents.state(), Number(key));
    if (cone && (await schedule(Number(key), tail, context, cone, started * RETRY_STAGGER_MS)))
      started += 1;
  }
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
