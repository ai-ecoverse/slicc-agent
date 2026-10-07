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
}

export async function pollWatch(
  fs: KernelFs,
  cwd: string,
  targets: readonly WatchTarget[],
  onChange: (change: WatchChange) => void,
  options: PollOptions = {}
): Promise<FileWatcher> {
  let current = await snapshot(fs, cwd, targets);
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
    async close(_context: Context) {
      open = false;
      clearInterval(timer);
      await running;
    },
  };
}
