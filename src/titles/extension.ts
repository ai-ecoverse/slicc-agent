import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  Conversation,
  ConversationId,
  EntryRecord,
  Extension,
  Harness,
} from '@earendil-works/pi-durable';
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable';
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

function answered(entries: readonly EntryRecord[], answer: AssistantMessage): EntryRecord[] {
  const last = entries.at(-1);
  const stamp = (last?.model?.[0] as { timestamp?: unknown } | undefined)?.timestamp;
  if (last?.kind === 'pi.assistant' && stamp === answer.timestamp) return [...entries];
  return [...entries, { kind: 'pi.assistant', model: [answer] } as unknown as EntryRecord];
}

function modelName(model: { provider: string; modelId: string } | undefined): string {
  return model ? `${model.provider}/${model.modelId}` : '';
}

export interface TitlesRuntime {
  extension: Extension;
  cancel(agentId: string): void;
}

export function titlesExtension(deps: TitlesAttach): TitlesRuntime {
  const pending = new Map<string, { token: symbol; conversation: number }>();

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

  const extension = defineExtension({
    name: TITLES,
    hooks: [
      hook(GenerationTask, {
        onYield(answer, api) {
          const agents = deps.agents();
          const harness = deps.harness();
          const title = deps.title();
          if (!agents || !harness || !title) return undefined;
          const found = findAgent(agents, api.conversationId);
          if (!found) return undefined;
          const { id, record } = found;
          const token = Symbol(id);
          void (async () => {
            const conversation = (await harness.conversation(
              api.conversationId,
              BACKGROUND_CONTEXT
            )) as Conversation;
            const entries = answered(
              (await conversation.context(BACKGROUND_CONTEXT)).entries,
              answer
            );
            const turns = titleDue(record, entries);
            if (turns === undefined || pending.get(id)?.conversation === record.conversation)
              return;
            pending.set(id, { token, conversation: record.conversation });
            const model = modelName((await conversation.agent(BACKGROUND_CONTEXT)).model);
            const label = await named(entries, model, BACKGROUND_CONTEXT, title);
            if (pending.get(id)?.token === token) await write(agents, id, record, turns, label);
          })()
            .catch(() => undefined)
            .finally(() => {
              if (pending.get(id)?.token === token) pending.delete(id);
            });
          return undefined;
        },
      }),
    ],
  });

  return {
    extension,
    cancel(agentId: string) {
      pending.delete(agentId);
    },
  };
}
