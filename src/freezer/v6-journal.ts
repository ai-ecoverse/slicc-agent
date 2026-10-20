import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { AgentsState } from '../agents.ts';
import { homeOf } from '../kernel/accounts.ts';
import { quote } from '../kernel/env.ts';
import type { KernelUsers } from '../kernel/users.ts';
import { writeTable } from '../licks/crontab.ts';
import { IMPORTS_DIR } from './paths.ts';
import { ImportError } from './zip.ts';

export type Step =
  | { made: string }
  | { file: string; backup: string | null }
  | { moved: string; to: string; mode: string | null }
  | { cron: string; backup: string | null };

export type Header = { key: string; at: number; cones: string[] };

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
    header.cones.every((cone) => typeof cone === 'string' && /^cone-\d+$/.test(cone))
    ? (header as Header)
    : undefined;
}

async function jsonIn(env: ExecutionEnv, path: string): Promise<unknown> {
  const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
  if (!read.ok) return undefined;
  try {
    return JSON.parse(read.value);
  } catch {
    return undefined;
  }
}

async function stepsIn(env: ExecutionEnv, dir: string): Promise<Step[]> {
  const listed = await env.listDir(`${dir}/${STEPS}`, BACKGROUND_CONTEXT);
  if (!listed.ok) return [];
  const numbers = listed.value
    .map((item) => /^(\d+)\.json$/.exec(item.name)?.[1])
    .filter((name): name is string => name !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const steps: Step[] = [];
  for (const n of numbers) {
    const step = stepOf(await jsonIn(env, `${dir}/${STEPS}/${n}.json`));
    if (step) steps.push(step);
  }
  return steps;
}

async function exists(env: ExecutionEnv, path: string): Promise<boolean> {
  const found = await env.exists(path, BACKGROUND_CONTEXT);
  return found.ok && found.value;
}

async function bytesOf(env: ExecutionEnv, path: string | null): Promise<Uint8Array | null> {
  if (path === null) return null;
  const read = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
  return read.ok ? read.value : null;
}

async function undoStep(deps: Undoing, step: Step, owners: Map<string, string[]>) {
  const { env } = deps;
  if ('made' in step)
    await env.remove(step.made, { recursive: true, force: true }, BACKGROUND_CONTEXT);
  else if ('file' in step) {
    const old = await bytesOf(env, step.backup);
    if (old) await env.writeFile(step.file, old, BACKGROUND_CONTEXT);
    else if (step.backup === null) await env.remove(step.file, { force: true }, BACKGROUND_CONTEXT);
  } else if ('moved' in step) {
    if ((await exists(env, step.moved)) || !(await exists(env, step.to))) return;
    const back = await env.renameFile(step.to, step.moved, BACKGROUND_CONTEXT);
    if (back.ok && step.mode) owners.set(step.mode, [...(owners.get(step.mode) ?? []), step.moved]);
  } else {
    const old = await bytesOf(env, step.backup);
    if (old) await writeTable(env, step.cron, decoder.decode(old), BACKGROUND_CONTEXT);
    else await env.exec(`crontab -u ${quote(step.cron)} -r`, undefined, BACKGROUND_CONTEXT);
  }
}

async function chownAll(env: ExecutionEnv, owners: Map<string, string[]>) {
  for (const [both, paths] of owners) {
    const [owner, mode] = both.split(' ') as [string, string];
    for (let at = 0; at < paths.length; at += 200) {
      const list = paths
        .slice(at, at + 200)
        .map(quote)
        .join(' ');
      await env.exec(
        `chown ${quote(owner)} -- ${list} && chmod ${quote(mode)} -- ${list}`,
        undefined,
        BACKGROUND_CONTEXT
      );
    }
  }
}

function named(state: Readonly<AgentsState>, cone: string): boolean {
  return (
    state.cones[cone] !== undefined ||
    Object.values(state.frozen ?? {}).some((record) => record.cone === cone)
  );
}

export async function undo(deps: Undoing, header: Header, steps: readonly Step[]) {
  const owners = new Map<string, string[]>();
  for (const step of [...steps].reverse())
    await undoStep(deps, step, owners).catch(() => undefined);
  await chownAll(deps.env, owners).catch(() => undefined);
  for (const cone of header.cones) {
    if (named(deps.state(), cone)) continue;
    await deps.users?.remove(cone).catch(() => false);
    await deps.env
      .remove(homeOf(cone), { recursive: true, force: true }, BACKGROUND_CONTEXT)
      .catch(() => undefined);
  }
}

export async function sweep(deps: Undoing): Promise<void> {
  const listed = await deps.env.listDir(IMPORTS_DIR, BACKGROUND_CONTEXT);
  if (!listed.ok) return;
  for (const item of listed.value) {
    if (item.kind !== 'directory') continue;
    const dir = `${IMPORTS_DIR}/${item.name}`;
    const header = headerOf(await jsonIn(deps.env, `${dir}/${HEADER}`));
    if (header && deps.state().imports?.[header.key]?.at !== header.at)
      await undo(deps, header, await stepsIn(deps.env, dir));
    await deps.env.remove(dir, { recursive: true, force: true }, BACKGROUND_CONTEXT);
  }
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

  async rollback(): Promise<void> {
    if (this.#header) await undo(this.#deps, this.#header, this.#steps);
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
