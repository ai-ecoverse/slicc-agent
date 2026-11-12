import type { KernelClient } from '../kernel/client.ts';
import { tagsOf } from '../kernel/sightings.ts';

export type RunKernel = Pick<KernelClient, 'fs' | 'spawn' | 'ps' | 'kill' | 'sudoRun' | 'trace'>;

export type Exit = { status?: number; signal?: string };

export const RUN_TAG = 'sudo-run:';
export const RUNS_DIR = '.slicc/sudo-runs';
export const GRACE_MS = 1000;

export const runTag = (id: string): string => `${RUN_TAG}${id}`;

type Row = NonNullable<Awaited<ReturnType<NonNullable<RunKernel['ps']>>>>[number];

async function passwdOf(kernel: RunKernel, user: string): Promise<string[] | undefined> {
  const passwd = await kernel.fs.readText('/etc/passwd').catch(() => '');
  return passwd
    .split('\n')
    .find((entry) => entry.startsWith(`${user}:`))
    ?.split(':');
}

async function homeOf(kernel: RunKernel, user: string): Promise<string> {
  const home = (await passwdOf(kernel, user))?.[5];
  if (home) return home.replace(/\/+$/, '') || '/';
  return user === 'root' ? '/root' : `/home/${user}`;
}

export async function uidOf(kernel: RunKernel, user: string): Promise<number | undefined> {
  const uid = Number((await passwdOf(kernel, user))?.[2] ?? (user === 'root' ? 0 : NaN));
  return Number.isInteger(uid) ? uid : undefined;
}

export function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function asUser(kernel: RunKernel, argv: string[], user: string, signal?: AbortSignal) {
  const made = await kernel.spawn(argv, { user, cwd: '/' });
  return Promise.race([made.exited, aborted(signal)]);
}

export async function outputOf(kernel: RunKernel, user: string, id: string, signal?: AbortSignal) {
  const home = await homeOf(kernel, user);
  const dir = `${home === '/' ? '' : home}/${RUNS_DIR}`;
  const code = await asUser(kernel, ['mkdir', '-p', dir], user, signal);
  if (code !== 0) throw new Error(`can't create ${dir} as ${user}`);
  return { stdout: `${dir}/${id}.out`, stderr: `${dir}/${id}.err` };
}

export async function removeOutput(kernel: RunKernel, user: string, paths: string[]) {
  await asUser(kernel, ['rm', '-f', '--', ...paths], user).catch(() => undefined);
}

export async function outputSize(kernel: RunKernel, paths: string[]): Promise<number> {
  const sizes = await Promise.all(
    paths.map((path) =>
      kernel.fs
        .lstat(path)
        .then((stat) => (stat.isFile ? stat.size : 0))
        .catch(() => 0)
    )
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export type Watcher = { waitFor(pid: number): Promise<Exit>; close(): void };

export async function watchExits(kernel: RunKernel, tag: string): Promise<Watcher> {
  const exits = new Map<number, Exit>();
  const waiting = new Map<number, (exit: Exit) => void>();
  const subscription = await kernel
    .trace?.(tag, ({ events }) => {
      for (const event of events) {
        if (event.type !== 'exit') continue;
        const exit = { status: event.status, ...(event.signal ? { signal: event.signal } : {}) };
        exits.set(event.pid, exit);
        waiting.get(event.pid)?.(exit);
      }
    })
    .catch(() => undefined);
  return {
    waitFor: (pid) =>
      new Promise((resolve) => {
        const known = exits.get(pid);
        if (known) resolve(known);
        else waiting.set(pid, resolve);
      }),
    close: () => subscription?.close(),
  };
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });

async function alive(kernel: RunKernel, pid: number): Promise<boolean> {
  const rows = await kernel.ps?.().catch(() => undefined);
  return !rows || rows.some((row) => row.pid === pid && row.state !== 'Z');
}

export async function gone(kernel: RunKernel, pid: number, ms: number, signal: AbortSignal) {
  while (await alive(kernel, pid)) await sleep(ms, signal);
  await sleep(GRACE_MS, signal);
  return {} as Exit;
}

export async function tagged(kernel: RunKernel, tag: string): Promise<Row[] | null> {
  const rows = await kernel.ps?.().catch(() => undefined);
  if (!rows) return null;
  return rows
    .filter((row) => row.state !== 'Z' && tagsOf(row).includes(tag))
    .sort((a, b) => a.pid - b.pid);
}

export type Signalled = 'sent' | 'none' | 'unknown';

export async function signalTree(
  kernel: RunKernel,
  tag: string,
  killMs: number
): Promise<Signalled> {
  const rows = await tagged(kernel, tag);
  if (!rows) return 'unknown';
  if (!rows.length) return 'none';
  const send = (list: Row[], signal: string) =>
    Promise.all(list.map((row) => kernel.kill?.(row.pid, signal).catch(() => undefined)));
  await send(rows, 'SIGTERM');
  setTimeout(() => {
    void tagged(kernel, tag).then((left) => (left ? send(left, 'SIGKILL') : undefined));
  }, killMs);
  return 'sent';
}

export async function adoptable(kernel: RunKernel, tag: string, target: string) {
  const uid = await uidOf(kernel, target);
  const rows = (await tagged(kernel, tag)) ?? [];
  const mine = rows.filter((row) => uid !== undefined && row.uid === uid);
  return mine.find((row) => row.pid === row.pgid) ?? mine[0];
}
