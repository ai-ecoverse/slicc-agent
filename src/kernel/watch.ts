import type { Context } from '@earendil-works/chord';
import type { FileWatcher, WatchChange, WatchTarget } from '@earendil-works/pi-durable/env';
import type { KernelFs } from './client.ts';
import { dirname, resolve } from './paths.ts';

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
  mode?: 'native' | 'polling';
}

export const RESCAN_MS = 2000;

function baseOf(path: string, target: WatchTarget): string | undefined {
  if (inside(path, target.path)) return target.path;
  return inside(target.path, path) ? path : undefined;
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
      for (const key of [...current.keys()]) if (inside(base, key)) current.delete(key);
      await scan(fs, base, target, base === target.path || target.recursive === true, current);
    }
}

export type PolledWatcher = FileWatcher & { absorb(paths: readonly string[]): void };

export async function pollWatch(
  fs: KernelFs,
  cwd: string,
  targets: readonly WatchTarget[],
  onChange: (change: WatchChange) => void,
  options: PollOptions = {}
): Promise<PolledWatcher> {
  let current = await snapshot(fs, cwd, targets);
  const resolved = targets.map((target) => ({ ...target, path: resolve(cwd, target.path) }));
  const refresh = (paths: readonly string[]) => absorbPaths(fs, current, resolved, paths);
  let open = true;
  let running = Promise.resolve();
  const tick = async () => {
    const next = await snapshot(fs, cwd, targets);
    const paths = differences(current, next);
    current = next;
    if (open && paths.length > 0) onChange({ paths });
  };
  const timer = setInterval(() => {
    running = running.then(tick);
  }, options.intervalMs ?? 100);
  return {
    mode: 'polling',
    absorb(paths) {
      running = running.then(() => refresh(paths));
    },
    async close(_context: Context) {
      open = false;
      clearInterval(timer);
      await running;
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

const FALLBACK = new Set(['ENOSYS', 'ENOENT', 'ENOTDIR']);

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

export async function nativeWatch(
  fs: KernelFs,
  cwd: string,
  targets: readonly WatchTarget[],
  onChange: (change: WatchChange) => void
): Promise<FileWatcher | undefined> {
  const watch = fs.watch?.bind(fs);
  if (!watch) return undefined;
  const resolved: Watched[] = [];
  for (const target of targets) {
    const path = resolve(cwd, target.path);
    if (!(await fs.exists(path).catch(() => false))) return undefined;
    resolved.push({ ...target, path, real: await fs.realpath(path).catch(() => path) });
  }
  let open = true;
  const handles: { close(): unknown }[] = [];
  const closeAll = async () => {
    for (const handle of handles.splice(0)) await handle.close();
  };
  const report = (change: { paths: string[] } | { overflow: true }) => {
    if (!open) return;
    if (!('paths' in change)) {
      onChange({ overflow: true });
      return;
    }
    const paths = [...new Set(change.paths.flatMap((path) => mapChange(resolved, path)))];
    if (paths.length) onChange({ paths });
  };
  try {
    for (const target of resolved) {
      const recursive = { recursive: target.recursive === true };
      handles.push(await watch([target.path], recursive, report));
      if (target.real !== target.path) handles.push(await watch([target.real], recursive, report));
    }
  } catch (error) {
    await closeAll();
    if (FALLBACK.has((error as { code?: string }).code ?? '')) return undefined;
    throw error;
  }
  return {
    mode: 'native',
    async close(_context: Context) {
      open = false;
      await closeAll();
    },
  };
}
