import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { AgentsState } from '../agents.ts';
import { homeOf } from '../kernel/accounts.ts';
import { quote } from '../kernel/env.ts';
import type { KernelUsers } from '../kernel/users.ts';
import { writeTable } from '../licks/crontab.ts';
import { IMPORTS_DIR } from './paths.ts';
import { DIRECTORY_ROOT } from './v6-schema.ts';
import { ImportError } from './zip.ts';

export type Step =
  | { made: string }
  | { file: string; backup: string | null }
  | { moved: string; to: string; mode: string | null }
  | { cron: string; backup: string | null };

export type Header = { key: string; at: number; cones: string[]; source: string | null };

export type Undoing = {
  env: ExecutionEnv;
  users?: Pick<KernelUsers, 'remove'> | undefined;
  state: () => Readonly<AgentsState>;
};

const HEADER = 'journal.json';
const STEPS = 'journal';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = (value: unknown) => typeof value === 'string' && value.startsWith('/');
const backup = (value: unknown) => value === null || text(value);

function stepOf(value: unknown): Step | undefined {
  const step = value as Record<string, unknown> | null;
  if (typeof step !== 'object' || step === null) return undefined;
  if (text(step.made)) return step as Step;
  if (text(step.file) && backup(step.backup)) return step as Step;
  if (text(step.moved) && text(step.to)) return step as Step;
  if (typeof step.cron === 'string' && backup(step.backup)) return step as Step;
  return undefined;
}

function headerOf(value: unknown): Header | undefined {
  const header = value as Partial<Header> | null;
  return typeof header?.key === 'string' &&
    typeof header.at === 'number' &&
    Array.isArray(header.cones) &&
    header.cones.every((cone) => typeof cone === 'string' && /^cone-\d+$/.test(cone)) &&
    (header.source === null || header.source?.startsWith(`${DIRECTORY_ROOT}/`))
    ? (header as Header)
    : undefined;
}

const UNREAD = Symbol('unread');
const ABSENT = new Set(['not_found', 'not_directory']);

async function jsonIn(env: ExecutionEnv, path: string): Promise<unknown> {
  const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
  if (!read.ok) return (await exists(env, path)) === false ? undefined : UNREAD;
  try {
    return JSON.parse(read.value);
  } catch {
    return undefined;
  }
}

async function stepsIn(env: ExecutionEnv, dir: string): Promise<Step[] | undefined> {
  const listed = await env.listDir(`${dir}/${STEPS}`, BACKGROUND_CONTEXT);
  if (!listed.ok) return undefined;
  const numbers = listed.value
    .map((item) => /^(\d+)\.json$/.exec(item.name)?.[1])
    .filter((name): name is string => name !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const steps: Step[] = [];
  for (const n of numbers) {
    const value = await jsonIn(env, `${dir}/${STEPS}/${n}.json`);
    if (value === UNREAD) return undefined;
    const step = stepOf(value);
    if (step) steps.push(step);
  }
  return steps;
}

async function exists(env: ExecutionEnv, path: string): Promise<boolean | undefined> {
  const found = await env.exists(path, BACKGROUND_CONTEXT);
  if (found.ok) return found.value;
  return ABSENT.has(found.error.code) ? false : undefined;
}

async function bytesOf(env: ExecutionEnv, path: string | null): Promise<Uint8Array | null> {
  if (path === null) return null;
  const read = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
  return read.ok ? read.value : null;
}

const done = (result: { ok: boolean }) => result.ok;

async function gone(env: ExecutionEnv, path: string, recursive = true): Promise<boolean> {
  const removed = await env.remove(path, { recursive, force: true }, BACKGROUND_CONTEXT);
  return removed.ok || (await exists(env, path)) === false;
}

async function undoStep(deps: Undoing, step: Step, owners: Map<string, string[]>) {
  const { env } = deps;
  if ('made' in step) return gone(env, step.made);
  if ('file' in step) {
    if (step.backup === null) return gone(env, step.file, false);
    const old = await bytesOf(env, step.backup);
    return old !== null && done(await env.writeFile(step.file, old, BACKGROUND_CONTEXT));
  }
  if ('moved' in step) {
    const there = await exists(env, step.moved);
    const to = await exists(env, step.to);
    if (there === undefined || to === undefined) return false;
    if (!there && !to) return true;
    const back = there || done(await env.renameFile(step.to, step.moved, BACKGROUND_CONTEXT));
    if (back && step.mode) owners.set(step.mode, [...(owners.get(step.mode) ?? []), step.moved]);
    return back;
  }
  if (step.backup === null)
    return done(await env.exec(`crontab -u ${quote(step.cron)} -r`, undefined, BACKGROUND_CONTEXT));
  const old = await bytesOf(env, step.backup);
  return (
    old !== null &&
    (await writeTable(env, step.cron, decoder.decode(old), BACKGROUND_CONTEXT)).code === 0
  );
}

async function chownAll(env: ExecutionEnv, owners: Map<string, string[]>) {
  let all = true;
  for (const [both, paths] of owners) {
    const [owner, mode] = both.split(' ') as [string, string];
    for (let at = 0; at < paths.length; at += 200) {
      const list = paths
        .slice(at, at + 200)
        .map(quote)
        .join(' ');
      const ran = await env.exec(
        `chown ${quote(owner)} -- ${list} && chmod ${quote(mode)} -- ${list}`,
        undefined,
        BACKGROUND_CONTEXT
      );
      all = all && ran.ok && ran.value.exitCode === 0;
    }
  }
  return all;
}

function named(state: Readonly<AgentsState>, cone: string): boolean {
  return (
    state.cones[cone] !== undefined ||
    Object.values(state.frozen ?? {}).some((record) => record.cone === cone)
  );
}

const fails = () => false;

async function removeCone(deps: Undoing, cone: string) {
  const user = (await deps.users?.remove(cone).then(() => true, fails)) ?? true;
  const home = await gone(deps.env, homeOf(cone)).catch(fails);
  return user && home;
}

export async function undo(deps: Undoing, header: Header, steps: readonly Step[]) {
  const owners = new Map<string, string[]>();
  let all = true;
  for (const step of [...steps].reverse())
    all = (await undoStep(deps, step, owners).catch(fails)) && all;
  all = (await chownAll(deps.env, owners).catch(fails)) && all;
  for (const cone of header.cones)
    if (!named(deps.state(), cone)) all = (await removeCone(deps, cone)) && all;
  return all;
}

async function settle(deps: Undoing, dir: string) {
  const value = await jsonIn(deps.env, `${dir}/${HEADER}`);
  if (value === UNREAD) return false;
  const header = headerOf(value);
  if (!header) return true;
  if (deps.state().imports?.[header.key]?.at !== header.at) {
    const steps = await stepsIn(deps.env, dir);
    return steps !== undefined && undo(deps, header, steps);
  }
  if (!header.source) return true;
  return gone(deps.env, header.source);
}

export async function sweep(deps: Undoing): Promise<string[]> {
  const listed = await deps.env.listDir(IMPORTS_DIR, BACKGROUND_CONTEXT);
  if (!listed.ok) return (await exists(deps.env, IMPORTS_DIR)) === false ? [] : [IMPORTS_DIR];
  const kept: string[] = [];
  for (const item of listed.value) {
    if (item.kind !== 'directory') continue;
    const dir = `${IMPORTS_DIR}/${item.name}`;
    if (!((await settle(deps, dir)) && (await gone(deps.env, dir)))) kept.push(dir);
  }
  return kept;
}

export class Journal {
  readonly #deps: Undoing;
  readonly #dir: string;
  readonly #steps: Step[] = [];
  #header: Header | undefined;
  #next = 0;

  constructor(deps: Undoing, dir: string) {
    this.#deps = deps;
    this.#dir = dir;
  }

  async #write(path: string, bytes: Uint8Array | string, context: Context) {
    const written = await this.#deps.env.writeFile(path, bytes, context);
    if (!written.ok) throw new ImportError(`couldn't write ${path}: ${written.error.message}`);
  }

  async open(header: Header, context: Context): Promise<void> {
    const made = await this.#deps.env.createDir(
      `${this.#dir}/${STEPS}`,
      { recursive: true },
      context
    );
    if (!made.ok) throw new ImportError(`couldn't write ${this.#dir}: ${made.error.message}`);
    await this.#write(`${this.#dir}/${HEADER}`, JSON.stringify(header), context);
    this.#header = header;
  }

  async backup(bytes: Uint8Array | string, context: Context): Promise<string> {
    const path = `${this.#dir}/${STEPS}/${this.#next++}`;
    await this.#write(path, typeof bytes === 'string' ? encoder.encode(bytes) : bytes, context);
    return path;
  }

  async log(step: Step, context: Context): Promise<void> {
    await this.#write(`${this.#dir}/${STEPS}/${this.#next++}.json`, JSON.stringify(step), context);
    this.#steps.push(step);
  }

  async rollback(): Promise<boolean> {
    return this.#header ? undo(this.#deps, this.#header, this.#steps) : true;
  }

  async close(): Promise<void> {
    await this.#deps.env.remove(`${this.#dir}/${HEADER}`, { force: true }, BACKGROUND_CONTEXT);
    await this.#deps.env.remove(
      `${this.#dir}/${STEPS}`,
      { recursive: true, force: true },
      BACKGROUND_CONTEXT
    );
  }
}
