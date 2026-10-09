import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Conversation, EntryRecord, Harness } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { answerText } from '../agent.ts';
import { type Agents, type AgentsState, type FrozenRecord, live } from '../agents.ts';
import type { LickTarget } from '../licks/lick.ts';
import { SCOOPS_ROOT } from '../scoops/service.ts';

export type Answer = { code: number; out: string };

export interface FrozenCone {
  id: string;
  name: string;
  title: string;
  model: string;
  messages: number;
  frozenAt: number;
}

export type Frozen = { id: string; name: string; at: number };

export interface FreezerAttach {
  harness: Harness;
  agents: Agents;
  env: Pick<ExecutionEnv, 'remove'>;
  title?: (transcript: string, model: string, context: Context) => Promise<string | undefined>;
  extract?: (conversation: number, tail: number, context: Context) => Promise<unknown>;
  now?: () => number;
}

export interface FreezerRuntime {
  readonly frozen: ReplicatedState<FrozenCone[]>;
  freeze(agentId: string, context: Context): Promise<string>;
  newChat(agentId: string, context: Context): Promise<string | null>;
  thaw(id: string, context: Context): Promise<string>;
  discard(id: string, context: Context): Promise<void>;
  frozenTarget(target: LickTarget): Frozen | undefined;
  command(argv: readonly string[], caller: string | null, context: Context): Promise<Answer>;
  close(): void;
}

export const USAGE = `usage:
  freezer list         every frozen chat: id, name, title, messages, when
  freezer show <id>    a frozen chat as Markdown
  freezer thaw <id>    bring a frozen chat back as a cone

Freeze a cone, or start a new chat, from the chat toolbar or the command palette.
`;

const TITLE_LENGTH = 60;

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

export function markdown(record: FrozenRecord, entries: readonly EntryRecord[]): string {
  const out = [
    `# ${record.title}`,
    '',
    `${record.name} · ${record.model} · frozen ${new Date(record.frozenAt).toISOString()}`,
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

function list(state: Readonly<AgentsState>): FrozenCone[] {
  return Object.entries(state.frozen ?? {})
    .map(([id, record]) => ({
      id,
      name: record.name,
      title: record.title,
      model: record.model,
      messages: record.messages,
      frozenAt: record.frozenAt,
    }))
    .sort((a, b) => b.frozenAt - a.frozenAt);
}

function freeName(state: Readonly<AgentsState>, wanted: string): string {
  const taken = new Set(Object.values(state.cones).map((cone) => cone.name));
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted} ${n}`)) return `${wanted} ${n}`;
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
      messages: view.entries.filter(
        (entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant'
      ).length,
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
  if (verb === 'list') {
    const rows = list(options.agents.state()).map(
      (item) =>
        `${item.id}\t${item.name}\t${item.title}\t${item.messages} messages\t${new Date(item.frozenAt).toISOString()}`
    );
    return { code: 0, out: rows.length ? `${rows.join('\n')}\n` : 'nothing is frozen\n' };
  }
  if (verb !== 'show' && verb !== 'thaw')
    return { code: verb === 'help' || verb === '--help' ? 0 : 2, out: USAGE };
  const id = argv[1] ?? '';
  const record = options.agents.state().frozen?.[id];
  if (!record) return { code: 1, out: `freezer: there is no frozen chat ${id}\n` };
  if (verb === 'thaw')
    return { code: 0, out: `thawed ${id} as ${await runtime.thaw(id, context)}\n` };
  const conversation = await options.harness.conversation(record.conversation as never, context);
  const entries = conversation ? (await conversation.context(context)).entries : [];
  return { code: 0, out: markdown(record, entries) };
}

export function attachFreezer(options: FreezerAttach): FreezerRuntime {
  const { harness, agents, env } = options;
  const now = options.now ?? Date.now;
  const frozen = replicatedState<FrozenCone[]>(list(agents.state()));
  const off = agents.onChange((state) => frozen.replace(BACKGROUND_CONTEXT, list(state)));
  const conversationOf = async (agentId: string, context: Context) => {
    const conversation = await agents.conversation(agentId, context);
    if (!conversation) throw new Error(`There is no cone ${agentId}.`);
    return conversation;
  };
  const prepare = async (
    conversation: Conversation,
    entries: readonly EntryRecord[],
    context: Context
  ) => {
    const tail = entries.at(-1)?.id ?? 0;
    await options.extract?.(conversation.id, tail, context).catch(() => undefined);
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
      await prepare(conversation, entries, context);
      const scoops = Object.entries(agents.state().scoops)
        .filter(([, scoop]) => scoop.cone === agentId && live(scoop))
        .map(([id]) => id);
      await conversation.abort(context, { background: true }).catch(() => undefined);
      for (const id of scoops)
        await (await agents.conversation(id, context))?.abort(context).catch(() => undefined);
      const next =
        agents.state().active === agentId ? await replacement(agentId, context) : undefined;
      const id = await agents.update((_tx, doc) => {
        const frozenId = `frozen-${doc.frozenNext ?? 1}`;
        doc.frozenNext = (doc.frozenNext ?? 1) + 1;
        doc.frozen ??= {};
        doc.frozen[frozenId] = { ...record, cone: agentId, scoops };
        delete doc.cones[agentId];
        for (const scoop of scoops) (doc.scoops[scoop] as { frozen?: string }).frozen = frozenId;
        if (next?.conversation) {
          doc.cones[next.id] = { name: record.name, conversation: next.conversation.id };
          doc.next += 1;
        }
        return frozenId;
      }, context);
      if (next) await agents.selectCone(next.id, context);
      retitle(id, record.model, entries, context);
      return id;
    },
    async newChat(agentId, context) {
      const cone = agents.state().cones[agentId];
      if (!cone) throw new Error(`There is no cone ${agentId}.`);
      const conversation = await conversationOf(agentId, context);
      const { entries, record } = await snapshot(conversation, cone.name, now(), context);
      if (!entries.some((entry) => entry.kind === 'pi.user')) return null;
      await prepare(conversation, entries, context);
      await conversation.abort(context).catch(() => undefined);
      const agent = await conversation.agent(context);
      const fresh = await harness.createConversation(
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
      const id = await agents.update((_tx, doc) => {
        const frozenId = `frozen-${doc.frozenNext ?? 1}`;
        doc.frozenNext = (doc.frozenNext ?? 1) + 1;
        doc.frozen ??= {};
        doc.frozen[frozenId] = { ...record, cone: agentId, scoops: [] };
        return frozenId;
      }, context);
      await agents.setConversation(agentId, fresh, context);
      retitle(id, record.model, entries, context);
      return id;
    },
    async thaw(id, context) {
      const record = agents.state().frozen?.[id];
      if (!record) throw new Error(`There is no frozen chat ${id}.`);
      const coneId = await agents.update((_tx, doc) => {
        const reuse = !doc.cones[record.cone];
        const target = reuse ? record.cone : `cone-${doc.next}`;
        if (!reuse) doc.next += 1;
        doc.cones[target] = { name: freeName(doc, record.name), conversation: record.conversation };
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
    },
    async discard(id, context) {
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
    },
    frozenTarget: (target) => frozenTarget(agents.state(), target),
    command: (argv, _caller, context) => command(options, runtime, argv, context),
    close: () => off(),
  };
  return runtime;
}
