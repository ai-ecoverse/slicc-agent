import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv, Result } from '@earendil-works/pi-durable/env';
import { quote } from '../kernel/env.ts';
import { dirname } from '../kernel/paths.ts';
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

  async put(path: string, content: Uint8Array | string, fresh: boolean, env = this.env) {
    this.check();
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
