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
  type ConeRecord,
  type FrozenRecord,
  live,
  type ScoopRecord,
} from '../agents.ts';
import { HOME } from '../kernel/env.ts';
import { resolve } from '../kernel/paths.ts';
import { type Layout, LEGACY, ROOT_HOME, ROOT_USER } from '../layout.ts';
import type { LickTarget } from '../licks/lick.ts';
import { copyAgent, SELECTION, storedAgent } from '../selection.ts';
import { cleanTitle, TITLE_TURNS, titleDue } from '../titles/extension.ts';
import { scrubTranscript } from '../titles/generate.ts';
import {
  createImporter,
  IDLE,
  type ImportDeps,
  type ImportProgress,
  type ImportResult,
  type ImportSource,
  V6_KIND,
} from './v6.ts';

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
  v6?: true;
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
  cancelTitle?: (agentId: string) => void;
  now?: () => number;
  layout?: Layout;
  imports?: Omit<ImportDeps, 'agents' | 'layout' | 'now'>;
}

export type Asker = { user: string | null; cwd: string };

export interface FreezerRuntime {
  readonly frozen: ReplicatedState<FrozenCone[]>;
  readonly importing: ReplicatedState<ImportProgress>;
  importProfile(
    source: ImportSource,
    options: { again?: boolean; preview?: boolean },
    context: Context
  ): Promise<ImportResult>;
  cancelImport(): void;
  freeze(agentId: string, context: Context): Promise<string>;
  newChat(agentId: string, context: Context): Promise<string | null>;
  thaw(id: string, context: Context): Promise<string>;
  discard(id: string, context: Context): Promise<void>;
  refresh(): Promise<readonly FrozenCone[]>;
  touch(): void;
  frozenTarget(target: LickTarget): Frozen | undefined;
  command(
    argv: readonly string[],
    caller: string | null,
    context: Context,
    asker?: Asker
  ): Promise<Answer>;
  close(): void;
}

export const USAGE = `usage:
  freezer list         every conversation: id, kind, name, title, messages, when
  freezer show <id>    a conversation as Markdown
  freezer thaw <id>    continue a stopped conversation as a cone
  freezer import [--again] [--preview] <zip>
                       import a SLICC 6 profile export as frozen cones (root only)

Delete a cone, or start a new conversation, from the chat toolbar or the command palette.
`;

const TITLE_LENGTH = 60;
export const TOUCH_MS = 500;

function textOf(entry: EntryRecord): string {
  return answerText(entry.model?.[0]?.content).trim();
}

function said(entry: EntryRecord, role: 'user' | 'assistant'): boolean {
  if (entry.kind === V6_KIND) return entry.model?.[0]?.role === role;
  return entry.kind === `pi.${role}`;
}

export function modelName(model: { provider: string; modelId: string } | undefined): string {
  return model ? `${model.provider}/${model.modelId}` : '';
}

export function firstLine(entries: readonly EntryRecord[]): string {
  const first = entries.find((entry) => said(entry, 'user') && textOf(entry));
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
    if (said(entry, 'user') && textOf(entry)) out.push('', '## User', '', textOf(entry));
    if (!said(entry, 'assistant')) continue;
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
  return entries.filter((entry) => said(entry, 'user') || said(entry, 'assistant')).length;
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

type Inspected = { stats: Stats; entries: readonly EntryRecord[] };

async function inspect(harness: Harness, id: number, context: Context): Promise<Inspected> {
  const conversation = await harness.conversation(id as ConversationId, context);
  if (!conversation)
    return { stats: { title: firstLine([]), model: '', messages: 0, frozenAt: 0 }, entries: [] };
  const view = await conversation.context(context);
  const agent = await conversation.agent(context);
  return {
    stats: {
      title: firstLine(view.entries),
      model: modelName(agent.model),
      messages: counted(view.entries),
      frozenAt: lastAt(view.entries),
    },
    entries: view.entries,
  };
}

type Titled = Pick<ConeRecord, 'conversation' | 'title' | 'titled'>;

type Seen = (id: string, record: Titled, entries: readonly EntryRecord[], model: string) => void;

const kindOf = (scoop: ScoopRecord): ConversationKind =>
  scoop.kind === 'sync' ? 'agent' : 'scoop';

async function rows(
  harness: Harness,
  state: Readonly<AgentsState>,
  cache: Map<number, Stats>,
  context: Context,
  seen?: Seen
): Promise<FrozenCone[]> {
  const stopped = async (conversation: number) => {
    const cached = cache.get(conversation);
    if (cached) return cached;
    const found = (await inspect(harness, conversation, context)).stats;
    cache.set(conversation, found);
    return found;
  };
  const ended = async (id: string, record: Titled) => {
    const stats = await stopped(record.conversation);
    if (seen && (record.titled ?? 0) < (TITLE_TURNS.at(-1) as number)) {
      const { entries } = await inspect(harness, record.conversation, context);
      seen(id, record, entries, stats.model);
    }
    return { ...stats, ...(record.title ? { title: record.title } : {}) };
  };
  const running = async (record: Titled) => {
    const { stats } = await inspect(harness, record.conversation, context);
    return { ...stats, ...(record.title ? { title: record.title } : {}) };
  };
  const out: FrozenCone[] = [];
  for (const [id, cone] of Object.entries(state.cones))
    out.push({
      id,
      name: cone.name,
      ...(await running(cone)),
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
      ...(record.v6 ? { v6: true as const } : {}),
    });
  for (const [id, scoop] of Object.entries(state.scoops)) {
    if (scoop.removed) continue;
    const on = live(scoop);
    out.push({
      id,
      name: scoop.name,
      ...(on ? await running(scoop) : await ended(id, scoop)),
      kind: kindOf(scoop),
      live: on,
      thawedAs: scoop.thawedAs ?? null,
    });
  }
  return out.sort((a, b) => Number(b.live) - Number(a.live) || b.frozenAt - a.frozenAt);
}

export function thawedNote(
  kind: ConversationKind,
  name: string,
  folder: string,
  kept: boolean,
  home = HOME
): string {
  const what = kind === 'agent' ? 'agent run' : kind;
  const place = kept
    ? `Its workspace ${folder} is still there.`
    : `Its workspace ${folder} was deleted when it stopped.`;
  return `This was ${what} ${name}'s conversation, thawed as a cone. ${place} You now work in ${home} as a cone, with a cone's tools.`;
}

type Snapshot = { entries: readonly EntryRecord[]; record: Omit<FrozenRecord, 'scoops' | 'cone'> };

async function snapshot(
  conversation: Conversation,
  name: string,
  now: number,
  context: Context,
  title?: string
): Promise<Snapshot> {
  const view = await conversation.context(context);
  const agent = await conversation.agent(context);
  return {
    entries: view.entries,
    record: {
      name,
      conversation: conversation.id,
      title: title ?? firstLine(view.entries),
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

async function importCommand(
  runtime: FreezerRuntime,
  args: readonly string[],
  asker: Asker | undefined,
  context: Context
): Promise<Answer> {
  if (asker?.user && asker.user !== ROOT_USER)
    return { code: 1, out: 'freezer: only root can import; run sudo freezer import\n' };
  const flags = args.filter((arg) => arg.startsWith('--'));
  const paths = args.filter((arg) => !arg.startsWith('--'));
  if (paths.length !== 1 || flags.some((flag) => flag !== '--again' && flag !== '--preview'))
    return { code: 2, out: USAGE };
  const result = await runtime.importProfile(
    { path: resolve(asker?.cwd ?? ROOT_HOME, paths[0] as string) },
    { again: flags.includes('--again'), preview: flags.includes('--preview') },
    context
  );
  return result.error
    ? { code: 1, out: `freezer: ${result.error}\n` }
    : { code: 0, out: result.text };
}

async function command(
  options: FreezerAttach,
  runtime: FreezerRuntime,
  argv: readonly string[],
  context: Context,
  asker?: Asker
): Promise<Answer> {
  const verb = argv[0] ?? 'help';
  if (verb === 'import') return importCommand(runtime, argv.slice(1), asker, context);
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
  const init = copyAgent(await storedAgent(harness, conversation.id, context));
  return harness.createConversation({ ownership: { kind: 'ownerless' }, init }, context);
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
  const layout = options.layout ?? LEGACY;
  if (scoop.removed) throw new Error(`There is no conversation ${id}.`);
  if (live(scoop)) throw new Error(`${scoop.name} is still running; open it instead.`);
  const conversation = await harness.conversation(scoop.conversation as ConversationId, context);
  if (!conversation) throw new Error(`There is no conversation ${id}.`);
  const last = (await conversation.context(context)).entries.at(-1);
  const agent = await conversation.agent(context);
  const cone = await storedAgent(harness, (await activeCone(agents, context)).id, context);
  const created = {
    ownership: { kind: 'ownerless' as const },
    agent: {
      model: agent.model as NonNullable<typeof agent.model>,
      thinkingLevel: agent.thinkingLevel,
      ...(layout.users ? {} : { cwd: HOME }),
    },
    init: copyAgent(cone, SELECTION),
  };
  const fork = last
    ? await conversation.fork(last.id, created, context)
    : await harness.createConversation(created, context);
  const folder = layout.workspace(scoop.folder);
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
            content: thawedNote(
              kindOf(scoop),
              scoop.name,
              folder,
              kept,
              layout.users ? 'your own home' : HOME
            ),
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
    doc.cones[target] = {
      name: scoop.name,
      conversation: fork.id,
      ...(scoop.title ? { title: scoop.title, titled: scoop.titled as number } : {}),
    };
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
  await env.remove(
    (options.layout ?? LEGACY).scoopRoot(scoop.folder),
    {
      recursive: true,
      force: true,
    },
    context
  );
}

function listing(harness: Harness, agents: Agents, seen: Seen | undefined) {
  const frozen = replicatedState<FrozenCone[]>([]);
  const cache = new Map<number, Stats>();
  let lock: Promise<readonly FrozenCone[]> = Promise.resolve([]);
  const refresh = () => {
    lock = lock
      .catch(() => [])
      .then(async () => {
        const listed = await rows(harness, agents.state(), cache, BACKGROUND_CONTEXT, seen);
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

export function v6Note(home: string, record: Pick<FrozenRecord, 'name'>): string {
  return `This was ${record.name}, a conversation imported from SLICC 6, thawed as a cone. SLICC 6's /workspace is now ~/workspace (${home}/workspace), and its scoops' files are in ${home}/scoops. Paths in the conversation above are SLICC 6's.`;
}

async function forkV6(
  options: FreezerAttach & { now: () => number },
  record: FrozenRecord,
  context: Context
): Promise<Conversation> {
  const { harness, agents } = options;
  const layout = options.layout ?? LEGACY;
  const conversation = await harness.conversation(record.conversation as ConversationId, context);
  if (!conversation) throw new Error(`There is no conversation for ${record.name}.`);
  const last = (await conversation.context(context)).entries.at(-1);
  const cone = await activeCone(agents, context);
  const agent = await cone.agent(context);
  const created = {
    ownership: { kind: 'ownerless' as const },
    agent: {
      model: agent.model as NonNullable<typeof agent.model>,
      thinkingLevel: agent.thinkingLevel,
      ...(layout.users ? {} : { cwd: HOME }),
    },
    init: copyAgent(await storedAgent(harness, cone.id, context), SELECTION),
  };
  const fork = last
    ? await conversation.fork(last.id, created, context)
    : await harness.createConversation(created, context);
  const home = `/home/${record.cone}`;
  await fork.submit(
    {
      type: 'write',
      entry: {
        kind: THAWED_KIND,
        data: {
          v6: true,
          name: record.name,
          kind: 'cone',
          workspace: `${home}/workspace`,
          kept: true,
        },
        model: [{ role: 'user', content: v6Note(home, record), timestamp: options.now() }],
      },
    },
    context
  );
  return fork;
}

async function thawFrozen(
  options: FreezerAttach & { now: () => number },
  id: string,
  context: Context
): Promise<string> {
  const { agents } = options;
  const found = agents.state().frozen?.[id];
  const fork = found?.v6 ? await forkV6(options, found, context) : undefined;
  const coneId = await agents.update((_tx, doc) => {
    const record = doc.frozen?.[id];
    if (!record) throw new Error(`There is no frozen chat ${id}.`);
    const reuse = !doc.cones[record.cone];
    const target = reuse ? record.cone : `cone-${doc.next}`;
    if (!reuse) doc.next += 1;
    doc.cones[target] = {
      name: record.name,
      conversation: fork?.id ?? record.conversation,
      title: record.title,
      titled: TITLE_TURNS.at(-1) as number,
    };
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
    await env.remove(
      (options.layout ?? LEGACY).scoopRoot(folder),
      {
        recursive: true,
        force: true,
      },
      context
    );
}

function titling(options: FreezerAttach) {
  const { agents } = options;
  const pending = new Set<string>();
  const last = TITLE_TURNS.at(-1) as number;
  const named = (entries: readonly EntryRecord[], model: string, context: Context) =>
    scrubTranscript(entries)
      .then((transcript) =>
        (options.title as NonNullable<FreezerAttach['title']>)(transcript, model, context)
      )
      .then(cleanTitle)
      .catch(() => undefined);
  const write = (id: string, titled: Titled, title: string | undefined) =>
    agents
      .update((_tx, doc) => {
        const record = doc.scoops[id];
        if (record?.conversation !== titled.conversation || (record.titled ?? 0) >= last) return;
        record.titled = last;
        if (title) record.title = title;
      }, BACKGROUND_CONTEXT)
      .catch(() => undefined);
  const seen: Seen = (id, seenAs, entries, model) => {
    const titled = agents.state().scoops[id];
    if (titled?.conversation !== seenAs.conversation || pending.has(id)) return;
    if (titleDue(titled, entries, true) === undefined) {
      void write(id, titled, undefined);
      return;
    }
    pending.add(id);
    void named(entries, model, BACKGROUND_CONTEXT)
      .then((title) => write(id, titled, title))
      .finally(() => pending.delete(id));
  };
  return { named, seen };
}

function importing(
  options: FreezerAttach,
  now: () => number
): Pick<FreezerRuntime, 'importing' | 'importProfile' | 'cancelImport'> {
  const importer = options.imports
    ? createImporter({
        ...options.imports,
        agents: options.agents,
        layout: options.layout ?? LEGACY,
        now,
      })
    : undefined;
  return {
    importing: importer?.progress ?? replicatedState<ImportProgress>(IDLE),
    importProfile: async (source, choices, context) =>
      importer
        ? importer.run(source, choices, context)
        : {
            done: false,
            preview: null,
            cones: [],
            report: null,
            text: '',
            error: 'this agent imports nothing',
          },
    cancelImport: () => importer?.cancel(),
  };
}

export function attachFreezer(options: FreezerAttach): FreezerRuntime {
  const { harness, agents } = options;
  const now = options.now ?? Date.now;
  const { named, seen } = titling(options);
  const { frozen, refresh, touch, off } = listing(
    harness,
    agents,
    options.title ? seen : undefined
  );

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
    void named(entries, model, context)
      .then(async (title) => {
        if (!title) return;
        await agents.update((_tx, doc) => {
          const record = doc.frozen?.[id];
          if (record) record.title = title;
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
    ...importing(options, now),
    async freeze(agentId, context) {
      const cone = agents.state().cones[agentId];
      if (!cone) throw new Error(`There is no cone ${agentId}.`);
      const conversation = await conversationOf(agentId, context);
      const { entries, record } = await snapshot(
        conversation,
        cone.name,
        now(),
        context,
        cone.title
      );
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
        options.cancelTitle?.(agentId);
        await (await agents.conversation(agentId, context))?.reset(undefined, context);
        await agents.update((_tx, doc) => {
          const record = doc.scoops[agentId] as ScoopRecord;
          delete record.title;
          delete record.titled;
        }, context);
        return null;
      }
      if (!cone) throw new Error(`There is no cone ${agentId}.`);
      const conversation = await conversationOf(agentId, context);
      const before = (await conversation.context(context)).entries;
      const title = cone.title;
      if (!before.some((entry) => entry.kind === 'pi.user')) return null;
      const fresh = await freshLike(harness, conversation, context);
      await agents.setConversation(agentId, fresh, context);
      await conversation.abort(context).catch(() => undefined);
      const { entries, record } = await snapshot(conversation, cone.name, now(), context, title);
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
      return thawFrozen({ ...options, now }, id, context);
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
    command: (argv, _caller, context, asker) => command(options, runtime, argv, context, asker),
    close: () => off(),
  };
  return runtime;
}
