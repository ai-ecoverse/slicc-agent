import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  Conversation,
  ConversationId,
  EntryRecord,
  Harness,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { answerText } from '../agent.ts';
import {
  type Agents,
  type AgentsState,
  type FrozenRecord,
  live,
  type ScoopRecord,
} from '../agents.ts';
import { HOME } from '../kernel/env.ts';
import type { LickTarget } from '../licks/lick.ts';
import { SCOOPS_ROOT, workspace } from '../scoops/service.ts';

export type Answer = { code: number; out: string };

export type ConversationKind = 'cone' | 'scoop' | 'agent';

export interface FrozenCone {
  id: string;
  name: string;
  title: string;
  model: string;
  messages: number;
  frozenAt: number;
  kind: ConversationKind;
  live: boolean;
  thawedAs: string | null;
}

export const THAWED_KIND = 'slicc.thawed';

export type Frozen = { id: string; name: string; at: number };

export interface FreezerAttach {
  harness: Harness;
  agents: Agents;
  env: Pick<ExecutionEnv, 'remove' | 'exists'>;
  title?: (transcript: string, model: string, context: Context) => Promise<string | undefined>;
  extract?: (
    conversation: number,
    tail: number,
    context: Context,
    cone: string
  ) => Promise<unknown>;
  now?: () => number;
}

export interface FreezerRuntime {
  readonly frozen: ReplicatedState<FrozenCone[]>;
  freeze(agentId: string, context: Context): Promise<string>;
  newChat(agentId: string, context: Context): Promise<string | null>;
  thaw(id: string, context: Context): Promise<string>;
  discard(id: string, context: Context): Promise<void>;
  refresh(): Promise<readonly FrozenCone[]>;
  touch(): void;
  frozenTarget(target: LickTarget): Frozen | undefined;
  command(argv: readonly string[], caller: string | null, context: Context): Promise<Answer>;
  close(): void;
}

export const USAGE = `usage:
  freezer list         every conversation: id, kind, name, title, messages, when
  freezer show <id>    a conversation as Markdown
  freezer thaw <id>    continue a stopped conversation as a cone

Delete a cone, or start a new conversation, from the chat toolbar or the command palette.
`;

const TITLE_LENGTH = 60;
export const TOUCH_MS = 500;

function textOf(entry: EntryRecord): string {
  return answerText(entry.model?.[0]?.content).trim();
}

export function modelName(model: { provider: string; modelId: string } | undefined): string {
  return model ? `${model.provider}/${model.modelId}` : '';
}

export function firstLine(entries: readonly EntryRecord[]): string {
  const first = entries.find((entry) => entry.kind === 'pi.user' && textOf(entry));
  const line = first ? (textOf(first).split('\n')[0] as string).trim() : '';
  if (!line) return 'Untitled chat';
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

function calls(entry: EntryRecord): string[] {
  const content = entry.model?.[0]?.content;
  if (!Array.isArray(content)) return [];
  return (content as { type: string; name?: string; arguments?: unknown }[])
    .filter((part) => part.type === 'toolCall')
    .map((part) => `- \`${part.name}\` ${JSON.stringify(part.arguments ?? {})}`);
}

export function markdown(
  record: Pick<FrozenRecord, 'title' | 'name' | 'model' | 'frozenAt'>,
  entries: readonly EntryRecord[]
): string {
  const out = [
    `# ${record.title}`,
    '',
    `${record.name} · ${record.model} · ${new Date(record.frozenAt).toISOString()}`,
  ];
  for (const entry of entries) {
    if (entry.kind === 'pi.user' && textOf(entry)) out.push('', '## User', '', textOf(entry));
    if (entry.kind !== 'pi.assistant') continue;
    const text = textOf(entry);
    const tools = calls(entry);
    if (!text && !tools.length) continue;
    out.push('', '## Assistant', '');
    if (text) out.push(text);
    if (tools.length) out.push(...(text ? [''] : []), ...tools);
  }
  return `${out.join('\n')}\n`;
}

type Stats = Pick<FrozenCone, 'title' | 'model' | 'messages' | 'frozenAt'>;

function counted(entries: readonly EntryRecord[]): number {
  return entries.filter((entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant')
    .length;
}

function lastAt(entries: readonly EntryRecord[]): number {
  let at = 0;
  for (const entry of entries)
    for (const message of entry.model ?? []) {
      const stamp = (message as { timestamp?: unknown }).timestamp;
      if (typeof stamp === 'number' && stamp > at) at = stamp;
    }
  return at;
}

async function statsOf(harness: Harness, id: number, context: Context): Promise<Stats> {
  const conversation = await harness.conversation(id as ConversationId, context);
  if (!conversation) return { title: firstLine([]), model: '', messages: 0, frozenAt: 0 };
  const view = await conversation.context(context);
  const agent = await conversation.agent(context);
  return {
    title: firstLine(view.entries),
    model: modelName(agent.model),
    messages: counted(view.entries),
    frozenAt: lastAt(view.entries),
  };
}

const kindOf = (scoop: ScoopRecord): ConversationKind =>
  scoop.kind === 'sync' ? 'agent' : 'scoop';

async function rows(
  harness: Harness,
  state: Readonly<AgentsState>,
  cache: Map<number, Stats>,
  context: Context
): Promise<FrozenCone[]> {
  const stats = async (conversation: number, stopped: boolean) => {
    const cached = stopped ? cache.get(conversation) : undefined;
    if (cached) return cached;
    const found = await statsOf(harness, conversation, context);
    if (stopped) cache.set(conversation, found);
    return found;
  };
  const out: FrozenCone[] = [];
  for (const [id, cone] of Object.entries(state.cones))
    out.push({
      id,
      name: cone.name,
      ...(await stats(cone.conversation, false)),
      kind: 'cone',
      live: true,
      thawedAs: null,
    });
  for (const [id, record] of Object.entries(state.frozen ?? {}))
    out.push({
      id,
      name: record.name,
      title: record.title,
      model: record.model,
      messages: record.messages,
      frozenAt: record.frozenAt,
      kind: 'cone',
      live: false,
      thawedAs: null,
    });
  for (const [id, scoop] of Object.entries(state.scoops)) {
    if (scoop.removed) continue;
    const running = live(scoop);
    out.push({
      id,
      name: scoop.name,
      ...(await stats(scoop.conversation, !running)),
      kind: kindOf(scoop),
      live: running,
      thawedAs: scoop.thawedAs ?? null,
    });
  }
  return out.sort((a, b) => Number(b.live) - Number(a.live) || b.frozenAt - a.frozenAt);
}

export function thawedNote(
  kind: ConversationKind,
  name: string,
  folder: string,
  kept: boolean
): string {
  const what = kind === 'agent' ? 'agent run' : kind;
  const place = kept
    ? `Its workspace ${folder} is still there.`
    : `Its workspace ${folder} was deleted when it stopped.`;
  return `This was ${what} ${name}'s conversation, thawed as a cone. ${place} You now work in ${HOME} as a cone, with a cone's tools.`;
}

type Snapshot = { entries: readonly EntryRecord[]; record: Omit<FrozenRecord, 'scoops' | 'cone'> };

async function snapshot(
  conversation: Conversation,
  name: string,
  now: number,
  context: Context
): Promise<Snapshot> {
  const view = await conversation.context(context);
  const agent = await conversation.agent(context);
  return {
    entries: view.entries,
    record: {
      name,
      conversation: conversation.id,
      title: firstLine(view.entries),
      model: modelName(agent.model),
      messages: counted(view.entries),
      frozenAt: now,
    },
  };
}

export function frozenTarget(state: Readonly<AgentsState>, target: LickTarget): Frozen | undefined {
  const records = Object.entries(state.frozen ?? {});
  if (target.startsWith('cone:')) {
    const cone = target.slice('cone:'.length);
    if (state.cones[cone]) return undefined;
    const found = records
      .filter(([, record]) => record.cone === cone)
      .sort(([, a], [, b]) => b.frozenAt - a.frozenAt)[0];
    return found ? { id: found[0], name: found[1].name, at: found[1].frozenAt } : undefined;
  }
  const owner = state.scoops[target]?.frozen;
  const record = owner ? state.frozen?.[owner] : undefined;
  return owner && record ? { id: owner, name: record.name, at: record.frozenAt } : undefined;
}

async function command(
  options: FreezerAttach,
  runtime: FreezerRuntime,
  argv: readonly string[],
  context: Context
): Promise<Answer> {
  const verb = argv[0] ?? 'help';
  const listed = await runtime.refresh();
  if (verb === 'list') {
    const lines = listed.map(
      (item) =>
        `${item.id}\t${item.kind}${item.live ? ' (live)' : ''}\t${item.name}\t${item.title}\t${item.messages} messages\t${new Date(item.frozenAt).toISOString()}`
    );
    return { code: 0, out: lines.length ? `${lines.join('\n')}\n` : 'no conversations\n' };
  }
  if (verb !== 'show' && verb !== 'thaw')
    return { code: verb === 'help' || verb === '--help' ? 0 : 2, out: USAGE };
  const id = argv[1] ?? '';
  const item = listed.find((row) => row.id === id);
  if (!item) return { code: 1, out: `freezer: there is no conversation ${id}\n` };
  if (verb === 'thaw') {
    if (item.live) return { code: 1, out: `freezer: ${item.name} is live; it needs no thawing\n` };
    return { code: 0, out: `thawed ${id} as ${await runtime.thaw(id, context)}\n` };
  }
  const state = options.agents.state();
  const conversationId =
    state.frozen?.[id]?.conversation ??
    state.cones[id]?.conversation ??
    state.scoops[id]?.conversation;
  const conversation = await options.harness.conversation(
    conversationId as ConversationId,
    context
  );
  const entries = conversation ? (await conversation.context(context)).entries : [];
  return { code: 0, out: markdown(item, entries) };
}

async function freshLike(
  harness: Harness,
  conversation: Conversation,
  context: Context
): Promise<Conversation> {
  const agent = await conversation.agent(context);
  return harness.createConversation(
    {
      ownership: { kind: 'ownerless' },
      agent: {
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
        extensions: agent.extensions,
        tools: agent.tools,
        instructions: agent.instructions ?? null,
        cwd: agent.cwd ?? null,
      },
    },
    context
  );
}

async function activeCone(agents: Agents, context: Context): Promise<Conversation> {
  const conversation = await agents.conversation(agents.state().active, context);
  if (!conversation) throw new Error('There is no active cone.');
  return conversation;
}

async function thawScoop(
  options: FreezerAttach & { now: () => number },
  id: string,
  scoop: ScoopRecord,
  context: Context
): Promise<string> {
  const { harness, agents, env, now } = options;
  if (scoop.removed) throw new Error(`There is no conversation ${id}.`);
  if (live(scoop)) throw new Error(`${scoop.name} is still running; open it instead.`);
  const conversation = await harness.conversation(scoop.conversation as ConversationId, context);
  if (!conversation) throw new Error(`There is no conversation ${id}.`);
  const last = (await conversation.context(context)).entries.at(-1);
  const agent = await conversation.agent(context);
  const cone = await (await activeCone(agents, context)).agent(context);
  const created = {
    ownership: { kind: 'ownerless' as const },
    agent: {
      model: agent.model as NonNullable<typeof agent.model>,
      thinkingLevel: agent.thinkingLevel,
      extensions: cone.extensions,
      tools: cone.tools,
      instructions: cone.instructions ?? null,
      cwd: HOME,
    },
  };
  const fork = last
    ? await conversation.fork(last.id, created, context)
    : await harness.createConversation(created, context);
  const folder = workspace(scoop.folder);
  const exists = await env.exists(folder, context);
  const kept = exists.ok && exists.value;
  await fork.submit(
    {
      type: 'write',
      entry: {
        kind: THAWED_KIND,
        data: { scoop: id, name: scoop.name, kind: kindOf(scoop), workspace: folder, kept },
        model: [
          {
            role: 'user',
            content: thawedNote(kindOf(scoop), scoop.name, folder, kept),
            timestamp: now(),
          },
        ],
      },
    },
    context
  );
  const coneId = await agents.update((_tx, doc) => {
    const target = `cone-${doc.next}`;
    doc.next += 1;
    doc.cones[target] = { name: scoop.name, conversation: fork.id };
    (doc.scoops[id] as ScoopRecord).thawedAs = target;
    return target;
  }, context);
  await agents.selectCone(coneId, context);
  return coneId;
}

async function removeScoop(
  options: FreezerAttach,
  id: string,
  scoop: ScoopRecord,
  context: Context
): Promise<void> {
  const { agents, env } = options;
  if (live(scoop)) throw new Error(`${scoop.name} is still running; stop it first.`);
  await agents.update((_tx, doc) => {
    const entry = doc.scoops[id] as ScoopRecord;
    entry.removed = true;
    entry.gone = true;
    delete entry.frozen;
  }, context);
  await env.remove(`${SCOOPS_ROOT}/${scoop.folder}`, { recursive: true, force: true }, context);
}

function listing(harness: Harness, agents: Agents) {
  const frozen = replicatedState<FrozenCone[]>([]);
  const cache = new Map<number, Stats>();
  let lock: Promise<readonly FrozenCone[]> = Promise.resolve([]);
  const refresh = () => {
    lock = lock
      .catch(() => [])
      .then(async () => {
        const listed = await rows(harness, agents.state(), cache, BACKGROUND_CONTEXT);
        frozen.replace(BACKGROUND_CONTEXT, listed);
        return listed;
      });
    return lock;
  };
  const quiet = () => void refresh().catch(() => undefined);
  quiet();
  const stop = agents.onChange(quiet);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(quiet, TOUCH_MS);
  };
  const off = () => {
    clearTimeout(timer);
    stop();
  };
  return { frozen, refresh, touch, off };
}

async function thawFrozen(agents: Agents, id: string, context: Context): Promise<string> {
  const coneId = await agents.update((_tx, doc) => {
    const record = doc.frozen?.[id];
    if (!record) throw new Error(`There is no frozen chat ${id}.`);
    const reuse = !doc.cones[record.cone];
    const target = reuse ? record.cone : `cone-${doc.next}`;
    if (!reuse) doc.next += 1;
    doc.cones[target] = { name: record.name, conversation: record.conversation };
    for (const scoop of record.scoops) {
      const entry = doc.scoops[scoop];
      if (!entry) continue;
      delete entry.frozen;
      entry.cone = target;
    }
    delete doc.frozen?.[id];
    return target;
  }, context);
  await agents.selectCone(coneId, context);
  return coneId;
}

async function discardFrozen(options: FreezerAttach, id: string, context: Context) {
  const { agents, env } = options;
  const record = agents.state().frozen?.[id];
  if (!record) throw new Error(`There is no frozen chat ${id}.`);
  const folders = record.scoops
    .map((scoop) => agents.state().scoops[scoop]?.folder)
    .filter((folder): folder is string => Boolean(folder));
  await agents.update((_tx, doc) => {
    for (const scoop of record.scoops) {
      const entry = doc.scoops[scoop];
      if (!entry) continue;
      delete entry.frozen;
      entry.gone = true;
    }
    delete doc.frozen?.[id];
  }, context);
  for (const folder of folders)
    await env.remove(`${SCOOPS_ROOT}/${folder}`, { recursive: true, force: true }, context);
}

export function attachFreezer(options: FreezerAttach): FreezerRuntime {
  const { harness, agents } = options;
  const now = options.now ?? Date.now;
  const { frozen, refresh, touch, off } = listing(harness, agents);
  const conversationOf = async (agentId: string, context: Context) => {
    const conversation = await agents.conversation(agentId, context);
    if (!conversation) throw new Error(`There is no cone ${agentId}.`);
    return conversation;
  };
  const prepare = async (
    conversation: Conversation,
    entries: readonly EntryRecord[],
    cone: string,
    context: Context
  ) => {
    const tail = entries.at(-1)?.id ?? 0;
    await options.extract?.(conversation.id, tail, context, cone).catch(() => undefined);
  };
  const retitle = (
    id: string,
    model: string,
    entries: readonly EntryRecord[],
    context: Context
  ) => {
    if (!options.title) return;
    const transcript = entries
      .filter((entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant')
      .map((entry) => `${entry.kind === 'pi.user' ? 'User' : 'Agent'}: ${textOf(entry)}`)
      .join('\n')
      .slice(0, 4000);
    void options
      .title(transcript, model, context)
      .then(async (title) => {
        const clean = title
          ?.replace(/\s+/g, ' ')
          .replace(/^["'“”]+|["'“”]+$/g, '')
          .replace(/\.+$/, '')
          .trim();
        if (!clean) return;
        await agents.update((_tx, doc) => {
          const record = doc.frozen?.[id];
          if (record) record.title = clean.slice(0, TITLE_LENGTH);
        }, context);
      })
      .catch(() => undefined);
  };
  const replacement = async (coneId: string, context: Context) => {
    const state = agents.state();
    const other = Object.keys(state.cones).find((id) => id !== coneId);
    if (other) return { id: other, conversation: undefined };
    const current = await conversationOf(coneId, context);
    const conversation = await harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: (await current.agent(context)).model },
      },
      context
    );
    return { id: `cone-${state.next}`, conversation };
  };
  const runtime: FreezerRuntime = {
    frozen,
    async freeze(agentId, context) {
      const cone = agents.state().cones[agentId];
      if (!cone) throw new Error(`There is no cone ${agentId}.`);
      const conversation = await conversationOf(agentId, context);
      const { entries, record } = await snapshot(conversation, cone.name, now(), context);
      await prepare(conversation, entries, agentId, context);
      await conversation.abort(context, { background: true }).catch(() => undefined);
      const next =
        agents.state().active === agentId ? await replacement(agentId, context) : undefined;
      const { id, scoops } = await agents.update((_tx, doc) => {
        if (!doc.cones[agentId]) throw new Error(`There is no cone ${agentId}.`);
        const frozenId = `frozen-${doc.frozenNext ?? 1}`;
        const owned = Object.entries(doc.scoops)
          .filter(([, scoop]) => scoop.cone === agentId && live(scoop))
          .map(([scoop]) => scoop);
        doc.frozenNext = (doc.frozenNext ?? 1) + 1;
        doc.frozen ??= {};
        doc.frozen[frozenId] = { ...record, cone: agentId, scoops: owned };
        delete doc.cones[agentId];
        for (const scoop of owned) (doc.scoops[scoop] as { frozen?: string }).frozen = frozenId;
        if (next?.conversation) {
          doc.cones[next.id] = { name: record.name, conversation: next.conversation.id };
          doc.next += 1;
        }
        return { id: frozenId, scoops: owned };
      }, context);
      for (const scoop of scoops)
        await (await agents.conversation(scoop, context))?.abort(context).catch(() => undefined);
      if (next) await agents.selectCone(next.id, context);
      retitle(id, record.model, entries, context);
      return id;
    },
    async newChat(agentId, context) {
      const cone = agents.state().cones[agentId];
      const scoop = agents.state().scoops[agentId];
      if (!cone && scoop && live(scoop)) {
        await (await agents.conversation(agentId, context))?.reset(undefined, context);
        return null;
      }
      if (!cone) throw new Error(`There is no cone ${agentId}.`);
      const conversation = await conversationOf(agentId, context);
      const before = (await conversation.context(context)).entries;
      if (!before.some((entry) => entry.kind === 'pi.user')) return null;
      const fresh = await freshLike(harness, conversation, context);
      await agents.setConversation(agentId, fresh, context);
      await conversation.abort(context).catch(() => undefined);
      const { entries, record } = await snapshot(conversation, cone.name, now(), context);
      await prepare(conversation, entries, agentId, context);
      const id = await agents.update((_tx, doc) => {
        const frozenId = `frozen-${doc.frozenNext ?? 1}`;
        doc.frozenNext = (doc.frozenNext ?? 1) + 1;
        doc.frozen ??= {};
        doc.frozen[frozenId] = { ...record, cone: agentId, scoops: [] };
        return frozenId;
      }, context);
      retitle(id, record.model, entries, context);
      return id;
    },
    async thaw(id, context) {
      const state = agents.state();
      if (state.cones[id]) {
        await agents.selectCone(id, context);
        return id;
      }
      const scoop = state.scoops[id];
      if (scoop) return thawScoop({ ...options, now }, id, scoop, context);
      return thawFrozen(agents, id, context);
    },
    async discard(id, context) {
      const state = agents.state();
      const scoop = state.scoops[id];
      if (scoop) return removeScoop(options, id, scoop, context);
      const cone = state.cones[id];
      if (cone) throw new Error(`${cone.name} is live; delete the cone first.`);
      return discardFrozen(options, id, context);
    },
    refresh,
    touch,
    frozenTarget: (target) => frozenTarget(agents.state(), target),
    command: (argv, _caller, context) => command(options, runtime, argv, context),
    close: () => off(),
  };
  return runtime;
}
