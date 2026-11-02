import type { Context, ReplicatedState } from '@earendil-works/chord';
import { replicatedState } from '@earendil-works/chord';
import type { ConversationView, Harness } from '@earendil-works/pi-durable';
import { type AgentsState, live } from './agents.ts';
import { LicksOutbox } from './licks/licks.ts';
import { lastAssistant } from './monitor/index.ts';
import { landsOn, type Outbox, type Work } from './remote/busy.ts';
import { ScoopWorkDoc } from './scoops/service.ts';
import type { InventoryAgent, InventoryRow, InventoryState, InventoryStatus } from './services.ts';

export interface InventoryModels {
  getModel(provider: string, modelId: string): unknown;
  getModels(provider: string): readonly unknown[];
}

export interface InventoryOptions {
  agents: { state(): Readonly<AgentsState>; onChange(listener: () => void): () => void };
  views: ReplicatedState<Record<string, ConversationView>>;
  harness: Pick<Harness, 'observeCommits' | 'snapshot'>;
  models?: InventoryModels;
  now?: () => number;
  context: Context;
}

export interface Inventory {
  readonly state: ReplicatedState<InventoryState>;
  dispose(): void;
}

interface Signals {
  work: Readonly<Work> | undefined;
  outbox: Readonly<Outbox> | undefined;
}

type Docs = {
  'pi.live'?: { run?: unknown };
  'pi.inbox'?: { items?: { mode?: string }[] };
  'pi.agent'?: { model?: { provider: string; modelId: string } };
};

const WORK = ScoopWorkDoc.definition.kind;
const OUTBOX = LicksOutbox.definition.kind;

export function modelOf(
  view: ConversationView | undefined,
  models: InventoryModels | undefined
): Pick<InventoryAgent, 'provider' | 'model'> {
  const ref = (view?.docs as Docs | undefined)?.['pi.agent']?.model;
  if (!ref || !models?.getModels(ref.provider).length) return {};
  const known =
    !ref.modelId.startsWith('arn:') && models.getModel(ref.provider, ref.modelId) !== undefined;
  return known ? { provider: ref.provider, model: ref.modelId } : { provider: ref.provider };
}

function pending(signals: Signals, state: Readonly<AgentsState>): Set<number> {
  const out = new Set<number>();
  for (const [key, queue] of Object.entries(signals.outbox?.queues ?? {})) {
    if (!queue.pending) continue;
    const lands = landsOn(state, key, queue.pending.lick.channel);
    if (lands !== undefined) out.add(lands);
  }
  return out;
}

function statusOf(
  view: ConversationView | undefined,
  waiting: boolean
): { status: InventoryStatus; queued: number } {
  const docs = view?.docs as Docs | undefined;
  const queued = (docs?.['pi.inbox']?.items ?? []).filter((item) => item.mode !== 'write').length;
  if (docs?.['pi.live']?.run) return { status: 'running', queued };
  if (queued) return { status: 'queued', queued };
  if (waiting) return { status: 'waiting', queued };
  const failed = lastAssistant(view)?.message.stopReason === 'error';
  return { status: failed ? 'error' : 'idle', queued };
}

export function inventoryRows(
  state: Readonly<AgentsState>,
  views: Readonly<Record<string, ConversationView>>,
  signals: Signals,
  models: InventoryModels | undefined
): Omit<InventoryRow, 'since'>[] {
  const lands = pending(signals, state);
  const waits = Object.values(signals.work?.waits ?? {});
  const feeds = Object.values(signals.work?.feeds ?? {});
  const cones = Object.entries(state.cones).map(([id, cone]) => ({
    id,
    cone: id,
    kind: 'cone' as const,
    ...statusOf(views[id], waits.some((wait) => wait.cone === id) || lands.has(cone.conversation)),
    ...modelOf(views[id], models),
  }));
  const scoops = Object.entries(state.scoops)
    .filter(([, scoop]) => live(scoop))
    .map(([id, scoop]) => ({
      id,
      cone: scoop.cone,
      kind: 'scoop' as const,
      parent: scoop.parent ?? scoop.cone,
      ...statusOf(
        views[id],
        feeds.some((feed) => feed.scoop === id) || lands.has(scoop.conversation)
      ),
      ...modelOf(views[id], models),
    }));
  return [...cones, ...scoops];
}

export function createInventory(options: InventoryOptions): Inventory {
  const now = options.now ?? Date.now;
  const { context, harness } = options;
  const signals: Signals = { work: undefined, outbox: undefined };
  const since = new Map<string, { status: InventoryStatus; at: number }>();
  let last = '';
  let disposed = false;
  const state = replicatedState<InventoryState>({ seq: 0, changedAt: 0, active: '', agents: [] });
  const build = () => {
    if (disposed) return;
    const registry = options.agents.state();
    const rows = inventoryRows(registry, options.views.value ?? {}, signals, options.models);
    const key = JSON.stringify({ active: registry.active, rows });
    if (key === last) return;
    last = key;
    const at = now();
    const agents = rows.map((row) => {
      const known = since.get(row.id);
      const mark = known?.status === row.status ? known : { status: row.status, at };
      since.set(row.id, mark);
      return { ...row, since: mark.at };
    });
    for (const id of [...since.keys()]) if (!rows.some((row) => row.id === id)) since.delete(id);
    const seq = (state.value?.seq ?? 0) + 1;
    state.replace(context, { seq, changedAt: at, active: registry.active, agents });
  };
  const commits = harness.observeCommits({
    advance(publication) {
      let touched = false;
      for (const change of publication.changes) {
        if (change.type !== 'document' || change.record.key !== undefined) continue;
        if (change.conversationId !== undefined) continue;
        if (change.kind !== 'change' && change.kind !== 'retire') continue;
        const value = change.kind === 'change' ? change.value : undefined;
        if (change.record.kind === WORK) signals.work = value as Work | undefined;
        else if (change.record.kind === OUTBOX) signals.outbox = value as Outbox | undefined;
        else continue;
        touched = true;
      }
      if (touched) build();
    },
    end() {},
  });
  void Promise.all([
    harness.snapshot(ScoopWorkDoc, context),
    harness.snapshot(LicksOutbox, context),
  ])
    .then(([work, outbox]) => {
      signals.work ??= work as unknown as Work;
      signals.outbox ??= outbox as unknown as Outbox;
      build();
    })
    .catch(() => undefined);
  const offs = [
    () => commits.detach(),
    options.agents.onChange(build),
    options.views.subscribe(build),
  ];
  build();
  return {
    state,
    dispose() {
      disposed = true;
      for (const off of offs) off();
    },
  };
}
