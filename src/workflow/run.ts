import type { Context, JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type {
  CodemodeHostCall,
  CodemodeOutcome,
  CodemodeResult,
  CodemodeRun,
  CodemodeRunOptions,
} from '@earendil-works/pi-codemode';
import {
  defineDoc,
  defineDocFamily,
  defineTask,
  type TaskRuntime,
  type Tx,
} from '@earendil-works/pi-durable';
import type { InheritedTaint } from '../guests/guard.ts';
import type { Spawned } from '../scoops/service.ts';
import { MAX_AGENTS } from './script.ts';
import {
  type AgentCall,
  cleanup,
  plan,
  StepError,
  type StepHost,
  settle,
  waitReport,
} from './step.ts';

export const MAX_LOGS = 200;
export const KEPT_RUNS = 50;

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type RunRecord = {
  id: string;
  name: string;
  description: string;
  cone: string;
  home: string;
  file: string | null;
  source: string;
  budget: number | null;
  concurrency: number;
  status: RunStatus;
  phase: string | null;
  started: number;
  ended: number | null;
  agents: { started: number; done: number; failed: number; running: string[] };
  spent: number;
  logs: string[];
  fromAgent: boolean;
  taints: InheritedTaint[];
  result?: JsonValue;
  error?: string;
};

export const WorkflowsDoc = defineDoc<{ runs: Record<string, RunRecord> }>({
  kind: 'slicc.workflows',
  version: 1,
  scope: 'session',
  initial: () => ({ runs: {} }),
});

type Start = {
  startedAt: number;
  seed: number;
  fingerprint: string | null;
  count: number;
  firstIssued: number | null;
};

const StartDoc = defineDoc<Start>({
  kind: 'slicc.workflow.start',
  version: 1,
  scope: 'task',
  initial: () => ({ startedAt: 0, seed: 0, fingerprint: null, count: 0, firstIssued: null }),
});

type Entry = {
  id: number;
  name: string;
  at: number;
  outcome: JsonValue;
  issuedAfter: number | null;
};

const JournalDoc = defineDocFamily<Entry, null>({
  kind: 'slicc.workflow.journal',
  version: 1,
  scope: 'task',
  family: true,
  initial: () => ({ id: 0, name: '', at: 0, outcome: null, issuedAfter: null }),
});

type Step = { folder: string; task: number; conversation: number };

const StepDoc = defineDocFamily<Step, null>({
  kind: 'slicc.workflow.step',
  version: 1,
  scope: 'task',
  family: true,
  initial: () => ({ folder: '', task: 0, conversation: 0 }),
});

export interface Engine {
  start(code: string, options: CodemodeRunOptions): CodemodeRun;
}

export interface RunHost extends StepHost {
  engine: () => Engine;
}

type Lookup = () => Promise<RunHost>;
type RunInput = { code: string };
type RunState = { phase: 'start' } | { phase: 'run' };

export const GLOBALS = [{ name: '__agent' }, { name: '__notify' }];

export const DIVERGED =
  'the workflow took another path than before the restart, so it cannot resume';

function addLog(record: RunRecord, line: string): void {
  record.logs.push(line);
  if (record.logs.length > MAX_LOGS) record.logs.splice(0, record.logs.length - MAX_LOGS);
}

export function noted(record: RunRecord, args: unknown): void {
  const { kind, text } = (args ?? {}) as { kind?: string; text?: unknown };
  const line = String(text ?? '');
  if (kind === 'phase') {
    record.phase = line;
    addLog(record, `phase: ${line}`);
  } else addLog(record, line);
}

function failure(error: unknown): CodemodeOutcome {
  const tokens = error instanceof StepError ? error.outputTokens : 0;
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    properties: { outputTokens: tokens },
  };
}

function spentOf(outcome: CodemodeOutcome): number {
  const value = outcome.ok ? outcome.value : outcome.properties;
  const tokens = (value as { outputTokens?: unknown } | undefined)?.outputTokens;
  return typeof tokens === 'number' ? tokens : 0;
}

export function errorText(result: CodemodeResult): string {
  if (result.ok) return '';
  const { error } = result;
  return error.kind === 'script' ? error.message : `${error.kind}: ${error.message}`;
}

type Runtime = TaskRuntime<RunInput, RunState, null, object>;

async function runOf(tx: Tx, id: string): Promise<RunRecord | undefined> {
  return (await tx.doc(WorkflowsDoc)).runs[id] as RunRecord | undefined;
}

type Event =
  | { kind: 'call'; call: CodemodeHostCall }
  | { kind: 'idle'; seq: number; issued: number }
  | { kind: 'started'; fingerprint: string };

export class Driver {
  readonly id: string;
  readonly host: RunHost;
  readonly runtime: Runtime;
  readonly context: Context;
  readonly controller = new AbortController();
  readonly issued = new Map<number, CodemodeHostCall>();
  readonly steps = new Set<Promise<void>>();
  readonly deferred: CodemodeHostCall[] = [];
  readonly queue: (() => void)[] = [];
  journal: Entry[] = [];
  start: Start = { startedAt: 0, seed: 0, fingerprint: null, count: 0, firstIssued: null };
  record: RunRecord | undefined;
  next = 0;
  idle: { seq: number; issued: number } | null = null;
  agents = 0;
  inflight = 0;
  spent = 0;
  stopped: string | null = null;
  run: CodemodeRun | undefined;

  constructor(host: RunHost, runtime: Runtime, context: Context) {
    this.host = host;
    this.runtime = runtime;
    this.context = context;
    this.id = String(runtime.taskId);
  }

  get scoped(): Context {
    return withAbortSignal(this.controller.signal, this.context);
  }

  get lanes(): number {
    return (this.record as RunRecord).concurrency;
  }

  async load(): Promise<void> {
    this.start = (await this.runtime.snapshot(
      StartDoc,
      this.runtime.taskId,
      this.context
    )) as Start;
    this.record = (await this.runtime.snapshot(WorkflowsDoc, this.context))?.runs[this.id];
    if (!this.record) throw new Error('the run is gone');
    this.spent = this.record.spent;
    for (let seq = 1; seq <= this.start.count; seq++) {
      const entry = await this.runtime.snapshot(
        JournalDoc,
        this.runtime.taskId,
        String(seq),
        this.context
      );
      if (!entry) throw new Error(`the run's journal is missing entry ${seq}`);
      this.journal.push(entry);
    }
  }

  halt(reason: string): void {
    this.stopped ??= reason;
    this.controller.abort();
  }

  replaying(): boolean {
    return this.next < this.journal.length;
  }

  deliver(seq: number, at: number, id: number, outcome: CodemodeOutcome): void {
    if (this.run && !this.run.finished) this.run.deliver(seq, at, id, outcome);
  }

  expected(): number | null {
    return this.next === 0
      ? this.start.firstIssued
      : (this.journal[this.next - 1] as Entry).issuedAfter;
  }

  pump(): void {
    while (this.replaying()) {
      if (this.idle?.seq !== this.next) return;
      const entry = this.journal[this.next] as Entry;
      const expected = this.expected();
      const call = this.issued.get(entry.id);
      if ((expected !== null && this.idle.issued !== expected) || call?.name !== entry.name) {
        this.halt(DIVERGED);
        return;
      }
      this.next++;
      this.deliver(this.next, entry.at, entry.id, entry.outcome as CodemodeOutcome);
    }
    for (const call of this.deferred.splice(0)) this.launch(call);
  }

  handle(event: Event): void {
    if (event.kind === 'started') {
      void this.fingerprint(event.fingerprint).catch(() => undefined);
      return;
    }
    if (event.kind === 'idle') {
      this.idle = { seq: event.seq, issued: event.issued };
      void this.acknowledge(event.seq, event.issued).catch(() => undefined);
      this.pump();
      return;
    }
    this.issued.set(event.call.id, event.call);
    if (event.call.name === '__agent') this.agents++;
    if (!this.replaying()) this.launch(event.call);
    else if (!this.journal.some((entry) => entry.id === event.call.id))
      this.deferred.push(event.call);
  }

  async acknowledge(seq: number, issued: number): Promise<void> {
    if (seq === 0 && this.start.firstIssued !== null) return;
    if (seq > 0 && seq <= this.journal.length) return;
    await this.runtime.commit(async (tx) => {
      if (seq === 0) (await tx.doc(StartDoc, this.runtime.taskId)).firstIssued = issued;
      else (await tx.doc(JournalDoc, this.runtime.taskId, String(seq), null)).issuedAfter = issued;
      return undefined;
    }, this.scoped);
  }

  launch(call: CodemodeHostCall): void {
    const step = this.live(call).catch((error) => {
      if (!this.controller.signal.aborted) this.halt((error as Error).message);
    });
    this.steps.add(step);
    void step.finally(() => this.steps.delete(step));
  }

  async journalize(
    call: CodemodeHostCall,
    outcome: CodemodeOutcome,
    effect: (record: RunRecord) => void
  ): Promise<void> {
    const at = this.runtime.now();
    let seq = 0;
    await this.runtime.commit(async (tx) => {
      const start = await tx.doc(StartDoc, this.runtime.taskId);
      start.count += 1;
      seq = start.count;
      Object.assign(await tx.doc(JournalDoc, this.runtime.taskId, String(seq), null), {
        id: call.id,
        name: call.name,
        at,
        outcome: outcome as JsonValue,
        issuedAfter: null,
      });
      const record = await runOf(tx, this.id);
      if (record) effect(record);
      return undefined;
    }, this.scoped);
    this.deliver(seq, at, call.id, outcome);
  }

  refused(): string | null {
    if (this.agents > MAX_AGENTS) return `agent(): a workflow starts at most ${MAX_AGENTS} agents`;
    const { budget } = this.record as RunRecord;
    if (budget !== null && this.spent >= budget)
      return `agent(): the budget of ${budget} output tokens is spent`;
    return null;
  }

  async admit(): Promise<void> {
    if (this.inflight < this.lanes) {
      this.inflight++;
      return;
    }
    await new Promise<void>((resume) => this.queue.push(resume));
  }

  free(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.inflight--;
  }

  async live(call: CodemodeHostCall): Promise<void> {
    if (call.name !== '__agent')
      return this.journalize(call, { ok: true, value: null }, (record) => noted(record, call.args));
    if (this.agents > MAX_AGENTS)
      return this.journalize(call, { ok: false, message: this.refused() as string }, () => {});
    await this.admit();
    const refused = this.refused();
    let outcome: CodemodeOutcome;
    if (refused) outcome = { ok: false, message: refused };
    else
      try {
        outcome = { ok: true, value: await this.step(call) };
      } catch (error) {
        if (this.controller.signal.aborted) {
          this.free();
          throw error;
        }
        outcome = failure(error);
      }
    const tokens = spentOf(outcome);
    this.spent += tokens;
    this.free();
    return this.journalize(call, outcome, (record) => {
      record.spent += tokens;
      if (refused) return;
      if (outcome.ok) record.agents.done++;
      else record.agents.failed++;
    });
  }

  created(call: CodemodeHostCall) {
    return async (tx: Tx, made: Spawned) => {
      Object.assign(await tx.doc(StepDoc, this.runtime.taskId, String(call.id), null), {
        folder: made.folder,
        task: made.tasks[0] as number,
        conversation: made.conversation,
      });
      const current = await runOf(tx, this.id);
      if (current) {
        current.agents.started++;
        current.agents.running.push(`scoop:${made.folder}`);
      }
    };
  }

  async spawn(call: CodemodeHostCall, planned: ReturnType<typeof plan>, limits: object) {
    const record = this.record as RunRecord;
    const answer = await this.host.scoops.spawn(
      {
        cone: record.cone,
        kind: 'sync',
        target: null,
        asker: null,
        name: planned.name,
        ...(planned.role ? { role: planned.role } : {}),
        ...(planned.model ? { model: planned.model } : {}),
        ...(planned.thinking ? { thinking: planned.thinking as never } : {}),
        prompts: [planned.prompt],
        fromAgent: record.fromAgent,
        request: `workflow:${this.id}:${call.id}`,
        limits: limits as never,
        taints: record.taints,
        created: this.created(call),
      },
      this.scoped
    );
    if (answer.code !== 0) throw new StepError(answer.out.trim().replace(/^subagent: /, ''));
    return { folder: answer.out.trim(), task: (answer.tasks as number[])[0] as number };
  }

  async step(call: CodemodeHostCall): Promise<JsonValue> {
    const host = this.host;
    const roles = await host.roles(this.scoped);
    const planned = plan(call.args as AgentCall, roles);
    const kept = await this.runtime.snapshot(
      StepDoc,
      this.runtime.taskId,
      String(call.id),
      this.scoped
    );
    const step = kept ?? (await this.spawn(call, planned, roles.limits));
    const scoop = `scoop:${step.folder}`;
    try {
      const done = await settle(
        host,
        step.folder,
        step.task,
        planned,
        (task) => waitReport((id, using) => this.runtime.waitForTask(id, using), task, this.scoped),
        this.scoped
      );
      return { value: done.value, outputTokens: done.outputTokens } as unknown as JsonValue;
    } finally {
      await cleanup(host, step.folder);
      await this.runtime
        .commit(async (tx) => {
          const current = await runOf(tx, this.id);
          if (current)
            current.agents.running = current.agents.running.filter((name) => name !== scoop);
          return undefined;
        }, BACKGROUND_CONTEXT)
        .catch(() => undefined);
    }
  }

  async fingerprint(value: string): Promise<void> {
    if (this.start.fingerprint === value) return;
    if (this.start.fingerprint !== null) {
      this.halt('the sandbox changed since the run started, so it cannot resume');
      return;
    }
    await this.runtime.commit(async (tx) => {
      (await tx.doc(StartDoc, this.runtime.taskId)).fingerprint = value;
      return undefined;
    }, this.scoped);
  }

  async execute(code: string): Promise<CodemodeResult> {
    const abort = () => this.controller.abort();
    this.runtime.signal.addEventListener('abort', abort, { once: true });
    this.context.abortSignal?.addEventListener('abort', abort, { once: true });
    const early: Event[] = [];
    let ready = false;
    const emit = (event: Event) => {
      if (ready) this.handle(event);
      else early.push(event);
    };
    const run = this.host.engine().start(code, {
      startedAt: this.start.startedAt,
      seed: this.start.seed,
      globals: GLOBALS,
      signal: this.controller.signal,
      onStarted: (fingerprint) => emit({ kind: 'started', fingerprint }),
      onCall: (call) => emit({ kind: 'call', call }),
      onIdle: (seq, issued) => emit({ kind: 'idle', seq, issued }),
    });
    this.run = run;
    ready = true;
    for (const event of early.splice(0)) this.handle(event);
    const result = await run.result;
    if (this.replaying()) this.halt(DIVERGED);
    this.controller.abort();
    await Promise.allSettled([...this.steps]);
    return result;
  }
}

function seed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] as number;
}

async function finish(
  runtime: Runtime,
  driver: Driver,
  result: CodemodeResult,
  context: Context
): Promise<void> {
  const error = driver.stopped ?? (result.ok ? null : errorText(result));
  await runtime.commit(async (tx) => {
    const record = await runOf(tx, String(runtime.taskId));
    if (record) {
      record.status = error === null ? 'completed' : 'failed';
      record.ended = runtime.now();
      record.agents.running = [];
      if (error === null) record.result = (result.ok ? (result.value ?? null) : null) as never;
      else record.error = error;
    }
    return { status: 'terminal', outcome: { status: 'completed', result: null } };
  }, context);
}

export function runTask(lookup: Lookup) {
  return defineTask<RunInput, RunState, null>({
    name: 'slicc.workflow-run',
    version: 1,
    initial: () => ({ phase: 'start' }),
    phases: {
      start: (_task, runtime, context) =>
        runtime.commit(async (tx) => {
          Object.assign(await tx.doc(StartDoc, runtime.taskId), {
            startedAt: runtime.now(),
            seed: seed(),
          });
          return { status: 'running', checkpoint: { phase: 'run' } };
        }, context),
      async run(task, runtime, context) {
        const driver = new Driver(await lookup(), runtime, context);
        await driver.load();
        const result = await driver.execute(task.input.code);
        if (runtime.signal.aborted || context.abortSignal?.aborted) return;
        await finish(runtime, driver, result, context);
      },
    },
    async abort(_task, runtime, context) {
      const host = await lookup();
      const id = String(runtime.taskId);
      const record = (await runtime.snapshot(WorkflowsDoc, context))?.runs[id];
      for (const scoop of record?.agents.running ?? [])
        await cleanup(host, scoop.slice('scoop:'.length));
      await runtime.commit(async (tx) => {
        const current = await runOf(tx, id);
        if (current) {
          current.status = 'stopped';
          current.ended = runtime.now();
          current.agents.running = [];
        }
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context);
    },
  });
}
