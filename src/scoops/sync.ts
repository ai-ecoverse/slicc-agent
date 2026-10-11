import type { Context } from '@earendil-works/chord';
import type { ConversationId, EntryRecord, TaskId } from '@earendil-works/pi-durable';
import { answerText } from '../agent.ts';
import type { ScoopRecord } from '../agents.ts';
import { quote } from '../kernel/env.ts';
import { resolve } from '../kernel/paths.ts';
import {
  type Caller,
  choices,
  type Deps,
  fail,
  flags,
  isAnswer,
  last,
  MAX_DEPTH,
  prompts,
  readText,
  role,
  unsupported,
} from './cli.ts';
import type { ReportResult } from './extension.ts';
import type { Request } from './requests.ts';
import type { Answer } from './service.ts';

export { SESSIONS } from '../layout.ts';

type Ending = 'cancel' | 'detach';

interface Pending {
  end: (ending: Ending) => void;
}

export interface SyncState {
  pending: Map<string, Pending>;
}

const SYNC_VALUES = [
  '--name',
  '--agent',
  '--provider',
  '--model',
  '--thinking',
  '--effort',
  '--tools',
  '--prompt',
  '--file',
  '--read-only',
  '--system-prompt',
  '--system-prompt-file',
  '--background-after',
];
const SYNC_SWITCHES = new Set([
  '--persist-session',
  '--no-persist-session',
  '--no-extensions',
  '--no-skills',
  '--no-context-files',
]);

type Persist = 'tmp' | 'durable' | 'none';
type Kept = Exclude<Persist, 'none'>;

function persistOf(switches: Set<string>): Persist {
  if (switches.has('--no-persist-session')) return 'none';
  return switches.has('--persist-session') ? 'durable' : 'tmp';
}

function block(text: unknown): string {
  return typeof text === 'string' ? text : JSON.stringify(text, null, 2);
}

function entryMarkdown(entry: EntryRecord): string | undefined {
  const message = entry.model?.[0] as { content?: unknown; toolCallId?: string } | undefined;
  if (entry.kind === 'pi.user') return `## Request\n\n${answerText(message?.content)}`;
  if (entry.kind === 'pi.tool-result')
    return `### Result\n\n\`\`\`\n${answerText(message?.content)}\n\`\`\``;
  if (entry.kind !== 'pi.assistant') return undefined;
  const parts = Array.isArray(message?.content)
    ? (message.content as { type: string; name?: string; arguments?: unknown }[])
    : [];
  const calls = parts
    .filter((part) => part.type === 'toolCall')
    .map((part) => `\`${part.name}\` ${block(part.arguments)}`);
  return [`## Answer\n\n${answerText(message?.content)}`, ...calls].join('\n\n');
}

export function transcript(record: ScoopRecord, entries: readonly EntryRecord[]): string {
  const body = entries.map(entryMarkdown).filter(Boolean);
  return `# ${record.name}${record.role ? ` (${record.role})` : ''}\n\n${body.join('\n\n')}\n`;
}

async function archive(
  deps: Deps,
  record: ScoopRecord,
  persist: Persist,
  user: string | null,
  context: Context
): Promise<string | null> {
  if (persist === 'none') return null;
  const kept: Kept = persist;
  const conversation = await deps.harness.conversation(
    record.conversation as ConversationId,
    context
  );
  if (!conversation) return null;
  const { entries } = await conversation.context(context);
  const dir = deps.layout.sessions(kept, user);
  const path = `${dir}/${record.folder}.md`;
  if (kept === 'tmp') await deps.layout.ownDir(dir, user, context);
  const env = (await deps.layout.envFor(user, context)) ?? deps.env;
  const written = await env.writeFile(path, transcript(record, entries), context);
  return written.ok ? path : null;
}

async function finish(
  deps: Deps,
  id: string,
  persist: Persist,
  user: string | null,
  context: Context
): Promise<void> {
  const record = deps.agents.state().scoops[id];
  if (!record) return;
  await archive(deps, record, persist, user, context).catch(() => null);
  await deps.scoops.stop(id, false, context);
  await deps.env.remove(
    deps.layout.scoopRoot(record.folder),
    { recursive: true, force: true },
    context
  );
}

async function callerRunning(deps: Deps, who: Caller, context: Context): Promise<boolean> {
  if (!who.fromAgent) return false;
  const state = deps.agents.state();
  const conversation = who.scoop
    ? state.scoops[who.scoop]?.conversation
    : state.cones[who.cone]?.conversation;
  return conversation !== undefined && deps.scoops.busy(conversation, context);
}

async function keep(
  deps: Deps,
  id: string,
  tasks: readonly number[],
  target: string | null,
  context: Context
) {
  if (target) await deps.scoops.detach(tasks, target, context);
  await deps.agents.update((_tx, state) => {
    const record = state.scoops[id];
    if (record) record.kind = 'async';
  }, context);
}

function watchPid(deps: Deps, pid: number | null, end: (ending: Ending) => void): () => void {
  const alive = deps.alive;
  if (pid === null || !alive) return () => undefined;
  const timer = setInterval(() => {
    void alive(pid).then(
      (yes) => yes || end('cancel'),
      () => undefined
    );
  }, 1000);
  return () => clearInterval(timer);
}

export type Shared = { path: string; write: boolean };

export function sharesOf(
  home: string,
  cwd: string,
  workdir: string | undefined,
  readOnly: readonly string[]
): Shared[] {
  const inside = (path: string) => path.startsWith(`${home}/`);
  const out: Shared[] = [];
  if (workdir && inside(workdir)) out.push({ path: workdir, write: true });
  for (const path of [...readOnly, ...(workdir ? [] : [cwd])])
    if (inside(path) && !out.some((shared) => shared.path === path))
      out.push({ path, write: false });
  return out;
}

export function shareScript(home: string, shares: readonly Shared[]): string {
  const lines: string[] = [];
  for (const { path, write } of shares) {
    const at = quote(path);
    lines.push(`chmod -R ${write ? 'g+rwX' : 'g+rX'} ${at}`);
    if (write)
      lines.push(
        `shopt -s globstar dotglob nullglob; for dir in ${at} ${at}/**/; do chmod g+s "$dir"; done`
      );
    const parts = path
      .slice(home.length + 1)
      .split('/')
      .slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++)
      lines.push(`chmod g+x ${quote(`${home}/${parts.slice(0, depth).join('/')}`)}`);
  }
  return lines.join('\n');
}

export function shareNote(shares: readonly Shared[]): string {
  const listed = shares
    .map(({ path, write }) => `${path}${write ? ' (you may change files there)' : ' (read only)'}`)
    .join(', ');
  return `Your caller shared these with you through its group: ${listed}.`;
}

async function share(deps: Deps, request: Request, shares: readonly Shared[], context: Context) {
  const env = await deps.layout.envFor(request.user ?? null, context);
  if (!env || !shares.length) return;
  const home = deps.layout.homeOf(request.user ?? null);
  await env.exec(shareScript(home, shares), undefined, context);
}

interface Plan {
  given: string[];
  shares?: Shared[];
  workdir?: string;
  instructions: string;
  readOnly: string[];
  persist: Persist;
}

async function plan(
  deps: Deps,
  request: Request,
  parsed: ReturnType<typeof flags>,
  context: Context
) {
  const given = await prompts(deps, request.argv, request, context);
  let workdir: string | undefined;
  const notes: string[] = [];
  if (!given.length && parsed.rest.length === 3) {
    const [cwd, allowed, prompt] = parsed.rest as [string, string, string];
    workdir = resolve(request.cwd, cwd);
    if (allowed && allowed !== '*')
      notes.push(
        `Use only these commands in bash: ${allowed}. This is not enforced; keep to it anyway.`
      );
    given.push(prompt);
  } else if (parsed.rest.length) return fail(`unexpected argument ${parsed.rest[0]}`, 2);
  if (!given.length)
    return fail('agent needs --prompt, --file, - or <cwd> <allowed-commands> <prompt>', 2);
  const systemFile = last(parsed, '--system-prompt-file');
  const system =
    last(parsed, '--system-prompt') ??
    (systemFile ? await readText(deps, systemFile, request, context) : undefined);
  if (system) notes.push(system);
  const readOnly = (last(parsed, '--read-only') ?? '')
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => resolve(request.cwd, path));
  const home = deps.layout.homeOf(request.user ?? null);
  const shares = deps.layout.users ? sharesOf(home, request.cwd, workdir, readOnly) : [];
  if (shares.length) notes.push(shareNote(shares));
  if (workdir) notes.push(`Your working folder is ${workdir}; you may change files there.`);
  const result: Plan = {
    given,
    instructions: notes.join('\n\n'),
    readOnly,
    persist: persistOf(parsed.switches),
  };
  if (workdir) result.workdir = workdir;
  if (shares.length) result.shares = shares;
  return result;
}

async function outcome(
  deps: Deps,
  tasks: readonly number[],
  context: Context
): Promise<ReportResult> {
  let result: ReportResult = { text: '', failed: 'no request', path: null };
  for (const task of tasks) {
    const settled = await deps.harness.waitForTask(task as TaskId<ReportResult>, context);
    const outcome = settled.state.outcome;
    result =
      outcome.status === 'completed'
        ? outcome.result
        : { text: '', failed: outcome.status, path: null };
  }
  return result;
}

function answerOf(result: ReportResult): Answer {
  if (result.failed) return fail(`the scoop's request ended without an answer: ${result.failed}`);
  return { code: 0, out: result.text.endsWith('\n') ? result.text : `${result.text}\n` };
}

async function settle(
  deps: Deps,
  who: Caller,
  id: string,
  tasks: readonly number[],
  ending: Ending,
  context: Context
): Promise<Answer> {
  const handle = id.slice('scoop:'.length);
  if (ending === 'detach') {
    await keep(deps, id, tasks, who.id, context);
    const how = who.id ? 'its answer arrives as a lick' : `follow it with agent wait ${handle}`;
    return { code: 0, out: `${handle} continues in the background; ${how}\n` };
  }
  if (await callerRunning(deps, who, context)) {
    await keep(deps, id, tasks, who.id, context);
    return {
      code: 143,
      out: `agent: the call was interrupted; ${handle} continues and its answer arrives as a lick\n`,
    };
  }
  return { code: 130, out: 'agent: stopped\n' };
}

export async function runSync(
  deps: Deps,
  request: Request,
  who: Caller,
  context: Context
): Promise<Answer> {
  const refused = unsupported(request.argv);
  if (refused) return refused;
  if (who.depth >= MAX_DEPTH) return fail(`agents nest at most ${MAX_DEPTH} deep`);
  const parsed = flags(request.argv, SYNC_VALUES);
  const unknown = [...parsed.switches].find((flag) => !SYNC_SWITCHES.has(flag));
  if (unknown) return fail(`unknown option ${unknown}`, 2);
  const planned = await plan(deps, request, parsed, context);
  if (isAnswer(planned)) return planned;
  const chosen = choices(parsed);
  if (isAnswer(chosen)) return chosen;
  const found = await role(deps, parsed);
  if (found.error) return found.error;
  if (planned.shares) await share(deps, request, planned.shares, context);
  const spawned = await deps.scoops.spawn(
    {
      cone: who.cone,
      kind: 'sync',
      parent: who.scoop ?? who.cone,
      depth: who.depth + 1,
      roots: { write: planned.workdir ? [planned.workdir] : [], read: planned.readOnly },
      ...(planned.workdir ? { cwd: planned.workdir } : {}),
      ...(planned.instructions ? { instructions: planned.instructions } : {}),
      target: null,
      asker: who.id,
      name: last(parsed, '--name') ?? found.role?.name ?? 'agent',
      ...(found.role ? { role: found.role } : {}),
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.thinking ? { thinking: chosen.thinking as never } : {}),
      ...(chosen.tools ? { tools: chosen.tools } : {}),
      prompts: planned.given,
      origin: request.cwd,
      fromAgent: who.fromAgent,
      request: request.id,
      limits: found.roles.limits,
    },
    context
  );
  if (spawned.code !== 0) return spawned;
  const id = `scoop:${spawned.out.trim()}`;
  const tasks = spawned.tasks ?? [];
  let end: (ending: Ending) => void = () => undefined;
  const ended = new Promise<Ending>((done) => {
    end = done;
  });
  deps.sync.pending.set(request.id, { end });
  const unwatch = watchPid(deps, request.pid, end);
  try {
    const raced = await Promise.race([outcome(deps, tasks, context), ended]);
    if (typeof raced === 'string') {
      const answer = await settle(deps, who, id, tasks, raced, context);
      if (answer.code === 130)
        await finish(deps, id, planned.persist, request.user ?? null, context);
      return answer;
    }
    await finish(deps, id, planned.persist, request.user ?? null, context);
    return answerOf(raced);
  } finally {
    unwatch();
    deps.sync.pending.delete(request.id);
  }
}

export async function cancelSync(
  deps: Deps,
  requestId: string,
  _context: Context
): Promise<Answer> {
  deps.sync.pending.get(requestId)?.end('cancel');
  return { code: 0, out: '' };
}

export async function detachSync(
  deps: Deps,
  requestId: string,
  _context: Context
): Promise<Answer> {
  deps.sync.pending.get(requestId)?.end('detach');
  return { code: 0, out: '' };
}
