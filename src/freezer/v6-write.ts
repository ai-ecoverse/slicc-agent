import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv, Result } from '@earendil-works/pi-durable/env';
import { quote } from '../kernel/env.ts';
import { dirname } from '../kernel/paths.ts';
import { readTable, sendCommand, writeTable } from '../licks/crontab.ts';
import type { LickTarget } from '../licks/lick.ts';
import { byteLength, MAX_BYTES, MAX_LINES } from '../memory/format.ts';
import type { Journal } from './v6-journal.ts';
import { ImportError } from './zip.ts';

const encoder = new TextEncoder();

export function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

function done<T>(result: Result<T, { message: string }>, what: string): T {
  if (!result.ok) throw new ImportError(`couldn't write ${what}: ${result.error.message}`);
  return result.value;
}

const CHUNK = 200;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += CHUNK) out.push(items.slice(at, at + CHUNK));
  return out;
}

export class Writer {
  readonly #modes = new Map<string, string>();
  readonly env: ExecutionEnv;
  readonly context: Context;
  readonly signal: AbortSignal;
  readonly journal: Journal;

  constructor(env: ExecutionEnv, context: Context, signal: AbortSignal, journal: Journal) {
    this.env = env;
    this.context = context;
    this.signal = signal;
    this.journal = journal;
  }

  check(): void {
    if (this.signal.aborted) throw new ImportError('the import was cancelled');
  }

  async exists(path: string, env = this.env): Promise<boolean> {
    const found = await env.exists(path, this.context);
    return found.ok && found.value;
  }

  async tree(root: string, env = this.env): Promise<boolean> {
    let top: string | undefined;
    for (let dir = root; dir !== '/' && !(await this.exists(dir, env)); dir = dirname(dir))
      top = dir;
    if (top === undefined) return false;
    await this.journal.log({ made: top }, this.context);
    return true;
  }

  readonly #real = new Set<string>(['/']);

  async direct(path: string): Promise<void> {
    for (let at = dirname(path); !this.#real.has(at); at = dirname(at)) {
      const real = await this.env.canonicalPath(at, this.context);
      if (!real.ok) continue;
      if (real.value !== at)
        throw new ImportError(`${at} leads through a symlink, and the import won't write there`);
      this.#real.add(at);
      break;
    }
  }

  async put(path: string, content: Uint8Array | string, fresh: boolean, env = this.env) {
    this.check();
    if (env === this.env) await this.direct(path);
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    if (!fresh && !(await this.tree(dirname(path), env))) {
      const old = await env.readBinaryFile(path, this.context);
      if (old.ok && same(old.value, bytes)) return false;
      await this.#keep(path, old.ok ? old.value : null);
    }
    done(await env.writeFile(path, bytes, this.context), path);
    return true;
  }

  async remember(paths: readonly string[]): Promise<void> {
    for (const part of chunks(paths)) {
      const out = await this.out(`stat -c '%u:%g %a %n' -- ${part.map(quote).join(' ')}`);
      for (const line of out.split('\n').filter(Boolean)) {
        const [owner = '', mode = '', ...name] = line.split(' ');
        this.#modes.set(name.join(' '), `${owner} ${mode}`);
      }
    }
  }

  async #keep(path: string, old: Uint8Array | null): Promise<void> {
    const backup = old ? await this.journal.backup(old, this.context) : null;
    await this.journal.log({ file: path, backup }, this.context);
  }

  async move(from: string, to: string, fresh: boolean): Promise<void> {
    this.check();
    await this.direct(to);
    if (!fresh && !(await this.tree(dirname(to)))) {
      const old = await this.env.readBinaryFile(to, this.context);
      await this.#keep(to, old.ok ? old.value : null);
    }
    done(await this.env.createDir(dirname(to), { recursive: true }, this.context), dirname(to));
    await this.journal.log({ moved: from, to, mode: this.#modes.get(from) ?? null }, this.context);
    done(await this.env.renameFile(from, to, this.context), to);
  }

  async out(command: string): Promise<string> {
    let out = '';
    let err = '';
    const ran = await this.env.exec(
      command,
      {
        onOutput: (text, _context, info) => {
          if (info.stream === 'stderr') err += text;
          else out += text;
        },
      },
      this.context
    );
    if (!ran.ok) throw new ImportError(`${command.split(' ')[0]}: ${ran.error.message}`);
    if (ran.value.exitCode !== 0)
      throw new ImportError(`${command.split(' ')[0]}: ${err.trim() || 'it failed'}`);
    return out;
  }

  async sh(command: string): Promise<void> {
    let err = '';
    const ran = await this.env.exec(
      command,
      {
        onOutput: (text, _context, info) => {
          if (info.stream === 'stderr') err += text;
        },
      },
      this.context
    );
    const failed = ran.ok
      ? ran.value.exitCode === 0
        ? ''
        : err.trim() || 'it failed'
      : ran.error.message;
    if (failed) throw new ImportError(`${command.split(' ')[0]}: ${failed}`);
  }

  rollback(): Promise<void> {
    return this.journal.rollback();
  }
}

export async function ownTree(writer: Writer, user: string, home: string, roots: Iterable<string>) {
  for (const root of roots) {
    const parents: string[] = [];
    for (let at = root.lastIndexOf('/'); at > home.length; at = root.lastIndexOf('/', at - 1))
      parents.push(quote(root.slice(0, at)));
    const owner = quote(`${user}:${user}`);
    const lift = parents.length
      ? `chown ${owner} ${parents.join(' ')} && chmod 700 ${parents.join(' ')} && `
      : '';
    await writer.sh(`${lift}chown -R ${owner} ${quote(root)} && chmod -R u=rwX,go= ${quote(root)}`);
  }
}

const fits = (text: string) =>
  byteLength(text) <= MAX_BYTES && text.split('\n').length <= MAX_LINES;

export async function remember(
  writer: Writer,
  file: string,
  text: string,
  rest: { file: string; date: string }
): Promise<'merged' | 'aside' | 'none'> {
  const body = text.replace(/^#{1,2}(\s)/gm, '###$1').trim();
  if (!body) return 'none';
  await writer.direct(file);
  const real = await writer.env.canonicalPath(file, writer.context);
  if (real.ok && real.value !== file)
    throw new ImportError(`${file} is a symlink, and the import won't write memory through it`);
  const read = await writer.env.readTextFile(file, writer.context);
  const before = read.ok ? read.value.trimEnd() : '';
  if (before.includes(body)) return 'none';
  const joined = (section: string) => `${before}${before ? '\n\n' : ''}${section}\n`;
  const heading = `## Imported from SLICC 6 (${rest.date})\n\n`;
  const whole = joined(`${heading}${body}`);
  if (fits(whole)) return (await writer.put(file, whole, false)) ? 'merged' : 'none';
  await writer.put(rest.file, `${text.trimEnd()}\n`, false);
  const lines = body.split('\n');
  const tail = `The rest is in ${rest.file}.`;
  const cut = () => joined(`${heading}${[...lines, '', tail].join('\n')}`);
  while (lines.length && !fits(cut())) lines.pop();
  if (!lines.length) return 'aside';
  await writer.put(file, cut(), false);
  return 'merged';
}

export type CronLine = {
  name: string;
  schedule: string;
  target: LickTarget;
  message: string;
  filter?: string;
};

export async function installCrons(
  writer: Writer,
  user: string,
  crons: readonly CronLine[],
  date: string
) {
  const before = await readTable(writer.env, user, writer.context);
  if (typeof before !== 'string') throw new ImportError(`crontab -u ${user}: ${before.error}`);
  const blocks = crons.map(
    (cron) => `# # name: ${cron.name}\n# ${cron.schedule} ${sendCommand(cron.target, cron.message)}`
  );
  const changed = blocks.filter((block) => !before.includes(block)).length;
  if (!changed) return 0;
  const head = `# SLICC 6 crons, imported off on ${date}. Remove "# " from a job's two lines to turn it on.`;
  const notes = crons
    .filter((cron) => cron.filter)
    .map(
      (cron) =>
        `# ${cron.name} had a SLICC 6 filter, not imported: ${(cron.filter as string).replace(/\s+/g, ' ')}`
    );
  const kept = withoutImported(before, new Set(crons.map((cron) => cron.name)));
  const table = `${[...kept, head, ...notes, ...blocks].join('\n')}\n`;
  const backup = before ? await writer.journal.backup(before, writer.context) : null;
  await writer.journal.log({ cron: user, backup }, writer.context);
  const ran = await writeTable(writer.env, user, table, writer.context);
  if (ran.code !== 0) throw new ImportError(`crontab -u ${user}: ${ran.err.trim()}`);
  return changed;
}

export function withoutImported(table: string, names: ReadonlySet<string>): string[] {
  const lines = table.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] as string;
    const named = /^# # name: (\S+)$/.exec(line);
    if (named && names.has(named[1] as string)) at++;
    else if (
      !line.startsWith('# SLICC 6 crons, imported off on ') &&
      !/^# (\S+) had a SLICC 6 filter/.test(line)
    )
      out.push(line);
  }
  return out;
}

export function userSection(text: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) inside = /^\s*\[user\]\s*$/i.test(line);
    if (inside && /^\s*(\[user\]|(name|email)\s*=)/i.test(line)) out.push(line.trim());
  }
  return out.length > 1
    ? `${out[0]}\n${out
        .slice(1)
        .map((line) => `\t${line}`)
        .join('\n')}\n`
    : '';
}
