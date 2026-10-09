import type { Context } from '@earendil-works/chord';
import {
  type Conversation,
  type ConversationId,
  defineDoc,
  type Harness,
  type Tx,
} from '@earendil-works/pi-durable';
import { ConeDoc } from './cone.ts';
import type { RoleMemory } from './memory/store.ts';

export const FIRST_CONE = 'cone';

export type ConeRecord = { name: string; conversation: number };

export type Mark = { in: number; at: number };

export type ScoopRecord = {
  name: string;
  folder: string;
  cone: string;
  conversation: number;
  anchor: number;
  role: string | null;
  memory?: RoleMemory;
  context?: { project: boolean; global: boolean };
  kind: 'async' | 'sync';
  parent: string;
  depth: number;
  roots: { write: string[]; read: string[] } | null;
  created: Mark | null;
  dropped: Mark | null;
  gone: boolean;
};

export function live(record: ScoopRecord): boolean {
  return record.dropped === null && !record.gone;
}

export type AgentsState = {
  cones: Record<string, ConeRecord>;
  active: string;
  next: number;
  scoops: Record<string, ScoopRecord>;
};

export const AgentsDoc = defineDoc<AgentsState>({
  kind: 'slicc.agents',
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
  update<T>(change: (tx: Tx, state: AgentsState) => T | Promise<T>, context: Context): Promise<T>;
  onChange(listener: (state: Readonly<AgentsState>) => void): () => void;
  onCone(listener: (conversation: Conversation) => void | Promise<void>): () => void;
}

async function initial(harness: Harness, root: Conversation, context: Context) {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(AgentsDoc);
    if (!doc.cones[FIRST_CONE]) {
      const legacy = (await tx.doc(ConeDoc)).conversation;
      doc.cones[FIRST_CONE] = { name: 'sliccy', conversation: legacy ?? root.id };
    }
    if (!doc.cones[doc.active]) doc.active = FIRST_CONE;
    return JSON.parse(JSON.stringify(doc)) as AgentsState;
  }, context);
}

export async function openAgents(
  harness: Harness,
  root: Conversation,
  context: Context
): Promise<Agents> {
  let state = await initial(harness, root, context);
  const handles = new Map<number, Conversation>([[root.id, root]]);
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
        doc.next += 1;
        doc.cones[id] = { name: wanted, conversation: conversation.id };
        return id;
      }, using);
    },
    async switchCone(conversation, using) {
      handles.set(conversation.id, conversation);
      await update(async (tx, doc) => {
        (doc.cones[doc.active] as ConeRecord).conversation = conversation.id;
        (await tx.doc(ConeDoc)).conversation = conversation.id;
      }, using);
      await notifyCone(conversation);
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
