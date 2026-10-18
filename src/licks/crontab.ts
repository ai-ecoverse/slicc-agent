import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { quote } from '../kernel/env.ts';
import { isName, isTarget } from './config.ts';
import type { LickTarget } from './lick.ts';
import type { LickEvent } from './licks.ts';

export interface CronJob {
  name: string;
  schedule: string;
  command: string;
  line?: number;
}

export interface CronProblem {
  line?: number;
  error: string;
}

export interface LegacyJob {
  name: string;
  schedule: string;
  target: LickTarget;
  message: string;
  line: number;
}

const NAMED = /^#\s*name:\s*(\S+)\s*$/;
const SCHEDULED = /^(@\S+|(?:\S+\s+){4}\S+)\s+(.*)$/;
const REFUSED = /^"[^"]*":(\d+): (.*)$/;

function legacyLine(text: string, line: number): LegacyJob {
  const tokens = text.split(/\s+/);
  const at = (tokens[0] as string).startsWith('@') ? 1 : 5;
  const [name, maybeTarget, ...words] = tokens.slice(at);
  if (name === undefined) throw new Error('a name must follow the schedule');
  if (!isName(name))
    throw new Error(
      `name "${name}" must be 1–64 of a-z, 0-9, ".", "_" or "-", starting with a letter or digit`
    );
  const target = maybeTarget !== undefined && isTarget(maybeTarget) ? maybeTarget : 'cone';
  const message = (target === maybeTarget ? words : [maybeTarget, ...words])
    .filter(Boolean)
    .join(' ');
  return { name, schedule: tokens.slice(0, at).join(' '), target, message, line };
}

export function legacyJobs(text: string): { jobs: LegacyJob[]; problems: CronProblem[] } {
  const jobs: LegacyJob[] = [];
  const problems: CronProblem[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    try {
      const job = legacyLine(line, index + 1);
      if (seen.has(job.name)) throw new Error(`name "${job.name}" is used twice`);
      seen.add(job.name);
      jobs.push(job);
    } catch (error) {
      problems.push({ line: index + 1, error: (error as Error).message });
    }
  });
  return { jobs, problems };
}

export function sendCommand(target: LickTarget, message: string, lick = true): string {
  return `agent send ${target}${lick ? ' --lick=cron' : ''}${message ? ` ${quote(message)}` : ''}`;
}

export function relicked(table: string, jobs: readonly LegacyJob[]): string | undefined {
  const named = new Map(jobs.map((job) => [job.name, job]));
  const lines = table.split('\n');
  let changed = false;
  for (let at = 0; at + 1 < lines.length; at++) {
    const job = named.get(NAMED.exec((lines[at] as string).trim())?.[1] ?? '');
    const parts = SCHEDULED.exec((lines[at + 1] as string).trim());
    if (!job || !parts || parts[2] !== sendCommand(job.target, job.message, false)) continue;
    lines[at + 1] = `${parts[1]} ${sendCommand(job.target, job.message)}`;
    changed = true;
  }
  return changed ? lines.join('\n') : undefined;
}

type Ran = { code: number; out: string; err: string };

async function sh(env: ExecutionEnv, command: string, context: Context): Promise<Ran> {
  let out = '';
  let err = '';
  const ran = await env.exec(
    command,
    {
      onOutput: (text, _context, info) => {
        if (info.stream === 'stdout') out += text;
        else err += text;
      },
    },
    context
  );
  return ran.ok
    ? { code: ran.value.exitCode, out, err }
    : { code: -1, out, err: ran.error.message };
}

export async function readTable(
  env: ExecutionEnv,
  user: string,
  context: Context
): Promise<string | CronProblem> {
  const ran = await sh(env, `crontab -u ${quote(user)} -l`, context);
  if (ran.code === 0) return ran.out;
  if (ran.err.startsWith('no crontab for ')) return '';
  return { error: ran.err.trim() || `crontab -l exited with ${ran.code}` };
}

export function withoutJobs(table: string, names: ReadonlySet<string>): string[] {
  const lines = table.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const named = NAMED.exec((lines[at] as string).trim());
    if (named && names.has(named[1] as string)) at++;
    else out.push(lines[at] as string);
  }
  return out;
}

export function scheduleOf(table: string, name: string): string | undefined {
  const lines = table.split('\n');
  const at = lines.findIndex((line) => NAMED.exec(line.trim())?.[1] === name);
  const job = at < 0 ? undefined : lines[at + 1]?.trim();
  if (!job) return undefined;
  const tokens = job.split(/\s+/);
  return tokens.slice(0, (tokens[0] as string).startsWith('@') ? 1 : 5).join(' ');
}

function refusals(err: string, origin: ReadonlyMap<number, number | undefined>): CronProblem[] {
  const out: CronProblem[] = [];
  for (const text of err.split('\n')) {
    const refused = REFUSED.exec(text);
    if (!refused) continue;
    const line = origin.get(Number(refused[1]));
    out.push({ ...(line === undefined ? {} : { line }), error: refused[2] as string });
  }
  return out;
}

export async function installJobs(
  env: ExecutionEnv,
  user: string,
  jobs: readonly CronJob[],
  context: Context
): Promise<CronProblem[]> {
  const current = await readTable(env, user, context);
  if (typeof current !== 'string') return [current];
  const lines = withoutJobs(current, new Set(jobs.map((job) => job.name)));
  const origin = new Map<number, number | undefined>();
  for (const job of jobs) {
    lines.push(`# name: ${job.name}`);
    origin.set(lines.length, job.line);
    lines.push(`${job.schedule} ${job.command}`);
    origin.set(lines.length, job.line);
  }
  const ran = await writeTable(env, user, `${lines.join('\n')}\n`, context);
  if (ran.code === 0) return [];
  const found = refusals(ran.err, origin);
  return found.length ? found : [{ error: ran.err.trim() || `crontab exited with ${ran.code}` }];
}

function writeTable(env: ExecutionEnv, user: string, table: string, context: Context) {
  return sh(env, `printf %s ${quote(table)} | crontab -u ${quote(user)} -`, context);
}

export async function relickJobs(
  env: ExecutionEnv,
  user: string,
  jobs: readonly LegacyJob[],
  context: Context
): Promise<CronProblem[]> {
  const current = await readTable(env, user, context);
  if (typeof current !== 'string') return [current];
  const table = relicked(current, jobs);
  if (table === undefined) return [];
  const ran = await writeTable(env, user, table, context);
  return ran.code === 0 ? [] : [{ error: ran.err.trim() || `crontab exited with ${ran.code}` }];
}

export interface CronRun {
  job: string;
  due: string;
  missed: number;
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function cronText(run: CronRun, at: number): string {
  if (!run.missed) return `${run.job} fired at ${clock(at)}`;
  const more = run.missed > 1 ? `${run.missed} more fires were` : '1 more fire was';
  return `${run.job} was due at ${clock(at)}; ${more} missed while seven was closed`;
}

export function cronLick(run: CronRun, target: LickTarget, message: string): LickEvent {
  const due = Date.parse(run.due);
  const at = Number.isNaN(due) ? Date.now() : due;
  return {
    channel: 'cron',
    source: run.job,
    title: run.job,
    text: cronText(run, at),
    ...(message ? { body: message } : {}),
    count: 1 + run.missed,
    target,
    eventId: `${run.job}@${run.due}`,
  };
}
