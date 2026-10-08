import type { Context } from '@earendil-works/chord';
import {
  ExecutionError,
  err,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  StreamDecoder,
} from '@earendil-works/pi-durable/env';
import type { KernelClient, KernelProcess } from './client.ts';
import { resolve } from './paths.ts';

export const SHELL = ['bash', '-c'] as const;

class Spill {
  readonly #chunks: Uint8Array[] = [];
  readonly #limit: { afterBytes: number; afterLines: number } | undefined;
  #bytes = 0;
  #lines = 0;

  constructor(limit: ShellExecOptions['spill']) {
    this.#limit = limit;
  }

  add(chunk: Uint8Array): void {
    if (!this.#limit) return;
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    for (const byte of chunk) if (byte === 10) this.#lines++;
  }

  get over(): boolean {
    const limit = this.#limit;
    return (
      limit !== undefined && (this.#bytes > limit.afterBytes || this.#lines > limit.afterLines)
    );
  }

  async write(client: KernelClient): Promise<string | undefined> {
    if (!this.over) return undefined;
    const path = `/tmp/slicc-agent-output-${crypto.randomUUID()}.log`;
    const all = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    await client.fs.mkdir('/tmp');
    await client.fs.writeFile(path, all);
    return path;
  }
}

function sink(
  stream: 'stdout' | 'stderr',
  spill: Spill,
  options: ShellExecOptions | undefined,
  context: Context
) {
  const decoder = new StreamDecoder();
  return {
    push(bytes: Uint8Array) {
      spill.add(bytes);
      const text = decoder.decode(bytes);
      if (text) options?.onOutput?.(text, context, { stream });
    },
    end() {
      const text = decoder.decode();
      if (text) options?.onOutput?.(text, context, { stream });
    },
  };
}

type Ending = 'timeout' | 'aborted' | undefined;

function guard(process: KernelProcess, options: ShellExecOptions | undefined, context: Context) {
  let ending: Ending;
  const stop = (why: Ending) => {
    ending ??= why;
    process.signal('SIGKILL');
  };
  const timer =
    options?.timeout === undefined
      ? undefined
      : setTimeout(() => stop('timeout'), options.timeout * 1000);
  const onAbort = () => stop('aborted');
  context.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (context.abortSignal?.aborted) onAbort();
  return {
    get ending() {
      return ending;
    },
    release() {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener('abort', onAbort);
    },
  };
}

export async function execute(
  client: KernelClient,
  cwd: string,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
  spawned?: (process: KernelProcess) => void
): Promise<Result<ShellExecResult, ExecutionError>> {
  const argv = typeof command === 'string' ? [...SHELL, command] : [...command];
  if (argv.length === 0) return err(new ExecutionError('spawn_error', 'No program to run'));
  if (context.abortSignal?.aborted)
    return err(new ExecutionError('aborted', 'The command was aborted'));
  const spill = new Spill(options?.spill);
  const out = sink('stdout', spill, options, context);
  const errors = sink('stderr', spill, options, context);
  let process: KernelProcess;
  try {
    process = await client.spawn(argv, {
      cwd: resolve(cwd, options?.cwd ?? '.'),
      ...(options?.env ? { env: options.env } : {}),
      onStdout: (bytes) => out.push(bytes),
      onStderr: (bytes) => errors.push(bytes),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new ExecutionError('spawn_error', message));
  }
  spawned?.(process);
  const watch = guard(process, options, context);
  const exitCode = await process.exited.finally(() => watch.release());
  out.end();
  errors.end();
  const spillPath = await spill.write(client);
  const ending = watch.ending;
  if (ending) {
    const error = new ExecutionError(
      ending,
      `The command was ${ending === 'timeout' ? 'timed out' : 'aborted'}`
    );
    if (spillPath) error.spillPath = spillPath;
    return err(error);
  }
  return ok(spillPath ? { exitCode, spillPath } : { exitCode });
}
