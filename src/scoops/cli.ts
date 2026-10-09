import type { Context } from '@earendil-works/chord';
import type { Harness } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Agents } from '../agents.ts';
import { resolve } from '../kernel/paths.ts';
import { findRole, type Roles } from '../roles/roles.ts';
import type { Request, Runner } from './requests.ts';
import { type Answer, findScoop, modelOf, SCOOPS_ROOT, type Scoops } from './service.ts';
import { cancelSync, detachSync, runSync, type SyncState } from './sync.ts';

export const DEFAULT_WAIT_S = 30;
export const MAX_DEPTH = 3;
export const RUN_DIR = '/var/lib/slicc/agent/scoops';

export const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };

export const USAGE = `usage:
  agent [options] (--prompt <text> | --file <path> | -)...          run a scoop, wait, print its answer
  agent --async [options] (--prompt <text> | --file <path> | -)...  start a scoop, print its handle
  agent <cwd> <allowed-commands> <prompt>                         the same as a synchronous run, in v6's form
  agent list [--agents] | status <handle> | rename <handle> <name>
  agent send <handle> [--follow-up] (<message> | --file <path> | -)
  agent send parent <note>                                        from a scoop: a progress note to its cone
  agent wait <handle>... [--timeout <seconds>] [--notify]
  agent stop <handle>

options:
  --name <name>  --agent <role>  --model <provider/model>  --thinking <level> | --effort <low|medium|high|max>
  --tools <a,b>  --read-only <path,path>  --system-prompt <text> | --system-prompt-file <path>
  --background-after <seconds>  --persist-session | --no-persist-session

A synchronous run removes the scoop's folder afterwards. Its transcript is archived in
/tmp/agent-sessions/<handle>.md, in /home/sessions/<handle>.md with --persist-session, or nowhere
with --no-persist-session. subagent is the same command: subagent spawn = agent --async.
`;

export interface CliOptions {
  env: ExecutionEnv;
  harness: Harness;
  agents: Agents;
  scoops: Scoops;
  roles: () => Promise<Roles>;
  alive?: (pid: number) => Promise<boolean>;
  now?: () => number;
  sprinkle?: (argv: readonly string[], caller: string | null, context: Context) => Promise<Answer>;
  memory?: (argv: readonly string[], caller: string | null, context: Context) => Promise<Answer>;
}

export type Deps = CliOptions & { now: () => number; sync: SyncState };

export interface Caller {
  id: string | null;
  cone: string;
  fromAgent: boolean;
  scoop: string | null;
  depth: number;
}

export type Flags = { values: Map<string, string[]>; switches: Set<string>; rest: string[] };

export const ok = (out: string): Answer => ({ code: 0, out });
export const fail = (out: string, code = 1): Answer => ({ code, out: `agent: ${out}\n` });

export function isAnswer(value: unknown): value is Answer {
  return typeof value === 'object' && value !== null && 'code' in value && 'out' in value;
}

export function flags(argv: readonly string[], withValue: readonly string[]): Flags {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at] as string;
    if (withValue.includes(arg)) {
      const value = argv[at + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      values.set(arg, [...(values.get(arg) ?? []), value]);
      at++;
    } else if (arg.startsWith('--')) switches.add(arg);
    else rest.push(arg);
  }
  return { values, switches, rest };
}

export function last(parsed: Flags, flag: string): string | undefined {
  return parsed.values.get(flag)?.at(-1);
}

export function callerOf(agents: Agents, request: Request): Caller {
  const state = agents.state();
  if (request.caller.startsWith('cone:') && state.cones[request.caller.slice(5)]) {
    const cone = request.caller.slice(5);
    return { id: `cone:${cone}`, cone, fromAgent: true, scoop: null, depth: 0 };
  }
  const record = request.caller.startsWith('scoop:') ? state.scoops[request.caller] : undefined;
  if (record)
    return {
      id: request.caller,
      cone: record.cone,
      fromAgent: true,
      scoop: request.caller,
      depth: record.depth,
    };
  return { id: null, cone: agents.activeCone(), fromAgent: false, scoop: null, depth: 0 };
}

export async function readText(
  deps: Deps,
  value: string,
  request: Request,
  context: Context
): Promise<string> {
  const read = await deps.env.readTextFile(resolve(request.cwd, value), context);
  if (!read.ok) throw new Error(`can't read ${value}: ${read.error.message}`);
  return read.value;
}

export async function prompts(
  deps: Deps,
  argv: readonly string[],
  request: Request,
  context: Context
) {
  const out: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === '--prompt') out.push(argv[++at] ?? '');
    else if (arg === '--file') out.push(await readText(deps, argv[++at] ?? '', request, context));
    else if (arg === '-') out.push(request.stdin);
  }
  return out.filter((prompt) => prompt.trim());
}

export type Choice = {
  model?: { provider: string; modelId: string };
  thinking?: string;
  tools?: string[];
};

function toolList(listed: string | undefined): string[] | undefined {
  if (listed === undefined || listed === 'auto' || listed === 'full') return undefined;
  return listed
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
}

export function choices(parsed: Flags): Choice | Answer {
  const provider = last(parsed, '--provider');
  const modelText = last(parsed, '--model');
  const model = modelText
    ? provider
      ? { provider, modelId: modelText }
      : modelOf(modelText)
    : undefined;
  if (modelText && !model)
    return fail('--model needs provider/model, or --provider with --model', 2);
  const effort = last(parsed, '--effort');
  if (effort && !EFFORT[effort]) return fail('--effort must be low, medium, high or max', 2);
  const thinking = last(parsed, '--thinking') ?? (effort ? EFFORT[effort] : undefined);
  if (thinking && !THINKING.has(thinking))
    return fail(`--thinking must be one of ${[...THINKING].join(', ')}`, 2);
  if (last(parsed, '--tools') === 'output')
    return fail('--tools output needs --schema-b64, which is not supported in SLICC yet', 2);
  const tools = toolList(last(parsed, '--tools'));
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools ? { tools } : {}),
  };
}

export async function role(deps: Deps, parsed: Flags) {
  const roles = await deps.roles();
  const name = last(parsed, '--agent');
  const found = name ? findRole(roles.roles, name) : undefined;
  if (name && !found)
    return {
      roles,
      error: fail(`there is no agent role ${name}; \`agent list --agents\` shows them`),
    };
  return { roles, role: found };
}

function handle(deps: Deps, who: Caller, name: string | undefined) {
  return name ? findScoop(deps.agents.state(), name, who.fromAgent ? who.cone : null) : undefined;
}

const ASYNC_VALUES = [
  '--name',
  '--agent',
  '--provider',
  '--model',
  '--thinking',
  '--effort',
  '--tools',
  '--prompt',
  '--file',
];
const ASYNC_SWITCHES = new Set(['--async', '--no-extensions', '--no-skills', '--no-context-files']);
const UNSUPPORTED = new Set([
  '--no-prompt-templates',
  '--session',
  '--resume',
  '--image',
  '--no-escalate',
  '--minimal',
  '--usage',
  '--schema-b64',
  '--cwd',
]);

export function unsupported(argv: readonly string[]): Answer | undefined {
  const found = argv.find((arg) => UNSUPPORTED.has(arg) || arg.startsWith('--image='));
  return found ? fail(`${found} is not supported in SLICC yet`, 2) : undefined;
}

async function spawnAsync(
  deps: Deps,
  request: Request,
  who: Caller,
  argv: readonly string[],
  context: Context
) {
  if (who.scoop) return fail('a scoop cannot start async scoops; run agent without --async');
  const refused = unsupported(argv);
  if (refused) return refused;
  const parsed = flags(argv, ASYNC_VALUES);
  const unknown = [...parsed.switches].find((flag) => !ASYNC_SWITCHES.has(flag));
  if (unknown) return fail(`unknown option ${unknown}`, 2);
  const given = await prompts(deps, argv, request, context);
  if (!given.length) return fail('--async needs at least one --prompt, --file or -', 2);
  const chosen = choices(parsed);
  if (isAnswer(chosen)) return chosen;
  const found = await role(deps, parsed);
  if (found.error) return found.error;
  return deps.scoops.spawn(
    {
      cone: who.cone,
      kind: 'async',
      name: last(parsed, '--name') ?? found.role?.name ?? 'scoop',
      ...(found.role ? { role: found.role } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.thinking ? { thinking: chosen.thinking as never } : {}),
      ...(chosen.tools ? { tools: chosen.tools } : {}),
      prompts: given,
      origin: request.cwd,
      fromAgent: who.fromAgent,
      request: request.id,
      limits: found.roles.limits,
    },
    context
  );
}

async function listAgents(deps: Deps): Promise<Answer> {
  const roles = await deps.roles();
  const lines = roles.roles.map(
    (entry) =>
      `${entry.name}\t${entry.source}\t${entry.description}${entry.aliases.length ? ` (also ${entry.aliases.join(', ')})` : ''}`
  );
  return ok(
    `${[
      ...lines,
      '',
      'Agent files are read from the built-in roles, installed packages (pi-subagents.agents) and ~/.pi/agent/agents.',
      "A project's .pi/agents folder is read only once the folder is trusted, which SLICC doesn't support yet.",
      ...roles.warnings.map((warning) => `warning: ${warning}`),
    ].join('\n')}\n`
  );
}

async function list(deps: Deps, request: Request, who: Caller, context: Context): Promise<Answer> {
  if (request.argv.includes('--agents')) return listAgents(deps);
  const rows = await deps.scoops.list(who.cone, context);
  if (!rows.length) return ok('no scoops\n');
  return ok(
    `${rows.map((row) => `${row.folder}\t${row.name}\t${row.role ?? '-'}\t${row.busy ? 'working' : 'idle'}`).join('\n')}\n`
  );
}

async function status(
  deps: Deps,
  request: Request,
  who: Caller,
  context: Context
): Promise<Answer> {
  const found = handle(deps, who, request.argv[1]);
  if (!found) return fail(`there is no scoop ${request.argv[1] ?? ''}`.trim());
  const [, record] = found;
  const busy = await deps.scoops.busy(record.conversation, context);
  return ok(
    `${[
      `handle: ${record.folder}`,
      `name: ${record.name}`,
      `role: ${record.role ?? '-'}`,
      `kind: ${record.kind}`,
      `state: ${busy ? 'working' : 'idle'}`,
      `folder: ${SCOOPS_ROOT}/${record.folder}`,
      `reports: ${SCOOPS_ROOT}/${record.folder}/reports`,
    ].join('\n')}\n`
  );
}

async function message(
  deps: Deps,
  parsed: Flags,
  request: Request,
  context: Context
): Promise<string> {
  const file = last(parsed, '--file');
  if (file) return readText(deps, file, request, context);
  return parsed.rest.includes('-') ? request.stdin : parsed.rest.join(' ');
}

async function send(deps: Deps, request: Request, who: Caller, context: Context): Promise<Answer> {
  const parsed = flags(request.argv.slice(2), ['--file']);
  const unknown = [...parsed.switches].find((flag) => flag !== '--follow-up');
  if (unknown) return fail(`unknown option ${unknown}`, 2);
  const text = await message(deps, parsed, request, context);
  if (!text.trim()) return fail('send needs a message, --file or -', 2);
  if (request.argv[1] === 'parent') {
    if (!who.scoop) return fail('only a scoop has a parent to send to');
    return deps.scoops.note(who.scoop, text, context);
  }
  if (who.scoop) return fail('a scoop can only send to its parent');
  const found = handle(deps, who, request.argv[1]);
  if (!found) return fail(`there is no scoop ${request.argv[1] ?? ''}`.trim());
  const followUp = parsed.switches.has('--follow-up');
  return deps.scoops.feed(
    found[0],
    text,
    { fromAgent: who.fromAgent, request: request.id, followUp, target: who.id },
    context
  );
}

async function latest(deps: Deps, folder: string, context: Context): Promise<string> {
  const dir = `${SCOOPS_ROOT}/${folder}/reports`;
  const listed = await deps.env.listDir(dir, context);
  if (!listed.ok || !listed.value.length) return '(no answer yet)';
  const newest = [...listed.value].sort(
    (a, b) => Number.parseInt(b.name, 10) - Number.parseInt(a.name, 10)
  )[0];
  const read = await deps.env.readTextFile(`${dir}/${newest?.name}`, context);
  return read.ok ? read.value.trimEnd() : '(no answer yet)';
}

function waitTargets(deps: Deps, who: Caller, rest: readonly string[]): string[] | Answer {
  if (!rest.length) return fail('wait needs at least one handle', 2);
  const missing = rest.filter((name) => !handle(deps, who, name));
  if (missing.length) return fail(`there is no scoop ${missing.join(', ')}`);
  return rest.map((name) => (handle(deps, who, name) as [string, unknown])[0]);
}

async function block(
  deps: Deps,
  ids: string[],
  seconds: number,
  context: Context
): Promise<Answer> {
  const deadline = deps.now() + seconds * 1000;
  let open = await deps.scoops.working(ids, context);
  while (open.length && deps.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200));
    open = await deps.scoops.working(ids, context);
  }
  const state = deps.agents.state();
  const sections: string[] = [];
  for (const id of ids) {
    const record = state.scoops[id];
    if (record)
      sections.push(
        `## ${record.folder}${open.includes(id) ? ' (still working)' : ''}\n${await latest(deps, record.folder, context)}`
      );
  }
  const body = `${sections.join('\n\n')}\n`;
  if (!open.length) return ok(body);
  const still = open.map((id) => state.scoops[id]?.folder).join(', ');
  return { code: 1, out: `${body}agent: timed out after ${seconds}s; still working: ${still}\n` };
}

async function wait(deps: Deps, request: Request, who: Caller, context: Context): Promise<Answer> {
  const parsed = flags(request.argv.slice(1), ['--timeout']);
  const unknown = [...parsed.switches].find((flag) => flag !== '--notify');
  if (unknown) return fail(`unknown option ${unknown}`, 2);
  const seconds = Number(last(parsed, '--timeout') ?? DEFAULT_WAIT_S);
  if (!Number.isInteger(seconds) || seconds <= 0)
    return fail('--timeout must be a positive whole number of seconds', 2);
  const ids = waitTargets(deps, who, parsed.rest);
  if (isAnswer(ids)) return ids;
  if (!parsed.switches.has('--notify')) return block(deps, ids, seconds, context);
  if (!who.fromAgent || who.scoop)
    return fail('wait --notify is for a cone; a terminal waits with agent wait');
  await deps.scoops.notifyWhenDone(who.cone, ids, deps.now() + seconds * 1000, context);
  return ok(`you'll get one scoop-wait lick when ${ids.length > 1 ? 'they are' : 'it is'} done\n`);
}

async function stop(deps: Deps, request: Request, who: Caller, context: Context): Promise<Answer> {
  if (who.scoop) return fail('a scoop cannot stop scoops');
  const found = handle(deps, who, request.argv[1]);
  if (!found) return fail(`there is no scoop ${request.argv[1] ?? ''}`.trim());
  return deps.scoops.stop(found[0], who.fromAgent, context);
}

async function rename(
  deps: Deps,
  request: Request,
  who: Caller,
  context: Context
): Promise<Answer> {
  if (who.scoop) return fail('a scoop cannot rename scoops');
  const found = handle(deps, who, request.argv[1]);
  if (!found) return fail(`there is no scoop ${request.argv[1] ?? ''}`.trim());
  return deps.scoops.rename(found[0], request.argv.slice(2).join(' '), context);
}

type Verb = (deps: Deps, request: Request, who: Caller, context: Context) => Promise<Answer>;

const help: Verb = async () => ok(USAGE);

const VERBS: Record<string, Verb> = {
  list,
  status,
  send,
  wait,
  stop,
  rename,
  help,
  '--help': help,
  '-h': help,
  __cancel: (deps, request, _who, context) => cancelSync(deps, request.argv[1] ?? '', context),
  __detach: (deps, request, _who, context) => detachSync(deps, request.argv[1] ?? '', context),
};

async function dispatch(
  deps: Deps,
  request: Request,
  who: Caller,
  context: Context
): Promise<Answer> {
  if (request.as === 'sprinkle')
    return deps.sprinkle
      ? deps.sprinkle(request.argv, who.id, context)
      : fail('sprinkles are not available in this agent');
  if (request.as === 'memory')
    return deps.memory
      ? deps.memory(request.argv, who.id, context)
      : fail('memory is not available in this agent');
  const first = request.argv[0] ?? '';
  const verb = VERBS[first];
  if (verb) return verb(deps, request, who, context);
  if (request.as === 'subagent') {
    if (first === 'spawn') return spawnAsync(deps, request, who, request.argv.slice(1), context);
    return { code: 2, out: USAGE };
  }
  if (!request.argv.length) return { code: 2, out: USAGE };
  if (request.argv.includes('--async'))
    return spawnAsync(deps, request, who, request.argv, context);
  return runSync(deps, request, who, context);
}

const BLOCKING = new Set([
  'wait',
  'list',
  'status',
  'help',
  '--help',
  '-h',
  '__cancel',
  '__detach',
]);

export function createCli(options: CliOptions): Runner {
  const deps: Deps = { ...options, now: options.now ?? Date.now, sync: { pending: new Map() } };
  return {
    blocking(request) {
      const first = request.argv[0] ?? '';
      if (BLOCKING.has(first)) return true;
      return request.as === 'agent' && !VERBS[first] && !request.argv.includes('--async');
    },
    async run(request, context) {
      try {
        return await dispatch(deps, request, callerOf(options.agents, request), context);
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  };
}
