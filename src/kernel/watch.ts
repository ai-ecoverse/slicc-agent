import type { Context } from '@earendil-works/chord';
import type { FileChange, FileWatcher, WatchTarget } from '@earendil-works/pi-durable/env';
import type { KernelClient, KernelFs } from './client.ts';
import { basename, dirname, resolve } from './paths.ts';

type Snapshot = Map<string, string>;

function excluded(name: string, target: WatchTarget): boolean {
  const rule = target.exclude;
  if (!rule) return false;
  return (rule.hidden === true && name.startsWith('.')) || (rule.names?.includes(name) ?? false);
}

async function record(fs: KernelFs, path: string, into: Snapshot): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => undefined);
  if (!stat) return false;
  into.set(
    path,
    `${stat.isDirectory ? 'd' : 'f'}:${stat.ino}:${stat.size}:${new Date(stat.mtime).getTime()}`
  );
  return stat.isDirectory;
}

async function scan(
  fs: KernelFs,
  path: string,
  target: WatchTarget,
  deep: boolean,
  into: Snapshot
) {
  const directory = await record(fs, path, into);
  if (!directory || !deep) return;
  const names = await fs.readdir(path).catch(() => [] as string[]);
  for (const name of names) {
    if (excluded(name, target)) continue;
    const child = `${path === '/' ? '' : path}/${name}`;
    await scan(fs, child, target, target.recursive === true, into);
  }
}

export async function snapshot(
  fs: KernelFs,
  cwd: string,
  targets: readonly WatchTarget[]
): Promise<Snapshot> {
  const all: Snapshot = new Map();
  for (const target of targets) await scan(fs, resolve(cwd, target.path), target, true, all);
  return all;
}

export function differences(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();
  const moved = (path: string) => {
    changed.add(path);
    changed.add(dirname(path));
  };
  for (const [path, value] of after) {
    if (!before.has(path)) moved(path);
    else if (before.get(path) !== value) changed.add(path);
  }
  for (const path of before.keys()) if (!after.has(path)) moved(path);
  return [...changed];
}

export interface PollOptions {
  intervalMs?: number;
  rescanMs?: number;
  deepRescanMs?: number;
  mode?: 'native' | 'polling';
}

export interface PollTiming {
  intervalMs?: number;
  backoff?: number;
}

export const RESCAN_MS = 2000;
export const DEEP_RESCAN_MS = 30_000;
export const POLL_MS = 500;
export const SCAN_BACKOFF = 10;
export const RESCAN_BACKOFF = 50;

let lane: Promise<unknown> = Promise.resolve();

export function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const turn = lane.then(run);
  lane = turn.catch(() => undefined);
  return turn;
}

export function pollInterval(targets: readonly WatchTarget[]): number {
  return targets.some((target) => target.recursive === true) ? RESCAN_MS : POLL_MS;
}

function baseOf(path: string, target: WatchTarget): string | undefined {
  if (inside(path, target.path)) return target.path;
  return inside(target.path, path) ? path : undefined;
}

function outermost(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const path of [...paths].sort()) {
    const last = out.at(-1);
    if (last === undefined || !inside(last, path)) out.push(path);
  }
  return out;
}

async function absorbPaths(
  fs: KernelFs,
  current: Snapshot,
  targets: readonly WatchTarget[],
  paths: readonly string[]
): Promise<void> {
  for (const path of paths)
    for (const target of targets) {
      const base = baseOf(path, target);
      if (base === undefined) continue;
      const was = current.get(base);
      current.delete(base);
      if (was?.startsWith('d'))
        for (const key of [...current.keys()]) if (inside(base, key)) current.delete(key);
      await scan(fs, base, target, base === target.path || target.recursive === true, current);
    }
}

export type PathsChange = Extract<FileChange, { kind: 'paths' }>;

export type PolledWatcher = FileWatcher & { absorb(paths: readonly string[]): void };

export async function pollWatch(
  fs: KernelFs,
  cwd: string,
  targets: readonly WatchTarget[],
  onChange: (change: PathsChange) => void,
  options: PollTiming = {}
): Promise<PolledWatcher> {
  let took = 0;
  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      took = Date.now() - started;
    }
  };
  let current = await exclusive(() => timed(() => snapshot(fs, cwd, targets)));
  const resolved = targets.map((target) => ({ ...target, path: resolve(cwd, target.path) }));
  const interval = options.intervalMs ?? pollInterval(targets);
  const backoff = options.backoff ?? SCAN_BACKOFF;
  const absorbing = new Set<string>();
  let open = true;
  let due = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let active: Promise<unknown> | undefined;
  const turn = (run: () => Promise<void>) =>
    exclusive(async () => {
      if (!open) return;
      active = run();
      try {
        await active;
      } finally {
        active = undefined;
      }
    });
  const tick = async () => {
    let paths: string[] = [];
    await turn(async () => {
      const next = await timed(() => snapshot(fs, cwd, targets));
      const heard = [...absorbing];
      paths = differences(current, next).filter(
        (path) => !heard.some((known) => inside(known, path) || dirname(known) === path)
      );
      current = next;
    });
    if (open && paths.length > 0) onChange({ kind: 'paths', paths });
  };
  const work = async () => {
    try {
      while (open && (absorbing.size > 0 || due)) {
        if (absorbing.size > 0) {
          const paths = outermost(absorbing);
          absorbing.clear();
          await turn(() => absorbPaths(fs, current, resolved, paths));
        } else {
          due = false;
          await tick().catch(() => undefined);
        }
      }
    } finally {
      running = false;
      schedule();
    }
  };
  const schedule = () => {
    if (!open || timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        due = true;
        kick();
      },
      Math.max(interval, took * backoff)
    );
  };
  const kick = () => {
    if (running) return;
    running = true;
    void work();
  };
  schedule();
  return {
    mode: 'polling',
    absorb(paths) {
      if (!open || paths.length === 0) return;
      for (const path of paths) absorbing.add(path);
      kick();
    },
    async stop(_context: Context) {
      open = false;
      clearTimeout(timer);
      timer = undefined;
      await active?.catch(() => undefined);
    },
  };
}

function hidden(base: string, path: string, target: WatchTarget): boolean {
  if (!target.exclude || path === base) return false;
  const below = path.slice(base === '/' ? 1 : base.length + 1);
  return below.split('/').some((name) => excluded(name, target));
}

function inside(base: string, path: string): boolean {
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
}

type Watched = WatchTarget & { real: string };

export function mapChange(targets: readonly Watched[], path: string): string[] {
  const out: string[] = [];
  for (const target of targets) {
    if (inside(target.path, path)) {
      if (!hidden(target.path, path, target)) out.push(path);
    } else if (inside(path, target.path)) out.push(target.path);
    else if (target.real !== target.path && inside(target.real, path)) {
      const mapped = `${target.path}${path.slice(target.real.length)}`;
      if (!hidden(target.path, mapped, target)) out.push(mapped);
    }
  }
  return out;
}

type Handle = { close(): unknown };

export type NativeWatcher = FileWatcher & {
  blind: readonly WatchTarget[];
  recheck(paths: readonly string[]): void;
};

function codeOf(error: unknown): string {
  return String((Object(error) as { code?: unknown }).code);
}

async function realOf(fs: KernelFs, path: string): Promise<string> {
  let at = path;
  let rest = '';
  for (;;) {
    const real = await fs.realpath(at).catch(() => undefined);
    if (real !== undefined) return `${real === '/' && rest ? '' : real}${rest}`;
    if (at === '/') return path;
    rest = `/${basename(at)}${rest}`;
    at = dirname(at);
  }
}

const PEERS_PROBE = '/proc/sys/kernel/slicc_meta_transactions';
const peerKernels = new WeakMap<KernelClient, Promise<boolean>>();

async function probePeers(client: KernelClient): Promise<boolean> {
  const decoder = new TextDecoder();
  let text = '';
  const probe = await client.spawn(['cat', PEERS_PROBE], {
    onStdout: (bytes) => {
      text += decoder.decode(bytes, { stream: true });
    },
  });
  if ((await probe.exited) !== 0) return false;
  return (
    text
      .trim()
      .split(/\s+/)
      .map(Number)
      .reduce((sum, count) => sum + count, 0) > 0
  );
}

export function hearsPeers(client: KernelClient): Promise<boolean> {
  let known = peerKernels.get(client);
  if (!known) {
    known = probePeers(client).catch(() => false);
    peerKernels.set(client, known);
  }
  return known;
}

type Entry = Watched & { main: Handle | undefined; alias: Handle | undefined };

export async function nativeWatch(
  fs: KernelFs,
  cwd: string,
  targets: readonly WatchTarget[],
  onChange: (change: FileChange) => void
): Promise<NativeWatcher | undefined> {
  const watch = fs.watch?.bind(fs);
  if (!watch) return undefined;
  const entries: Entry[] = [];
  const dirty = new Set<Entry>();
  let settling = false;
  let settled = Promise.resolve();
  let open = true;
  const recheck = (paths: readonly string[] | undefined) => {
    if (!open) return;
    for (const entry of entries)
      if (!paths || paths.some((at) => inside(at, entry.path))) dirty.add(entry);
    if (dirty.size > 0) kick();
  };
  const report = (change: { paths: string[] } | { overflow: true }) => {
    if (!open) return;
    if (!('paths' in change)) {
      onChange({ kind: 'overflow' });
      recheck(undefined);
      return;
    }
    const paths = [...new Set(change.paths.flatMap((path) => mapChange(entries, path)))];
    if (paths.length) onChange({ kind: 'paths', paths });
    recheck(change.paths);
  };
  const opened = async (path: string, recursive: boolean) => {
    try {
      return await watch([path], { recursive }, report);
    } catch (error) {
      if (codeOf(error) !== 'ENOSYS' && !(await fs.exists(path).catch(() => false)))
        return undefined;
      throw error;
    }
  };
  const settle = async (entry: Entry) => {
    const recursive = entry.recursive === true;
    entry.main ??= await opened(entry.path, recursive);
    const real = await realOf(fs, entry.path);
    if (real === entry.real && (entry.alias || real === entry.path)) return;
    const was = entry.alias;
    entry.real = real;
    entry.alias = real === entry.path ? undefined : await opened(real, recursive);
    await was?.close();
  };
  const drain = async () => {
    try {
      while (open && dirty.size > 0) {
        const entry = dirty.values().next().value as Entry;
        dirty.delete(entry);
        await settle(entry).catch(() => undefined);
      }
    } finally {
      settling = false;
    }
  };
  const kick = () => {
    if (settling) return;
    settling = true;
    settled = drain();
  };
  const closeAll = async () => {
    open = false;
    for (const entry of entries.splice(0)) {
      await entry.main?.close();
      await entry.alias?.close();
    }
  };
  try {
    for (const target of targets) {
      const path = resolve(cwd, target.path);
      const entry: Entry = { ...target, path, real: path, main: undefined, alias: undefined };
      entries.push(entry);
      await settle(entry);
    }
  } catch (error) {
    await closeAll();
    if (codeOf(error) === 'ENOSYS') return undefined;
    throw error;
  }
  return {
    mode: 'native',
    blind: targets.filter((_, index) => !entries[index]?.main),
    recheck,
    async stop(_context: Context) {
      await closeAll();
      await settled;
    },
  };
}
