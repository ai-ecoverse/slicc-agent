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
import { type Agents, openAgents } from './agents.ts';
import type { Cones } from './cone.ts';
import { type GuestToolGate, guestToolGate } from './guests/guard.ts';
import { type GuestReviews, guestReviews } from './guests/review.ts';
import { type ScoopReviews, scoopReviews } from './guests/scoop.ts';

export interface AgentOptions {
  models: Models;
  model: ModelRef;
  storage?: Storage;
  registry?: Registry;
  settings?: HarnessOptions['settings'];
  env?: HarnessOptions['env'];
  conversationCreated?: HarnessOptions['conversationCreated'];
  context?: Context;
  beforeResume?: (harness: Harness, context: Context) => Promise<unknown>;
}

export interface Agent extends Cones {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly agents: Agents;
  readonly reviews: GuestReviews;
  readonly gate: GuestToolGate;
  readonly scoopReviews: ScoopReviews;
  onCone(listener: (conversation: Conversation) => void | Promise<void>): () => void;
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
  const registry = options.registry ?? createRegistry();
  let opened: Harness | undefined;
  const gate = guestToolGate(() => opened);
  registry.install(gate.extension);
  const reviews = guestReviews();
  registry.install(reviews.extension);
  const scooped = scoopReviews();
  registry.install(scooped.extension);
  const harness = await Harness.open(
    options.storage ?? new MemoryStorage(),
    {
      models: options.models,
      registry,
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.conversationCreated ? { conversationCreated: options.conversationCreated } : {}),
    },
    context
  );
  opened = harness;
  const root = await harness.root(context, { agent: { model: options.model } });
  const agents = await openAgents(harness, root, context);
  await options.beforeResume?.(harness, context);
  harness.resume();
  return {
    harness,
    root,
    agents,
    reviews,
    gate,
    scoopReviews: scooped,
    cone: () => agents.cone(),
    switchCone: (conversation, switching) => agents.switchCone(conversation, switching),
    onCone: (listener) => agents.onCone(listener),
    prompt: (text) => prompt(agents.cone(), text, context),
    close: () => harness.close(context),
  };
}
