import type { Context } from '@earendil-works/chord';
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
import type { Agents } from './agents.ts';
import type { Cones } from './cone.ts';
import type { Deliveries } from './deliveries.ts';
import type { LickSources, Licks } from './licks/index.ts';
import { LICK_STATE_KIND } from './licks/state.ts';
import type { Scoops, ScoopsRuntime } from './scoops/index.ts';
import type { AgentControl, Created, OperationError, SendResponse } from './services.ts';

export interface HostLicks {
  licks: Licks;
  sources: LickSources;
}

export interface HostScoops {
  scoops: Scoops;
  runtime: ScoopsRuntime;
}

type WithAgents = { agents?: Agents };

export function readable(out: string): string {
  const text = out.replace(/^(?:sub)?agent: /, '').trim();
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

function created(run: () => Promise<string>): Promise<Created> {
  return run().then(
    (id) => ({ id, error: null }),
    (error: Error) => ({ id: null, error: error.message })
  );
}

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
  deliveries?: Deliveries,
  licks?: HostLicks,
  scoops?: HostScoops
): AgentControl {
  const cone = cones(target);
  const current = () => cone.cone();
  const agents = (target as WithAgents).agents;
  const conversationFor = async (agentId: string | null | undefined, context: Context) => {
    if (!agentId || !agents) return current();
    const found = await agents.conversation(agentId, context);
    if (!found) throw new Error(`There is no agent ${agentId}.`);
    return found;
  };
  const withdraw = async (conversation: Conversation, id: string, context: Context) => {
    const parsed = submissionId(id);
    if (parsed === undefined) return { outcome: 'not_found' as const };
    const result = await harness.abortSubmission(parsed, context, conversation.id);
    if (result === 'aborted') return { outcome: 'withdrawn' as const };
    return {
      outcome: result === 'not_found' ? ('not_found' as const) : ('already_placed' as const),
    };
  };
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lock.then(operation, operation);
    lock = run.catch(() => undefined);
    return run;
  };
  return {
    send(request, context) {
      return serial(async () => {
        const response = await accepted(async () =>
          (await conversationFor(request.agentId, context)).submit(
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
        const changed =
          scoops && agents
            ? await scoops.scoops.rewound(agents.activeCone(), fork, context)
            : { stopped: [], restored: [] };
        await fork.submit(
          { type: 'write', entry: { kind: 'slicc.rewound', data: { turns: 1, ...changed } } },
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
    withdraw: (id, context) => withdraw(current(), id, context),
    async unqueue(agentId, id, context) {
      return withdraw(await conversationFor(agentId, context), id, context);
    },
    abort: (context) => current().abort(context),
    compact: (instructions, context) =>
      accepted(() => current().compact(instructions ?? undefined, context)),
    reset: (handoff, context) => current().reset(handoff ?? undefined, context),
    resolveLick(lickId, state, context) {
      return serial(async () => {
        if (!licks) return { done: false, text: null, error: 'this agent has no licks' };
        const conversation = current();
        const action = state === 'confirmed' ? 'confirm' : 'dismiss';
        try {
          const text = await licks.licks.decide(conversation, lickId, action, undefined, context);
          await conversation.submit(
            {
              type: 'write',
              entry: {
                kind: LICK_STATE_KIND,
                data: { lick: lickId, state, by: 'user' },
                model: [
                  {
                    role: 'user',
                    content: `The user ${state} lick ${lickId}: ${text}`,
                    timestamp: Date.now(),
                  },
                ],
              },
            },
            context
          );
          return { done: true, text, error: null };
        } catch (error) {
          return { done: false, text: null, error: (error as Error).message };
        }
      });
    },
    async webhook(name, delivery, context) {
      const delivered = licks
        ? await licks.sources.webhook(
            name,
            {
              ...(delivery.id ? { id: delivery.id } : {}),
              headers: delivery.headers,
              body: delivery.body,
            },
            context
          )
        : false;
      return { delivered };
    },
    async stopAgent(agentId, context) {
      await (await conversationFor(agentId, context)).abort(context);
    },
    async selectCone(agentId, context) {
      await agents?.selectCone(agentId, context);
    },
    createCone(name, context) {
      return created(async () => {
        if (!agents) throw new Error('This agent has a single cone.');
        return agents.createCone(name, context);
      });
    },
    createScoop(parentId, name, context) {
      return created(async () => {
        if (!scoops) throw new Error('This agent has no scoops.');
        const roles = await scoops.runtime.roles(context);
        const answer = await scoops.scoops.spawn(
          { cone: parentId, name, prompts: [], fromAgent: false, limits: roles.limits },
          context
        );
        if (answer.code !== 0) throw new Error(readable(answer.out));
        return `scoop:${answer.out.trim()}`;
      });
    },
    drop(agentId, context) {
      return created(async () => {
        if (!scoops) throw new Error('This agent has no scoops.');
        const answer = await scoops.scoops.stop(agentId, false, context);
        if (answer.code !== 0) throw new Error(readable(answer.out));
        return agentId;
      });
    },
    configure: async (change, context) =>
      (await conversationFor(change.agentId, context)).configure(
        {
          ...(change.model ? { model: change.model } : {}),
          ...(change.thinkingLevel ? { thinkingLevel: change.thinkingLevel } : {}),
        },
        context
      ),
  };
}
