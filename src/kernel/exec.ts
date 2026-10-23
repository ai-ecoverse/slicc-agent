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
import type { ScrubStream } from '../secrets/scrub.ts';
import type { KernelClient, KernelProcess, SpawnOptions } from './client.ts';
import { descendants, REFUSED } from './groups.ts';
import { resolve } from './paths.ts';

export const SHELL = ['bash', '-c'] as const;
export const HELD_LIMIT = 32 * 1024 * 1024;
export const HELD = 'output held: waiting for the vault';
export const GONE = 'the kernel went away mid-run, so the command may have partly run';

export interface ExecHooks {
  scrub?: () => ScrubStream;
  spawn?: (argv: readonly string[]) => readonly string[];
  tag?: (context: Context) => Promise<string | undefined>;
}

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

interface Sink {
  push(bytes: Uint8Array): void;
  end(): Promise<void>;
  drop(): void;
}

function sink(
  stream: 'stdout' | 'stderr',
  spill: Spill,
  options: ShellExecOptions | undefined,
  context: Context,
  scrub?: { stream: ScrubStream; held(bytes: number): void }
): Sink {
  const decoder = new StreamDecoder();
  const emit = (bytes: Uint8Array) => {
    spill.add(bytes);
    const text = decoder.decode(bytes);
    if (text) options?.onOutput?.(text, context, { stream });
  };
  const flush = () => {
    const text = decoder.decode();
    if (text) options?.onOutput?.(text, context, { stream });
  };
  if (!scrub)
    return {
      push: emit,
      end: async () => flush(),
      drop: flush,
    };
  let chain: Promise<void> = Promise.resolve();
  let dropped = false;
  const live = (bytes: Uint8Array) => {
    if (!dropped) emit(bytes);
  };
  return {
    push(bytes) {
      scrub.held(bytes.length);
      chain = chain
        .then(() => scrub.stream.push(bytes))
        .then((out) => {
          scrub.held(-bytes.length);
          live(out);
        });
    },
    async end() {
      await chain;
      live(await scrub.stream.end());
      if (!dropped) flush();
    },
    drop() {
      dropped = true;
      chain.catch(() => undefined);
      scrub.stream.drop();
    },
  };
}

type Ending = 'timeout' | 'aborted' | 'held' | undefined;

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
    stop,
    release() {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener('abort', onAbort);
    },
  };
}

async function drained(sinks: readonly Sink[], context: Context): Promise<Ending> {
  const signal = context.abortSignal;
  if (signal?.aborted) return 'aborted';
  let off = () => undefined as void;
  const aborted = new Promise<Ending>((resolve) => {
    const onAbort = () => resolve('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    off = () => signal?.removeEventListener('abort', onAbort);
  });
  const ends = Promise.all(sinks.map((each) => each.end())).then(() => undefined);
  ends.catch(() => undefined);
  try {
    return await Promise.race([ends, aborted]);
  } finally {
    off();
  }
}

export interface Join {
  pgid?: number;
  refused(code: string): void;
}

type Started = { process: KernelProcess; tag?: string };

async function tagged(
  client: KernelClient,
  argv: readonly string[],
  options: SpawnOptions
): Promise<Started> {
  const { tag, ...untagged } = options;
  if (tag === undefined) return { process: await client.spawn(argv, options) };
  try {
    return { process: await client.spawn(argv, options), tag };
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOSYS') throw error;
    return { process: await client.spawn(argv, untagged) };
  }
}

async function start(
  client: KernelClient,
  argv: readonly string[],
  options: SpawnOptions,
  join: Join | undefined
): Promise<Started & { joined: boolean }> {
  if (join?.pgid !== undefined) {
    try {
      return { ...(await tagged(client, argv, { ...options, pgid: join.pgid })), joined: true };
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? '');
      if (!REFUSED.has(code)) throw error;
      join.refused(code);
    }
  }
  return { ...(await tagged(client, argv, options)), joined: false };
}

export async function execute(
  client: KernelClient,
  cwd: string,
  command: string | readonly string[],
  options: ShellExecOptions | undefined,
  context: Context,
  spawned?: (process: KernelProcess, tag?: string) => void,
  join?: Join,
  hooks: ExecHooks = {}
): Promise<Result<ShellExecResult, ExecutionError>> {
  const given = typeof command === 'string' ? [...SHELL, command] : [...command];
  if (given.length === 0) return err(new ExecutionError('spawn_error', 'No program to run'));
  const argv = hooks.spawn ? [...hooks.spawn(given)] : given;
  if (context.abortSignal?.aborted)
    return err(new ExecutionError('aborted', 'The command was aborted'));
  const spill = new Spill(options?.spill);
  let held = 0;
  let overflowed = false;
  let over = () => {
    overflowed = true;
  };
  const scrubbed = () =>
    hooks.scrub && {
      stream: hooks.scrub(),
      held(bytes: number) {
        held += bytes;
        if (held > HELD_LIMIT) over();
      },
    };
  const out = sink('stdout', spill, options, context, scrubbed());
  const errors = sink('stderr', spill, options, context, scrubbed());
  let started: Started & { joined: boolean };
  try {
    const tag = await hooks.tag?.(context);
    started = await start(
      client,
      argv,
      {
        cwd: resolve(cwd, options?.cwd ?? '.'),
        ...(options?.env ? { env: options.env } : {}),
        ...(tag === undefined ? {} : { tag }),
        onStdout: (bytes) => out.push(bytes),
        onStderr: (bytes) => errors.push(bytes),
      },
      join
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new ExecutionError('spawn_error', message));
  }
  const { process } = started;
  spawned?.(process, started.tag);
  const watch = guard(process, options, context, () =>
    join ? void sweep(client, process) : process.signal('SIGKILL')
  );
  over = () => watch.stop('held');
  if (overflowed) over();
  const exitCode = await process.exited.finally(() => watch.release()).catch(() => undefined);
  if (exitCode === undefined) {
    out.drop();
    errors.drop();
    return err(new ExecutionError('unknown', GONE));
  }
  const ended = watch.ending ?? (await drained([out, errors], context));
  if (ended) {
    out.drop();
    errors.drop();
  }
  const spillPath = await spill.write(client);
  const ending = watch.ending ?? ended;
  if (ending) {
    const error =
      ending === 'held'
        ? new ExecutionError('unknown', HELD)
        : new ExecutionError(
            ending,
            `The command was ${ending === 'timeout' ? 'timed out' : 'aborted'}`
          );
    if (spillPath) error.spillPath = spillPath;
    return err(error);
  }
  return ok(spillPath ? { exitCode, spillPath } : { exitCode });
}
