import type { PortEndpoint } from '../wire.ts';
import type { KernelClient } from './client.ts';

export interface KernelUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  groups: number[];
  umask?: number;
}

export interface UserSpec {
  name: string;
  home?: string;
  groups?: string[];
  umask?: number;
  homeGroup?: string;
}

export interface KernelUsers {
  add(spec: UserSpec): Promise<KernelUser>;
  remove(name: string, options?: { keepHome?: boolean }): Promise<boolean>;
  list(): Promise<KernelUser[]>;
}

export interface UserConnect {
  user?: string;
  agentId?: string;
}

export interface KernelSource {
  connect(options?: UserConnect): Promise<Transferable>;
  users?: KernelUsers;
}

export interface KernelAdmin {
  connect(options: UserConnect): Promise<MessagePort>;
  users: KernelUsers;
  close(): void;
}

type Op = 'connect' | 'users.add' | 'users.remove' | 'users.list';
type Call = { id: number; op: Op; args: unknown[] };
type Reply = { id: number; value?: unknown; error?: { message: string; code?: string } };

function failure(error: unknown): { message: string; code?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { message, code } : { message };
}

async function perform(source: KernelSource, call: Call): Promise<unknown> {
  const users = source.users;
  if (call.op === 'connect') return source.connect(call.args[0] as UserConnect);
  if (!users) throw Object.assign(new Error('this kernel has no users'), { code: 'ENOSYS' });
  if (call.op === 'users.add') return users.add(call.args[0] as UserSpec);
  if (call.op === 'users.remove')
    return users.remove(call.args[0] as string, call.args[1] as { keepHome?: boolean });
  return users.list();
}

export function serveAdmin(port: PortEndpoint, source: KernelSource): void {
  port.addEventListener('message', (event: MessageEvent) => {
    const call = event.data as Call;
    perform(source, call).then(
      (value) => {
        const transfer = call.op === 'connect' ? [value as Transferable] : [];
        port.postMessage({ id: call.id, value } satisfies Reply, transfer);
      },
      (error: unknown) => port.postMessage({ id: call.id, error: failure(error) } satisfies Reply)
    );
  });
  port.start?.();
}

export function adminOver(port: PortEndpoint): KernelAdmin {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let next = 0;
  let shut = false;
  port.addEventListener('message', (event: MessageEvent) => {
    const reply = event.data as Reply;
    const waiting = pending.get(reply.id);
    if (!waiting) return;
    pending.delete(reply.id);
    if (reply.error) waiting.reject(Object.assign(new Error(reply.error.message), reply.error));
    else waiting.resolve(reply.value);
  });
  port.start?.();
  const call = <T>(op: Op, ...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      if (shut) {
        reject(new Error('the kernel admin closed'));
        return;
      }
      const id = ++next;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      port.postMessage({ id, op, args } satisfies Call);
    });
  return {
    connect: (options) => call<MessagePort>('connect', options),
    users: {
      add: (spec) => call<KernelUser>('users.add', spec),
      remove: (name, options) => call<boolean>('users.remove', name, options),
      list: () => call<KernelUser[]>('users.list'),
    },
    close() {
      shut = true;
      for (const waiting of pending.values()) waiting.reject(new Error('the kernel admin closed'));
      pending.clear();
      port.close?.();
    },
  };
}

export type UserClient = KernelClient & {
  close?(options?: { kill?: boolean }): unknown;
  closed?: Promise<unknown>;
};

export interface UserClients {
  readonly users: KernelUsers;
  client(agentId: string, user: string): Promise<UserClient>;
  drop(agentId: string): Promise<void>;
  close(): Promise<void>;
}

type Held = { user: string; client: Promise<UserClient> };

export function userClients(
  admin: KernelAdmin,
  attach: (port: MessagePort) => Promise<UserClient>
): UserClients {
  const held = new Map<string, Held>();
  const forget = (agentId: string, entry: Held) => {
    if (held.get(agentId) === entry) held.delete(agentId);
  };
  const end = async (entry: Held, kill: boolean) => {
    const client = await entry.client.catch(() => undefined);
    await client?.close?.({ kill });
  };
  return {
    users: admin.users,
    client(agentId, user) {
      const known = held.get(agentId);
      if (known?.user === user) return known.client;
      if (known) void end(known, true);
      const entry: Held = {
        user,
        client: admin.connect({ user, agentId }).then(attach),
      };
      held.set(agentId, entry);
      entry.client.then(
        (client) =>
          client.closed?.then(
            () => forget(agentId, entry),
            () => forget(agentId, entry)
          ),
        () => forget(agentId, entry)
      );
      return entry.client;
    },
    async drop(agentId) {
      const entry = held.get(agentId);
      if (!entry) return;
      held.delete(agentId);
      await end(entry, true);
    },
    async close() {
      const entries = [...held.values()];
      held.clear();
      await Promise.all(entries.map((entry) => end(entry, false)));
      admin.close();
    },
  };
}
