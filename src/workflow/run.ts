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
  result?: JsonValue;
  error?: string;
};

export const WorkflowsDoc = defineDoc<{ runs: Record<string, RunRecord> }>({
  kind: 'slicc.workflows',
  version: 1,
  scope: 'session',
  initial: () => ({ runs: {} }),
});

type Start = { startedAt: number; seed: number; fingerprint: string | null; count: number };

const StartDoc = defineDoc<Start>({
  kind: 'slicc.workflow.start',
  version: 1,
  scope: 'task',
  initial: () => ({ startedAt: 0, seed: 0, fingerprint: null, count: 0 }),
});

type Entry = { id: number; name: string; at: number; outcome: JsonValue };

const JournalDoc = defineDocFamily<Entry, null>({
  kind: 'slicc.workflow.journal',
  version: 1,
  scope: 'task',
  family: true,
  initial: () => ({ id: 0, name: '', at: 0, outcome: null }),
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

export function refusal(record: RunRecord | undefined, inflight: number): string | null {
  if (!record) return 'the run is gone';
  if (record.agents.started >= MAX_AGENTS)
    return `agent(): a workflow starts at most ${MAX_AGENTS} agents`;
  if (record.budget !== null && record.spent >= record.budget)
    return `agent(): the budget of ${record.budget} output tokens is spent`;
  if (inflight >= record.concurrency)
    return `agent(): at most ${record.concurrency} agents run at once`;
  return null;
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

export class Driver {
  readonly id: string;
  readonly issued = new Map<number, CodemodeHostCall>();
  readonly steps = new Set<Promise<void>>();
  journal: Entry[] = [];
  next = 0;
  inflight = 0;
  stopped: string | null = null;
  run: CodemodeRun | undefined;
  readonly controller = new AbortController();
  readonly host: RunHost;
  readonly runtime: Runtime;
  readonly context: Context;

  constructor(host: RunHost, runtime: Runtime, context: Context) {
    this.host = host;
    this.runtime = runtime;
    this.context = context;
    this.id = String(runtime.taskId);
  }

  get scoped(): Context {
    return withAbortSignal(this.controller.signal, this.context);
  }

  async load(count: number): Promise<void> {
    for (let seq = 1; seq <= count; seq++) {
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

  deliver(seq: number, at: number, id: number, outcome: CodemodeOutcome): void {
    if (this.run && !this.run.finished) this.run.deliver(seq, at, id, outcome);
  }

  pump(): void {
    while (this.next < this.journal.length) {
      const entry = this.journal[this.next] as Entry;
      const call = this.issued.get(entry.id);
      if (!call) return;
      if (call.name !== entry.name) {
        this.halt('the workflow took another path than before the restart, so it cannot resume');
        return;
      }
      this.next++;
      this.deliver(this.next, entry.at, entry.id, entry.outcome as CodemodeOutcome);
    }
  }

  replayed(id: number): boolean {
    return this.journal.some((entry) => entry.id === id);
  }

  onCall(call: CodemodeHostCall): void {
    this.issued.set(call.id, call);
    if (this.replayed(call.id)) {
      this.pump();
      return;
    }
    const step = this.live(call).catch((error) => {
      if (!this.controller.signal.aborted) this.halt((error as Error).message);
    });
    this.steps.add(step);
    void step.finally(() => this.steps.delete(step));
  }

  async record(
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
      });
      const record = await runOf(tx, this.id);
      if (record) effect(record);
      return undefined;
    }, this.scoped);
    this.deliver(seq, at, call.id, outcome);
  }

  async snapshot(): Promise<RunRecord | undefined> {
    return (await this.runtime.snapshot(WorkflowsDoc, this.context))?.runs[this.id];
  }

  async live(call: CodemodeHostCall): Promise<void> {
    if (call.name !== '__agent')
      return this.record(call, { ok: true, value: null }, (record) => noted(record, call.args));
    const current = await this.snapshot();
    const refused = refusal(current, this.inflight);
    if (refused) return this.record(call, { ok: false, message: refused }, () => {});
    this.inflight++;
    let outcome: CodemodeOutcome;
    try {
      outcome = { ok: true, value: await this.step(call, current as RunRecord) };
    } catch (error) {
      if (this.controller.signal.aborted) throw error;
      outcome = failure(error);
    } finally {
      this.inflight--;
    }
    const tokens = spentOf(outcome);
    return this.record(call, outcome, (record) => {
      record.spent += tokens;
      if (outcome.ok) record.agents.done++;
      else record.agents.failed++;
    });
  }

  async step(call: CodemodeHostCall, record: RunRecord): Promise<JsonValue> {
    const host = this.host;
    const args = call.args as AgentCall;
    const roles = await host.roles(this.scoped);
    const planned = plan(args, roles);
    const answer = await host.scoops.spawn(
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
        fromAgent: false,
        request: `workflow:${this.id}:${call.id}`,
        limits: roles.limits,
      },
      this.scoped
    );
    if (answer.code !== 0) throw new StepError(answer.out.trim().replace(/^subagent: /, ''));
    const folder = answer.out.trim();
    const scoop = `scoop:${folder}`;
    await this.runtime.commit(async (tx) => {
      const current = await runOf(tx, this.id);
      if (current && !current.agents.running.includes(scoop)) {
        current.agents.started++;
        current.agents.running.push(scoop);
      }
      return undefined;
    }, this.scoped);
    try {
      const done = await settle(
        host,
        folder,
        (answer.tasks as number[])[0] as number,
        planned,
        (task) => waitReport((id, using) => this.runtime.waitForTask(id, using), task, this.scoped),
        this.scoped
      );
      return { value: done.value, outputTokens: done.outputTokens } as unknown as JsonValue;
    } finally {
      await cleanup(host, folder);
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

  async fingerprint(start: Start, value: string): Promise<void> {
    if (start.fingerprint === value) return;
    if (start.fingerprint !== null) {
      this.halt('the sandbox changed since the run started, so it cannot resume');
      return;
    }
    await this.runtime.commit(async (tx) => {
      (await tx.doc(StartDoc, this.runtime.taskId)).fingerprint = value;
      return undefined;
    }, this.scoped);
  }

  async execute(code: string, start: Start): Promise<CodemodeResult> {
    const signal = this.controller.signal;
    const abort = () => this.controller.abort();
    this.runtime.signal.addEventListener('abort', abort, { once: true });
    this.context.abortSignal?.addEventListener('abort', abort, { once: true });
    const calls: CodemodeHostCall[] = [];
    let ready = false;
    const run = this.host.engine().start(code, {
      startedAt: start.startedAt,
      seed: start.seed,
      globals: GLOBALS,
      signal,
      onStarted: (value) => {
        void this.fingerprint(start, value).catch(() => undefined);
      },
      onCall: (call) => {
        if (ready) this.onCall(call);
        else calls.push(call);
      },
    });
    this.run = run;
    ready = true;
    for (const call of calls.splice(0)) this.onCall(call);
    const result = await run.result;
    this.controller.abort();
    await Promise.allSettled([...this.steps]);
    return result;
  }
}

function seed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] as number;
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
        const host = await lookup();
        const start = (await runtime.snapshot(StartDoc, runtime.taskId, context)) as Start;
        const driver = new Driver(host, runtime, context);
        await driver.load(start.count);
        const result = await driver.execute(task.input.code, start);
        if (runtime.signal.aborted || context.abortSignal?.aborted) return;
        const error = driver.stopped ?? (result.ok ? null : errorText(result));
        await runtime.commit(async (tx) => {
          const record = await runOf(tx, String(runtime.taskId));
          if (record) {
            record.status = error === null ? 'completed' : 'failed';
            record.ended = runtime.now();
            record.agents.running = [];
            if (error === null)
              record.result = (result.ok ? (result.value ?? null) : null) as never;
            else record.error = error;
          }
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }, context);
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
