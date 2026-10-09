import { type Context, type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import type { Agents } from '../agents.ts';
import { HOME } from '../kernel/env.ts';
import {
  type ChangesView,
  type FileChange,
  failure,
  joined,
  MAX_FILES,
  NO_GIT,
  NO_REPO,
  type Pending,
  parseStatus,
  relative,
  run,
  SCAN_DEPTH,
  SCAN_ENTRIES,
  scanned,
  shown,
  textOf,
  within,
} from './git.ts';

export interface ChangesRuntime {
  readonly view: MutableReplicatedState<ChangesView>;
  open(context: Context): Promise<void>;
  accept(path: string, context: Context): Promise<void>;
  revert(path: string, context: Context): Promise<void>;
  refresh(context: Context): Promise<void>;
  close(context: Context): Promise<void>;
}

export const CHANGES_MS = 500;

export interface ChangesOptions {
  env: ExecutionEnv;
  agents: Agents;
  reloadMs: number;
}

const WATCHED = [HOME, '/mnt', '/scoops'];
const EXCLUDED = ['/tmp', '/var/lib/slicc'];

type Env = ChangesOptions['env'];

async function walk(env: Env, dir: string, depth: number, out: Set<string>, context: Context) {
  const listed = await env.listDir(dir, context);
  if (!listed.ok) return;
  if (listed.value.some((entry) => entry.name === '.git')) {
    out.add(dir);
    return;
  }
  if (depth >= SCAN_DEPTH) return;
  const dirs = listed.value
    .filter((entry) => entry.kind === 'directory' && scanned(entry.name))
    .slice(0, SCAN_ENTRIES);
  for (const entry of dirs) await walk(env, entry.path, depth + 1, out, context);
}

async function cwds(agents: Agents, context: Context): Promise<string[]> {
  const state = agents.state();
  const ids = [
    state.active,
    ...Object.keys(state.cones).filter((id) => id !== state.active),
    ...Object.entries(state.scoops)
      .filter(([, scoop]) => !scoop.gone && !scoop.dropped && !scoop.frozen)
      .map(([id]) => id),
  ];
  const out: string[] = [];
  for (const id of ids) {
    const conversation = await agents.conversation(id, context);
    if (conversation) out.push((await conversation.agent(context)).cwd ?? HOME);
  }
  return out;
}

async function discover(options: ChangesOptions, context: Context): Promise<string[]> {
  const { env } = options;
  const found: string[] = [];
  for (const cwd of await cwds(options.agents, context)) {
    const top = await run(env, ['git', 'rev-parse', '--show-toplevel'], cwd, context);
    if (top.code === 0 && top.out.trim()) found.push(top.out.trim());
  }
  const walked = new Set<string>();
  await walk(env, HOME, 0, walked, context);
  const mounts = await env.listDir('/mnt', context);
  if (mounts.ok)
    for (const mount of mounts.value)
      if (mount.kind === 'directory') await walk(env, mount.path, 0, walked, context);
  const ordered = [...found, ...[...walked].sort()];
  return [...new Set(ordered)].filter(
    (root) => !EXCLUDED.some((excluded) => within(root, excluded))
  );
}

async function sideOf(env: Env, repo: string, pending: Pending, context: Context) {
  const path = joined(repo, pending.path);
  const before =
    pending.status === 'added'
      ? null
      : await run(env, ['git', 'show', `:${pending.path}`], repo, context).then((ran) =>
          ran.code === 0 ? shown(ran.out) : null
        );
  const read = pending.status === 'deleted' ? null : await env.readBinaryFile(path, context);
  const after = read?.ok ? textOf(read.value) : null;
  const opaque =
    (pending.status !== 'added' && before === null) ||
    (pending.status !== 'deleted' && after === null);
  return { path, before: opaque ? null : before, after: opaque ? null : after };
}

async function statusOf(env: Env, repo: string, context: Context): Promise<FileChange[] | null> {
  const ran = await run(
    env,
    [
      'git',
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ],
    repo,
    context
  );
  if (ran.code !== 0) return null;
  const out: FileChange[] = [];
  for (const pending of parseStatus(ran.out).slice(0, MAX_FILES)) {
    const side = await sideOf(env, repo, pending, context);
    out.push({ ...side, repo, status: pending.status, kind: pending.kind });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const STATE = ['index', 'HEAD', 'refs'];

function noise(path: string, repos: readonly string[]): boolean {
  return repos.some((repo) => {
    const git = joined(repo, '.git');
    return (
      within(path, git) &&
      path !== git &&
      !STATE.includes(relative(path, git).split('/')[0] as string)
    );
  });
}

function rediscovers(paths: readonly string[], repos: readonly string[]): boolean {
  return paths.some((path) => {
    const parts = path.split('/');
    const git = parts.indexOf('.git');
    if (git > 0) return !repos.includes(parts.slice(0, git).join('/') || '/');
    if (parts.some((part) => part && !scanned(part))) return false;
    return !repos.some((repo) => within(path, repo));
  });
}

export function attachChanges(options: ChangesOptions): ChangesRuntime {
  const { env } = options;
  const view = replicatedState<ChangesView>({ unavailable: null, changes: [] });
  let repos: string[] | null = null;
  let opened: Promise<void> | null = null;
  let watcher: FileWatcher | undefined;
  let stop = () => undefined as void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = lock.then(work, work);
    lock = next.catch(() => undefined);
    return next;
  };
  const scan = async (context: Context) => {
    const git = await run(env, 'command -v git', HOME, context);
    if (git.code !== 0) {
      view.replace(context, { unavailable: NO_GIT, changes: [] });
      return;
    }
    repos ??= await discover(options, context);
    const changes: FileChange[] = [];
    const live: string[] = [];
    for (const repo of repos) {
      const found = await statusOf(env, repo, context);
      if (!found) {
        const still = await env.exists(joined(repo, '.git'), context);
        if (!still.ok || !still.value) continue;
      }
      live.push(repo);
      changes.push(...(found ?? view.value.changes.filter((change) => change.repo === repo)));
    }
    repos = live;
    view.replace(context, { unavailable: live.length ? null : NO_REPO, changes });
  };
  const refresh = (context: Context) => serial(() => scan(context));
  let running = false;
  let again = false;
  const kick = async (context: Context) => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      await refresh(context).catch(() => undefined);
    } while (again);
    running = false;
  };
  const later = (context: Context) => {
    clearTimeout(timer);
    timer = setTimeout(() => void kick(context), options.reloadMs);
  };
  const change = (path: string, context: Context, act: (found: FileChange) => Promise<void>) =>
    serial(async () => {
      await scan(context);
      const found = view.value.changes.find((item) => item.path === path);
      if (!found) throw new Error(`${path} has no pending change`);
      await act(found);
      await scan(context);
    });
  const start = async (context: Context) => {
    await refresh(context);
    const watched = await env.watch(
      WATCHED.map((path) => ({ path, recursive: true, exclude: { names: ['node_modules'] } })),
      (change) => {
        const known = repos ?? [];
        const paths = 'paths' in change ? change.paths.filter((path) => !noise(path, known)) : null;
        if (paths?.length === 0) return;
        if (!paths || rediscovers(paths, known)) repos = null;
        later(context);
      },
      context
    );
    watcher = watched.ok ? watched.value : undefined;
    stop = options.agents.onChange(() => {
      repos = null;
      later(context);
    });
  };
  return {
    view,
    open(context) {
      opened ??= start(context);
      return opened;
    },
    accept: (path, context) =>
      change(path, context, async (found) => {
        const rel = relative(found.path, found.repo);
        const ran = await run(env, ['git', 'add', '-A', '--', rel], found.repo, context);
        if (ran.code !== 0) throw failure(ran, `git add ${rel}`);
      }),
    revert: (path, context) =>
      change(path, context, async (found) => {
        const rel = relative(found.path, found.repo);
        if (found.kind === 'conflict')
          throw new Error(`${found.path} has a merge conflict; resolve it with git first.`);
        if (found.kind === 'untracked') {
          const removed = await env.remove(found.path, { force: true }, context);
          if (!removed.ok) throw removed.error;
        } else {
          const ran = await run(env, ['git', 'restore', '--', rel], found.repo, context);
          if (ran.code !== 0) throw failure(ran, `git restore ${rel}`);
        }
      }),
    refresh,
    async close(context) {
      clearTimeout(timer);
      stop();
      await watcher?.close(context);
    },
  };
}
