import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SendAttachment } from '../attachments.ts';
import type { AgentConnection } from '../client.ts';
import type { Delivered, SendMode } from '../services.ts';
import type { RemoteEvent } from './events.ts';
import type { AgentRemote, RemoteOpened } from './host.ts';

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

export function remoteControl(
  connection: Pick<AgentConnection, 'remote'>,
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
  };
}
