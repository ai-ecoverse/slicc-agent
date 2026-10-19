import { redacted } from '../monitor/redact.ts';
import type { KernelClient, KernelProcess } from './client.ts';

export type Job = { pid: number; pgid: number; command: string };

export interface Jobs {
  started(client: KernelClient, command: string, process: KernelProcess): Promise<void>;
  list(): Job[];
  adopt(jobs: readonly Job[]): void;
  watch(listener: () => Promise<void>): () => void;
}

export const JOBS_MS = 2000;

type Ps = Pick<KernelClient, 'ps'>;

type Row = Awaited<ReturnType<NonNullable<KernelClient['ps']>>>[number];

export function shortCommand(command: string): string {
  const lines = command.trim().split('\n');
  const first = redacted(lines[0] as string);
  return lines.length > 1 && !first.endsWith('…') ? `${first} …` : first;
}

export function backgroundJobs(client: Ps, ms = JOBS_MS): Jobs {
  const jobs = new Map<number, Job & { client: Ps }>();
  const running = new Set<number>();
  const listeners = new Set<() => Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const list = () => [...jobs.values()].map(({ pid, pgid, command }) => ({ pid, pgid, command }));
  const orphans = (table: readonly Row[], pgid: number, after: number) =>
    table.filter(
      (row) =>
        row.ppid === 1 &&
        row.pgid === pgid &&
        row.pid > after &&
        row.state !== 'Z' &&
        !running.has(row.pid) &&
        !jobs.has(row.pid)
    );
  const keep = (rows: readonly Row[], pgid: number, command: string, owner: Ps) => {
    for (const row of rows) jobs.set(row.pid, { pid: row.pid, pgid, command, client: owner });
  };
  const schedule = () => {
    const wanted = jobs.size > 0 && listeners.size > 0;
    if (wanted && !timer) timer = setInterval(() => void prune(), ms);
    if (!wanted && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const changed = async () => {
    schedule();
    await Promise.all([...listeners].map((listener) => listener()));
  };
  const sweep = (owner: Ps, table: readonly Row[]) => {
    const alive = new Set(table.filter((row) => row.state !== 'Z').map((row) => row.pid));
    let gone = false;
    for (const [pid, job] of [...jobs])
      if (job.client === owner && !alive.has(pid)) {
        gone = jobs.delete(pid);
        keep(orphans(table, job.pgid, pid), job.pgid, job.command, owner);
      }
    return gone;
  };
  async function prune(): Promise<void> {
    let gone = false;
    for (const each of new Set([...jobs.values()].map((job) => job.client))) {
      const table = await each.ps?.().catch(() => undefined);
      if (table && sweep(each, table)) gone = true;
    }
    if (gone) await changed();
  }
  async function survivors(owner: Ps, command: string, process: KernelProcess): Promise<void> {
    const table = await owner.ps?.().catch(() => undefined);
    if (!table) return;
    const found = orphans(table, process.pgid, process.pid);
    keep(found, process.pgid, shortCommand(command), owner);
    if (sweep(owner, table) || found.length) await changed();
  }
  return {
    async started(owner, command, process) {
      if (!owner.ps) return;
      running.add(process.pid);
      const ended = () => {
        running.delete(process.pid);
        return survivors(owner, command, process);
      };
      await process.exited.then(ended, ended).catch(() => undefined);
    },
    list,
    adopt(adopted) {
      for (const job of adopted) if (!jobs.has(job.pid)) jobs.set(job.pid, { ...job, client });
      schedule();
    },
    watch(listener) {
      listeners.add(listener);
      schedule();
      return () => {
        listeners.delete(listener);
        schedule();
      };
    },
  };
}
