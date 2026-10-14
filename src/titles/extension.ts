import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, EntryRecord, Extension, Harness } from '@earendil-works/pi-durable';
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
  title: TitleFn;
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
    context: Context
  ): Promise<string | undefined> =>
    scrubTranscript(entries)
      .then((transcript) => deps.title(transcript, model, context))
      .then(cleanTitle)
      .catch(() => undefined);

  const write = (id: string, titled: Titled, turns: number, title: string | undefined) => {
    const agents = deps.agents();
    if (!agents) return Promise.resolve();
    return agents.update((_tx, doc) => {
      const record = doc.cones[id] ?? doc.scoops[id];
      if (record?.conversation !== titled.conversation) return;
      record.titled = turns;
      if (title) record.title = title;
    }, BACKGROUND_CONTEXT);
  };

  const extension = defineExtension({
    name: TITLES,
    hooks: [
      hook(GenerationTask, {
        onYield(_answer, api, context) {
          const agents = deps.agents();
          const harness = deps.harness();
          if (!agents || !harness) return undefined;
          const found = findAgent(agents, api.conversationId);
          if (!found) return undefined;
          const { id, record } = found;
          if (pending.get(id)?.conversation === record.conversation) return undefined;
          void (async () => {
            const conversation = await harness.conversation(api.conversationId, context);
            if (!conversation) return;
            const view = await conversation.context(context);
            const entries = view.entries;
            const agent = await conversation.agent(context);
            const model = modelName(agent.model);
            const turns = titleDue(record, entries);
            if (turns === undefined) return;
            const token = Symbol(id);
            pending.set(id, { token, conversation: record.conversation });
            try {
              const title = await named(entries, model, BACKGROUND_CONTEXT);
              if (pending.get(id)?.token === token) await write(id, record, turns, title);
            } catch {
            } finally {
              if (pending.get(id)?.token === token) pending.delete(id);
            }
          })();
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
