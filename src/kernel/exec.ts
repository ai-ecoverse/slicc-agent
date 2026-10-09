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
import type { KernelClient, KernelProcess, SpawnOptions } from './client.ts';
import { descendants, REFUSED } from './groups.ts';
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

export async function sweep(
  client: Pick<KernelClient, 'kill' | 'ps'>,
  process: KernelProcess
): Promise<void> {
  const table = (await client.ps?.().catch(() => undefined)) ?? [];
  const pids = [process.pid, ...descendants(table, process.pid)];
  await Promise.all(pids.map((pid) => client.kill?.(pid, 'SIGKILL').catch(() => undefined)));
}

function guard(
  process: KernelProcess,
  options: ShellExecOptions | undefined,
  context: Context,
  kill: () => void
) {
  let ending: Ending;
  const stop = (why: Ending) => {
    ending ??= why;
    kill();
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

export interface Join {
  pgid: number;
  refused(code: string): void;
}

async function start(
  client: KernelClient,
  argv: readonly string[],
  options: SpawnOptions,
  join: Join | undefined
): Promise<{ process: KernelProcess; joined: boolean }> {
  if (join) {
    try {
      return { process: await client.spawn(argv, { ...options, pgid: join.pgid }), joined: true };
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? '');
      if (!REFUSED.has(code)) throw error;
      join.refused(code);
    }
  }
  return { process: await client.spawn(argv, options), joined: false };
}

export async function execute(
  client: KernelClient,
  cwd: string,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
  spawned?: (process: KernelProcess) => void,
  join?: Join
): Promise<Result<ShellExecResult, ExecutionError>> {
  const argv = typeof command === 'string' ? [...SHELL, command] : [...command];
  if (argv.length === 0) return err(new ExecutionError('spawn_error', 'No program to run'));
  if (context.abortSignal?.aborted)
    return err(new ExecutionError('aborted', 'The command was aborted'));
  const spill = new Spill(options?.spill);
  const out = sink('stdout', spill, options, context);
  const errors = sink('stderr', spill, options, context);
  let started: { process: KernelProcess; joined: boolean };
  try {
    started = await start(
      client,
      argv,
      {
        cwd: resolve(cwd, options?.cwd ?? '.'),
        ...(options?.env ? { env: options.env } : {}),
        onStdout: (bytes) => out.push(bytes),
        onStderr: (bytes) => errors.push(bytes),
      },
      join
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new ExecutionError('spawn_error', message));
  }
  const { process, joined } = started;
  spawned?.(process);
  const watch = guard(process, options, context, () =>
    joined ? void sweep(client, process) : process.signal('SIGKILL')
  );
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
