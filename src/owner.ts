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
  restart(): Promise<void>;
  release(): Promise<void>;
}

export interface KernelSource {
  connect(): Promise<Transferable>;
}

export interface OwnerOptions {
  worker: () => AgentWorker;
  kernel?: KernelSource;
  locks?: LockManager;
  channel?: () => { port1: PortEndpoint; port2: Transferable };
}

export async function startAgent(options: OwnerOptions): Promise<AgentOwner> {
  const release = await holdLock(options.locks ?? navigator.locks, AGENT_LOCK);
  const channel = options.channel ?? (() => new MessageChannel());
  const spawn = async () => {
    const created = options.worker();
    if (options.kernel) {
      const port = await options.kernel.connect();
      created.postMessage({ kernel: port }, [port]);
    }
    return created;
  };
  let worker: Promise<AgentWorker> = spawn();
  try {
    await worker;
  } catch (error) {
    release();
    throw error;
  }
  return {
    async connect() {
      const ready = await worker;
      const { port1, port2 } = channel();
      ready.postMessage({ connect: port2 }, [port2]);
      return connectAgent(port1);
    },
    async restart() {
      (await worker).terminate();
      worker = spawn();
      await worker;
    },
    async release() {
      (await worker).terminate();
      release();
    },
  };
}
