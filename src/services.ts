import {
  type Context,
  defineService,
  type JsonValue,
  type ReplicatedState,
} from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { SendAttachment, ShownAttachment } from './attachments.ts';
import type { ChangesView } from './changes/git.ts';
import type { FrozenCone } from './freezer/index.ts';
import type { MemoryEntry, MemoryScope, MemoryTag } from './memory/format.ts';
import type { AgentRemote } from './remote/host.ts';
import type { AgentPages } from './remote/pages.ts';
import type { VaultState } from './secrets/vault.ts';
import type { Sprinkle } from './sprinkles/kind.ts';

export type SendMode = 'steer' | 'followUp' | 'reject';

export interface SendRequest {
  text: string;
  whenBusy: SendMode;
  requestId: string | null;
  agentId?: string | null;
  attachments?: SendAttachment[];
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
  compactAgent(
    agentId: string,
    instructions: string | null,
    context: Context
  ): Promise<SendResponse>;
  reset(handoff: string | null, context: Context): Promise<void>;
  configure(change: AgentSettingsChange, context: Context): Promise<void>;
  rewind(messageId: string | null, context: Context): Promise<Rewound>;
  rewindAgent(agentId: string, messageId: string | null, context: Context): Promise<Rewound>;
  resolveLick(
    lickId: string,
    state: 'confirmed' | 'dismissed',
    context: Context
  ): Promise<LickResolved>;
  resolveAgentLick(
    agentId: string,
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
  monitorOpen(lease: string | null, resync: boolean, context: Context): Promise<MonitorLease>;
  monitorClose(lease: string, context: Context): Promise<void>;
}

export interface MonitorLease {
  lease: string;
  ttlMs: number;
}

export interface MonitorAgent {
  id: string;
  name: string;
  kind: 'cone' | 'scoop';
  parentId: string | null;
  model: string | null;
  running: boolean;
  queued: number;
  tool: string | null;
  retry: { attempt: number; since: number; error: string } | null;
  failed: string | null;
  context: number | null;
  cpu?: number | null;
}

export interface MonitorTask {
  id: string;
  kind: string;
  detail: string | null;
  agentId: string | null;
  owner: string | null;
  status: 'pending' | 'running' | 'waiting' | 'completing';
  phase: string;
  background: boolean;
  aborting: number | null;
  since: number;
  waits: number;
}

export interface MonitorProcess {
  pid: number;
  ppid: number;
  pgid: number;
  user: string | null;
  agentId: string | null;
  command: string;
  state: 'S' | 'Z';
  started: number;
  zombie: number | null;
  tty: boolean;
  rss: number | null;
  utime?: number;
  stime?: number;
  cpu?: number | null;
}

export interface MonitorProblem {
  id: string;
  at: number;
  agentId: string | null;
  kind: 'task' | 'retry' | 'turn';
  message: string;
}

export interface MonitorFeed {
  open: boolean;
  at: number;
  usage: { tokens: number; cost: number; free: boolean } | null;
  agents: MonitorAgent[];
  tasks: MonitorTask[];
  processes: MonitorProcess[] | null;
  kernel: 'checking' | 'ok' | 'unreachable';
  problems: MonitorProblem[];
  paused: boolean;
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
  | { done: true; text: string; reason: null; attachments?: ShownAttachment[] }
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
  readonly monitor: ReplicatedState<MonitorFeed>;
  readonly vault: ReplicatedState<VaultState>;
}

export interface Command {
  name: string;
  description: string;
  kind: 'prompt' | 'skill' | 'action';
}

export const AgentTranscript = defineService<AgentTranscript>('slicc.agent.transcript');

export interface AgentSessions {
  attach(sessionId: string, context: Context): Promise<void>;
  detach(context: Context): Promise<void>;
}

export const AgentSessions = defineService<AgentSessions>('slicc.agent.sessions');

export const AgentRemoteService = defineService<AgentRemote>('slicc.agent.remote');

export const AgentPagesService = defineService<AgentPages>('slicc.agent.pages');

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
  status: 'connected' | 'disconnected' | 'expired';
  auth: 'api-key' | 'oauth';
  needs: 'cors-free-transport' | null;
  group?: 'providers' | 'mcp';
  secret?: 'api-key' | 'token';
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

export interface McpSignIn {
  url: string;
  state: string;
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
  signIn(providerId: string, context: Context): Promise<SignIn | McpSignIn | null>;
}

export const AgentSettings = defineService<AgentSettings>('slicc.agent.settings');
