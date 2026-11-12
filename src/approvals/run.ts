import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  type ConversationId,
  defineExtension,
  defineTask,
  type Extension,
  type Harness,
  type NextTaskState,
  type TaskRuntime,
} from '@earendil-works/pi-durable';
import type { AgentsState } from '../agents.ts';
import { taggedTaints } from '../guests/tags.ts';
import type { KernelClient, SudoRunning } from '../kernel/client.ts';
import { tagsOf } from '../kernel/sightings.ts';
import type { LickEvent, Licks } from '../licks/licks.ts';
import {
  type Approval,
  ApprovalsDoc,
  type DecidedBy,
  runLive,
  type SudoApproval,
  type SudoRun,
} from './record.ts';
import { agentTarget, RUN_REASONS, type RunGates, runnable } from './runnable.ts';
import { shellWord } from './sudo.ts';

export const SUDO_RUN_TASK = 'slicc.sudo-run';
export const SUDO_RUNS = 'slicc-sudo-runs';
export const RUN_TAG = 'sudo-run:';
export const RUNS_DIR = '.slicc/sudo-runs';
export const TAIL_BYTES = 2048;
export const POLL_MS = 5000;
export const GRACE_MS = 1000;
export const KILL_MS = 5000;

export const RUN_ERRORS = {
  interrupted: 'interrupted before it started',
  reloaded: 'the page reloaded while it ran',
  idle: "This request isn't running.",
} as const;

export type RunKernel = Pick<KernelClient, 'fs' | 'spawn' | 'ps' | 'kill' | 'sudoRun' | 'trace'>;

export interface SudoRunHost {
  kernel: RunKernel;
  harness: Pick<Harness, 'commit' | 'snapshot'>;
  agents: { state(): Readonly<AgentsState> };
  licks?: Pick<Licks, 'deliver'>;
  boot: string | null;
  server: string;
  conversation: number;
  now?: () => number;
  pollMs?: number;
  killMs?: number;
}

export type RunAnswer = { done: true; error: null } | { done: false; error: string };

export type Runner = { by: DecidedBy; device?: string };

export interface SudoRuns {
  readonly extension: Extension;
  bind(host: SudoRunHost): void;
  claim(id: string, runner: Runner, gates: RunGates, context: Context): Promise<RunAnswer>;
  stop(id: string, runner: Runner, context: Context): Promise<RunAnswer>;
}

type Input = { approval: string };
type Phase =
  | { phase: 'prepare' }
  | { phase: 'call'; server: string; boot: string | null }
  | { phase: 'started'; pid: number; pgid: number; boot: string | null }
  | { phase: 'wait'; pid: number; pgid: number; boot: string | null }
  | { phase: 'ended' };
type Runtime = TaskRuntime<Input, Phase, null, object>;
type Next = NextTaskState<Phase, null>;
type Exit = { status?: number; signal?: string };

const DONE: Next = { status: 'terminal', outcome: { status: 'completed', result: null } };

const next = (checkpoint: Phase): Next => ({ status: 'running', checkpoint });

export const runTag = (id: string): string => `${RUN_TAG}${id}`;

const sudoIn = (items: readonly Approval[] | undefined, id: string) => {
  const item = items?.find((entry) => entry.id === id);
  return item?.kind === 'sudo' ? item : undefined;
};

async function itemOf(runtime: Runtime, id: string, context: Context) {
  return sudoIn((await runtime.snapshot(ApprovalsDoc, context))?.items, id);
}

type Claimed = SudoApproval & { replay: NonNullable<SudoApproval['replay']>; run: SudoRun };

async function claimed(runtime: Runtime, id: string, context: Context) {
  const item = await itemOf(runtime, id, context);
  if (item?.replay && item.run?.state === 'starting') return item as Claimed;
  await runtime.commit(async () => DONE, context);
  return undefined;
}

function edit(
  runtime: Runtime,
  id: string,
  change: (run: SudoRun, item: SudoApproval) => void,
  then: Next,
  context: Context
): Promise<void> {
  return runtime.commit(async (tx) => {
    const item = sudoIn((await tx.doc(ApprovalsDoc)).items, id);
    if (item?.run) change(item.run, item);
    return then;
  }, context);
}

const ended = (run: SudoRun, state: SudoRun['state'], at: number, error?: string) => {
  run.state = state;
  run.endedAt = at;
  if (error) run.error = error;
};

export function messageOf(error: unknown): string {
  if ((error as { code?: unknown })?.code === 'ENOSYS') return RUN_REASONS.kernel;
  const text = error instanceof Error ? error.message : String(error);
  return text.trim() || 'the kernel refused to run it';
}

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

async function uidOf(kernel: RunKernel, user: string): Promise<number | undefined> {
  const uid = Number((await passwdOf(kernel, user))?.[2] ?? (user === 'root' ? 0 : NaN));
  return Number.isInteger(uid) ? uid : undefined;
}

function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export async function outputOf(kernel: RunKernel, user: string, id: string, signal?: AbortSignal) {
  const home = await homeOf(kernel, user);
  const dir = `${home === '/' ? '' : home}/${RUNS_DIR}`;
  const made = await kernel.spawn(['mkdir', '-p', dir], { user, cwd: '/' });
  const code = await Promise.race([made.exited, aborted(signal)]);
  if (code !== 0) throw new Error(`can't create ${dir} as ${user}`);
  return { stdout: `${dir}/${id}.out`, stderr: `${dir}/${id}.err` };
}

type Watcher = { waitFor(pid: number): Promise<Exit>; close(): void };

async function watchExits(kernel: RunKernel, tag: string): Promise<Watcher> {
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

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

async function alive(kernel: RunKernel, pid: number): Promise<boolean> {
  const rows = await kernel.ps?.().catch(() => undefined);
  return !rows || rows.some((row) => row.pid === pid && row.state !== 'Z');
}

async function gone(kernel: RunKernel, pid: number, ms: number, signal: AbortSignal) {
  while (await alive(kernel, pid)) await sleep(ms, signal);
  await sleep(GRACE_MS, signal);
  return {} as Exit;
}

const decoder = () => new TextDecoder('utf-8', { fatal: false });

export const READ_MS = 5000;

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

async function plain(kernel: RunKernel, path: string): Promise<boolean> {
  const [file, dir] = await Promise.all([kernel.fs.lstat(path), kernel.fs.lstat(parentOf(path))]);
  return file.isFile && !file.isSymbolicLink && dir.isDirectory && !dir.isSymbolicLink;
}

async function readAs(
  kernel: RunKernel,
  user: string,
  path: string,
  ms: number
): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  const tail = await kernel.spawn(['tail', '-c', String(TAIL_BYTES + 1), path], {
    user,
    cwd: '/',
    onStdout: (chunk) => parts.push(chunk.slice()),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      void Promise.resolve(tail.signal('SIGKILL')).catch(() => undefined);
      resolve(null);
    }, ms);
  });
  const code = await Promise.race([tail.exited, late]).finally(() => clearTimeout(timer));
  if (code !== 0) return null;
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

export async function tailOf(
  kernel: RunKernel,
  user: string | undefined,
  path: string | undefined,
  ms = READ_MS
): Promise<string | null> {
  if (!user || !path?.startsWith('/')) return null;
  try {
    if (!(await plain(kernel, path))) return null;
    const bytes = await readAs(kernel, user, path, ms);
    if (!bytes) return null;
    const cut = bytes.length > TAIL_BYTES;
    const text = decoder()
      .decode(cut ? bytes.slice(-TAIL_BYTES) : bytes)
      .replace(/^\uFFFD+/, '');
    return cut ? `…${text}` : text;
  } catch {
    return null;
  }
}

function typed(item: SudoApproval): string {
  return (item.replay?.argv ?? [])
    .map((word) => shellWord(String(word)))
    .join(' ')
    .trim();
}

function where(item: SudoApproval): string {
  const { command, target, cwd } = item.detail;
  return `${command} as ${target ?? 'root'}${cwd ? ` in ${cwd}` : ''}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function clock(at: number, now: number): string {
  const when = new Date(at);
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (when.toDateString() === new Date(now).toDateString()) return time;
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function outcome(run: SudoRun): { text: string; sentence: string; ok: boolean } {
  if (run.state === 'failed')
    return { text: run.error ?? 'failed', sentence: `didn't finish: ${run.error}`, ok: false };
  const signal = run.signal ? ` (${run.signal})` : '';
  if (run.state === 'stopped')
    return {
      text: 'stopped by the owner',
      sentence: `was stopped by the owner${signal}`,
      ok: false,
    };
  if (run.status === undefined)
    return {
      text: 'status unknown',
      sentence: 'ended while the agent was away, so its exit status is unknown',
      ok: false,
    };
  if (run.signal)
    return {
      text: `killed by ${run.signal}`,
      sentence: `was killed by ${run.signal} (status ${run.status})`,
      ok: false,
    };
  return {
    text: `exit ${run.status}`,
    sentence: `exited with status ${run.status}`,
    ok: run.status === 0,
  };
}

async function lickBase(host: SudoRunHost, item: SudoApproval) {
  const replay = item.replay;
  const tags = [...(replay?.tag ? [replay.tag] : []), ...(replay?.tags ?? [])];
  const taints = await taggedTaints(host.harness, tags, BACKGROUND_CONTEXT);
  return {
    channel: 'sudo-run' as const,
    source: item.id,
    target: agentTarget(host.agents.state(), item.requester.agentId as string),
    coalesce: false,
    ...(taints.length ? { taints } : {}),
  };
}

export async function startLick(host: SudoRunHost, item: SudoApproval): Promise<LickEvent> {
  const run = item.run as SudoRun;
  const now = host.now?.() ?? Date.now();
  return {
    ...(await lickBase(host, item)),
    eventId: `${item.id}:start`,
    title: `sudo runs now: ${typed(item)}`,
    text: '[the owner ran your timed-out sudo request]',
    body: [
      `Your sudo request from ${clock(item.createdAt, now)} (${where(item)}) timed out.`,
      `The owner ran it at ${clock(run.at, now)} with Run now. It runs in the background (pid ${run.pid}), with no terminal and no input.`,
      `Its result follows as another sudo-run lick. Output: ${run.stdout} (.err)`,
    ].join('\n'),
  };
}

export async function endLick(host: SudoRunHost, item: SudoApproval): Promise<LickEvent> {
  const run = item.run as SudoRun;
  const ran = outcome(run);
  const took = run.endedAt !== undefined ? ` after ${duration(run.endedAt - run.at)}` : '';
  const user = item.replay?.user;
  const [stdout, stderr] = await Promise.all([
    tailOf(host.kernel, user, run.stdout),
    tailOf(host.kernel, user, run.stderr),
  ]);
  const shown = (name: string, text: string | null) =>
    text === null
      ? [`${name}: output unavailable`]
      : text
        ? [`${name} (last 2 KiB):`, text]
        : [`${name}: empty`];
  return {
    ...(await lickBase(host, item)),
    eventId: `${item.id}:end`,
    title: `sudo run ended: ${typed(item)}`,
    text: `[your late sudo run ended: ${ran.text}]`,
    body: [
      `${where(item)} ${ran.sentence}${took}.`,
      ...shown('stdout', stdout),
      ...shown('stderr', stderr),
      `Full output: ${run.stdout} and ${run.stderr}`,
    ].join('\n'),
    ...(ran.ok ? {} : { severity: 'warn' as const }),
  };
}

async function tell(host: SudoRunHost, made: Promise<LickEvent>) {
  const event = await made.catch(() => undefined);
  if (event) await host.licks?.deliver(event, BACKGROUND_CONTEXT).catch(() => undefined);
}

export async function leads(kernel: RunKernel, tag: string, pgid: number): Promise<boolean> {
  const rows = await kernel.ps?.().catch(() => undefined);
  return !!rows?.some((row) => row.pid === pgid && row.state !== 'Z' && tagsOf(row).includes(tag));
}

function killer(host: SudoRunHost, tag: string) {
  return async (pgid: number) => {
    if (!(await leads(host.kernel, tag, pgid))) return;
    await host.kernel.kill?.(-pgid, 'SIGTERM').catch(() => undefined);
    setTimeout(() => {
      void leads(host.kernel, tag, pgid).then((up) =>
        up ? host.kernel.kill?.(-pgid, 'SIGKILL').catch(() => undefined) : undefined
      );
    }, host.killMs ?? KILL_MS);
  };
}

type Lookup = () => Promise<SudoRunHost>;

const nowOf = (host: SudoRunHost) => host.now?.() ?? Date.now();

function memory() {
  const calling = new Set<string>();
  const ends = new Map<string, SudoRunning['ended']>();
  const watchers = new Map<string, Promise<Watcher>>();
  return {
    calling,
    ends,
    watcher(host: SudoRunHost, id: string) {
      const found = watchers.get(id) ?? watchExits(host.kernel, runTag(id));
      watchers.set(id, found);
      return found;
    },
    async release(id: string) {
      const found = watchers.get(id);
      watchers.delete(id);
      ends.delete(id);
      calling.delete(id);
      (await found)?.close();
    },
  };
}

type Memory = ReturnType<typeof memory>;

function starting(lookup: Lookup, mem: Memory) {
  const { calling, ends, watcher, release } = mem;
  const now = nowOf;

  async function prepare(id: string, runtime: Runtime, context: Context) {
    const host = await lookup();
    const item = await claimed(runtime, id, context);
    if (!item) return;
    const place = await outputOf(host.kernel, item.replay.user, id, context.abortSignal).catch(
      (error: unknown) => {
        if (context.abortSignal?.aborted) throw error;
        return messageOf(error);
      }
    );
    if (typeof place === 'string')
      return edit(runtime, id, (kept) => ended(kept, 'failed', now(host), place), DONE, context);
    return edit(
      runtime,
      id,
      (kept) => Object.assign(kept, place),
      next({ phase: 'call', server: host.server, boot: host.boot }),
      context
    );
  }

  async function adopt(id: string, boot: string | null, runtime: Runtime, context: Context) {
    const host = await lookup();
    const item = await itemOf(runtime, id, context);
    const uid = await uidOf(host.kernel, item?.replay?.target ?? 'root');
    const rows = (await host.kernel.ps?.().catch(() => undefined)) ?? [];
    const mine = rows
      .filter(
        (row) =>
          row.state !== 'Z' &&
          uid !== undefined &&
          row.uid === uid &&
          tagsOf(row).includes(runTag(id))
      )
      .sort((a, b) => a.pid - b.pid);
    const lead = mine.find((row) => row.pid === row.pgid) ?? mine[0];
    if (!lead)
      return edit(
        runtime,
        id,
        (kept) => ended(kept, 'failed', now(host), RUN_ERRORS.interrupted),
        DONE,
        context
      );
    const pgid = lead.pgid ?? lead.pid;
    return edit(
      runtime,
      id,
      (kept) => Object.assign(kept, { state: 'running', pid: lead.pid, pgid }),
      next({ phase: 'started', pid: lead.pid, pgid, boot }),
      context
    );
  }

  async function call(
    id: string,
    at: { server: string; boot: string | null },
    runtime: Runtime,
    context: Context
  ) {
    const host = await lookup();
    if (at.server !== host.server || calling.has(id)) return adopt(id, at.boot, runtime, context);
    calling.add(id);
    const item = await claimed(runtime, id, context);
    if (!item) return;
    const { run } = item;
    if (run.stopBy)
      return edit(runtime, id, (kept) => ended(kept, 'stopped', now(host)), DONE, context);
    await watcher(host, id);
    let started: SudoRunning;
    try {
      if (!host.kernel.sudoRun)
        throw Object.assign(new Error(RUN_REASONS.kernel), { code: 'ENOSYS' });
      const asked = host.kernel.sudoRun(item.replay, {
        stdout: run.stdout as string,
        stderr: run.stderr as string,
        tag: runTag(id),
      });
      started = await Promise.race([asked, aborted(context.abortSignal)]);
    } catch (error) {
      await release(id);
      if (context.abortSignal?.aborted) throw error;
      const why = messageOf(error);
      return edit(runtime, id, (kept) => ended(kept, 'failed', now(host), why), DONE, context);
    }
    ends.set(id, started.ended);
    started.ended.catch(() => undefined);
    const { pid, pgid } = started;
    return edit(
      runtime,
      id,
      (kept) => Object.assign(kept, { state: 'running', pid, pgid }),
      next({ phase: 'started', pid, pgid, boot: at.boot }),
      context
    );
  }

  async function begun(
    id: string,
    at: { pid: number; pgid: number; boot: string | null },
    runtime: Runtime,
    context: Context
  ) {
    const host = await lookup();
    const item = await itemOf(runtime, id, context);
    if (item?.run) {
      await tell(host, startLick(host, item));
      if (item.run.stopBy) await killer(host, runTag(id))(at.pgid);
    }
    const { pid, pgid, boot } = at;
    await runtime.commit(async () => next({ phase: 'wait', pid, pgid, boot }), context);
  }

  return { prepare, call, begun };
}

function finishing(lookup: Lookup, mem: Memory) {
  const { ends, watcher, release } = mem;
  const now = nowOf;

  async function exitOf(host: SudoRunHost, id: string, pid: number, context: Context) {
    const seen = await watcher(host, id);
    const end = ends.get(id)?.then(
      (exit) => ({ status: exit.status, ...(exit.signal ? { signal: exit.signal } : {}) }),
      () => new Promise<Exit>(() => undefined)
    );
    const polling = new AbortController();
    const signal = context.abortSignal;
    const quit = () => polling.abort(signal?.reason);
    signal?.addEventListener('abort', quit, { once: true });
    if (signal?.aborted) quit();
    try {
      return await Promise.race([
        seen.waitFor(pid),
        ...(end ? [end] : []),
        gone(host.kernel, pid, host.pollMs ?? POLL_MS, polling.signal),
      ]);
    } finally {
      signal?.removeEventListener('abort', quit);
      polling.abort();
    }
  }

  async function wait(
    id: string,
    at: { pid: number; boot: string | null },
    runtime: Runtime,
    context: Context
  ) {
    const host = await lookup();
    if (at.boot !== host.boot) {
      await release(id);
      return edit(
        runtime,
        id,
        (kept) => ended(kept, 'failed', now(host), RUN_ERRORS.reloaded),
        next({ phase: 'ended' }),
        context
      );
    }
    try {
      const exit = await exitOf(host, id, at.pid, context);
      await edit(
        runtime,
        id,
        (kept) => {
          ended(kept, kept.stopBy ? 'stopped' : 'done', now(host));
          if (exit.status !== undefined) kept.status = exit.status;
          if (exit.signal) kept.signal = exit.signal;
        },
        next({ phase: 'ended' }),
        context
      );
    } finally {
      await release(id);
    }
  }

  async function report(id: string, runtime: Runtime, context: Context) {
    const host = await lookup();
    const item = await itemOf(runtime, id, context);
    if (item?.run) await tell(host, endLick(host, item));
    await runtime.commit(async () => DONE, context);
  }

  async function abort(id: string, runtime: Runtime, context: Context) {
    const host = await lookup();
    const item = await itemOf(runtime, id, context);
    const pgid = item?.run?.pgid;
    if (item && runLive(item) && pgid) await killer(host, runTag(id))(pgid);
    await release(id);
    await runtime.commit(async (tx) => {
      const kept = sudoIn((await tx.doc(ApprovalsDoc)).items, id);
      if (kept?.run && runLive(kept)) ended(kept.run, 'stopped', now(host));
      return { status: 'terminal', outcome: { status: 'aborted' } };
    }, context);
    const after = await itemOf(runtime, id, context);
    if (after?.run?.pid) await tell(host, endLick(host, after));
  }

  return { wait, report, abort };
}

function phases(lookup: Lookup) {
  const mem = memory();
  return { ...starting(lookup, mem), ...finishing(lookup, mem) };
}

export function sudoRuns(): SudoRuns {
  let bind: (host: SudoRunHost) => void = () => undefined;
  let held: SudoRunHost | undefined;
  const bound = new Promise<SudoRunHost>((resolve) => {
    bind = (host) => {
      held = host;
      resolve(host);
    };
  });
  const run = phases(() => bound);
  const task = defineTask<Input, Phase, null>({
    name: SUDO_RUN_TASK,
    version: 1,
    initial: () => ({ phase: 'prepare' }),
    phases: {
      prepare: (task, runtime, context) => run.prepare(task.input.approval, runtime, context),
      call: (task, runtime, context) =>
        run.call(task.input.approval, task.state.checkpoint, runtime, context),
      started: (task, runtime, context) =>
        run.begun(task.input.approval, task.state.checkpoint, runtime, context),
      wait: (task, runtime, context) =>
        run.wait(task.input.approval, task.state.checkpoint, runtime, context),
      ended: (task, runtime, context) => run.report(task.input.approval, runtime, context),
    },
    abort: (task, runtime, context) => run.abort(task.input.approval, runtime, context),
  });
  return {
    extension: defineExtension({ name: SUDO_RUNS, tasks: [task] }),
    bind: (host) => bind(host),
    async claim(id, runner, gates, context) {
      const host = held;
      if (!host) return { done: false, error: RUN_REASONS.kernel };
      const at = host.now?.() ?? Date.now();
      return host.harness.commit(async (tx): Promise<RunAnswer> => {
        const item = (await tx.doc(ApprovalsDoc)).items.find((entry) => entry.id === id);
        if (!item) return { done: false, error: `There is no approval ${id}.` };
        const able = runnable(item, at, gates);
        if (able !== true) return { done: false, error: able.reason };
        (item as SudoApproval).run = {
          state: 'starting',
          by: runner.by,
          ...(runner.device ? { device: runner.device } : {}),
          at,
        };
        await tx.createTask(
          task,
          { approval: id },
          {
            ownership: { kind: 'conversation' },
            conversationId: host.conversation as ConversationId,
            background: true,
          }
        );
        return { done: true, error: null };
      }, context);
    },
    async stop(id, runner, context) {
      const host = held;
      if (!host) return { done: false, error: RUN_ERRORS.idle };
      const pgid = await host.harness.commit(async (tx) => {
        const item = sudoIn((await tx.doc(ApprovalsDoc)).items, id);
        if (!item?.run || !runLive(item)) return null;
        item.run.stopBy = runner.by;
        return item.run.pgid ?? 0;
      }, context);
      if (pgid === null) return { done: false, error: RUN_ERRORS.idle };
      if (pgid) await killer(host, runTag(id))(pgid);
      return { done: true, error: null };
    },
  };
}
