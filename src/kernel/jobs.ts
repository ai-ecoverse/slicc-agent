import { redacted } from '../monitor/redact.ts';
import type { KernelClient, KernelProcess } from './client.ts';

export type Job = { pid: number; command: string };

export interface Jobs {
  started(client: KernelClient, command: string, process: KernelProcess): Promise<void>;
  list(): Job[];
  adopt(jobs: readonly Job[]): void;
  watch(listener: () => Promise<void>): () => void;
}

export const JOBS_MS = 2000;

type Ps = Pick<KernelClient, 'ps'>;

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
  const list = () => [...jobs.values()].map(({ pid, command }) => ({ pid, command }));
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
  async function prune(): Promise<void> {
    let gone = false;
    for (const each of new Set([...jobs.values()].map((job) => job.client))) {
      const table = await each.ps?.().catch(() => undefined);
      if (!table) continue;
      const alive = new Set(table.filter((row) => row.state !== 'Z').map((row) => row.pid));
      for (const [pid, job] of jobs)
        if (job.client === each && !alive.has(pid)) gone = jobs.delete(pid);
    }
    if (gone) await changed();
  }
  async function survivors(owner: Ps, command: string, process: KernelProcess): Promise<void> {
    const table = await owner.ps?.().catch(() => undefined);
    const found = (table ?? []).filter(
      (row) =>
        row.ppid === 1 &&
        row.pgid === process.pgid &&
        row.pid > process.pid &&
        row.state !== 'Z' &&
        !running.has(row.pid) &&
        !jobs.has(row.pid)
    );
    if (!found.length) return;
    for (const row of found)
      jobs.set(row.pid, { pid: row.pid, command: shortCommand(command), client: owner });
    await changed();
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
