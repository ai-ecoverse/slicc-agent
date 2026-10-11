import { type AgentConnection, connectAgent } from './client.ts';
import { type KernelSource, serveAdmin } from './kernel/users.ts';
import { holdLock } from './opfs-pool.ts';
import type { PortEndpoint } from './wire.ts';

export const AGENT_LOCK = 'slicc-agent';

export interface AgentWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface PortOptions {
  readOnly?: boolean;
}

export interface AgentOwner {
  connect(options?: PortOptions): Promise<AgentConnection>;
  port(options?: PortOptions): Promise<PortEndpoint & Transferable>;
  restart(): Promise<void>;
  release(): Promise<void>;
}

export type { KernelSource } from './kernel/users.ts';

export interface OwnerOptions {
  worker: () => AgentWorker;
  kernel?: KernelSource;
  locks?: LockManager;
  held?: boolean;
  channel?: () => { port1: PortEndpoint & Transferable; port2: Transferable };
}

export async function startAgent(options: OwnerOptions): Promise<AgentOwner> {
  const release = options.held
    ? () => undefined
    : await holdLock(options.locks ?? navigator.locks, AGENT_LOCK);
  const channel = options.channel ?? (() => new MessageChannel());
  const spawn = async (): Promise<AgentWorker> => {
    const created = options.worker();
    let admin: (PortEndpoint & Transferable) | undefined;
    try {
      if (options.kernel) {
        const port = await options.kernel.connect();
        if (!options.kernel.users) created.postMessage({ kernel: port }, [port]);
        else {
          const { port1, port2 } = channel();
          admin = port1;
          serveAdmin(port1, options.kernel);
          created.postMessage({ kernel: port, admin: port2 }, [port, port2]);
        }
      }
    } catch (error) {
      admin?.close?.();
      created.terminate();
      throw error;
    }
    if (!admin) return created;
    const served = admin;
    return {
      postMessage: (message, transfer) => created.postMessage(message, transfer),
      terminate() {
        served.close?.();
        created.terminate();
      },
    };
  };
  let worker: Promise<AgentWorker | undefined> = Promise.resolve().then(spawn);
  try {
    await worker;
  } catch (error) {
    release();
    throw error;
  }
  const open = async (portOptions: PortOptions = {}): Promise<PortEndpoint & Transferable> => {
    const ready = await worker;
    if (!ready) throw new Error('the agent was released');
    const { port1, port2 } = channel();
    const readOnly = portOptions.readOnly === true ? { readOnly: true } : {};
    ready.postMessage({ connect: port2, ...readOnly }, [port2]);
    return port1;
  };
  return {
    async connect(portOptions) {
      return connectAgent(await open(portOptions));
    },
    port: open,
    restart() {
      worker = worker
        .catch(() => undefined)
        .then((old) => {
          old?.terminate();
          return spawn();
        });
      return worker.then(() => undefined);
    },
    async release() {
      const previous = worker;
      worker = Promise.resolve(undefined);
      try {
        (await previous.catch(() => undefined))?.terminate();
      } finally {
        release();
      }
    },
  };
}
