import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import type { Answer } from './service.ts';

export const CONTROL_DIR = '/var/lib/slicc/agent/requests';
export const PROTOCOL = 'slicc-agent/1';
export const STALE_MS = 10 * 60_000;
const COMMAND_NAMES = new Set(['subagent', 'sprinkle', 'memory', 'gelatiere', 'freezer']);

export interface Request {
  id: string;
  as: 'agent' | 'subagent' | 'sprinkle' | 'memory' | 'gelatiere' | 'freezer';
  caller: string;
  cwd: string;
  pid: number | null;
  argv: string[];
  stdin: string;
}

const HEADER = 6;

export function parseRequest(id: string, bytes: Uint8Array): Request | undefined {
  const decoder = new TextDecoder();
  const fields: string[] = [];
  let at = 0;
  while (fields.length < HEADER) {
    const end = bytes.indexOf(0, at);
    if (end < 0) return undefined;
    fields.push(decoder.decode(bytes.subarray(at, end)));
    at = end + 1;
  }
  const [version, as, caller, cwd, pid, count] = fields;
  const argc = Number(count);
  if (version !== PROTOCOL || !Number.isInteger(argc) || argc < 0) return undefined;
  const argv: string[] = [];
  while (argv.length < argc) {
    const end = bytes.indexOf(0, at);
    if (end < 0) return undefined;
    argv.push(decoder.decode(bytes.subarray(at, end)));
    at = end + 1;
  }
  const process = Number(pid);
  return {
    id,
    as: COMMAND_NAMES.has(as as string) ? (as as Request['as']) : 'agent',
    caller: caller as string,
    cwd: cwd || '/',
    pid: Number.isInteger(process) && process > 0 ? process : null,
    argv,
    stdin: decoder.decode(bytes.subarray(at)),
  };
}

export interface Runner {
  run(request: Request, context: Context): Promise<Answer>;
  blocking(request: Request): boolean;
}

export interface ControlPlane {
  start(context: Context): Promise<void>;
  sweep(context: Context): Promise<void>;
  close(context: Context): Promise<void>;
}

export interface PlaneOptions {
  dir?: string;
  now?: () => number;
  sweepEvery?: number;
  mirror?: (context: Context) => Promise<void>;
}

export function controlPlane(
  env: ExecutionEnv,
  runner: Runner,
  options: PlaneOptions = {}
): ControlPlane {
  const dir = options.dir ?? CONTROL_DIR;
  const requests = `${dir}/in`;
  const responses = `${dir}/out`;
  const now = options.now ?? Date.now;
  const handled = new Set<string>();
  let watcher: FileWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lock.then(operation, operation);
    lock = next.catch(() => undefined);
    return next;
  };

  async function answer(id: string, result: Answer, context: Context) {
    await env.writeFile(`${responses}/${id}.out`, result.out, context);
    await env.writeFile(`${responses}/${id}.code`, String(result.code), context);
    await env.remove(`${requests}/${id}`, { force: true }, context);
    await env.remove(`${responses}/${id}.ack`, { force: true }, context);
    await options.mirror?.(context).catch(() => undefined);
  }

  async function handle(id: string, context: Context) {
    if (handled.has(id)) return;
    handled.add(id);
    try {
      const bytes = await env.readBinaryFile(`${requests}/${id}`, context);
      if (!bytes.ok) return;
      await env.writeFile(`${responses}/${id}.ack`, '', context);
      const request = parseRequest(id, bytes.value);
      if (!request) {
        await answer(
          id,
          { code: 2, out: 'agent: this request is not understood; update the agent command\n' },
          context
        );
        return;
      }
      const result = runner.blocking(request)
        ? await runner.run(request, context)
        : await serial(() => runner.run(request, context));
      await answer(id, result, context);
    } finally {
      handled.delete(id);
    }
  }

  async function scan(context: Context) {
    const listed = await env.listDir(requests, context);
    if (!listed.ok) return;
    for (const entry of listed.value.sort((a, b) => a.name.localeCompare(b.name)))
      if (entry.kind === 'file' && !entry.name.startsWith('.'))
        void handle(entry.name, context).catch(() => undefined);
  }

  async function sweep(context: Context) {
    for (const folder of [requests, responses]) {
      const listed = await env.listDir(folder, context);
      if (!listed.ok) continue;
      for (const entry of listed.value) {
        const stale = now() - entry.mtimeMs > STALE_MS;
        const removable = folder === responses || entry.name.startsWith('.tmp-');
        if (stale && removable)
          await env.remove(`${folder}/${entry.name}`, { force: true }, context);
      }
    }
  }

  return {
    async start(context) {
      await env.createDir(requests, { recursive: true }, context);
      await env.createDir(responses, { recursive: true }, context);
      const leftovers = await env.listDir(requests, context);
      if (leftovers.ok)
        for (const entry of leftovers.value)
          if (entry.name.startsWith('.tmp-'))
            await env.remove(`${requests}/${entry.name}`, { force: true }, context);
      await sweep(context);
      const watched = await env.watch(
        [{ path: requests }],
        () => void scan(context).catch(() => undefined),
        context
      );
      if (watched.ok) watcher = watched.value;
      await scan(context);
      timer = setInterval(
        () => void sweep(context).catch(() => undefined),
        options.sweepEvery ?? 60_000
      );
    },
    sweep,
    async close(context) {
      clearInterval(timer);
      await watcher?.close(context);
      await lock;
    },
  };
}
