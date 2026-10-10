import type { Context } from '@earendil-works/chord';
import {
  type AgentChange,
  type AnyTask,
  type Conversation,
  type ConversationId,
  configure,
  defineDoc,
  type Harness,
  type TaskId,
  type ToolRegistration,
  type Tx,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import {
  type Agents,
  type AgentsState,
  freeFolder,
  live,
  type Mark,
  type ScoopRecord,
  scoopId,
} from '../agents.ts';
import { CODEMODE } from '../codemode/index.ts';
import type { ProcessGroups } from '../kernel/groups.ts';
import type { Licks } from '../licks/licks.ts';
import { McpAllowDoc, mcpEntries } from '../mcp/index.ts';
import type { Role } from '../roles/roles.ts';
import { visible } from './visible.ts';

export const SCOOPS_ROOT = '/scoops';
export const LEDGER_SIZE = 512;

export type Feed = {
  scoop: string;
  created: Mark | null;
  report: boolean;
  target: string | null;
  channel: 'scoop-notify' | 'bash';
  from?: string;
  agent?: boolean;
};
type Wait = { scoops: string[]; done: Record<string, string>; cone: string };
export type Answer = { code: number; out: string; tasks?: number[] };
type WorkState = {
  feeds: Record<string, Feed>;
  waits: Record<string, Wait>;
  ledger: Record<string, Answer>;
  turns: Record<string, { at: number; count: number }>;
};

export const ScoopWorkDoc = defineDoc<WorkState>({
  kind: 'slicc.scoops.work',
  version: 1,
  scope: 'session',
  initial: () => ({ feeds: {}, waits: {}, ledger: {}, turns: {} }),
});

export interface ScoopTasks {
  anchor: AnyTask;
  reporter: AnyTask;
  wait: AnyTask;
}

export interface ScoopsHost {
  harness: Harness;
  agents: Agents;
  licks: Licks;
  groups?: ProcessGroups;
  tools?: readonly ToolRegistration[];
  reads?: () => readonly string[];
  files?: Pick<ExecutionEnv, 'remove' | 'createDir'>;
  mcp?: (names: readonly string[]) => ToolRegistration[];
}

export interface Rewound {
  stopped: string[];
  restored: string[];
}

export interface ScoopSummary {
  id: string;
  folder: string;
  name: string;
  role: string | null;
  busy: boolean;
}

export interface Limits {
  maxLiveScoops: number;
  maxPerTurn: number;
}

export interface SpawnRequest {
  cone: string;
  kind?: 'async' | 'sync';
  parent?: string;
  depth?: number;
  roots?: { write: string[]; read: string[] };
  cwd?: string;
  origin?: string;
  instructions?: string;
  target?: string | null;
  asker?: string | null;
  name: string;
  role?: Role;
  model?: { provider: string; modelId: string };
  thinking?: AgentChange['thinkingLevel'];
  tools?: string[];
  prompts: string[];
  fromAgent: boolean;
  request?: string;
  limits: Limits;
}

export function workspace(folder: string): string {
  return `${SCOOPS_ROOT}/${folder}/workspace`;
}

export async function tail(conversation: Conversation, context: Context): Promise<Mark> {
  const { entries } = await conversation.context(context);
  return { in: conversation.id, at: Number(entries.at(-1)?.id ?? 0) };
}

export async function turnStart(conversation: Conversation, context: Context): Promise<number> {
  const { entries } = await conversation.context(context);
  return Number(entries.findLast((entry) => entry.kind === 'pi.user')?.id ?? 0);
}

export function coneOf(state: Readonly<AgentsState>, conversation: number): string | undefined {
  return Object.entries(state.cones).find(([, cone]) => cone.conversation === conversation)?.[0];
}

export function findScoop(
  state: Readonly<AgentsState>,
  handle: string,
  cone: string | null
): [string, ScoopRecord] | undefined {
  const id = handle.startsWith('scoop:') ? handle : scoopId(handle);
  const reachable = (record: ScoopRecord | undefined): record is ScoopRecord =>
    !!record && live(record) && (cone === null || record.cone === cone);
  const record = state.scoops[id];
  if (reachable(record)) return [id, record];
  return Object.entries(state.scoops).find(
    ([, candidate]) => reachable(candidate) && candidate.name === handle
  );
}

function remember(work: WorkState, request: string | undefined, answer: Answer): void {
  if (!request) return;
  work.ledger[request] = answer;
  const keys = Object.keys(work.ledger);
  for (const key of keys.slice(0, Math.max(0, keys.length - LEDGER_SIZE))) delete work.ledger[key];
}

type Core = { host: Promise<ScoopsHost>; tasks: () => ScoopTasks };

async function coneOfId(core: Core, coneId: string, context: Context): Promise<Conversation> {
  const { agents } = await core.host;
  const found = await agents.conversation(coneId, context);
  if (!found) throw new Error(`There is no cone ${coneId}.`);
  return found;
}

async function isBusy(core: Core, conversation: number, context: Context): Promise<boolean> {
  const { harness } = await core.host;
  const handle = await harness.conversation(conversation as ConversationId, context);
  const view = await handle?.viewState(context);
  const run = (view?.value.docs['pi.live'] as { run?: unknown } | undefined)?.run;
  view?.dispose();
  return Boolean(run);
}

async function answered(
  core: Core,
  request: string | undefined,
  context: Context
): Promise<Answer | undefined> {
  if (!request) return undefined;
  const { harness } = await core.host;
  return (await harness.snapshot(ScoopWorkDoc, context))?.ledger[request];
}

type NewFeed = Omit<Feed, 'channel' | 'from'> & {
  from: string;
  agent: boolean;
  prompt: string;
  request?: string;
  followUp?: boolean;
};

async function addFeed(core: Core, tx: Tx, parent: number, feed: NewFeed): Promise<number> {
  const task = await tx.createTask(
    core.tasks().reporter as never,
    {
      scoop: feed.scoop,
      prompt: feed.prompt,
      ...(feed.followUp ? { followUp: true } : {}),
      ...(feed.request ? { request: feed.request } : {}),
    },
    {
      ownership: { kind: 'conversation' },
      conversationId: parent as ConversationId,
      background: true,
    }
  );
  (await tx.doc(ScoopWorkDoc)).feeds[String(task)] = {
    scoop: feed.scoop,
    created: feed.created,
    report: feed.report,
    target: feed.target,
    channel: 'scoop-notify',
    from: feed.from,
    agent: feed.agent,
  };
  return Number(task);
}

function selection(
  tools: readonly ToolRegistration[] | undefined,
  names: string[] | undefined,
  mcp?: (names: readonly string[]) => ToolRegistration[]
) {
  if (!names || !tools) return undefined;
  const picked = tools.filter((tool) => names.includes(tool.name));
  const entries = mcpEntries(names) ?? [];
  if (!entries.length) return picked;
  const codemode = tools.find((tool) => tool.name === CODEMODE);
  if (codemode && !picked.includes(codemode)) picked.push(codemode);
  return [...picked, ...(mcp?.(entries) ?? [])];
}

function liveCount(state: Readonly<AgentsState>, cone: string): number {
  return Object.values(state.scoops).filter((scoop) => scoop.cone === cone && live(scoop)).length;
}

function claimTurn(
  work: WorkState,
  request: SpawnRequest,
  turn: number | null
): Answer | undefined {
  if (turn === null) return undefined;
  const counted = work.turns[request.cone];
  const count = counted && counted.at === turn ? counted.count : 0;
  if (count >= request.limits.maxPerTurn)
    return {
      code: 1,
      out: `subagent: this turn already started ${count} scoops (the limit is ${request.limits.maxPerTurn})\n`,
    };
  work.turns[request.cone] = { at: turn, count: count + 1 };
  return undefined;
}

function agentChange(
  request: SpawnRequest,
  folder: string,
  tools: readonly ToolRegistration[] | undefined,
  mcp?: (names: readonly string[]) => ToolRegistration[]
): AgentChange {
  const model = request.model ?? modelOf(request.role?.model);
  const thinking = request.thinking ?? request.role?.thinking;
  const chosen = selection(tools, request.tools ?? request.role?.tools, mcp);
  const instructions = [request.role?.prompt, request.instructions].filter(Boolean).join('\n\n');
  return {
    cwd: request.cwd ?? workspace(folder),
    ...(instructions ? { instructions } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking as AgentChange['thinkingLevel'] } : {}),
    ...(chosen ? { tools: chosen } : {}),
  };
}

async function narrowMcp(
  tx: Tx,
  state: Readonly<AgentsState>,
  cone: ConversationId,
  child: ConversationId,
  request: SpawnRequest
): Promise<void> {
  const listed = mcpEntries(request.tools ?? request.role?.tools);
  const caller = state.scoops[request.parent ?? '']?.conversation as ConversationId | undefined;
  const inherited = (await tx.doc(McpAllowDoc, caller ?? cone)).allow;
  if (listed !== null || inherited !== null)
    (await tx.doc(McpAllowDoc, child)).allow = listed ?? inherited;
}

async function spawn(core: Core, request: SpawnRequest, context: Context): Promise<Answer> {
  const done = await answered(core, request.request, context);
  if (done) return done;
  const { agents, tools, mcp } = await core.host;
  const parent = await coneOfId(core, request.cone, context);
  const count = liveCount(agents.state(), request.cone);
  if (count >= request.limits.maxLiveScoops)
    return {
      code: 1,
      out: `subagent: this cone already has ${count} live scoops (the limit is ${request.limits.maxLiveScoops}); stop one first\n`,
    };
  const created = request.fromAgent ? await tail(parent, context) : null;
  const turn = request.fromAgent ? await turnStart(parent, context) : null;
  return agents.update(async (tx, doc) => {
    const work = await tx.doc(ScoopWorkDoc);
    const refused = claimTurn(work as WorkState, request, turn);
    if (refused) return refused;
    const folder = freeFolder(doc, request.name);
    const id = scoopId(folder);
    const anchor = await tx.createTask(core.tasks().anchor as never, null, {
      ownership: { kind: 'conversation' },
      conversationId: parent.id,
      background: true,
    });
    const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
    await configure(tx, child.id, agentChange(request, folder, tools, mcp));
    await narrowMcp(tx, doc, parent.id, child.id, request);
    doc.scoops[id] = {
      name: request.name.trim() || folder,
      folder,
      cone: request.cone,
      conversation: child.id,
      anchor,
      role: request.role?.name ?? null,
      ...(request.role?.memory ? { memory: request.role.memory } : {}),
      ...(request.role?.memory && request.origin ? { origin: request.origin } : {}),
      ...(request.role?.context ? { context: request.role.context } : {}),
      kind: request.kind ?? 'async',
      parent: request.parent ?? request.cone,
      depth: request.depth ?? 1,
      roots: request.roots ?? null,
      created,
      dropped: null,
      gone: false,
    };
    const target =
      request.target === undefined
        ? request.fromAgent
          ? `cone:${request.cone}`
          : null
        : request.target;
    const made: number[] = [];
    const asker = request.asker === undefined ? target : request.asker;
    const from = askerName(doc, asker);
    for (const prompt of request.prompts)
      made.push(
        await addFeed(core, tx, parent.id, {
          scoop: id,
          created,
          report: target !== null,
          target,
          from,
          agent: asker !== null,
          prompt,
        })
      );
    const answer = { code: 0, out: `${folder}\n`, tasks: made };
    remember(work as WorkState, request.request, answer);
    return answer;
  }, context);
}

export function askerName(state: Readonly<AgentsState>, asker: string | null): string {
  if (asker === null) return 'terminal';
  if (asker.startsWith('cone:')) return state.cones[asker.slice('cone:'.length)]?.name ?? asker;
  return state.scoops[asker]?.name ?? asker;
}

const missing = (id: string): Answer => ({
  code: 1,
  out: `subagent: there is no scoop ${id.replace('scoop:', '')}\n`,
});

async function feed(
  core: Core,
  id: string,
  prompt: string,
  options: { fromAgent: boolean; request: string; followUp: boolean; target: string | null },
  context: Context
): Promise<Answer> {
  const done = await answered(core, options.request, context);
  if (done) return done;
  const { harness, agents } = await core.host;
  const record = agents.state().scoops[id];
  if (!record || !live(record)) return missing(id);
  const parent = await coneOfId(core, record.cone, context);
  const created = options.fromAgent ? await tail(parent, context) : null;
  const { target } = options;
  return harness.commit(async (tx) => {
    await addFeed(core, tx, parent.id, {
      scoop: id,
      created,
      report: target !== null,
      target,
      from: askerName(agents.state(), target),
      agent: target !== null,
      prompt,
      followUp: options.followUp,
      request: options.request,
    });
    const answer = { code: 0, out: `sent to ${record.folder}\n` };
    remember((await tx.doc(ScoopWorkDoc)) as WorkState, options.request, answer);
    return answer;
  }, context);
}

async function signal(core: Core, record: ScoopRecord, context: Context): Promise<void> {
  const { harness, groups } = await core.host;
  const conversation = await harness.conversation(record.conversation as ConversationId, context);
  await conversation?.abort(context, { background: true });
  await groups?.signal(record.conversation);
}

async function stopFeeds(
  core: Core,
  scoop: string,
  keep: (feed: Feed) => Promise<boolean>,
  context: Context
) {
  const { harness } = await core.host;
  const work = (await harness.snapshot(ScoopWorkDoc, context)) ?? { feeds: {} };
  const dropped: string[] = [];
  for (const [task, entry] of Object.entries(work.feeds)) {
    if (entry.scoop !== scoop || (await keep(entry))) continue;
    const record = await harness.getTask(Number(task) as TaskId, context);
    if (record && record.state.status !== 'terminal')
      await harness.abortTask(Number(task) as TaskId, context);
    dropped.push(task);
  }
  if (dropped.length)
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ScoopWorkDoc);
      for (const task of dropped) delete doc.feeds[task];
    }, context);
  return dropped.length;
}

async function stop(core: Core, id: string, fromAgent: boolean, context: Context): Promise<Answer> {
  const { agents, files } = await core.host;
  const record = agents.state().scoops[id];
  if (!record || !live(record)) return missing(id);
  await stopFeeds(core, id, async () => false, context);
  await signal(core, record, context);
  const mark = fromAgent
    ? await tail(await coneOfId(core, record.cone, context), context)
    : { in: 0, at: 0 };
  await agents.update((_tx, state) => {
    (state.scoops[id] as ScoopRecord).dropped = mark;
  }, context);
  const removed = await files?.remove(
    workspace(record.folder),
    { recursive: true, force: true },
    context
  );
  const folder = removed?.ok
    ? `removed ${workspace(record.folder)}`
    : `kept ${workspace(record.folder)}`;
  return {
    code: 0,
    out: `stopped ${record.folder}; its transcript is kept, ${folder}, and its reports stay in ${SCOOPS_ROOT}/${record.folder}/reports\n`,
  };
}

async function rename(core: Core, id: string, name: string, context: Context): Promise<Answer> {
  const { agents } = await core.host;
  const record = agents.state().scoops[id];
  if (!record || !live(record)) return missing(id);
  const wanted = name.trim();
  if (!wanted) return { code: 2, out: 'subagent: rename needs a non-empty name\n' };
  await agents.update((_tx, state) => {
    (state.scoops[id] as ScoopRecord).name = wanted;
  }, context);
  return { code: 0, out: `${record.folder} is now called ${wanted}\n` };
}

async function resetWorkspace(
  files: ScoopsHost['files'],
  folder: string,
  context: Context
): Promise<boolean> {
  if (!files) return true;
  const cleared = await files.remove(workspace(folder), { recursive: true, force: true }, context);
  if (!cleared.ok) return false;
  return (await files.createDir(workspace(folder), { recursive: true }, context)).ok;
}

type Seen = (mark: Mark | null) => Promise<boolean>;

async function rewindOne(
  core: Core,
  coneId: string,
  id: string,
  record: ScoopRecord,
  seen: Seen,
  result: Rewound,
  context: Context
): Promise<Partial<ScoopRecord> | undefined> {
  const { harness, licks, files } = await core.host;
  if (!(await seen(record.created))) {
    if (live(record)) {
      await stopFeeds(core, id, async () => false, context);
      await signal(core, record, context);
      result.stopped.push(record.name);
    }
    return { gone: true };
  }
  if (record.dropped !== null) {
    if (await seen(record.dropped)) return undefined;
    const reset = await resetWorkspace(files, record.folder, context);
    result.restored.push(
      reset ? record.name : `${record.name} (its working folder could not be reset)`
    );
    return { dropped: null };
  }
  const withdrawn = await stopFeeds(core, id, (entry) => seen(entry.created), context);
  if (!withdrawn) return undefined;
  const conversation = await harness.conversation(record.conversation as ConversationId, context);
  await conversation?.abort(context);
  await licks.forget(`cone:${coneId}`, 'scoop-notify', id, context);
  return undefined;
}

async function rewound(
  core: Core,
  coneId: string,
  fork: Conversation,
  context: Context
): Promise<Rewound> {
  const { harness, agents } = await core.host;
  const read = (id: number) =>
    harness.commit((tx) => tx.conversation(id as ConversationId), context);
  const seen: Seen = async (mark) =>
    mark === null || mark.in === 0 || (await visible(read, fork.id, mark));
  const result: Rewound = { stopped: [], restored: [] };
  const changes: [string, Partial<ScoopRecord>][] = [];
  for (const [id, record] of Object.entries(agents.state().scoops)) {
    if (record.cone !== coneId || record.gone) continue;
    const change = await rewindOne(core, coneId, id, record, seen, result, context);
    if (change) changes.push([id, change]);
  }
  if (changes.length)
    await agents.update((_tx, state) => {
      for (const [id, change] of changes) Object.assign(state.scoops[id] as ScoopRecord, change);
    }, context);
  return result;
}

async function list(core: Core, coneId: string | null, context: Context): Promise<ScoopSummary[]> {
  const { agents } = await core.host;
  const out: ScoopSummary[] = [];
  for (const [id, record] of Object.entries(agents.state().scoops)) {
    if ((coneId !== null && record.cone !== coneId) || !live(record)) continue;
    out.push({
      id,
      folder: record.folder,
      name: record.name,
      role: record.role,
      busy: await isBusy(core, record.conversation, context),
    });
  }
  return out;
}

async function working(core: Core, ids: readonly string[], context: Context): Promise<string[]> {
  const { harness, agents } = await core.host;
  const feeds = Object.values((await harness.snapshot(ScoopWorkDoc, context))?.feeds ?? {});
  const out: string[] = [];
  for (const id of ids) {
    const record = agents.state().scoops[id];
    if (!record) continue;
    if (
      feeds.some((entry) => entry.scoop === id) ||
      (await isBusy(core, record.conversation, context))
    )
      out.push(id);
  }
  return out;
}

async function notifyWhenDone(
  core: Core,
  coneId: string,
  ids: string[],
  deadline: number,
  context: Context
) {
  const { harness } = await core.host;
  const parent = await coneOfId(core, coneId, context);
  await harness.commit(
    (tx) =>
      tx.createTask(
        core.tasks().wait as never,
        { scoops: ids, cone: coneId, deadline },
        { ownership: { kind: 'conversation' }, conversationId: parent.id, background: true }
      ),
    context
  );
}

async function detach(core: Core, tasks: readonly number[], target: string, context: Context) {
  const { harness } = await core.host;
  await harness.commit(async (tx) => {
    const work = await tx.doc(ScoopWorkDoc);
    for (const task of tasks) {
      const entry = work.feeds[String(task)];
      if (!entry) continue;
      entry.report = true;
      entry.target = target;
      entry.channel = 'bash';
    }
  }, context);
}

async function note(core: Core, id: string, text: string, context: Context): Promise<Answer> {
  const { agents, licks } = await core.host;
  const record = agents.state().scoops[id];
  if (!record || !live(record)) return missing(id);
  const label = `${record.name} (${record.role ?? 'scoop'})`;
  await licks.deliver(
    {
      channel: 'scoop-notify',
      source: `${id}#note`,
      title: label,
      text: `[scoop ${label} progress]`,
      body: text,
      target: `cone:${record.cone}`,
    },
    context
  );
  return { code: 0, out: 'note sent to the cone\n' };
}

export function createScoops(host: Promise<ScoopsHost>, tasks: () => ScoopTasks) {
  const core: Core = { host, tasks };
  return {
    detach: (made: readonly number[], target: string, context: Context) =>
      detach(core, made, target, context),
    note: (id: string, text: string, context: Context) => note(core, id, text, context),
    spawn: (request: SpawnRequest, context: Context) => spawn(core, request, context),
    feed: (
      id: string,
      prompt: string,
      options: { fromAgent: boolean; request: string; followUp: boolean; target: string | null },
      context: Context
    ) => feed(core, id, prompt, options, context),
    stop: (id: string, fromAgent: boolean, context: Context) => stop(core, id, fromAgent, context),
    rename: (id: string, name: string, context: Context) => rename(core, id, name, context),
    rewound: (coneId: string, fork: Conversation, context: Context) =>
      rewound(core, coneId, fork, context),
    list: (coneId: string | null, context: Context) => list(core, coneId, context),
    busy: (conversation: number, context: Context) => isBusy(core, conversation, context),
    working: (ids: readonly string[], context: Context) => working(core, ids, context),
    notifyWhenDone: (coneId: string, ids: string[], deadline: number, context: Context) =>
      notifyWhenDone(core, coneId, ids, deadline, context),
  };
}

export function modelOf(
  value: string | undefined
): { provider: string; modelId: string } | undefined {
  if (!value) return undefined;
  const at = value.indexOf('/');
  if (at <= 0) return undefined;
  return { provider: value.slice(0, at), modelId: value.slice(at + 1) };
}

export type Scoops = ReturnType<typeof createScoops>;
