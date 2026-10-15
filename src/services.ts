import type { Context, JsonValue, RemoteContract, ReplicatedState } from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { SendAttachment, ShownAttachment } from './attachments.ts';
import type { ChangesView } from './changes/git.ts';
import type { FrozenCone } from './freezer/index.ts';
import type { GuestOpened, Proposed, ProposeRequest } from './guests/index.ts';
import type { GuestDraft, GuestGates, GuestSeat } from './guests/seats.ts';
import type { MemoryEntry, MemoryScope, MemoryTag } from './memory/format.ts';
import type { AgentRemote } from './remote/host.ts';
import type { AgentPages } from './remote/pages.ts';
import type { VaultState } from './secrets/vault.ts';
import { contract } from './serving.ts';
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
  image(ref: ImageRef, context: Context): Promise<StoredImage>;
  agentCommands(agentId: string, context: Context): Promise<Command[]>;
  toolLabel(agentId: string, callIds: string[], context: Context): Promise<string | null>;
  guestOpen(draft: GuestDraft, context: Context): Promise<GuestOpened>;
  guestRevoke(id: string, context: Context): Promise<{ revoked: boolean }>;
}

export interface ImageRef {
  entry: number;
  message: number;
  part: number;
}

export type StoredImage = { data: string; mimeType: string } | { data: null; mimeType: null };

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

const keys = <T>(record: Record<keyof T, true>) => Object.keys(record) as (keyof T & string)[];

export const CONTROL_METHODS = keys<AgentControl>({
  send: true,
  wait: true,
  withdraw: true,
  abort: true,
  compact: true,
  compactAgent: true,
  reset: true,
  configure: true,
  rewind: true,
  rewindAgent: true,
  resolveLick: true,
  resolveAgentLick: true,
  webhook: true,
  stopAgent: true,
  selectCone: true,
  createCone: true,
  createScoop: true,
  drop: true,
  unqueue: true,
  sprinkleSend: true,
  sprinkleCall: true,
  memorySave: true,
  memoryRemove: true,
  freeze: true,
  newChat: true,
  thaw: true,
  discard: true,
  changesOpen: true,
  changeAccept: true,
  changeRevert: true,
  monitorOpen: true,
  monitorClose: true,
  image: true,
  agentCommands: true,
  toolLabel: true,
  guestOpen: true,
  guestRevoke: true,
});

export const CONTROL_READS: readonly (keyof AgentControl & string)[] = [
  'wait',
  'changesOpen',
  'monitorOpen',
  'monitorClose',
  'image',
  'toolLabel',
];

export const AgentControl: RemoteContract = contract('slicc.agent.control', {
  control: { methods: CONTROL_METHODS },
  view: { methods: CONTROL_READS },
});

export type Delivered = 'run' | 'steer' | 'follow-up';

export interface AgentTranscript {
  readonly state: ReplicatedState<ConversationView>;
  readonly deliveries: ReplicatedState<Record<string, Delivered>>;
  readonly agents: ReplicatedState<AgentsSummary>;
  readonly views: ReplicatedState<Record<string, ConversationView>>;
  readonly commands: ReplicatedState<Command[]>;
  readonly privateRevision: ReplicatedState<PrivateRevision>;
  readonly sprinkles: ReplicatedState<Sprinkle[]>;
  readonly memories: ReplicatedState<MemoryEntry[]>;
  readonly memoryScopes: ReplicatedState<MemoryScope[]>;
  readonly frozen: ReplicatedState<FrozenCone[]>;
  readonly changes: ReplicatedState<ChangesView>;
  readonly monitor: ReplicatedState<MonitorFeed>;
  readonly vault: ReplicatedState<VaultState>;
  readonly labels: ReplicatedState<Record<string, string>>;
  readonly guests: ReplicatedState<GuestSeat[]>;
}

export interface PrivateRevision {
  revision: number;
}

export interface Command {
  name: string;
  description: string;
  kind: 'prompt' | 'skill' | 'action';
}

export const TRANSCRIPT_STATES = keys<AgentTranscript>({
  state: true,
  deliveries: true,
  agents: true,
  views: true,
  commands: true,
  privateRevision: true,
  sprinkles: true,
  memories: true,
  memoryScopes: true,
  frozen: true,
  changes: true,
  monitor: true,
  vault: true,
  labels: true,
  guests: true,
});

export const AgentTranscript: RemoteContract = contract('slicc.agent.transcript', {
  transcript: { state: TRANSCRIPT_STATES },
});

export const REMOTE_METHODS = keys<AgentRemote>({
  prompt: true,
  watch: true,
  next: true,
  close: true,
  abort: true,
});

export const REMOTE_READS: readonly (keyof AgentRemote & string)[] = ['watch', 'next', 'close'];

export interface GuestShown {
  id: string;
  label: string;
  agentId: string;
  name: string;
  expiresAt: number | null;
  gates: GuestGates;
}

export interface AgentGuest {
  readonly transcript: ReplicatedState<ConversationView>;
  readonly seat: ReplicatedState<GuestShown>;
  propose(request: ProposeRequest, context: Context): Promise<Proposed>;
}

export const GUEST_STATES = ['transcript', 'seat'] as const;

export const GUEST_METHODS = ['propose'] as const;

export const AgentGuestService: RemoteContract = contract('slicc.agent.guest', {
  guest: { state: GUEST_STATES, methods: GUEST_METHODS },
  none: {},
});

export const AgentRemoteService: RemoteContract = contract('slicc.agent.remote', {
  remote: { methods: REMOTE_METHODS },
  watch: { methods: REMOTE_READS },
});

export const PAGE_METHODS = keys<AgentPages>({
  open: true,
  report: true,
  next: true,
  answer: true,
  close: true,
});

export const AgentPagesService: RemoteContract = contract('slicc.agent.pages', {
  pages: { methods: PAGE_METHODS },
  none: {},
});

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
  store?: 'vault';
  fields?: AccountField[];
}

export interface AccountField {
  name: string;
  label: string;
  required?: boolean;
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
  moved?: { kind: 'model' | 'mcp'; label: string }[];
  labels?: Record<string, string>;
}

export interface AgentSettings {
  readonly state: ReplicatedState<SettingsState>;
  connect(
    providerId: string,
    secret: string | null,
    fields: Record<string, string> | null,
    context: Context
  ): Promise<void>;
  disconnect(providerId: string, context: Context): Promise<void>;
  signIn(providerId: string, context: Context): Promise<SignIn | McpSignIn | null>;
  dismissMoved(context: Context): Promise<void>;
}

export const SETTINGS_METHODS = keys<Omit<AgentSettings, 'state'>>({
  connect: true,
  disconnect: true,
  signIn: true,
  dismissMoved: true,
});

export const AgentSettings: RemoteContract = contract('slicc.agent.settings', {
  settings: { state: ['state'], methods: SETTINGS_METHODS },
  view: { state: ['state'] },
});
