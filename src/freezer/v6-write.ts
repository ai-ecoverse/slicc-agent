import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv, Result } from '@earendil-works/pi-durable/env';
import { quote } from '../kernel/env.ts';
import { dirname } from '../kernel/paths.ts';
import { readTable, sendCommand, writeTable } from '../licks/crontab.ts';
import type { LickTarget } from '../licks/lick.ts';
import { byteLength, MAX_BYTES, MAX_LINES } from '../memory/format.ts';
import { ImportError } from './zip.ts';

const encoder = new TextEncoder();

export function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

function done<T>(result: Result<T, { message: string }>, what: string): T {
  if (!result.ok) throw new ImportError(`couldn't write ${what}: ${result.error.message}`);
  return result.value;
}

export class Writer {
  readonly #undo: (() => Promise<unknown>)[] = [];
  readonly env: ExecutionEnv;
  readonly context: Context;
  readonly signal: AbortSignal;

  constructor(env: ExecutionEnv, context: Context, signal: AbortSignal) {
    this.env = env;
    this.context = context;
    this.signal = signal;
  }

  check(): void {
    if (this.signal.aborted) throw new ImportError('the import was cancelled');
  }

  later(step: () => Promise<unknown>): void {
    this.#undo.push(step);
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
    const gone = top;
    this.later(() => env.remove(gone, { recursive: true, force: true }, BACKGROUND_CONTEXT));
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
      this.later(() =>
        old.ok
          ? env.writeFile(path, old.value, BACKGROUND_CONTEXT)
          : env.remove(path, { force: true }, BACKGROUND_CONTEXT)
      );
    }
    done(await env.writeFile(path, bytes, this.context), path);
    return true;
  }

  async move(from: string, to: string, fresh: boolean): Promise<void> {
    this.check();
    await this.direct(to);
    if (!fresh && !(await this.tree(dirname(to)))) {
      const old = await this.env.readBinaryFile(to, this.context);
      this.later(() =>
        old.ok
          ? this.env.writeFile(to, old.value, BACKGROUND_CONTEXT)
          : this.env.remove(to, { force: true }, BACKGROUND_CONTEXT)
      );
    }
    done(await this.env.createDir(dirname(to), { recursive: true }, this.context), dirname(to));
    done(await this.env.renameFile(from, to, this.context), to);
    this.later(() => this.env.renameFile(to, from, BACKGROUND_CONTEXT));
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

  async rollback(): Promise<void> {
    for (const step of this.#undo.reverse()) await step().catch(() => undefined);
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
  writer.later(async () =>
    before
      ? writeTable(writer.env, user, before, BACKGROUND_CONTEXT)
      : writer.env.exec(`crontab -u ${quote(user)} -r`, undefined, BACKGROUND_CONTEXT)
  );
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
