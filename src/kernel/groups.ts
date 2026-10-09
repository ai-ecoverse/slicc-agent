import type { KernelClient, KernelProcess } from './client.ts';

export const REFUSED = new Set(['ESRCH', 'EPERM', 'ENOSYS']);

export interface ProcessGroups {
  track(owner: number, process: KernelProcess): void;
  of(owner: number): number[];
  shared(owner: number): number | undefined;
  refused(owner: number, code: string): void;
  signal(owner: number, signal?: string): Promise<number[]>;
}

export function processGroups(client: Pick<KernelClient, 'kill'>): ProcessGroups {
  const groups = new Map<number, Set<number>>();
  const shared = new Map<number, number>();
  let joining = true;
  return {
    track(owner, process) {
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
    shared: (owner) => (joining ? shared.get(owner) : undefined),
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
