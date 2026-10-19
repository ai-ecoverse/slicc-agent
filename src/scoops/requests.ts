import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import type { CronRun } from '../licks/crontab.ts';
import type { Answer } from './service.ts';

export const CONTROL_DIR = '/var/lib/slicc/agent/requests';
export const PROTOCOL = 'slicc-agent/2';
export const PROTOCOL_MARK = 'slicc-agent/';
export const STALE_MS = 10 * 60_000;
const COMMAND_NAMES = new Set(['subagent', 'memory', 'gelatiere', 'freezer', 'models', 'panel']);

export interface Request {
  id: string;
  as: 'agent' | 'subagent' | 'memory' | 'gelatiere' | 'freezer' | 'models' | 'panel';
  caller: string;
  tab?: string | null;
  cwd: string;
  pid: number | null;
  argv: string[];
  stdin: string;
  user?: string;
  cron?: CronRun;
}

const HEADERS: Record<string, number> = { 'slicc-agent/1': 6, [PROTOCOL]: 7 };

export function cronOf(field: string): CronRun | undefined {
  const [job, due, missed, extra] = field.split(' ');
  const count = Number(missed);
  if (!job || !due || extra !== undefined || !Number.isInteger(count) || count < 0)
    return undefined;
  return { job, due, missed: count };
}

export function parseRequest(id: string, bytes: Uint8Array): Request | undefined {
  const decoder = new TextDecoder();
  const fields: string[] = [];
  let at = 0;
  let header = 1;
  while (fields.length < header) {
    const end = bytes.indexOf(0, at);
    if (end < 0) return undefined;
    fields.push(decoder.decode(bytes.subarray(at, end)));
    at = end + 1;
    header = HEADERS[fields[0] as string] ?? 0;
  }
  if (!header) return undefined;
  const [, as, caller, cwd, pid] = fields;
  const cron = header === 7 ? cronOf(fields[5] as string) : undefined;
  const argc = Number(fields.at(-1));
  if (!Number.isInteger(argc) || argc < 0) return undefined;
  const argv: string[] = [];
  while (argv.length < argc) {
    const end = bytes.indexOf(0, at);
    if (end < 0) return undefined;
    argv.push(decoder.decode(bytes.subarray(at, end)));
    at = end + 1;
  }
  const process = Number(pid);
  const tab = (caller as string).startsWith('tab:') ? (caller as string).slice(4) : null;
  return {
    id,
    as: COMMAND_NAMES.has(as as string) ? (as as Request['as']) : 'agent',
    caller: tab === null ? (caller as string) : '',
    ...(tab ? { tab } : {}),
    cwd: cwd || '/',
    pid: Number.isInteger(process) && process > 0 ? process : null,
    argv,
    stdin: decoder.decode(bytes.subarray(at)),
    ...(cron ? { cron } : {}),
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
  user?: string;
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
    const codePath = `${responses}/${id}.code`;
    const staged = `${responses}/.tmp-${id}.code`;
    const publish = async (code: number) => {
      const body = String(code);
      for (let attempt = 0; attempt < 2; attempt++) {
        const stage = attempt === 0 ? staged : `${responses}/.tmp-${id}-${attempt}.code`;
        const written = await env.writeFile(stage, body, context);
        if (!written.ok) continue;
        let renamed = await env.renameFile(stage, codePath, context);
        if (!renamed.ok) renamed = await env.renameFile(stage, codePath, context);
        if (renamed.ok) return true;
        await env.remove(stage, { force: true }, context);
      }
      return (await env.writeFile(codePath, body, context)).ok;
    };
    let code = result.code;
    const out = await env.writeFile(`${responses}/${id}.out`, result.out, context);
    if (!out.ok) {
      code = 1;
      await env.writeFile(
        `${responses}/${id}.err`,
        `agent: ${out.error.code}: ${out.error.message}\n`,
        context
      );
    } else if (result.err !== undefined) {
      const err = await env.writeFile(`${responses}/${id}.err`, result.err, context);
      if (!err.ok) {
        code = 1;
        await env.writeFile(
          `${responses}/${id}.err`,
          `agent: ${err.error.code}: ${err.error.message}\n`,
          context
        );
      }
    }
    if (!(await publish(code))) throw new Error(`couldn't place ${codePath}`);
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
      const parsed = parseRequest(id, bytes.value);
      const request = parsed && options.user ? { ...parsed, user: options.user } : parsed;
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
