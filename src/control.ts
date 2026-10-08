import {
  type AgentChange,
  AssistantEntry,
  type Conversation,
  ConversationBusy,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type Harness,
  type SubmissionId,
} from '@earendil-works/pi-durable';
import { answerText } from './agent.ts';
import type { Cones } from './cone.ts';
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

function cones(target: Conversation | Cones): Cones {
  if ('cone' in target) return target;
  return {
    cone: () => target,
    switchCone: async () => {
      throw new Error('this conversation has no cone to rewind');
    },
  };
}

interface Turn {
  text: string;
  at: EntryId | null;
}

function lastTurn(view: ConversationView, messageId: string | null): Turn | null {
  const { entries } = view;
  const target = entries.findIndex((entry) => `e${entry.id}` === messageId);
  if (target < 0) return null;
  const turn = entries.slice(0, target).findLastIndex((entry) => entry.kind === 'pi.user');
  if (turn < 0) return null;
  const user = entries[turn] as EntryRecord;
  return { text: answerText(user.model?.[0]?.content), at: entries[turn - 1]?.id ?? null };
}

function busy(view: ConversationView): boolean {
  const live = view.docs['pi.live'] as { run?: unknown } | undefined;
  const inbox = view.docs['pi.inbox'] as { items?: unknown[] } | undefined;
  return Boolean(live?.run) || Boolean(inbox?.items?.length);
}

export function createAgentControl(
  harness: Harness,
  target: Conversation | Cones,
  deliveries?: Deliveries
): AgentControl {
  const cone = cones(target);
  const current = () => cone.cone();
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lock.then(operation, operation);
    lock = run.catch(() => undefined);
    return run;
  };
  return {
    send(request, context) {
      return serial(async () => {
        const response = await accepted(() =>
          current().submit(
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
      });
    },
    rewind(messageId, context) {
      return serial(async () => {
        const conversation = current();
        const attached = await conversation.viewState(context);
        const view = attached.value;
        attached.dispose();
        const pending = (await harness.inspect(context)).submissions.some(
          (submission) => submission.conversationId === conversation.id
        );
        if (pending || busy(view)) return { done: false, text: null, reason: 'busy' };
        const turn = lastTurn(view, messageId);
        if (!turn) return { done: false, text: null, reason: 'no-turn' };
        const agent = view.docs['pi.agent'] as AgentChange | undefined;
        const ownership = { kind: 'ownerless' } as const;
        const fork =
          turn.at === null
            ? await harness.createConversation(
                {
                  ownership,
                  agent: {
                    model: agent?.model ?? null,
                    thinkingLevel: agent?.thinkingLevel ?? null,
                  },
                },
                context
              )
            : await conversation.fork(turn.at, { ownership }, context);
        await fork.submit(
          { type: 'write', entry: { kind: 'slicc.rewound', data: { turns: 1 } } },
          context
        );
        await cone.switchCone(fork, context);
        return { done: true, text: turn.text, reason: null };
      });
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
      const result = await harness.abortSubmission(parsed, context, current().id);
      if (result === 'aborted') return { outcome: 'withdrawn' };
      return { outcome: result === 'not_found' ? 'not_found' : 'already_placed' };
    },
    abort: (context) => current().abort(context),
    compact: (instructions, context) =>
      accepted(() => current().compact(instructions ?? undefined, context)),
    reset: (handoff, context) => current().reset(handoff ?? undefined, context),
    configure: (change, context) =>
      current().configure(
        {
          ...(change.model ? { model: change.model } : {}),
          ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
        },
        context
      ),
  };
}
