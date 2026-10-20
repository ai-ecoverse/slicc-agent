import type { Context } from '@earendil-works/chord';
import {
  AssistantEntry,
  type Conversation,
  ConversationBusy,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type Harness,
  type SubmissionId,
  type UserInput,
} from '@earendil-works/pi-durable';
import { answerText } from './agent.ts';
import type { Agents, ScoopRecord } from './agents.ts';
import { fromBase64, type ShownAttachment, splitUser, userParts } from './attachments.ts';
import type { ChangesRuntime } from './changes/index.ts';
import type { Cones } from './cone.ts';
import type { Deliveries } from './deliveries.ts';
import type { FreezerRuntime } from './freezer/index.ts';
import type { Guests } from './guests/index.ts';
import type { LickSources, Licks } from './licks/index.ts';
import { LICK_STATE_KIND } from './licks/state.ts';
import type { MemoryRuntime } from './memory/index.ts';
import type { Monitor } from './monitor/index.ts';
import type { Scoops, ScoopsRuntime } from './scoops/index.ts';
import { SECRETS_COMMAND, secretsEntry } from './secrets/extension.ts';
import type { SecretListing } from './secrets/names.ts';
import { scrubItems, scrubText } from './secrets/scrub.ts';
import { copyAgent, storedAgent } from './selection.ts';
import type {
  AgentControl,
  Created,
  ImageRef,
  LickResolved,
  OperationError,
  Rewound,
  SendRequest,
  SendResponse,
  StoredImage,
} from './services.ts';
import type { SkillsRuntime } from './skills/index.ts';
import type { SprinklesRuntime } from './sprinkles/index.ts';
import type { LabelsRuntime } from './titles/labels.ts';
import { saverFor, type Uploads } from './uploads.ts';

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

function monitorControl(
  monitor: Pick<Monitor, 'open' | 'close'> | undefined
): Pick<AgentControl, 'monitorOpen' | 'monitorClose'> {
  return {
    monitorOpen: async (lease, resync, context) =>
      monitor ? monitor.open(lease, resync, context) : { lease: '', ttlMs: 0 },
    monitorClose: async (lease, context) => monitor?.close(lease, context),
  };
}

const noApprovals: AgentControl['decide'] = async () => ({
  done: false,
  state: null,
  error: 'This agent has no approvals.',
});

type FreezerControl = Pick<
  FreezerRuntime,
  'freeze' | 'newChat' | 'thaw' | 'discard' | 'importProfile' | 'cancelImport'
>;

function freezerControl(
  freezer: FreezerControl | undefined
): Pick<
  AgentControl,
  'freeze' | 'newChat' | 'thaw' | 'discard' | 'importProfile' | 'importCancel'
> {
  const needed = () => {
    if (!freezer) throw new Error('This agent has no freezer.');
    return freezer;
  };
  return {
    freeze: (agentId, context) => created(async () => needed().freeze(agentId, context)),
    newChat: (agentId, context) =>
      created(async () => (await needed().newChat(agentId, context)) ?? ''),
    thaw: (id, context) => created(async () => needed().thaw(id, context)),
    discard: (id, context) =>
      created(async () => {
        await needed().discard(id, context);
        return id;
      }),
    importProfile: (request, context) =>
      freezer
        ? freezer.importProfile(
            request.inPlace
              ? { inPlace: request.inPlace }
              : request.data === null
                ? { upload: request.upload ?? '' }
                : { bytes: fromBase64(request.data) },
            { again: request.again, preview: request.preview },
            context
          )
        : Promise.resolve({
            done: false,
            preview: null,
            cones: [],
            report: null,
            text: '',
            line: '',
            error: 'This agent has no freezer.',
          }),
    importCancel: async () => freezer?.cancelImport(),
  };
}

function guestControl(
  guests: Pick<Guests, 'open' | 'revoke' | 'forgetAlways'> | undefined
): Pick<AgentControl, 'guestOpen' | 'guestRevoke' | 'guestAlwaysForget'> {
  return {
    guestOpen: async (draft, context) =>
      guests ? guests.open(draft, context) : { seat: null, error: NO_GUESTS },
    guestRevoke: async (id, context) => (guests ? guests.revoke(id, context) : { revoked: false }),
    guestAlwaysForget: async (seat, approval, context) =>
      guests ? guests.forgetAlways(seat, approval, context) : { removed: false },
  };
}

const NO_GUESTS = 'This agent has no guest seats.';

function changesControl(
  changes: Pick<ChangesRuntime, 'open' | 'accept' | 'revert'> | undefined
): Pick<AgentControl, 'changesOpen' | 'changeAccept' | 'changeRevert'> {
  const needed = () => {
    if (!changes) throw new Error('This agent tracks no changes.');
    return changes;
  };
  const done = (path: string, run: (runtime: NonNullable<typeof changes>) => Promise<void>) =>
    created(async () => {
      await run(needed());
      return path;
    });
  return {
    changesOpen: async (context) => changes?.open(context),
    changeAccept: (path, context) => done(path, (runtime) => runtime.accept(path, context)),
    changeRevert: (path, context) => done(path, (runtime) => runtime.revert(path, context)),
  };
}

function memoryControl(
  memory: Pick<MemoryRuntime, 'save' | 'remove'> | undefined
): Pick<AgentControl, 'memorySave' | 'memoryRemove'> {
  return {
    async memorySave(draft, context) {
      if (!memory) throw new Error('This agent has no memory.');
      const { id, ...rest } = draft;
      return memory.save({ ...rest, ...(id ? { id } : {}) }, context);
    },
    async memoryRemove(id, context) {
      return { removed: memory ? await memory.remove(id, context) : false };
    },
  };
}

function sprinkleControl(
  sprinkles: Pick<SprinklesRuntime, 'send' | 'call'> | undefined
): Pick<AgentControl, 'sprinkleSend' | 'sprinkleCall'> {
  return {
    sprinkleSend: async (id, payload, context) =>
      sprinkles ? sprinkles.send(id, payload, context) : { delivered: false },
    async sprinkleCall(id, method, args, context) {
      if (!sprinkles) throw new Error('This agent has no sprinkles.');
      return sprinkles.call(id, method, args, context);
    },
  };
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
  attachments: ShownAttachment[];
  at: EntryId | null;
  files: boolean;
}

type Block = { type?: string; name?: string };

const WRITERS = ['write', 'edit', 'bash', 'codemode'];

function writesIn(entries: readonly EntryRecord[]): boolean {
  return entries.some((entry) =>
    (entry.model ?? []).some(
      (message) =>
        Array.isArray(message.content) &&
        (message.content as Block[]).some(
          (block) => block.type === 'toolCall' && WRITERS.includes(String(block.name))
        )
    )
  );
}

function lastTurn(view: ConversationView, messageId: string | null): Turn | null {
  const { entries } = view;
  const target = entries.findIndex((entry) => `e${entry.id}` === messageId);
  if (target < 0) return null;
  const turn = entries.slice(0, target).findLastIndex((entry) => entry.kind === 'pi.user');
  if (turn < 0) return null;
  const user = entries[turn] as EntryRecord;
  return {
    ...splitUser(user.model?.[0]?.content),
    at: entries[turn - 1]?.id ?? null,
    files: writesIn(entries.slice(turn)),
  };
}

function busy(view: ConversationView): boolean {
  const live = view.docs['pi.live'] as { run?: unknown } | undefined;
  const inbox = view.docs['pi.inbox'] as { items?: unknown[] } | undefined;
  return Boolean(live?.run) || Boolean(inbox?.items?.length);
}

type RewindDeps = {
  harness: Harness;
  agents?: Agents;
  cone: Cones;
  scoops?: HostScoops;
};

async function turnIn(
  harness: Harness,
  conversation: Conversation,
  messageId: string | null,
  context: Context
): Promise<{ turn: Turn; view: ConversationView } | Rewound> {
  const attached = await conversation.viewState(context);
  const view = attached.value;
  attached.dispose();
  const pending = (await harness.inspect(context)).submissions.some(
    (submission) => submission.conversationId === conversation.id
  );
  if (pending || busy(view)) return { done: false, text: null, reason: 'busy' };
  const turn = lastTurn(view, messageId);
  return turn ? { turn, view } : { done: false, text: null, reason: 'no-turn' };
}

async function forkAt(
  harness: Harness,
  conversation: Conversation,
  found: { turn: Turn },
  context: Context
): Promise<Conversation> {
  const ownership = { kind: 'ownerless' } as const;
  if (found.turn.at !== null) return conversation.fork(found.turn.at, { ownership }, context);
  const init = copyAgent(await storedAgent(harness, conversation.id, context));
  return harness.createConversation({ ownership, init }, context);
}

async function rewindAgent(
  deps: RewindDeps,
  agentId: string | null,
  messageId: string | null,
  context: Context
): Promise<Rewound> {
  const { harness, agents, cone, scoops } = deps;
  const scoop = agentId && agents ? agents.state().scoops[agentId] : undefined;
  if (agentId && agents && !scoop && agentId !== agents.activeCone())
    await agents.selectCone(agentId, context);
  const conversation =
    scoop && agents
      ? ((await agents.conversation(agentId as string, context)) as Conversation)
      : cone.cone();
  const found = await turnIn(harness, conversation, messageId, context);
  if ('reason' in found) return found;
  const fork = await forkAt(harness, conversation, found, context);
  const changed =
    scoops && agents && !scoop
      ? await scoops.scoops.rewound(agents.activeCone(), fork, context)
      : { stopped: [], restored: [] };
  const files = found.turn.files;
  await fork.submit(
    { type: 'write', entry: { kind: 'slicc.rewound', data: { turns: 1, ...changed, files } } },
    context
  );
  if (scoop && agents)
    await agents.update((_tx, state) => {
      const record = state.scoops[agentId as string] as ScoopRecord;
      record.conversation = fork.id;
      delete record.title;
      delete record.titled;
    }, context);
  else await cone.switchCone(fork, context);
  const { attachments } = found.turn;
  return {
    done: true,
    text: found.turn.text,
    reason: null,
    ...(attachments.length ? { attachments } : {}),
  };
}

type Picture = { type?: string; data?: string; mimeType?: string };

async function storedImage(
  harness: Harness,
  ref: ImageRef,
  context: Context
): Promise<StoredImage> {
  const entry = await harness.commit((tx) => tx.entry(ref.entry as EntryId), context);
  const content = entry?.model?.[ref.message]?.content;
  const part = Array.isArray(content) ? (content[ref.part] as Picture | undefined) : undefined;
  return part?.type === 'image' && part.data && part.mimeType
    ? { data: part.data, mimeType: part.mimeType }
    : { data: null, mimeType: null };
}

async function contentOf(
  text: string,
  request: SendRequest,
  conversation: Conversation,
  uploads: Uploads | undefined,
  context: Context
): Promise<UserInput> {
  if (!request.attachments?.length) return scrubText(text);
  const saver = await saverFor(conversation, uploads, context);
  return scrubItems(await userParts(text, request.attachments, saver));
}

export function createAgentControl(
  harness: Harness,
  target: Conversation | Cones,
  deliveries?: Deliveries,
  licks?: HostLicks,
  scoops?: HostScoops,
  skills?: Pick<SkillsRuntime, 'expand' | 'commandsFor'>,
  sprinkles?: Pick<SprinklesRuntime, 'send' | 'call'>,
  memory?: Pick<MemoryRuntime, 'save' | 'remove'>,
  freezer?: FreezerControl,
  changes?: Pick<ChangesRuntime, 'open' | 'accept' | 'revert'>,
  monitor?: Pick<Monitor, 'open' | 'close'>,
  secrets?: () => SecretListing,
  uploads?: Uploads,
  labels?: Pick<LabelsRuntime, 'label'>,
  guests?: Pick<Guests, 'open' | 'revoke' | 'forgetAlways'>
): Omit<AgentControl, 'approvalPolicySet'> {
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
  const rewindIn = (agentId: string | null, messageId: string | null, context: Context) =>
    serial(() => rewindAgent({ harness, agents, cone, scoops }, agentId, messageId, context));
  const decide = (
    agentId: string | null,
    lickId: string,
    state: 'confirmed' | 'dismissed',
    context: Context
  ): Promise<LickResolved> =>
    serial(async () => {
      if (!licks) return { done: false, text: null, error: 'this agent has no licks' };
      const action = state === 'confirmed' ? 'confirm' : 'dismiss';
      try {
        const conversation = await conversationFor(agentId, context);
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
  return {
    send(request, context) {
      return serial(async () => {
        if (secrets && request.text.trim() === SECRETS_COMMAND)
          return accepted(async () =>
            (await conversationFor(request.agentId, context)).submit(
              { type: 'write', entry: secretsEntry(secrets()) },
              context
            )
          );
        const response = await accepted(async () => {
          const conversation = await conversationFor(request.agentId, context);
          const expanded = skills
            ? await skills.expand(request.text, context, conversation.id)
            : request.text;
          return conversation.submit(
            {
              type: 'input',
              content: await contentOf(expanded, request, conversation, uploads, context),
              whenBusy: request.whenBusy,
              ...(request.requestId ? { requestId: request.requestId } : {}),
            },
            context
          );
        });
        const id = response.submissionId === null ? undefined : submissionId(response.submissionId);
        if (id !== undefined) deliveries?.expect(id, request.whenBusy);
        return response;
      });
    },
    rewind: (messageId, context) => rewindIn(null, messageId, context),
    rewindAgent: (agentId, messageId, context) => rewindIn(agentId, messageId, context),

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
    ...sprinkleControl(sprinkles),
    ...memoryControl(memory),
    ...freezerControl(freezer),
    ...changesControl(changes),
    ...guestControl(guests),
    ...monitorControl(monitor),
    image: (ref, context) => storedImage(harness, ref, context),
    async unqueue(agentId, id, context) {
      return withdraw(await conversationFor(agentId, context), id, context);
    },
    abort: (context) => current().abort(context),
    compact: (instructions, context) =>
      accepted(() => current().compact(instructions ?? undefined, context)),
    compactAgent: (agentId, instructions, context) =>
      accepted(async () =>
        (await conversationFor(agentId, context)).compact(instructions ?? undefined, context)
      ),
    reset: (handoff, context) => current().reset(handoff ?? undefined, context),
    resolveLick: (lickId, state, context) => decide(null, lickId, state, context),
    resolveAgentLick: (agentId, lickId, state, context) => decide(agentId, lickId, state, context),
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
    agentCommands: async (agentId) => skills?.commandsFor(agentId) ?? [],
    toolLabel: async (agentId, callIds, context) =>
      labels ? labels.label(agentId, callIds, context) : null,
    decide: noApprovals,
  };
}
