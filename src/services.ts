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
}

export const AgentControl = defineService<AgentControl>('slicc.agent.control');

export interface AgentTranscript {
  readonly state: ReplicatedState<ConversationView>;
}

export const AgentTranscript = defineService<AgentTranscript>('slicc.agent.transcript');

export interface AgentSessions {
  attach(sessionId: string, context: Context): Promise<void>;
  detach(context: Context): Promise<void>;
}

export const AgentSessions = defineService<AgentSessions>('slicc.agent.sessions');

export const AGENT_SESSION = 'agent';
