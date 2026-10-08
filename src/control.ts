import {
  AssistantEntry,
  type Conversation,
  ConversationBusy,
  type EntryId,
  type Harness,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import { answerText } from './agent.ts';
import type { Deliveries } from './deliveries.ts';
import type { AgentControl, OperationError, SendResponse } from './services.ts';

export function submissionId(value: string): SubmissionId | undefined {
  const id = Number(value);
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(id) ? (id as SubmissionId) : undefined;
}

function operationError(error: unknown): OperationError {
  if (error instanceof ConversationBusy) return { code: 'busy', message: error.message };
  return { code: 'failed', message: error instanceof Error ? error.message : String(error) };
}

async function accepted(operation: () => Promise<{ id: number } | number>): Promise<SendResponse> {
  try {
    const result = await operation();
    const id = typeof result === 'number' ? result : result.id;
    return { accepted: true, submissionId: String(id), error: null };
  } catch (error) {
    return { accepted: false, submissionId: null, error: operationError(error) };
  }
}

export function createAgentControl(
  harness: Harness,
  conversation: Conversation,
  deliveries?: Deliveries
): AgentControl {
  return {
    async send(request, context) {
      const response = await accepted(() =>
        conversation.submit(
          {
            type: 'input',
            content: request.text,
            whenBusy: request.whenBusy,
            ...(request.requestId ? { requestId: request.requestId } : {}),
          },
          context
        )
      );
      const id = response.submissionId === null ? undefined : submissionId(response.submissionId);
      if (id !== undefined) deliveries?.expect(id, request.whenBusy);
      return response;
    },
    async wait(id, context) {
      const parsed = submissionId(id);
      const submission =
        parsed === undefined ? undefined : await harness.submission(parsed, context);
      if (!submission) throw new Error(`unknown submission ${id}`);
      const settled = await submission.wait(context);
      const { answer, reason } = settled as { answer?: EntryId; reason?: string };
      if (answer === undefined) return { status: 'unanswered', text: null, reason: String(reason) };
      const entry = await harness.commit((tx) => tx.entry(AssistantEntry, answer), context);
      return { status: 'done', text: answerText(entry?.model?.[0]?.content), reason: null };
    },
    async withdraw(id, context) {
      const parsed = submissionId(id);
      if (parsed === undefined) return { outcome: 'not_found' };
      const result = await harness.abortSubmission(parsed, context, conversation.id);
      if (result === 'aborted') return { outcome: 'withdrawn' };
      return { outcome: result === 'not_found' ? 'not_found' : 'already_placed' };
    },
    abort: (context) => conversation.abort(context),
    compact: (instructions, context) =>
      accepted(() => conversation.compact(instructions ?? undefined, context)),
    reset: (handoff, context) => conversation.reset(handoff ?? undefined, context),
    configure: (change, context) =>
      conversation.configure(
        {
          ...(change.model ? { model: change.model } : {}),
          ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
        },
        context
      ),
  };
}
