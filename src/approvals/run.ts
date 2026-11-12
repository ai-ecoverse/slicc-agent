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
import type { SudoRunning } from '../kernel/client.ts';
import type { LickEvent, Licks } from '../licks/licks.ts';
import {
  type Approval,
  ApprovalsDoc,
  type DecidedBy,
  MAX_DELAY,
  runLive,
  type SudoApproval,
  type SudoRun,
} from './record.ts';
import { endLick, KEEP_HOURS, MIB, startLick } from './run-licks.ts';
import {
  aborted,
  adoptable,
  type Exit,
  gone,
  outputOf,
  outputSize,
  type RunKernel,
  removeOutput,
  runTag,
  signalTree,
  sleep,
  tagged,
  type Watcher,
  watchExits,
} from './run-procs.ts';
import { RUN_REASONS, type RunGates, runnable } from './runnable.ts';

export { clock, duration, endLick, startLick } from './run-licks.ts';
export { outputOf, RUN_TAG, RUNS_DIR, type RunKernel, runTag } from './run-procs.ts';

export const SUDO_RUN_TASK = 'slicc.sudo-run';
export const SUDO_RUNS = 'slicc-sudo-runs';
export const POLL_MS = 5000;
export const KILL_MS = 5000;
export const ADOPT_MS = 250;
export const ADOPT_TRIES = 5;
export const OUTPUT_CAP = 32 * MIB;
export const KEEP_MS = KEEP_HOURS * 3_600_000;

export const RUN_ERRORS = {
  interrupted: 'interrupted before it started',
  reloaded: 'the page reloaded while it ran',
  idle: "This request isn't running.",
  gone: 'Its processes are already gone.',
  unseen: "The kernel's process list isn't available, so it can't be stopped.",
} as const;

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
  adoptMs?: number;
  outputCap?: number;
  keepMs?: number;
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
  | { phase: 'ended' }
  | { phase: 'linger' };
type Runtime = TaskRuntime<Input, Phase, null, object>;
type Next = NextTaskState<Phase, null>;

const DONE: Next = { status: 'terminal', outcome: { status: 'completed', result: null } };

const next = (checkpoint: Phase): Next => ({ status: 'running', checkpoint });

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
  then: Next | undefined,
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

async function tell(host: SudoRunHost, made: Promise<LickEvent>) {
  const event = await made.catch(() => undefined);
  if (event) await host.licks?.deliver(event, BACKGROUND_CONTEXT).catch(() => undefined);
}

const stopTree = (host: SudoRunHost, id: string) =>
  signalTree(host.kernel, runTag(id), host.killMs ?? KILL_MS);

type Lookup = () => Promise<SudoRunHost>;

const nowOf = (host: SudoRunHost) => host.now?.() ?? Date.now();

const knownBoots = (a: string | null, b: string | null) => a !== null && b !== null;

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
    const target = item?.replay?.target ?? 'root';
    let lead = await adoptable(host.kernel, runTag(id), target);
    for (let attempt = 0; !lead && attempt < ADOPT_TRIES - 1; attempt++) {
      await sleep((host.adoptMs ?? ADOPT_MS) * 2 ** attempt, context.abortSignal);
      lead = await adoptable(host.kernel, runTag(id), target);
    }
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
      if (item.run.stopBy) await stopTree(host, id);
    }
    const { pid, pgid, boot } = at;
    await runtime.commit(async () => next({ phase: 'wait', pid, pgid, boot }), context);
  }

  return { prepare, call, begun };
}

function watchdog(host: SudoRunHost, id: string, paths: string[], signal: AbortSignal) {
  const cap = host.outputCap ?? OUTPUT_CAP;
  return (async () => {
    for (;;) {
      await sleep(host.pollMs ?? POLL_MS, signal);
      if ((await outputSize(host.kernel, paths)) <= cap) continue;
      await stopTree(host, id);
      return cap;
    }
  })().catch(() => undefined);
}

function finishing(lookup: Lookup, mem: Memory, swept: (host: SudoRunHost) => void) {
  const { ends, watcher, release } = mem;
  const now = nowOf;

  async function exitOf(
    host: SudoRunHost,
    id: string,
    pid: number,
    paths: string[],
    context: Context
  ) {
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
    const capped = watchdog(host, id, paths, polling.signal);
    try {
      const exit = await Promise.race([
        seen.waitFor(pid),
        ...(end ? [end] : []),
        gone(host.kernel, pid, host.pollMs ?? POLL_MS, polling.signal),
      ]);
      polling.abort();
      return { exit, cap: await capped };
    } finally {
      signal?.removeEventListener('abort', quit);
      polling.abort();
    }
  }

  async function wait(
    id: string,
    at: { pid: number; pgid: number; boot: string | null },
    runtime: Runtime,
    context: Context
  ) {
    const host = await lookup();
    if (knownBoots(at.boot, host.boot) && at.boot !== host.boot) {
      const left = await tagged(host.kernel, runTag(id));
      if (left?.length)
        return runtime.commit(async () => next({ ...at, phase: 'wait', boot: host.boot }), context);
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
      const item = await itemOf(runtime, id, context);
      const paths = [item?.run?.stdout, item?.run?.stderr].filter((path): path is string => !!path);
      const { exit, cap } = await exitOf(host, id, at.pid, paths, context);
      const left = ((await tagged(host.kernel, runTag(id))) ?? [])
        .map((row) => row.pid)
        .filter((pid) => pid !== at.pid);
      await edit(
        runtime,
        id,
        (kept) => {
          ended(kept, kept.stopBy || cap ? 'stopped' : 'done', now(host));
          if (exit.status !== undefined) kept.status = exit.status;
          if (exit.signal) kept.signal = exit.signal;
          if (cap) kept.capped = cap;
          if (left.length) kept.survivors = left;
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
    const lingering = !!item?.run?.survivors?.length;
    await runtime.commit(async () => (lingering ? next({ phase: 'linger' }) : DONE), context);
    if (!lingering) swept(host);
  }

  async function abort(id: string, runtime: Runtime, context: Context) {
    const host = await lookup();
    const item = await itemOf(runtime, id, context);
    if (item && (runLive(item) || item.run?.survivors?.length)) await stopTree(host, id);
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

async function linger(
  lookup: Lookup,
  swept: (host: SudoRunHost) => void,
  id: string,
  runtime: Runtime,
  context: Context
) {
  const host = await lookup();
  const item = await itemOf(runtime, id, context);
  let shown = (item?.run?.survivors ?? []).join(',');
  for (;;) {
    await sleep(host.pollMs ?? POLL_MS, context.abortSignal);
    const rows = await tagged(host.kernel, runTag(id));
    if (!rows) continue;
    const pids = rows.map((row) => row.pid);
    if (pids.join(',') === shown) continue;
    shown = pids.join(',');
    const done = !pids.length;
    await edit(
      runtime,
      id,
      (kept) => {
        if (done) delete kept.survivors;
        else kept.survivors = pids;
      },
      done ? DONE : undefined,
      context
    );
    if (!done) continue;
    swept(host);
    return;
  }
}

function sweeper() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sweep = async (host: SudoRunHost) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const keep = host.keepMs ?? KEEP_MS;
    const at = nowOf(host);
    const items = (await host.harness.snapshot(ApprovalsDoc, BACKGROUND_CONTEXT))?.items ?? [];
    const kept = items.filter(
      (item): item is SudoApproval & { run: SudoRun } =>
        item.kind === 'sudo' &&
        !!item.run?.stdout &&
        !item.run.removed &&
        item.run.endedAt !== undefined &&
        !runLive(item) &&
        !item.run.survivors?.length
    );
    const due = kept.filter((item) => at - (item.run.endedAt as number) >= keep);
    for (const item of due) {
      const paths = [item.run.stdout, item.run.stderr].filter((path): path is string => !!path);
      const user = item.replay?.user;
      if (user) await removeOutput(host.kernel, user, paths);
    }
    if (due.length)
      await host.harness.commit(async (tx) => {
        for (const item of due) {
          const found = sudoIn((await tx.doc(ApprovalsDoc)).items, item.id)?.run;
          if (!found) continue;
          delete found.stdout;
          delete found.stderr;
          found.removed = true;
        }
      }, BACKGROUND_CONTEXT);
    const later = kept
      .filter((item) => !due.includes(item))
      .map((item) => (item.run.endedAt as number) + keep - at);
    if (!later.length) return;
    timer = setTimeout(
      () => void sweep(host).catch(() => undefined),
      Math.min(MAX_DELAY, Math.max(0, Math.min(...later)))
    );
    (timer as { unref?: () => void }).unref?.();
  };
  return (host: SudoRunHost) => void sweep(host).catch(() => undefined);
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
  const swept = sweeper();
  const mem = memory();
  const lookup = () => bound;
  const run = {
    ...starting(lookup, mem),
    ...finishing(lookup, mem, swept),
    linger: (id: string, runtime: Runtime, context: Context) =>
      linger(lookup, swept, id, runtime, context),
  };
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
      linger: (task, runtime, context) => run.linger(task.input.approval, runtime, context),
    },
    abort: (task, runtime, context) => run.abort(task.input.approval, runtime, context),
  });
  return {
    extension: defineExtension({ name: SUDO_RUNS, tasks: [task] }),
    bind: (host) => {
      bind(host);
      swept(host);
    },
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
      const found = await host.harness.commit(async (tx) => {
        const item = sudoIn((await tx.doc(ApprovalsDoc)).items, id);
        if (!item?.run) return null;
        const live = runLive(item);
        if (live) item.run.stopBy = runner.by;
        return { live, pid: item.run.pid };
      }, context);
      if (!found) return { done: false, error: RUN_ERRORS.idle };
      if (found.live && found.pid === undefined) return { done: true, error: null };
      const sent = await stopTree(host, id);
      if (sent === 'sent') return { done: true, error: null };
      if (sent === 'unknown') return { done: false, error: RUN_ERRORS.unseen };
      return { done: false, error: found.live ? RUN_ERRORS.gone : RUN_ERRORS.idle };
    },
  };
}
