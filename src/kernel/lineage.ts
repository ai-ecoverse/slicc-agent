import type { KernelClient, KernelProcess } from './client.ts';
import { boundedPs, PS_MS } from './jobs.ts';

export interface Lineage {
  agent: number | null;
  spawned: boolean;
}

export interface Spawns {
  started(process: KernelProcess, owner: number): void;
  lineage(pid: number | null): Promise<Lineage | undefined>;
}

type Row = { pid: number; ppid?: number; pgid?: number };

function indexed(rows: readonly Row[]): Map<number, Row> {
  const byPid = new Map<number, Row>();
  for (const row of rows) if (!byPid.has(row.pid)) byPid.set(row.pid, row);
  return byPid;
}

function parentOf(byPid: ReadonlyMap<number, Row>, row: Row): Row | undefined {
  return row.ppid === undefined || row.ppid <= 1 ? undefined : byPid.get(row.ppid);
}

export function spawns(
  client: Pick<KernelClient, 'ps'>,
  warn: (message: string) => void = (message) => console.warn(message),
  bound = PS_MS
): Spawns {
  const live = new Map<number, number>();
  const groups = new Set<number>();
  const seen = (found: Lineage, row: Row) => {
    const owner = live.get(row.pid);
    if (owner !== undefined || (row.pgid !== undefined && groups.has(row.pgid)))
      found.spawned = true;
    if (owner !== undefined && found.agent === null) found.agent = owner;
  };
  const walk = (rows: readonly Row[], pid: number): Lineage | undefined => {
    for (const pgid of [...groups]) if (!rows.some((row) => row.pgid === pgid)) groups.delete(pgid);
    const byPid = indexed(rows);
    const visited = new Set<number>();
    const found: Lineage = { agent: null, spawned: false };
    let row = byPid.get(pid);
    if (!row) return undefined;
    for (; row && !visited.has(row.pid); row = parentOf(byPid, row)) {
      visited.add(row.pid);
      seen(found, row);
    }
    return found;
  };
  return {
    started(process, owner) {
      live.set(process.pid, owner);
      groups.add(process.pgid);
      const ended = () => live.delete(process.pid);
      process.exited.then(ended, ended);
    },
    async lineage(pid) {
      if (pid === null) return undefined;
      const rows = await boundedPs(client, warn, bound);
      return rows ? walk(rows, pid) : undefined;
    },
  };
}
