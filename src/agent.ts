import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai/models';
import {
  AssistantEntry,
  type Conversation,
  createRegistry,
  type EntryId,
  Harness,
  type HarnessOptions,
  MemoryStorage,
  type ModelRef,
  type Registry,
  type Storage,
} from '@earendil-works/pi-durable';

export interface AgentOptions {
  models: Models;
  model: ModelRef;
  storage?: Storage;
  registry?: Registry;
  settings?: HarnessOptions['settings'];
  env?: HarnessOptions['env'];
  context?: Context;
}

export interface Agent {
  readonly harness: Harness;
  readonly root: Conversation;
  prompt(text: string): Promise<string>;
  close(): Promise<void>;
}

interface Block {
  type: string;
  text?: string;
}

export function answerText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

async function prompt(root: Conversation, text: string, context: Context): Promise<string> {
  const submission = await root.submit({ type: 'input', content: text }, context);
  const settled = await submission.wait(context);
  const { answer, reason } = settled as { answer?: EntryId; reason?: string };
  if (answer === undefined) throw new Error(`unanswered: ${reason}`);
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, answer), context);
  return answerText(entry?.model?.[0]?.content);
}

export async function openAgent(options: AgentOptions): Promise<Agent> {
  const context = options.context ?? BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    options.storage ?? new MemoryStorage(),
    {
      models: options.models,
      registry: options.registry ?? createRegistry(),
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.env ? { env: options.env } : {}),
    },
    context
  );
  const root = await harness.root(context, { agent: { model: options.model } });
  harness.resume();
  return {
    harness,
    root,
    prompt: (text) => prompt(root, text, context),
    close: () => harness.close(context),
  };
}
