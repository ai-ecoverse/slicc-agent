import type { KernelClient, KernelProcess } from './client.ts';

export interface ProcessGroups {
  track(owner: number, process: KernelProcess): void;
  of(owner: number): number[];
  signal(owner: number, signal?: string): Promise<number[]>;
}

export function processGroups(client: Pick<KernelClient, 'kill'>): ProcessGroups {
  const groups = new Map<number, Set<number>>();
  return {
    track(owner, process) {
      const set = groups.get(owner) ?? new Set<number>();
      groups.set(owner, set);
      set.add(process.pgid);
      process.exited.then(
        () => set.delete(process.pgid),
        () => set.delete(process.pgid)
      );
    },
    of: (owner) => [...(groups.get(owner) ?? [])],
    async signal(owner, signal = 'SIGTERM') {
      const signalled: number[] = [];
      for (const pgid of groups.get(owner) ?? []) {
        try {
          await client.kill?.(-pgid, signal);
          signalled.push(pgid);
        } catch {}
      }
      groups.delete(owner);
      return signalled;
    },
  };
}
