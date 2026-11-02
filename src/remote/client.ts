import type { ReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SendAttachment } from '../attachments.ts';
import type { AgentConnection } from '../client.ts';
import type { Delivered, InventorySnapshot, InventoryState, SendMode } from '../services.ts';
import type { RemoteEvent } from './events.ts';
import type { AgentRemote, RemoteOpened } from './host.ts';
import { narrowInventory } from './inventory.ts';

export type { RemoteEvent } from './events.ts';

export const POLL_MS = 25000;

export interface RemoteOptions {
  agent?: () => string | null;
}

export interface RemoteControl {
  prompt(request: {
    text: string;
    whenBusy?: SendMode;
    thinking?: boolean;
    attachments?: SendAttachment[];
  }): Promise<{ delivered: Delivered; events: AsyncIterable<RemoteEvent> }>;
  watch(request?: {
    since?: string | null;
    thinking?: boolean;
    busy?: boolean;
  }): Promise<{ head: string; gap?: true; busy?: boolean; events: AsyncIterable<RemoteEvent> }>;
  abort(): Promise<{ aborted: boolean }>;
  inventory(request?: {
    watch?: boolean;
  }): Promise<{ snapshot: InventorySnapshot; events?: AsyncIterable<InventorySnapshot> }>;
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

function snapshots(
  state: ReplicatedState<InventoryState>,
  cone: () => string | null,
  first: InventorySnapshot
): AsyncIterable<InventorySnapshot> {
  return {
    [Symbol.asyncIterator]() {
      let last = JSON.stringify(first.agents);
      let latest: InventorySnapshot | undefined;
      let wake: (() => void) | undefined;
      let closed = false;
      const off = state.subscribe((value) => {
        if (!value?.seq || closed) return;
        const next = narrowInventory(value, cone());
        const key = JSON.stringify(next.agents);
        if (key === last) return;
        last = key;
        latest = next;
        wake?.();
      });
      const close = () => {
        closed = true;
        off();
        wake?.();
      };
      return {
        async next(): Promise<IteratorResult<InventorySnapshot>> {
          while (!latest && !closed) await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          const value = latest;
          latest = undefined;
          return value ? { value, done: false } : { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<InventorySnapshot>> {
          close();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

export function remoteControl(
  connection: Pick<AgentConnection, 'remote'> & Pick<Partial<AgentConnection>, 'inventory'>,
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
        events: events(service, result.stream),
      };
    },
    async abort() {
      return need().abort(agent(), BACKGROUND_CONTEXT);
    },
    async inventory({ watch = false } = {}) {
      const state = connection.inventory;
      if (!state) throw failure('EOPNOTSUPP', 'this agent has no inventory');
      const snapshot = narrowInventory(await current(state), agent());
      return watch ? { snapshot, events: snapshots(state, agent, snapshot) } : { snapshot };
    },
  };
}
