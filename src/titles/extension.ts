import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  Extension,
  Harness,
  TaskId,
  TaskRuntime,
} from '@earendil-works/pi-durable';
import {
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  runEndTask,
} from '@earendil-works/pi-durable';
import { answerText } from '../agent.ts';
import type { Agents, ConeRecord } from '../agents.ts';
import { scrubTranscript } from './generate.ts';

export const TITLES = 'slicc-titles';

const TITLE_LENGTH = 60;
const TITLE_WORDS = 6;
export const TITLE_TURNS = [1, 3];
const TRIVIAL_WORDS = 4;

function textOf(entry: EntryRecord): string {
  return answerText(entry.model?.[0]?.content).trim();
}

export function trivial(text: string): boolean {
  const words = text
    .split(/\s+/)
    .map((word) => word.replace(/\p{P}|\p{S}|\u200d|\ufe0f/gu, ''))
    .filter(Boolean);
  return (
    words.length < TRIVIAL_WORDS && !(words.length === 1 && [...(words[0] as string)].length >= 8)
  );
}

export function titleDue(
  record: Pick<ConeRecord, 'titled'>,
  entries: readonly EntryRecord[],
  final = false
): number | undefined {
  const last = entries.at(-1);
  const stop = (last?.model?.[0] as { stopReason?: unknown } | undefined)?.stopReason;
  if (last?.kind !== 'pi.assistant' || stop !== 'stop') return undefined;
  const said = entries.filter((entry) => entry.kind === 'pi.user' && textOf(entry));
  const greeting = !final && trivial(textOf(said[0] ?? ({} as EntryRecord)));
  const next = TITLE_TURNS.find((turn) => turn > (record.titled ?? 0) && !(greeting && turn === 1));
  return next !== undefined && said.length >= next ? said.length : undefined;
}

export function cleanTitle(title: string | undefined): string | undefined {
  const clean = title
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'""]+|["'""]+$/g, '')
    .replace(/\.+$/, '')
    .trim()
    .split(' ')
    .slice(0, TITLE_WORDS)
    .join(' ');
  return clean ? clean.slice(0, TITLE_LENGTH) : undefined;
}

export type TitleFn = (
  transcript: string,
  model: string,
  context: Context
) => Promise<string | undefined>;

type Titled = Pick<ConeRecord, 'conversation' | 'title' | 'titled'>;

function findAgent(
  agents: Agents,
  conversationId: ConversationId
): { id: string; record: Titled } | undefined {
  const state = agents.state();
  const cid = conversationId as number;
  for (const [id, cone] of Object.entries(state.cones))
    if (cone.conversation === cid) return { id, record: cone };
  const found = Object.entries(state.scoops).find(
    ([, scoop]) => scoop.conversation === cid && !scoop.frozen && !scoop.gone
  );
  return found ? { id: found[0], record: found[1] } : undefined;
}

export interface TitlesAttach {
  agents: () => Agents | undefined;
  harness: () => Harness | undefined;
  title: () => TitleFn | undefined;
}

function modelName(model: { provider: string; modelId: string } | undefined): string {
  return model ? `${model.provider}/${model.modelId}` : '';
}

const DUE_TASK = 'slicc.title-due';
const TITLE_TASK = 'slicc.title';
const PAGE = 100;

type History = Pick<TaskRuntime<unknown, { phase: string }, unknown, object>, 'entries'>;

async function history(runtime: History, max: number | undefined, context: Context) {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await runtime.entries(
      {
        ...(max === undefined ? {} : { maxEntryId: max as EntryId }),
        order: 'ascending',
      },
      PAGE,
      cursor,
      context
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return entries;
}

export interface TitlesRuntime {
  extension: Extension;
  cancel(agentId: string): void;
}

export function titlesExtension(deps: TitlesAttach): TitlesRuntime {
  const pending = new Map<string, { token: symbol; conversation: number; taskId: number }>();

  const named = (
    entries: readonly EntryRecord[],
    model: string,
    context: Context,
    title: TitleFn
  ): Promise<string | undefined> =>
    scrubTranscript(entries)
      .then((transcript) => title(transcript, model, context))
      .then(cleanTitle)
      .catch(() => undefined);

  const write = (
    agents: Agents,
    id: string,
    titled: Titled,
    turns: number,
    title: string | undefined
  ) =>
    agents.update((_tx, doc) => {
      const record = doc.cones[id] ?? doc.scoops[id];
      if (record?.conversation !== titled.conversation || (record.titled ?? 0) >= turns) return;
      record.titled = turns;
      if (title) record.title = title;
    }, BACKGROUND_CONTEXT);

  const done = () =>
    ({ status: 'terminal', outcome: { status: 'completed', result: null } }) as const;
  const naming = defineTask<
    { agentId: string; conversation: number; turns: number },
    { phase: 'name' },
    null
  >({
    name: TITLE_TASK,
    version: 1,
    initial: () => ({ phase: 'name' }),
    phases: {
      async name(task, runtime, context) {
        const { agentId, conversation, turns } = task.input;
        const finish = () => runtime.commit(async () => done(), context);
        const agents = deps.agents();
        const title = deps.title();
        const token = pending.get(agentId)?.token;
        if (!agents || !title) return finish();
        const entries = await history(runtime, undefined, context);
        const model = modelName((await runtime.agent(context)).model);
        const label = await named(entries, model, context, title);
        if (runtime.signal.aborted || pending.get(agentId)?.token !== token) return finish();
        await write(agents, agentId, { conversation, title: undefined, titled: 0 }, turns, label);
        if (pending.get(agentId)?.token === token) pending.delete(agentId);
        return finish();
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });
  const due = defineTask<{ last: number }, { phase: 'schedule' }, null>({
    name: DUE_TASK,
    version: 1,
    initial: () => ({ phase: 'schedule' }),
    phases: {
      async schedule(task, runtime, context) {
        const finish = () => runtime.commit(async () => done(), context);
        const agents = deps.agents();
        if (!agents || !deps.title()) return finish();
        const found = findAgent(agents, runtime.conversationId);
        if (!found) return finish();
        const { id, record } = found;
        if (pending.get(id)?.conversation === record.conversation) return finish();
        const entries = await history(runtime, task.input.last, context);
        const turns = titleDue(record, entries);
        if (turns === undefined) return finish();
        const token = Symbol(id);
        const conversation = record.conversation;
        let created = 0;
        await runtime.commit(async (tx) => {
          created = Number(
            await tx.createTask(
              naming,
              { agentId: id, conversation, turns },
              { ownership: { kind: 'conversation' }, background: true }
            )
          );
          return done();
        }, context);
        pending.set(id, { token, conversation, taskId: created });
        return undefined;
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async () => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  const extension = defineExtension({
    name: TITLES,
    tasks: [due, naming],
    hooks: [
      hook(GenerationTask, {
        afterRun(run, api) {
          const agents = deps.agents();
          if (!agents || !deps.harness() || !deps.title()) return undefined;
          const found = findAgent(agents, api.conversationId);
          const lastTurn = TITLE_TURNS[TITLE_TURNS.length - 1] ?? 0;
          if (!found || (found.record.titled ?? 0) >= lastTurn) return undefined;
          return { tasks: [runEndTask(due, { last: Number(run.last) })] };
        },
      }),
    ],
  });

  return {
    extension,
    cancel(agentId: string) {
      const held = pending.get(agentId);
      pending.delete(agentId);
      const harness = deps.harness();
      if (held && harness)
        void harness.abortTask(held.taskId as TaskId, BACKGROUND_CONTEXT).catch(() => undefined);
    },
  };
}
