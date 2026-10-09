import {
  type Context,
  defineService,
  type JsonValue,
  type ReplicatedState,
} from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { ChangesView } from './changes/git.ts';
import type { FrozenCone } from './freezer/index.ts';
import type { MemoryEntry, MemoryScope, MemoryTag } from './memory/format.ts';
import type { Sprinkle } from './sprinkles/kind.ts';

export type SendMode = 'steer' | 'followUp' | 'reject';

export interface SendRequest {
  text: string;
  whenBusy: SendMode;
  requestId: string | null;
  agentId?: string | null;
}

export interface OperationError {
  code: string;
  message: string;
}

export type SendResponse =
  | { accepted: true; submissionId: string; error: null }
  | { accepted: false; submissionId: null; error: OperationError };

export type PromptResult =
  | { status: 'done'; text: string; reason: null }
  | { status: 'unanswered'; text: null; reason: string };

export interface AgentControl {
  send(request: SendRequest, context: Context): Promise<SendResponse>;
  wait(submissionId: string, context: Context): Promise<PromptResult>;
  withdraw(
    submissionId: string,
    context: Context
  ): Promise<{ outcome: 'withdrawn' | 'already_placed' | 'not_found' }>;
  abort(context: Context): Promise<void>;
  compact(instructions: string | null, context: Context): Promise<SendResponse>;
  reset(handoff: string | null, context: Context): Promise<void>;
  configure(change: AgentSettingsChange, context: Context): Promise<void>;
  rewind(messageId: string | null, context: Context): Promise<Rewound>;
  rewindAgent(agentId: string, messageId: string | null, context: Context): Promise<Rewound>;
  resolveLick(
    lickId: string,
    state: 'confirmed' | 'dismissed',
    context: Context
  ): Promise<LickResolved>;
  webhook(
    name: string,
    delivery: WebhookRequest,
    context: Context
  ): Promise<{ delivered: boolean }>;
  stopAgent(agentId: string, context: Context): Promise<void>;
  selectCone(agentId: string, context: Context): Promise<void>;
  createCone(name: string, context: Context): Promise<Created>;
  createScoop(parentId: string, name: string, context: Context): Promise<Created>;
  drop(agentId: string, context: Context): Promise<Created>;
  unqueue(
    agentId: string | null,
    submissionId: string,
    context: Context
  ): Promise<{ outcome: 'withdrawn' | 'already_placed' | 'not_found' }>;
  sprinkleSend(
    sprinkleId: string,
    payload: { action: string; data: JsonValue | null; target: string | null },
    context: Context
  ): Promise<{ delivered: boolean }>;
  sprinkleCall(
    sprinkleId: string,
    method: string,
    args: JsonValue[],
    context: Context
  ): Promise<JsonValue>;
  memorySave(draft: MemoryDraft, context: Context): Promise<MemoryEntry>;
  memoryRemove(id: string, context: Context): Promise<{ removed: boolean }>;
  freeze(agentId: string, context: Context): Promise<Created>;
  newChat(agentId: string, context: Context): Promise<Created>;
  thaw(frozenId: string, context: Context): Promise<Created>;
  discard(frozenId: string, context: Context): Promise<Created>;
  changesOpen(context: Context): Promise<void>;
  changeAccept(path: string, context: Context): Promise<Created>;
  changeRevert(path: string, context: Context): Promise<Created>;
}

export interface MemoryDraft {
  id: string | null;
  scope: string;
  section: string;
  title: string;
  body: string;
  tag: MemoryTag | null;
}

export type Created = { id: string; error: null } | { id: null; error: string };

export interface AgentSummary {
  id: string;
  name: string;
  kind: 'cone' | 'scoop';
  parentId: string | null;
  role: string | null;
}

export interface AgentsSummary {
  active: string;
  agents: AgentSummary[];
}

export type LickResolved =
  | { done: true; text: string; error: null }
  | { done: false; text: null; error: string };

export interface WebhookRequest {
  id: string | null;
  headers: Record<string, string>;
  body: string;
}

export type Rewound =
  | { done: true; text: string; reason: null }
  | { done: false; text: null; reason: 'busy' | 'no-turn' };

export interface AgentSettingsChange {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  agentId?: string | null;
}

export const AgentControl = defineService<AgentControl>('slicc.agent.control');

export type Delivered = 'run' | 'steer' | 'follow-up';

export interface AgentTranscript {
  readonly state: ReplicatedState<ConversationView>;
  readonly deliveries: ReplicatedState<Record<string, Delivered>>;
  readonly agents: ReplicatedState<AgentsSummary>;
  readonly views: ReplicatedState<Record<string, ConversationView>>;
  readonly commands: ReplicatedState<Command[]>;
  readonly sprinkles: ReplicatedState<Sprinkle[]>;
  readonly memories: ReplicatedState<MemoryEntry[]>;
  readonly memoryScopes: ReplicatedState<MemoryScope[]>;
  readonly frozen: ReplicatedState<FrozenCone[]>;
  readonly changes: ReplicatedState<ChangesView>;
}

export interface Command {
  name: string;
  description: string;
  kind: 'prompt' | 'skill';
}

export const AgentTranscript = defineService<AgentTranscript>('slicc.agent.transcript');

export interface AgentSessions {
  attach(sessionId: string, context: Context): Promise<void>;
  detach(context: Context): Promise<void>;
}

export const AgentSessions = defineService<AgentSessions>('slicc.agent.sessions');

export const AGENT_SESSION = 'agent';

export interface ModelChoice {
  id: string;
  label: string;
  provider: string;
  kind: 'chat' | 'classifier';
  reasoning: boolean;
  images?: boolean;
  contextWindow: number;
}

export interface AccountState {
  id: string;
  provider: string;
  identity: string;
  status: 'connected' | 'disconnected';
  auth: 'api-key' | 'oauth';
  needs: 'cors-free-transport' | null;
}

export interface BudgetState {
  provider: string;
  percent: number;
  window: 'weekly';
  resets: string;
}

export interface SignIn {
  clientId: string;
  scopes: string;
  imsEnvironment: string;
}

export interface SettingsState {
  models: ModelChoice[];
  accounts: AccountState[];
  budget?: BudgetState | null;
}

export interface AgentSettings {
  readonly state: ReplicatedState<SettingsState>;
  connect(
    providerId: string,
    secret: string,
    region: string | null,
    context: Context
  ): Promise<void>;
  disconnect(providerId: string, context: Context): Promise<void>;
  signIn(providerId: string, context: Context): Promise<SignIn | null>;
}

export const AgentSettings = defineService<AgentSettings>('slicc.agent.settings');
