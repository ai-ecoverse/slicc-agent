import type { ReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ApprovalDecision } from '../approvals/record.ts';
import type { SendAttachment } from '../attachments.ts';
import type { AgentConnection } from '../client.ts';
import { NO_APPROVALS, VIEW_ONLY } from '../readonly.ts';
import type { Delivered, InventorySnapshot, InventoryState, SendMode } from '../services.ts';
import { type LinkApproval, pendingApprovals } from './approvals.ts';
import type { RemoteEvent } from './events.ts';
import type { AgentRemote, RemoteOpened } from './host.ts';
import { narrowInventory } from './inventory.ts';

export type { LinkApproval } from './approvals.ts';
export type { RemoteEvent } from './events.ts';

export const POLL_MS = 25000;

export interface RemoteOptions {
  agent?: () => string | null;
  device?: string;
}

export interface RemoteControl {
  prompt(request: {
    text: string;
    whenBusy?: SendMode;
    thinking?: boolean;
    attachments?: SendAttachment[];
  }): Promise<{ delivered: Delivered; events: AsyncIterable<RemoteEvent> }>;
  watch(request?: { since?: string | null; thinking?: boolean; busy?: boolean }): Promise<{
    head: string;
    gap?: true;
    busy?: boolean;
    history: string | null;
    events: AsyncIterable<RemoteEvent>;
  }>;
  history(request: {
    before: string | null;
    limit?: number;
    thinking?: boolean;
  }): Promise<{ events: RemoteEvent[]; before: string | null; more: boolean }>;
  abort(): Promise<{ aborted: boolean }>;
  inventory(request?: {
    watch?: boolean;
  }): Promise<{ snapshot: InventorySnapshot; events?: AsyncIterable<InventorySnapshot> }>;
  approvals(request?: {
    watch?: boolean;
  }): Promise<{ approvals: LinkApproval[]; events?: AsyncIterable<LinkApproval[]> }>;
  decide(request: {
    id: string;
    answer: ApprovalDecision;
    reason?: string | null;
  }): Promise<{ ok: true }>;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function opened(result: RemoteOpened): Extract<RemoteOpened, { ok: true }> {
  if (!result.ok) throw failure(result.code, result.message);
  return result;
}

function events(remote: AgentRemote, stream: string): AsyncIterable<RemoteEvent> {
  return {
    [Symbol.asyncIterator]() {
      let buffer: RemoteEvent[] = [];
      let done = false;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await remote.close(stream, BACKGROUND_CONTEXT).catch(() => undefined);
      };
      return {
        async next(): Promise<IteratorResult<RemoteEvent>> {
          while (!buffer.length && !done && !closed) {
            const batch = await remote.next(stream, POLL_MS, BACKGROUND_CONTEXT);
            buffer = batch.events;
            done = batch.done;
          }
          const value = buffer.shift();
          if (value) return { value, done: false };
          await close();
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<RemoteEvent>> {
          await close();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function current(state: ReplicatedState<InventoryState>): Promise<InventoryState> {
  if (state.value?.seq) return Promise.resolve(state.value);
  return new Promise((resolve) => {
    let off: (() => void) | undefined;
    let done = false;
    off = state.subscribe((value) => {
      if (!value?.seq || done) return;
      done = true;
      off?.();
      resolve(value);
    });
    if (done) off();
  });
}

function following<T>(
  sources: readonly Pick<ReplicatedState<unknown>, 'subscribe'>[],
  compute: () => T | undefined,
  key: (value: T) => string,
  first: T
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let last = key(first);
      let latest: T | undefined;
      let wake: (() => void) | undefined;
      let closed = false;
      const look = () => {
        const next = compute();
        if (next === undefined) return;
        const seen = key(next);
        if (seen === last) return;
        last = seen;
        latest = next;
        wake?.();
      };
      const offs = sources.map((source) => source.subscribe(look));
      const close = () => {
        closed = true;
        for (const off of offs) off();
        wake?.();
      };
      return {
        async next(): Promise<IteratorResult<T>> {
          while (latest === undefined && !closed)
            await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          const value = latest;
          latest = undefined;
          return value === undefined ? { value: undefined, done: true } : { value, done: false };
        },
        async return(): Promise<IteratorResult<T>> {
          close();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

export function remoteControl(
  connection: Pick<AgentConnection, 'remote'> &
    Pick<Partial<AgentConnection>, 'inventory' | 'approvals' | 'agents' | 'readOnly'>,
  options: RemoteOptions = {}
): RemoteControl {
  const remote = connection.remote;
  const agent = () => options.agent?.() ?? null;
  const need = (): AgentRemote => {
    if (!remote) throw failure('ENOSYS', 'this agent has no remote control');
    return remote;
  };
  return {
    async prompt({ text, whenBusy = 'followUp', thinking = false, attachments }) {
      const service = need();
      const request = {
        agentId: agent(),
        text,
        whenBusy,
        thinking,
        ...(attachments?.length ? { attachments } : {}),
      };
      const result = opened(await service.prompt(request, BACKGROUND_CONTEXT));
      return {
        delivered: result.delivered as Delivered,
        events: events(service, result.stream),
      };
    },
    async watch({ since = null, thinking = false, busy = false } = {}) {
      const service = need();
      const request = { agentId: agent(), since, thinking, ...(busy ? { busy: true } : {}) };
      const result = opened(await service.watch(request, BACKGROUND_CONTEXT));
      return {
        head: result.head ?? '',
        ...(result.gap ? { gap: true as const } : {}),
        ...(typeof result.busy === 'boolean' ? { busy: result.busy } : {}),
        history: result.history ?? null,
        events: events(service, result.stream),
      };
    },
    async history({ before, limit, thinking = false }) {
      const service = need();
      const request = {
        agentId: agent(),
        before,
        thinking,
        ...(limit === undefined ? {} : { limit }),
      };
      const result = await service.history(request, BACKGROUND_CONTEXT);
      if (!result.ok) throw failure(result.code, result.message);
      return { events: result.events, before: result.before, more: result.more };
    },
    async abort() {
      return need().abort(agent(), BACKGROUND_CONTEXT);
    },
    async inventory({ watch = false } = {}) {
      const state = connection.inventory;
      if (!state) throw failure('EOPNOTSUPP', 'this agent has no inventory');
      const snapshot = narrowInventory(await current(state), agent());
      if (!watch) return { snapshot };
      const compute = () => (state.value?.seq ? narrowInventory(state.value, agent()) : undefined);
      const key = (next: InventorySnapshot) => JSON.stringify(next.agents);
      return { snapshot, events: following([state], compute, key, snapshot) };
    },
    async approvals({ watch = false } = {}) {
      const items = connection.approvals;
      if (!items) throw failure('EOPNOTSUPP', NO_APPROVALS);
      const agents = connection.agents;
      const compute = () => pendingApprovals(items.value, agents?.value);
      const approvals = compute();
      if (!watch) return { approvals };
      const sources = agents ? [items, agents] : [items];
      return { approvals, events: following(sources, compute, JSON.stringify, approvals) };
    },
    async decide({ id, answer, reason = null }) {
      const request = { id, answer, reason, device: options.device ?? null };
      const service = need();
      if (connection.readOnly) throw failure('EACCES', VIEW_ONLY);
      if (typeof service.decide !== 'function') throw failure('EOPNOTSUPP', NO_APPROVALS);
      const result = await service.decide(request, BACKGROUND_CONTEXT);
      if (!result.ok) throw failure(result.code, result.message);
      return { ok: true };
    },
  };
}
