import { type AgentConnection, connectAgent } from './client.ts';
import { holdLock } from './opfs-pool.ts';
import type { PortEndpoint } from './wire.ts';

export const AGENT_LOCK = 'slicc-agent';

export interface AgentWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface AgentOwner {
  connect(): Promise<AgentConnection>;
  restart(): void;
  release(): void;
}

export interface OwnerOptions {
  worker: () => AgentWorker;
  locks?: LockManager;
  channel?: () => { port1: PortEndpoint; port2: Transferable };
}

export async function startAgent(options: OwnerOptions): Promise<AgentOwner> {
  const release = await holdLock(options.locks ?? navigator.locks, AGENT_LOCK);
  const channel = options.channel ?? (() => new MessageChannel());
  let worker: AgentWorker;
  try {
    worker = options.worker();
  } catch (error) {
    release();
    throw error;
  }
  return {
    connect() {
      const { port1, port2 } = channel();
      worker.postMessage({ connect: port2 }, [port2]);
      return connectAgent(port1);
    },
    restart() {
      worker.terminate();
      worker = options.worker();
    },
    release() {
      worker.terminate();
      release();
    },
  };
}
