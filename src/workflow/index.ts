import type { Context, JsonValue } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import {
  type AnyTask,
  type ConversationId,
  defineExtension,
  defineTool,
  type Extension,
  type Registry,
  type TaskId,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Agents } from '../agents.ts';
import { MEMORY_LIMIT_BYTES, sharedSandbox } from '../codemode/index.ts';
import { type InheritedTaint, runTaints } from '../guests/guard.ts';
import { resolve } from '../kernel/paths.ts';
import type { Layout } from '../layout.ts';
import { coneOf } from '../scoops/service.ts';
import {
  type Engine,
  KEPT_RUNS,
  type RunHost,
  type RunRecord,
  runTask,
  WorkflowsDoc,
} from './run.ts';
import { buildCode, DEFAULT_CONCURRENCY, maxConcurrency, parseMeta } from './script.ts';

export { WorkflowsDoc } from './run.ts';

export const WORKFLOW = 'workflow';
export const SAVE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export type Answer = { code: number; out: string };

export interface Files {
  dir: string;
  env: Pick<ExecutionEnv, 'readTextFile' | 'writeFile' | 'createDir' | 'fileInfo'>;
  cwd: string;
}

export interface RunRequest {
  cone: string;
  from?: number | null;
  taints?: InheritedTaint[];
  files: Files;
  target: string;
  script?: boolean;
  args?: JsonValue;
  budget?: number;
  concurrency?: number;
}

export interface WorkflowHost extends RunHost {
  envFor(user: string | null, context: Context): Promise<Files['env']>;
  tasks: { run: AnyTask };
}

const ok = (out: string): Answer => ({ code: 0, out });
const fail = (out: string, code = 1): Answer => ({ code, out: `workflow: ${out}\n` });

export function workflowsDir(home: string): string {
  return `${home}/.slicc/workflows`;
}

export function pathOf(files: Files, target: string): string {
  if (SAVE_NAME.test(target) && !target.endsWith('.js'))
    return `${files.dir}/${target}.workflow.js`;
  return resolve(files.cwd, target);
}

export function concurrencyOf(value: number | undefined): number {
  const most = maxConcurrency();
  if (value === undefined) return Math.min(DEFAULT_CONCURRENCY, most);
  if (!Number.isFinite(value)) throw new Error('concurrency must be a number');
  return Math.min(most, Math.max(1, Math.trunc(value)));
}

export function budgetOf(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error('budget must be a positive number');
  return value;
}

async function sourceOf(request: RunRequest, context: Context) {
  if (request.script) return { source: request.target, file: null };
  const path = pathOf(request.files, request.target);
  const read = await request.files.env.readTextFile(path, context);
  if (!read.ok) throw new Error(`can't read ${path}: ${read.error.message}`);
  return { source: read.value, file: path };
}

function prune(runs: Record<string, RunRecord>): void {
  const ended = Object.values(runs)
    .filter((run) => run.status !== 'running')
    .sort((a, b) => Number(a.id) - Number(b.id));
  for (const run of ended.slice(0, Math.max(0, ended.length - KEPT_RUNS))) delete runs[run.id];
}

export function summary(run: RunRecord): string {
  const budget = run.budget === null ? '' : ` of ${run.budget}`;
  const lines = [
    `run ${run.id}: ${run.name} (${run.status})`,
    `phase: ${run.phase ?? '-'}`,
    `agents: ${run.agents.done} done, ${run.agents.failed} failed, ${run.agents.running.length} running, ${run.agents.started} started`,
    `output tokens: ${run.spent}${budget}`,
    `concurrency: ${run.concurrency}`,
  ];
  if (run.logs.length) lines.push('log:', ...run.logs.slice(-20).map((line) => `  ${line}`));
  if (run.error) lines.push(`error: ${run.error}`);
  if (run.status === 'completed')
    lines.push(`result: ${JSON.stringify(run.result ?? null, null, 2)}`);
  return `${lines.join('\n')}\n`;
}

export function outcome(run: RunRecord): Answer {
  if (run.status === 'completed') return ok(`${JSON.stringify(run.result ?? null, null, 2)}\n`);
  if (run.status === 'stopped') return fail(`run ${run.id} was stopped`);
  return fail(`run ${run.id} failed: ${run.error ?? 'unknown error'}`);
}

export function createWorkflows(host: Promise<WorkflowHost>) {
  const runs = async (context: Context) => {
    const { harness } = await host;
    return (await harness.snapshot(WorkflowsDoc, context))?.runs ?? {};
  };
  const find = async (id: string, context: Context) => (await runs(context))[id];

  async function start(request: RunRequest, context: Context): Promise<string> {
    const { harness, agents } = await host;
    const { source, file } = await sourceOf(request, context);
    const meta = parseMeta(source);
    const budget = budgetOf(request.budget);
    const concurrency = concurrencyOf(request.concurrency);
    const code = buildCode(source, {
      ...(request.args !== undefined ? { args: request.args } : {}),
      budget,
      concurrency,
    });
    const cone = await agents.conversation(request.cone, context);
    if (!cone) throw new Error(`there is no cone ${request.cone}`);
    const from = request.from ?? null;
    const taints =
      request.taints ??
      (from === null ? [] : await runTaints(harness, from as ConversationId, context));
    return harness.commit(async (tx) => {
      const task = await tx.createTask(
        (await host).tasks.run as never,
        { code },
        {
          ownership: { kind: 'conversation' },
          conversationId: cone.id as ConversationId,
          background: true,
        }
      );
      const doc = await tx.doc(WorkflowsDoc);
      prune(doc.runs as Record<string, RunRecord>);
      const id = String(task);
      doc.runs[id] = {
        id,
        name: meta.name,
        description: meta.description,
        cone: request.cone,
        home: request.files.dir,
        file,
        source,
        budget,
        concurrency,
        status: 'running',
        phase: null,
        started: Date.now(),
        ended: null,
        agents: { started: 0, done: 0, failed: 0, running: [] },
        spent: 0,
        logs: [],
        fromAgent: from !== null,
        taints,
      };
      return id;
    }, context);
  }

  async function wait(id: string, context: Context): Promise<RunRecord | undefined> {
    const { harness } = await host;
    if (!(await find(id, context))) return undefined;
    await harness.waitForTask(Number(id) as TaskId, context);
    return find(id, context);
  }

  async function stop(id: string, context: Context): Promise<RunRecord | undefined> {
    const { harness } = await host;
    const run = await find(id, context);
    if (run?.status !== 'running') return run;
    await harness.abortTask(Number(id) as TaskId, context);
    return wait(id, context);
  }

  async function save(
    id: string,
    name: string,
    force: boolean,
    files: Files,
    context: Context
  ): Promise<Answer> {
    if (!SAVE_NAME.test(name)) return fail(`invalid name ${name} (use [a-z0-9][a-z0-9-]*)`, 2);
    const run = await find(id, context);
    if (!run) return fail(`there is no run ${id}`);
    const path = `${files.dir}/${name}.workflow.js`;
    const exists = await files.env.fileInfo(path, context);
    if (exists.ok && !force) return fail(`${path} already exists (pass --force to overwrite)`);
    const made = await files.env.createDir(files.dir, { recursive: true }, context);
    if (!made.ok) return fail(`can't create ${files.dir}: ${made.error.message}`);
    const written = await files.env.writeFile(path, run.source, context);
    if (!written.ok) return fail(`can't write ${path}: ${written.error.message}`);
    return ok(`saved workflow ${name} to ${path}; run it with agent workflow run ${name}\n`);
  }

  return {
    runs,
    find,
    start,
    wait,
    stop,
    save,
    async list(cone: string | null, context: Context): Promise<RunRecord[]> {
      return Object.values(await runs(context))
        .filter((run) => cone === null || run.cone === cone)
        .sort((a, b) => Number(a.id) - Number(b.id));
    },
  };
}

export type Workflows = ReturnType<typeof createWorkflows>;

export interface Invocation {
  cone: string;
  scoop: boolean;
  from: number | null;
  taints?: InheritedTaint[];
  files: Files;
}

export const USAGE = `usage:
  agent workflow run <file.js | name> [--args <json>] [--budget <tokens>] [--concurrency <n>] [--wait]
  agent workflow run --script '<js>' [same options]
  agent workflow list | status <run> | wait <run> | stop <run> | save <run> <name> [--force]

Globals: agent(prompt, { label, phase, schema, model, effort, agentType }), parallel(thunks),
pipeline(items, ...stages), phase(title), log(message), console, args, budget (output tokens).

Runs a Claude Code .workflow.js as a durable task; it survives a reload. Without --wait it prints
the run id. --budget caps output tokens, --concurrency caps agents running at once. save keeps a
run's source as ~/.slicc/workflows/<name>.workflow.js, which agent workflow run <name> runs.
`;

const VALUES = new Set(['--args', '--budget', '--concurrency', '--script']);
const SWITCHES = new Set(['--wait', '--force']);

type Parsed = { values: Map<string, string>; switches: Set<string>; rest: string[] };

export function parseArgv(argv: readonly string[]): Parsed {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at] as string;
    if (VALUES.has(arg)) {
      const value = argv[++at];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      values.set(arg, value);
    } else if (SWITCHES.has(arg)) switches.add(arg);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  return { values, switches, rest };
}

function number(parsed: Parsed, flag: string): number | undefined {
  const value = parsed.values.get(flag);
  if (value === undefined) return undefined;
  const found = Number(value);
  if (!Number.isFinite(found)) throw new Error(`${flag} must be a number`);
  return found;
}

function argsOf(parsed: Parsed): JsonValue | undefined {
  const text = parsed.values.get('--args');
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new Error('--args must be valid JSON');
  }
}

export interface RunOptions {
  target?: string;
  script?: string;
  args?: JsonValue;
  budget?: number;
  concurrency?: number;
  wait?: boolean;
}

export async function runWorkflow(
  workflows: Workflows,
  who: Invocation,
  options: RunOptions,
  context: Context
): Promise<Answer> {
  if (who.scoop) return fail('a scoop cannot start workflows');
  const target = options.script ?? options.target;
  if (target === undefined) return fail('run needs a <file.js>, a saved name or --script', 2);
  const id = await workflows.start(
    {
      cone: who.cone,
      from: who.from,
      ...(who.taints ? { taints: who.taints } : {}),
      files: who.files,
      target,
      ...(options.script !== undefined ? { script: true } : {}),
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    },
    context
  );
  if (!options.wait)
    return ok(`${id}\nworkflow run ${id} started; follow it with agent workflow status ${id}\n`);
  const run = await workflows.wait(id, context);
  return run ? outcome(run) : fail(`run ${id} is gone`);
}

async function listed(workflows: Workflows, who: Invocation, context: Context) {
  const rows = await workflows.list(who.cone, context);
  if (!rows.length) return ok('no workflow runs\n');
  return ok(
    `${rows.map((run) => `${run.id}\t${run.status}\t${run.agents.done}/${run.agents.started}\t${run.name}`).join('\n')}\n`
  );
}

function runOptions(parsed: Parsed): RunOptions {
  const args = argsOf(parsed);
  const budget = number(parsed, '--budget');
  const concurrency = number(parsed, '--concurrency');
  const script = parsed.values.get('--script');
  const target = parsed.rest[0];
  return {
    ...(target !== undefined ? { target } : {}),
    ...(script !== undefined ? { script } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    wait: parsed.switches.has('--wait'),
  };
}

type Verb = (
  workflows: Workflows,
  who: Invocation,
  parsed: Parsed,
  context: Context
) => Promise<Answer>;

async function owned(workflows: Workflows, who: Invocation, id: string, context: Context) {
  const run = await workflows.find(id, context);
  return run && run.cone === who.cone ? run : undefined;
}

const VERBS: Record<string, Verb> = {
  run: (workflows, who, parsed, context) =>
    runWorkflow(workflows, who, runOptions(parsed), context),
  list: (workflows, who, _parsed, context) => listed(workflows, who, context),
  async status(workflows, who, parsed, context) {
    const id = parsed.rest[0] ?? '';
    const run = await owned(workflows, who, id, context);
    return run ? ok(summary(run)) : fail(`there is no run ${id}`);
  },
  async wait(workflows, who, parsed, context) {
    const id = parsed.rest[0] ?? '';
    if (!(await owned(workflows, who, id, context))) return fail(`there is no run ${id}`);
    const run = await workflows.wait(id, context);
    return run ? outcome(run) : fail(`run ${id} is gone`);
  },
  async stop(workflows, who, parsed, context) {
    const id = parsed.rest[0] ?? '';
    if (who.scoop) return fail('a scoop cannot stop workflows');
    if (!(await owned(workflows, who, id, context))) return fail(`there is no run ${id}`);
    const run = await workflows.stop(id, context);
    return ok(`run ${id} is ${run?.status ?? 'gone'}\n`);
  },
  async save(workflows, who, parsed, context) {
    const id = parsed.rest[0] ?? '';
    if (who.scoop) return fail('a scoop cannot save workflows');
    if (!(await owned(workflows, who, id, context))) return fail(`there is no run ${id}`);
    const name = parsed.rest[1] ?? '';
    return workflows.save(id, name, parsed.switches.has('--force'), who.files, context);
  },
};

export async function command(
  workflows: Workflows,
  who: Invocation,
  argv: readonly string[],
  context: Context
): Promise<Answer> {
  const [verb, ...rest] = argv;
  const handler = verb === undefined ? undefined : VERBS[verb];
  if (!handler) return { code: verb === 'help' || verb === undefined ? 0 : 2, out: USAGE };
  return handler(workflows, who, parseArgv(rest), context);
}

export const TOOL_DESCRIPTION = `Run a Claude Code dynamic workflow (.workflow.js) as a durable background task that survives a reload, or manage runs.
action run: give file (a path, or the name of a saved workflow) or script (the source). The source starts with \`export const meta = { name, description }\`; the body may use top-level await and return a JSON result. Globals: \`agent(prompt, { label, phase, schema, model: 'provider/model', effort, agentType })\` runs one scoop and resolves to its answer (JSON matching schema, when given), and rejects when it fails; \`parallel(thunks)\` and \`pipeline(items, ...stages)\` turn a failed branch into null; \`phase(title)\`, \`log(message)\`, \`console.*\`, \`args\`, \`budget\` ({ total, spent(), remaining() } in output tokens). No Date.now(), Math.random(), timers, require, fs or nested workflow().
budget caps output tokens, concurrency caps agents running at once (default 8). wait: true blocks until the run ends and returns its result; otherwise the run id comes back at once.
action list | status (run) | stop (run) | save (run, name, force): manage runs; save keeps the source as ~/.slicc/workflows/<name>.workflow.js.`;

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal('run'),
    Type.Literal('list'),
    Type.Literal('status'),
    Type.Literal('stop'),
    Type.Literal('save'),
  ]),
  file: Type.Optional(Type.String()),
  script: Type.Optional(Type.String()),
  args: Type.Optional(Type.Unknown()),
  budget: Type.Optional(Type.Number()),
  concurrency: Type.Optional(Type.Number()),
  wait: Type.Optional(Type.Boolean()),
  run: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  force: Type.Optional(Type.Boolean()),
});

type ToolArgs = {
  action: 'run' | 'list' | 'status' | 'stop' | 'save';
  file?: string;
  script?: string;
  args?: unknown;
  budget?: number;
  concurrency?: number;
  wait?: boolean;
  run?: string;
  name?: string;
  force?: boolean;
};

export function toolArgv(args: ToolArgs): string[] {
  const argv: string[] = [args.action];
  if (args.action !== 'run') {
    if (args.run !== undefined) argv.push(args.run);
    if (args.name !== undefined) argv.push(args.name);
    if (args.force) argv.push('--force');
  }
  return argv;
}

export function workflowTool(
  workflows: Workflows,
  who: (conversation: number, context: Context) => Promise<Invocation | undefined>
): ToolRegistration {
  return defineTool({
    name: WORKFLOW,
    description: TOOL_DESCRIPTION,
    parameters,
    async execute(args, api, context) {
      const caller = await who(Number(api.conversationId), context);
      if (!caller) throw new Error('only a cone can use workflows');
      const given = args as ToolArgs;
      const answer =
        given.action === 'run'
          ? await runWorkflow(
              workflows,
              caller,
              {
                ...(given.file !== undefined ? { target: given.file } : {}),
                ...(given.script !== undefined ? { script: given.script } : {}),
                ...(given.args !== undefined ? { args: given.args as JsonValue } : {}),
                ...(given.budget !== undefined ? { budget: given.budget } : {}),
                ...(given.concurrency !== undefined ? { concurrency: given.concurrency } : {}),
                wait: given.wait === true,
              },
              context
            )
          : await command(workflows, caller, toolArgv(given), context);
      return {
        output: [{ type: 'text', text: answer.out }],
        ...(answer.code === 0 ? {} : { isError: true }),
      };
    },
  }) as ToolRegistration;
}

export interface WorkflowsSetup {
  workflows: Workflows;
  extension: Extension;
  attach(host: Omit<WorkflowHost, 'tasks'>): void;
}

export function setupWorkflows(registry: Registry): WorkflowsSetup {
  let bind: (host: WorkflowHost) => void = () => undefined;
  const host = new Promise<WorkflowHost>((resolve) => {
    bind = resolve;
  });
  const run = runTask(() => host);
  const workflows = createWorkflows(host);
  const who = async (conversation: number, context: Context): Promise<Invocation | undefined> => {
    const bound = await host;
    const cone = coneOf(bound.agents.state(), conversation);
    if (!cone) return undefined;
    const home = bound.layout.homeOf(cone);
    return {
      cone,
      scoop: false,
      from: conversation,
      files: { dir: workflowsDir(home), env: await bound.envFor(cone, context), cwd: home },
    };
  };
  const extension = defineExtension({
    name: 'slicc-workflows',
    tasks: [run],
    tools: [workflowTool(workflows, who)],
  });
  registry.install(extension);
  return {
    workflows,
    extension,
    attach(given) {
      bind({ ...given, tasks: { run: run as AnyTask } });
    },
  };
}

export function cliCommand(
  workflows: Workflows,
  layout: Layout,
  env: Files['env'],
  agents: Pick<Agents, 'state'>
): (
  argv: readonly string[],
  who: { cone: string; scoop: string | null; fromAgent: boolean; taints: InheritedTaint[] },
  request: { user?: string | null; cwd: string },
  context: Context
) => Promise<Answer> {
  return async (argv, who, request, context) => {
    const user = request.user ?? null;
    const files = {
      dir: workflowsDir(layout.homeOf(user)),
      env: (await layout.envFor(user, context)) ?? env,
      cwd: request.cwd,
    };
    const from = who.fromAgent ? (agents.state().cones[who.cone]?.conversation ?? null) : null;
    return command(
      workflows,
      { cone: who.cone, scoop: who.scoop !== null, from, taints: who.taints, files },
      argv,
      context
    );
  };
}

export function workflowEngine(factory = sharedSandbox): () => Engine {
  let engine: Engine | undefined;
  return () => {
    const make = factory();
    if (!make) throw new Error('workflows need the codemode sandbox, which settings turned off');
    engine ??= make({ memoryLimitBytes: MEMORY_LIMIT_BYTES });
    return engine;
  };
}
