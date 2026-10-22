import type { Context } from '@earendil-works/chord';
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type ExecutionError,
  err,
  FileError,
  type FileInfo,
  type FileWatcher,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from '@earendil-works/pi-durable/env';
import { mimeOf } from '../images/index.ts';
import type { Scrub } from '../secrets/scrub.ts';
import type { Activity } from './activity.ts';
import type { KernelClient, KernelProcess } from './client.ts';
import { type ExecHooks, execute } from './exec.ts';
import { attempt, info, KernelDirReader, SnapshotLines, SnapshotReader } from './files.ts';
import type { ProcessGroups } from './groups.ts';
import type { Jobs } from './jobs.ts';
import { dirname, normalize, resolve } from './paths.ts';
import { nativeWatch, type PollOptions, pollWatch, RESCAN_MS } from './watch.ts';

export interface KernelEnvOptions {
  cwd: string;
  id?: string;
  watch?: PollOptions;
  activity?: Activity;
  groups?: ProcessGroups;
  jobs?: Jobs;
  owner?: number;
  exports?: Readonly<Record<string, string>>;
  scrub?: Scrub;
  spawn?: (argv: readonly string[]) => readonly string[];
  tag?: (context: Context) => Promise<string | undefined>;
}

export const STREAMED_READ = 8 * 1024 * 1024;
export const READ_CHUNK = 1024 * 1024;

export async function scrubbedFile(scrub: Scrub, bytes: Uint8Array): Promise<Uint8Array> {
  if (mimeOf(bytes)) return bytes;
  if (bytes.length <= STREAMED_READ) return (await scrub.texts([bytes]))[0] as Uint8Array;
  const stream = scrub.stream();
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += READ_CHUNK)
    parts.push(await stream.push(bytes.subarray(at, at + READ_CHUNK)));
  parts.push(await stream.end());
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

export function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function prefixed(
  command: string,
  exports: Readonly<Record<string, string>> | undefined
): string {
  const names = Object.keys(exports ?? {}).filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name));
  if (!names.length) return command;
  return `export ${names.map((name) => `${name}=${quote((exports as Record<string, string>)[name] as string)}`).join(' ')}; ${command}`;
}

type FileResult<T> = Promise<Result<T, FileError>>;

export class SliccKernelEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #client: KernelClient;
  readonly #watchers = new Set<FileWatcher>();
  readonly #poll: PollOptions;
  readonly #activity: Activity | undefined;
  readonly #groups: ProcessGroups | undefined;
  readonly #jobs: Jobs | undefined;
  readonly #owner: number | undefined;
  readonly #exports: Readonly<Record<string, string>> | undefined;
  readonly #hooks: ExecHooks;
  readonly #scrub: Scrub | undefined;

  constructor(client: KernelClient, options: KernelEnvOptions) {
    this.#client = client;
    this.cwd = options.cwd;
    this.id = options.id ?? 'slicc-kernel';
    this.#poll = options.watch ?? {};
    this.#activity = options.activity;
    this.#groups = options.groups;
    this.#jobs = options.jobs;
    this.#owner = options.owner;
    this.#exports = options.exports;
    this.#scrub = options.scrub;
    const scrub = options.scrub;
    this.#hooks = {
      ...(scrub ? { scrub: () => scrub.stream() } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.tag ? { tag: options.tag } : {}),
    };
  }

  #path(path: string): string {
    return resolve(this.cwd, path);
  }

  #written(path: string): string {
    const resolved = this.#path(path);
    this.#activity?.wrote(resolved);
    return resolved;
  }

  get #fs() {
    return this.#client.fs;
  }

  async absolutePath(path: string): FileResult<string> {
    return ok(this.#path(path));
  }

  async joinPath(parts: string[]): FileResult<string> {
    return ok(normalize(parts.join('/')));
  }

  readTextFile(path: string, context: Context): FileResult<string> {
    const resolved = this.#path(path);
    return attempt(context, resolved, () => this.#fs.readText(resolved));
  }

  readBinaryFile(path: string, context: Context): FileResult<Uint8Array> {
    const resolved = this.#path(path);
    return attempt(context, resolved, () => this.#fs.readFile(resolved));
  }

  async openTextLineReader(path: string, context: Context): FileResult<TextLineReader> {
    const text = await this.readTextFile(path, context);
    return text.ok ? ok(new SnapshotLines(text.value)) : text;
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context
  ): FileResult<string[]> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
    const text = await this.readTextFile(path, context);
    if (!text.ok) return text;
    const reader = new SnapshotLines(text.value);
    const lines: string[] = [];
    for (
      let line = await reader.readLine();
      line.ok && line.value;
      line = await reader.readLine()
    ) {
      if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
      lines.push(line.value.text);
    }
    return ok(lines);
  }

  openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context
  ): FileResult<BinaryReader> {
    const resolved = this.#path(path);
    return attempt(context, resolved, async () => {
      if (options?.noFollow && (await this.#fs.lstat(resolved)).isSymbolicLink) {
        throw new FileError('invalid', 'Refusing to follow a symbolic link', resolved);
      }
      const stat = await this.#fs.stat(resolved);
      if (stat.isDirectory) throw new FileError('is_directory', 'Is a directory', resolved);
      if (!stat.isFile) throw new FileError('invalid', 'Not a regular file', resolved);
      const bytes = await this.#fs.readFile(resolved);
      if (!this.#scrub) return new SnapshotReader(bytes, info(resolved, stat));
      const shown = await scrubbedFile(this.#scrub, bytes);
      return new SnapshotReader(shown, { ...info(resolved, stat), size: shown.length });
    });
  }

  writeFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
    const resolved = this.#written(path);
    return attempt(context, resolved, async () => {
      await this.#fs.mkdir(dirname(resolved));
      await this.#fs.writeFile(resolved, content);
    });
  }

  appendFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
    const resolved = this.#written(path);
    return attempt(context, resolved, async () => {
      const before = (await this.#fs.exists(resolved))
        ? await this.#fs.readFile(resolved)
        : new Uint8Array();
      const added = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const all = new Uint8Array(before.length + added.length);
      all.set(before);
      all.set(added, before.length);
      await this.#fs.mkdir(dirname(resolved));
      await this.#fs.writeFile(resolved, all);
    });
  }

  truncateFile(path: string, size: number, context: Context): FileResult<void> {
    const resolved = this.#written(path);
    if (!Number.isSafeInteger(size) || size < 0) {
      return Promise.resolve(
        err(new FileError('invalid', 'File size must be a non-negative integer', resolved))
      );
    }
    return attempt(context, resolved, async () => {
      const before = await this.#fs.readFile(resolved);
      const after = new Uint8Array(size);
      after.set(before.subarray(0, size));
      await this.#fs.writeFile(resolved, after);
    });
  }

  flushFile(path: string, context: Context): FileResult<void> {
    const resolved = this.#path(path);
    return attempt(context, resolved, async () => {
      if ((await this.#fs.stat(resolved)).isDirectory)
        throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
    });
  }

  renameFile(sourcePath: string, destinationPath: string, context: Context): FileResult<void> {
    const source = this.#written(sourcePath);
    return attempt(context, source, () => this.#fs.rename(source, this.#written(destinationPath)));
  }

  fileInfo(path: string, context: Context): FileResult<FileInfo> {
    const resolved = this.#path(path);
    return attempt(context, resolved, async () => info(resolved, await this.#fs.lstat(resolved)));
  }

  async listDir(path: string, context: Context): FileResult<FileInfo[]> {
    const reader = await this.openDirReader(path, context);
    if (!reader.ok) return reader;
    return ok(await (reader.value as KernelDirReader).rest());
  }

  openDirReader(path: string, context: Context): FileResult<DirReader> {
    const resolved = this.#path(path);
    return attempt(context, resolved, async () => {
      if (!(await this.#fs.stat(resolved)).isDirectory) {
        throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
      }
      return new KernelDirReader(this.#fs, resolved, await this.#fs.readdir(resolved));
    });
  }

  watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    context: Context
  ): FileResult<FileWatcher> {
    return attempt(context, this.cwd, async () => {
      let absorb: (paths: readonly string[]) => void = () => undefined;
      const reported = (change: WatchChange) => {
        if ('paths' in change) absorb(change.paths);
        onChange(change);
      };
      const native =
        this.#poll.mode === 'polling'
          ? undefined
          : await nativeWatch(this.#fs, this.cwd, targets, reported);
      const intervalMs = native ? (this.#poll.rescanMs ?? RESCAN_MS) : this.#poll.intervalMs;
      const polled = await pollWatch(this.#fs, this.cwd, targets, onChange, {
        ...(intervalMs === undefined ? {} : { intervalMs }),
      });
      absorb = (paths) => polled.absorb(paths);
      const watcher: FileWatcher = native
        ? {
            mode: 'native',
            async close(closing: Context) {
              await native.close(closing);
              await polled.close(closing);
            },
          }
        : polled;
      this.#watchers.add(watcher);
      return {
        mode: watcher.mode,
        close: async (closing: Context) => {
          this.#watchers.delete(watcher);
          await watcher.close(closing);
        },
      };
    });
  }

  canonicalPath(path: string, context: Context): FileResult<string> {
    const resolved = this.#path(path);
    return attempt(context, resolved, () => this.#fs.realpath(resolved));
  }

  async exists(path: string, context: Context): FileResult<boolean> {
    const found = await this.fileInfo(path, context);
    if (found.ok) return ok(true);
    return found.error.code === 'not_found' ? ok(false) : found;
  }

  createDir(
    path: string,
    _options: { recursive?: boolean } | undefined,
    context: Context
  ): FileResult<void> {
    const resolved = this.#written(path);
    return attempt(context, resolved, () => this.#fs.mkdir(resolved));
  }

  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context
  ): FileResult<void> {
    const resolved = this.#written(path);
    return attempt(context, resolved, async () => {
      if (!options?.recursive) {
        const stat = await this.#fs.lstat(resolved).catch((error: unknown) => {
          if (options?.force) return undefined;
          throw error;
        });
        if (stat?.isDirectory) throw Object.assign(new Error('Is a directory'), { code: 'EISDIR' });
      }
      await this.#fs.rm(resolved, { force: options?.force ?? false });
    });
  }

  async createTempDir(prefix: string | undefined, context: Context): FileResult<string> {
    const path = `/tmp/${prefix ?? 'tmp-'}${crypto.randomUUID()}`;
    return attempt(context, path, async () => {
      await this.#fs.mkdir(path);
      return path;
    });
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context
  ): FileResult<string> {
    const dir = await this.createTempDir('tmp-', context);
    if (!dir.ok) return dir;
    const path = `${dir.value}/${options?.prefix ?? ''}${crypto.randomUUID()}${options?.suffix ?? ''}`;
    return attempt(context, path, async () => {
      await this.#fs.writeFile(path, '');
      return path;
    });
  }

  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const ended = this.#activity?.began();
    const line = typeof command === 'string' ? prefixed(command, this.#exports) : command;
    const jobs = this.#jobs;
    const client = this.#client;
    let recorded: Promise<void> | undefined;
    const tracked =
      jobs && typeof command === 'string'
        ? (process: KernelProcess) => {
            recorded = jobs.started(client, command, process);
          }
        : undefined;
    const groups = this.#groups;
    const owner = this.#owner;
    const run =
      !groups || owner === undefined
        ? execute(client, this.cwd, line, options, context, tracked, undefined, this.#hooks)
        : this.#grouped(groups, owner, line, options, context, tracked);
    return run
      .then(async (result) => {
        await recorded;
        return result;
      })
      .finally(ended);
  }

  async #grouped(
    groups: ProcessGroups,
    owner: number,
    line: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
    tracked: ((process: KernelProcess) => void) | undefined
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    for (let wait = groups.pending(owner); wait; wait = groups.pending(owner)) await wait;
    const pgid = groups.shared(owner);
    const release = pgid === undefined && groups.joins() ? groups.reserve(owner) : () => undefined;
    const spawned = (process: KernelProcess, tag?: string) => {
      groups.track(owner, process, tag);
      tracked?.(process);
      release();
    };
    const join = groups.joins()
      ? {
          ...(pgid === undefined ? {} : { pgid }),
          refused: (code: string) => groups.refused(owner, code),
        }
      : undefined;
    return execute(
      this.#client,
      this.cwd,
      line,
      options,
      context,
      spawned,
      join,
      this.#hooks
    ).finally(release);
  }

  async cleanup(context: Context): Promise<void> {
    for (const watcher of [...this.#watchers]) await watcher.close(context);
    this.#watchers.clear();
  }
}

export const HOME = '/home';

export type EnvTargetLike = { cwd?: string; conversationId?: number; read?: unknown };

export type EnvRoute = { client: KernelClient; home: string; cwd?: string };

export function kernelEnvironment(
  client: KernelClient,
  options: Omit<KernelEnvOptions, 'cwd'> & {
    identify?: (target: EnvTargetLike, context: Context) => Promise<Record<string, string>>;
    route?: (target: EnvTargetLike) => Promise<EnvRoute | undefined>;
    tagOf?: (conversationId: number, context: Context) => Promise<string | undefined>;
  } = {}
): (target: EnvTargetLike, context?: Context) => SliccKernelEnv | Promise<SliccKernelEnv> {
  const { identify, route, tagOf, ...rest } = options;
  const make = (target: EnvTargetLike, exports?: Record<string, string>, routed?: EnvRoute) => {
    const owner = target.conversationId;
    return new SliccKernelEnv(routed?.client ?? client, {
      ...rest,
      cwd: routed?.cwd ?? target.cwd ?? routed?.home ?? HOME,
      ...(owner === undefined ? {} : { owner }),
      ...(owner !== undefined && tagOf ? { tag: (context: Context) => tagOf(owner, context) } : {}),
      ...(exports ? { exports } : {}),
    });
  };
  if (route)
    return async (target, context) => {
      const routed = await route(target);
      const exports = identify && context ? await identify(target, context) : undefined;
      return make(target, exports, routed);
    };
  return (target, context) =>
    identify && context
      ? identify(target, context).then((exports) => make(target, exports))
      : make(target);
}
