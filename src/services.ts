import { type Context, defineService, type ReplicatedState } from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';

export type SendMode = 'steer' | 'followUp' | 'reject';

export interface SendRequest {
  text: string;
  whenBusy: SendMode;
  requestId: string | null;
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
}

export type Rewound =
  | { done: true; text: string; reason: null }
  | { done: false; text: null; reason: 'busy' | 'no-turn' };

export interface AgentSettingsChange {
  model: { provider: string; modelId: string } | null;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
}

export const AgentControl = defineService<AgentControl>('slicc.agent.control');

export type Delivered = 'run' | 'steer' | 'follow-up';

export interface AgentTranscript {
  readonly state: ReplicatedState<ConversationView>;
  readonly deliveries: ReplicatedState<Record<string, Delivered>>;
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
