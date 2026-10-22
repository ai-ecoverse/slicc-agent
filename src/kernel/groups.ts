import type { KernelClient, KernelProcess } from './client.ts';
import { type Lineage, spawns } from './lineage.ts';

export const REFUSED = new Set(['ESRCH', 'EPERM', 'ENOSYS']);

export interface ProcessGroups {
  track(owner: number, process: KernelProcess, tag?: string): void;
  of(owner: number): number[];
  owned(owner: number): number[];
  shared(owner: number): number | undefined;
  joins(): boolean;
  pending(owner: number): Promise<void> | undefined;
  reserve(owner: number): () => void;
  refused(owner: number, code: string): void;
  signal(owner: number, signal?: string): Promise<number[]>;
  lineage(pid: number | null): Promise<Lineage | undefined>;
}

export function processGroups(client: Pick<KernelClient, 'kill' | 'ps' | 'fs'>): ProcessGroups {
  const spawned = spawns(client);
  const groups = new Map<number, Set<number>>();
  const shared = new Map<number, number>();
  const leading = new Map<number, Promise<void>>();
  let joining = true;
  return {
    track(owner, process, tag) {
      spawned.started(process, owner, tag);
      const set = groups.get(owner) ?? new Set<number>();
      groups.set(owner, set);
      set.add(process.pgid);
      if (!shared.has(owner)) shared.set(owner, process.pgid);
      process.exited.then(
        () => set.delete(process.pgid),
        () => set.delete(process.pgid)
      );
    },
    of: (owner) => [...(groups.get(owner) ?? [])],
    owned: (owner) =>
      [
        ...new Set([
          ...(groups.get(owner) ?? []),
          ...(shared.has(owner) ? [shared.get(owner)] : []),
        ]),
      ] as number[],
    shared: (owner) => (joining ? shared.get(owner) : undefined),
    joins: () => joining,
    pending: (owner) => leading.get(owner),
    reserve(owner) {
      let done: () => void = () => undefined;
      leading.set(
        owner,
        new Promise<void>((resolve) => {
          done = resolve;
        })
      );
      return () => {
        leading.delete(owner);
        done();
      };
    },
    refused(owner, code) {
      if (code === 'ENOSYS') joining = false;
      shared.delete(owner);
    },
    async signal(owner, signal = 'SIGTERM') {
      const signalled: number[] = [];
      const all = new Set([
        ...(groups.get(owner) ?? []),
        ...(shared.has(owner) ? [shared.get(owner) as number] : []),
      ]);
      for (const pgid of all) {
        try {
          await client.kill?.(-pgid, signal);
          signalled.push(pgid);
        } catch {}
      }
      groups.delete(owner);
      shared.delete(owner);
      return signalled;
    },
    lineage: spawned.lineage,
  };
}

export function descendants(
  table: readonly { pid: number; ppid?: number }[],
  root: number
): number[] {
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift() as number;
    for (const entry of table)
      if (entry.ppid === parent && !out.includes(entry.pid)) {
        out.push(entry.pid);
        queue.push(entry.pid);
      }
  }
  return out;
}
