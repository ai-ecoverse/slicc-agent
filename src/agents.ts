import type { Context } from '@earendil-works/chord/context';
import {
  type Conversation,
  type ConversationId,
  defineDoc,
  type Harness,
  type Tx,
} from '@earendil-works/pi-durable';
import { boundedDeltas } from './checkpoints.ts';
import { ConeDoc } from './cone.ts';
import type { RoleMemory } from './memory/store.ts';

export const FIRST_CONE = 'cone';

export type ConeRecord = { name: string; conversation: number; title?: string; titled?: number };

export type Mark = { in: number; at: number };

export type ScoopRecord = {
  name: string;
  folder: string;
  cone: string;
  conversation: number;
  anchor: number;
  role: string | null;
  memory?: RoleMemory;
  origin?: string;
  context?: { project: boolean; global: boolean };
  kind: 'async' | 'sync';
  parent: string;
  depth: number;
  roots: { write: string[]; read: string[] } | null;
  created: Mark | null;
  dropped: Mark | null;
  gone: boolean;
  frozen?: string;
  removed?: boolean;
  thawedAs?: string;
  title?: string;
  titled?: number;
};

export type FrozenRecord = {
  cone: string;
  name: string;
  conversation: number;
  title: string;
  model: string;
  messages: number;
  frozenAt: number;
  scoops: string[];
  v6?: { origin: string; key: string; suffix?: string };
};

export type V6Import = {
  at: number;
  origin: string;
  cones: Record<string, string>;
  tails: Record<string, string>;
};

export function live(record: ScoopRecord): boolean {
  return record.dropped === null && !record.gone && !record.frozen;
}

export type AgentsState = {
  cones: Record<string, ConeRecord>;
  active: string;
  next: number;
  scoops: Record<string, ScoopRecord>;
  frozen?: Record<string, FrozenRecord>;
  frozenNext?: number;
  imports?: Record<string, V6Import>;
};

export const AgentsDoc = defineDoc<AgentsState>({
  kind: 'slicc.agents',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ cones: {}, active: FIRST_CONE, next: 2, scoops: {} }),
});

export const SCOOP_PREFIX = 'scoop:';

export function scoopId(folder: string): string {
  return `${SCOOP_PREFIX}${folder}`;
}

export function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48);
  return cleaned || 'scoop';
}

export function freeFolder(state: Pick<AgentsState, 'scoops'>, name: string): string {
  const base = slug(name);
  if (!state.scoops[scoopId(base)]) return base;
  for (let n = 2; ; n++) if (!state.scoops[scoopId(`${base}-${n}`)]) return `${base}-${n}`;
}

export interface Agents {
  state(): Readonly<AgentsState>;
  cone(): Conversation;
  activeCone(): string;
  conversation(agentId: string, context: Context): Promise<Conversation | undefined>;
  selectCone(id: string, context: Context): Promise<void>;
  createCone(name: string, context: Context): Promise<string>;
  switchCone(conversation: Conversation, context: Context): Promise<void>;
  setConversation(coneId: string, conversation: Conversation, context: Context): Promise<void>;
  update<T>(change: (tx: Tx, state: AgentsState) => T | Promise<T>, context: Context): Promise<T>;
  onChange(listener: (state: Readonly<AgentsState>) => void): () => void;
  onCone(listener: (conversation: Conversation) => void | Promise<void>): () => void;
}

export type Repaired = { message: string; conversation: number };

function rank(id: string): number {
  if (id === FIRST_CONE) return 0;
  const numbered = /^cone-(\d+)$/.exec(id);
  return numbered ? Number(numbered[1]) : Number.MAX_SAFE_INTEGER;
}

export function ranked(state: Pick<AgentsState, 'cones'>): string[] {
  return Object.keys(state.cones).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function holder(
  state: Pick<AgentsState, 'cones'>,
  conversation: number,
  except?: string
): string | undefined {
  return ranked(state).find(
    (id) => id !== except && state.cones[id]?.conversation === conversation
  );
}

export function claim(
  state: Pick<AgentsState, 'cones'>,
  coneId: string,
  name: string,
  conversation: number
): void {
  const other = holder(state, conversation, coneId);
  if (other === undefined) return;
  const held = (state.cones[other] as ConeRecord).name;
  throw new Error(
    `${held} (${other}) already has this conversation live, so ${name} can’t have it too; open ${other} instead.`
  );
}

function freezeWith(doc: AgentsState, coneId: string, frozenId: string): string[] {
  const owned = Object.entries(doc.scoops)
    .filter(([, scoop]) => scoop.cone === coneId && live(scoop))
    .map(([id]) => id);
  for (const id of owned) (doc.scoops[id] as ScoopRecord).frozen = frozenId;
  delete doc.cones[coneId];
  return owned;
}

function refreeze(doc: AgentsState): Repaired[] {
  const notes: Repaired[] = [];
  for (const id of ranked(doc)) {
    const cone = doc.cones[id] as ConeRecord;
    const found = Object.entries(doc.frozen ?? {}).find(
      ([, record]) => record.cone === id && record.conversation === cone.conversation
    );
    if (!found) continue;
    const [frozenId, record] = found;
    record.scoops.push(...freezeWith(doc, id, frozenId));
    notes.push({
      conversation: cone.conversation,
      message: `${cone.name} (${id}) was live again on the conversation it was frozen with as ${frozenId}, so it is frozen again; thaw ${frozenId} to continue it.`,
    });
  }
  return notes;
}

function unshare(doc: AgentsState, now: number): Repaired[] {
  const notes: Repaired[] = [];
  const first = new Map<number, string>();
  for (const id of ranked(doc)) {
    const cone = doc.cones[id] as ConeRecord;
    const keeper = first.get(cone.conversation);
    if (keeper === undefined) {
      first.set(cone.conversation, id);
      continue;
    }
    const frozenId = `frozen-${doc.frozenNext ?? 1}`;
    doc.frozenNext = (doc.frozenNext ?? 1) + 1;
    doc.frozen ??= {};
    doc.frozen[frozenId] = {
      cone: id,
      name: cone.name,
      conversation: cone.conversation,
      title: cone.title ?? '',
      model: '',
      messages: 0,
      frozenAt: now,
      scoops: freezeWith(doc, id, frozenId),
    };
    const kept = (doc.cones[keeper] as ConeRecord).name;
    notes.push({
      conversation: cone.conversation,
      message: `${cone.name} (${id}) shared its conversation with ${kept} (${keeper}), so it moved to the Freezer as ${frozenId}; the conversation stays live in ${keeper}.`,
    });
  }
  return notes;
}

function settle(
  doc: AgentsState,
  legacy: number,
  fresh: number | undefined,
  now: number
): Repaired[] | null {
  const notes = [...refreeze(doc), ...unshare(doc, now)];
  if (!ranked(doc).length) {
    if (doc.frozenNext === undefined)
      doc.cones[FIRST_CONE] = { name: 'sliccy', conversation: legacy };
    else if (fresh === undefined) return null;
    else {
      doc.cones[`cone-${doc.next}`] = { name: 'sliccy', conversation: fresh };
      doc.next += 1;
    }
  }
  if (!doc.cones[doc.active]) doc.active = ranked(doc)[0] as string;
  return notes;
}

const copied = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Settled = { state: AgentsState; notes: Repaired[] };

async function initial(harness: Harness, root: Conversation, context: Context) {
  const now = Date.now();
  const once = (fresh?: Conversation) =>
    harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const legacy = (await tx.doc(ConeDoc)).conversation ?? root.id;
      if (!fresh && settle(copied(doc as AgentsState), legacy, undefined, now) === null)
        return undefined;
      const notes = settle(doc as AgentsState, legacy, fresh?.id, now) as Repaired[];
      return { state: copied(doc as AgentsState), notes };
    }, context);
  const settled = await once();
  if (settled) return { ...settled, fresh: undefined };
  const fresh = await harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: { model: (await root.agent(context)).model } },
    context
  );
  return { ...((await once(fresh)) as Settled), fresh };
}

export async function openAgents(
  harness: Harness,
  root: Conversation,
  context: Context,
  report: (note: Repaired) => void = () => undefined
): Promise<Agents> {
  const settled = await initial(harness, root, context);
  let state = settled.state;
  for (const note of settled.notes) report(note);
  const handles = new Map<number, Conversation>([[root.id, root]]);
  if (settled.fresh) handles.set(settled.fresh.id, settled.fresh);
  const handle = async (id: number, using: Context) => {
    const known = handles.get(id);
    if (known) return known;
    const found = await harness.conversation(id as ConversationId, using);
    if (found) handles.set(id, found);
    return found;
  };
  let cone =
    (await handle((state.cones[state.active] as ConeRecord).conversation, context)) ?? root;
  const changes = new Set<(state: Readonly<AgentsState>) => void>();
  const cones = new Set<(conversation: Conversation) => void | Promise<void>>();
  const notifyCone = async (next: Conversation) => {
    cone = next;
    await Promise.all([...cones].map((listener) => listener(next)));
  };
  const update: Agents['update'] = async (change, using) => {
    const [result, next] = await harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      const value = await change(tx, doc as AgentsState);
      return [value, JSON.parse(JSON.stringify(doc)) as AgentsState] as const;
    }, using);
    state = next;
    for (const listener of changes) listener(state);
    return result;
  };
  const agents: Agents = {
    state: () => state,
    cone: () => cone,
    activeCone: () => state.active,
    async conversation(agentId, using) {
      const id = state.cones[agentId]?.conversation ?? state.scoops[agentId]?.conversation;
      return id === undefined ? undefined : handle(id, using);
    },
    async selectCone(id, using) {
      const record = state.cones[id];
      if (!record) throw new Error(`no cone ${id}`);
      if (state.active === id) return;
      await update((_tx, doc) => {
        doc.active = id;
      }, using);
      await notifyCone((await handle(record.conversation, using)) as Conversation);
    },
    async createCone(name, using) {
      const wanted = name.trim();
      if (!wanted) throw new Error('A cone needs a name.');
      if (/[\p{Cc}\u2028\u2029]/u.test(wanted))
        throw new Error('A cone name can’t contain line breaks, tabs or other control characters.');
      if (Object.values(state.cones).some((record) => record.name === wanted))
        throw new Error(`A cone named ${wanted} already exists.`);
      const conversation = await harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { model: (await cone.agent(using)).model ?? null },
        },
        using
      );
      handles.set(conversation.id, conversation);
      return update((_tx, doc) => {
        const id = `cone-${doc.next}`;
        claim(doc, id, wanted, conversation.id);
        doc.next += 1;
        doc.cones[id] = { name: wanted, conversation: conversation.id };
        return id;
      }, using);
    },
    switchCone(conversation, using) {
      return agents.setConversation(state.active, conversation, using);
    },
    async setConversation(coneId, conversation, using) {
      handles.set(conversation.id, conversation);
      await update(async (tx, doc) => {
        const cone = doc.cones[coneId] as ConeRecord;
        claim(doc, coneId, cone.name, conversation.id);
        cone.conversation = conversation.id;
        delete cone.title;
        delete cone.titled;
        if (coneId === doc.active) (await tx.doc(ConeDoc)).conversation = conversation.id;
      }, using);
      if (coneId === state.active) await notifyCone(conversation);
    },
    update,
    onChange(listener) {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    onCone(listener) {
      cones.add(listener);
      return () => cones.delete(listener);
    },
  };
  return agents;
}
