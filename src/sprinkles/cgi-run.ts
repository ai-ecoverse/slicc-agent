import type { KernelClient, KernelFs, KernelProcess, SpawnOptions } from '../kernel/client.ts';
import { dirname } from '../kernel/paths.ts';
import {
  CGI_DIR,
  CGI_LIMITS,
  type CgiHead,
  type CgiHeaders,
  type CgiRequest,
  cgiEnv,
  inside,
  methodOf,
  openTo,
  parseHead,
  REASONS,
  scriptOf,
  shebang,
  tagOf,
  toBase64,
} from './cgi.ts';

export interface CgiKernel {
  client: KernelClient;
  user: string;
}

export interface CgiSite {
  id: string;
  folder: string;
  owner: string;
}

export interface CgiReply {
  status: number;
  statusText: string;
  headers: CgiHeaders;
  body: string;
  done: boolean;
  stream: string | null;
}

export interface CgiChunk {
  body: string;
  done: boolean;
}

export interface CgiRunner {
  start(site: CgiSite, kernel: CgiKernel, request: CgiRequest): Promise<CgiReply>;
  read(stream: string, sprinkle: string): Promise<CgiChunk>;
  close(stream: string, sprinkle: string): void;
  stop(): void;
}

export type CgiLimits = typeof CGI_LIMITS;

type Found = { path: string } | { status: 403 | 404; reason: string };

const missing = (reason: string): Found => ({ status: 404, reason });

async function real(fs: KernelFs, path: string): Promise<string | undefined> {
  return fs.realpath(path).catch(() => undefined);
}

export async function locate(
  fs: KernelFs,
  folder: string,
  script: string,
  uid: number
): Promise<Found> {
  const root = await real(fs, folder);
  if (!root) return missing(`${folder} is gone`);
  const bin = await real(fs, `${folder}/${CGI_DIR}`);
  if (!bin || !inside(bin, root)) return missing(`${folder} has no ${CGI_DIR}/`);
  const path = await real(fs, `${folder}/${CGI_DIR}/${script}`);
  if (!path || !inside(path, root)) return missing(`${CGI_DIR}/${script} isn't there`);
  const stat = await fs.stat(path).catch(() => undefined);
  if (!stat?.isFile) return missing(`${CGI_DIR}/${script} is no file`);
  for (const each of new Set([root, bin, dirname(path), path])) {
    const why = openTo(await fs.stat(each), uid);
    if (why) return { status: 403, reason: `${each} is refused: ${why}` };
  }
  return { path };
}

export async function uidOf(fs: KernelFs, user: string): Promise<number> {
  if (user === 'root') return 0;
  const passwd = await fs.readText('/etc/passwd').catch(() => '');
  const line = passwd.split('\n').find((entry) => entry.startsWith(`${user}:`));
  const uid = Number(line?.split(':')[2] ?? Number.NaN);
  if (!Number.isInteger(uid)) throw new Error(`there is no kernel user ${user}`);
  return uid;
}

async function launch(
  client: KernelClient,
  path: string,
  options: SpawnOptions
): Promise<KernelProcess> {
  try {
    return await client.spawn([path], options);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EACCES') throw error;
    const line = shebang(await client.fs.readFile(path));
    if (!line) throw new Error(`${path} can't run: it has no #! line`);
    return client.spawn([...line, path], options);
  }
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function cgiReply(status: number, text: string, more: CgiHeaders = []): CgiReply {
  return {
    status,
    statusText: REASONS[status] ?? '',
    headers: [['Content-Type', 'text/plain; charset=utf-8'], ...more],
    body: toBase64(new TextEncoder().encode(text ? `${text}\n` : '')),
    done: true,
    stream: null,
  };
}

function plain(status: number): CgiHead {
  return { status, statusText: REASONS[status] ?? '', headers: [['Content-Type', 'text/plain']] };
}

export async function appendLog(fs: KernelFs, path: string, text: string, max: number) {
  const old = await fs.readFile(path).catch(() => new Uint8Array());
  let all = joined([old, new TextEncoder().encode(text)]);
  if (all.length > max) {
    const cut = all.indexOf(10, all.length - Math.floor(max / 2));
    all = all.subarray(cut < 0 ? all.length - Math.floor(max / 2) : cut + 1);
  }
  await fs.writeFile(path, all);
}

function lines(at: Date, script: string, text: string): string {
  const stamp = at.toISOString();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => `[${stamp}] ${script}: ${line}\n`)
    .join('');
}

const encode = (text: string) => new TextEncoder().encode(text);

export class CgiRun {
  readonly sprinkle: string;
  readonly answered: Promise<CgiReply>;
  process: KernelProcess | undefined;
  ended = false;
  why: string | undefined;
  readonly #limits: CgiLimits;
  readonly #publish: (run: CgiRun) => string;
  readonly #settle: (reply: CgiReply) => void;
  #early: Uint8Array[] = [];
  #queue: Uint8Array[] = [];
  #total = 0;
  #errors: Uint8Array[] = [];
  #errorBytes = 0;
  #head: CgiHead | undefined;
  #waiting: (() => void)[] = [];
  readonly #bodiless: boolean;

  constructor(
    sprinkle: string,
    limits: CgiLimits,
    publish: (run: CgiRun) => string,
    bodiless = false
  ) {
    this.sprinkle = sprinkle;
    this.#bodiless = bodiless;
    this.#limits = limits;
    this.#publish = publish;
    const { promise, resolve } = Promise.withResolvers<CgiReply>();
    this.answered = promise;
    this.#settle = resolve;
  }

  stop(why: string): void {
    this.why ??= why;
    void this.process?.signal('SIGKILL');
  }

  fail(message: string): void {
    this.#settle(cgiReply(500, message));
  }

  readonly out = (bytes: Uint8Array): void => {
    if (this.ended || this.why) return;
    this.#total += bytes.length;
    if (this.#total > this.#limits.output) {
      this.stop(`its output passed ${this.#limits.output} bytes`);
      return;
    }
    if (this.#head) {
      this.#queue.push(bytes);
      this.#wake();
      return;
    }
    this.#early.push(bytes);
    this.#headed(false);
  };

  readonly err = (bytes: Uint8Array): void => {
    const room = this.#limits.stderr - this.#errorBytes;
    if (room <= 0) return;
    const kept = bytes.subarray(0, room);
    this.#errors.push(kept);
    this.#errorBytes += kept.length;
  };

  end(code: number | undefined): string {
    this.ended = true;
    const stderr = new TextDecoder().decode(joined(this.#errors));
    if (!this.#head && this.#total === 0) this.#silent(code, stderr);
    else this.#headed(true);
    this.#wake();
    const timeout = `timed out after ${this.#limits.timeoutMs / 1000} s`;
    return [
      stderr,
      this.why === 'timeout' ? timeout : this.why,
      code === undefined || code === 0 ? undefined : `exited ${code}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  drain(): string {
    const body = this.#bodiless ? '' : toBase64(joined(this.#queue));
    this.#queue = [];
    return body;
  }

  get pending(): boolean {
    return this.#queue.length > 0;
  }

  wait(ms: number, later: (ms: number, run: () => void) => () => void): Promise<void> {
    if (this.pending || this.ended) return Promise.resolve();
    return new Promise((resolve) => {
      const cancel = later(ms, resolve);
      this.#waiting.push(() => {
        cancel();
        resolve();
      });
    });
  }

  #wake(): void {
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  #silent(code: number | undefined, stderr: string): void {
    const status = this.why === 'timeout' ? 504 : code === undefined ? 502 : code ? 500 : 200;
    this.#head = plain(status);
    const said = stderr || (this.why === 'timeout' ? 'timed out\n' : `exit ${code ?? '?'}\n`);
    if (status !== 200) this.#queue.push(encode(said));
    this.#answer();
  }

  #headed(ended: boolean): void {
    if (this.#head) return;
    const bytes = joined(this.#early);
    const parsed = parseHead(bytes, ended);
    if (parsed.kind === 'more') return;
    this.#early = [];
    if (parsed.kind === 'head') {
      this.#head = parsed.head;
      if (parsed.body.length) this.#queue.push(parsed.body);
    } else if (parsed.kind === 'body') {
      this.#head = plain(200);
      this.#queue.push(bytes);
    } else {
      this.#head = plain(502);
      this.#queue.push(encode(`${parsed.reason}\n`));
      this.stop(parsed.reason);
    }
    this.#answer();
  }

  #answer(): void {
    const head = this.#head as CgiHead;
    const done = this.ended && !this.pending;
    const stream = done ? null : this.#publish(this);
    this.#settle({ ...head, body: this.drain(), done, stream });
  }
}

export function cgiRunner(
  limits: CgiLimits = CGI_LIMITS,
  now: () => Date = () => new Date()
): CgiRunner {
  const running = new Map<string, number>();
  const streams = new Map<string, CgiRun>();
  const logs = new Map<string, Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return () => {
      clearTimeout(timer);
      timers.delete(timer);
    };
  };
  const count = (id: string, by: number) => running.set(id, (running.get(id) ?? 0) + by);
  const log = (fs: KernelFs, folder: string, script: string, text: string) => {
    const added = lines(now(), script, text);
    if (!added) return;
    const path = `${folder}/error.log`;
    const next = (logs.get(path) ?? Promise.resolve())
      .then(() => appendLog(fs, path, added, limits.log))
      .catch(() => undefined);
    logs.set(path, next);
  };
  const publish = (run: CgiRun) => {
    const id = crypto.randomUUID();
    streams.set(id, run);
    return id;
  };
  const execute = (site: CgiSite, kernel: CgiKernel, request: CgiRequest, path: string) => {
    const { script, pathInfo } = scriptOf(request.path) as { script: string; pathInfo: string };
    const run = new CgiRun(site.id, limits, publish, request.method === 'HEAD');
    const fs = kernel.client.fs;
    const env = cgiEnv({
      request,
      script,
      pathInfo,
      ...site,
      sprinkle: site.id,
      user: kernel.user,
    });
    const ended = (code: number | undefined) => {
      count(site.id, -1);
      log(fs, site.folder, script, run.end(code));
      later(limits.keepMs, () => {
        for (const [id, kept] of streams) if (kept === run) streams.delete(id);
      });
    };
    const started = (process: KernelProcess) => {
      run.process = process;
      if (run.why) void process.signal('SIGKILL');
      const cancel = later(limits.timeoutMs, () => run.stop('timeout'));
      process.exited
        .then(
          (code) => ended(code),
          () => ended(undefined)
        )
        .finally(cancel);
    };
    launch(kernel.client, path, {
      cwd: site.folder,
      env,
      tag: tagOf(site.id),
      ...(request.body ? { stdin: request.body } : {}),
      onStdout: run.out,
      onStderr: run.err,
    }).then(started, (error: Error) => {
      count(site.id, -1);
      log(fs, site.folder, script, error.message);
      run.fail(error.message);
    });
    return run.answered;
  };
  const refused = async (site: CgiSite, kernel: CgiKernel, request: CgiRequest) => {
    const parts = scriptOf(request.path);
    if (!parts) return cgiReply(404, `there is no ${CGI_DIR}/${request.path}`);
    if (request.body && request.body.length > limits.input)
      return cgiReply(413, `a ${CGI_DIR} request body is at most ${limits.input} bytes`);
    if ((running.get(site.id) ?? 0) >= limits.parallel)
      return cgiReply(503, `${site.id} runs ${limits.parallel} scripts already`, [
        ['Retry-After', '1'],
      ]);
    count(site.id, 1);
    const fs = kernel.client.fs;
    const found = await uidOf(fs, kernel.user)
      .then((uid) => locate(fs, site.folder, parts.script, uid))
      .catch((error: Error): Found => ({ status: 403, reason: error.message }));
    if (!('status' in found)) return found.path;
    count(site.id, -1);
    if (found.status === 403) log(fs, site.folder, parts.script, found.reason);
    return cgiReply(found.status, found.reason);
  };
  return {
    async start(site, kernel, request) {
      const method = methodOf(request.method);
      if (!method) return cgiReply(400, 'the method is no HTTP token');
      const path = await refused(site, kernel, request);
      return typeof path === 'string' ? execute(site, kernel, { ...request, method }, path) : path;
    },
    async read(stream, sprinkle) {
      const run = streams.get(stream);
      if (run?.sprinkle !== sprinkle) throw new Error(`there is no ${CGI_DIR} stream ${stream}`);
      await run.wait(limits.pollMs, later);
      const body = run.drain();
      if (run.ended) streams.delete(stream);
      return { body, done: run.ended };
    },
    close(stream, sprinkle) {
      const run = streams.get(stream);
      if (run?.sprinkle !== sprinkle) return;
      streams.delete(stream);
      run.stop('the frame stopped reading its output');
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const run of new Set(streams.values())) run.stop('the worker closed');
      streams.clear();
    },
  };
}
