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
import type { Activity } from './activity.ts';
import type { KernelClient } from './client.ts';
import { execute } from './exec.ts';
import { attempt, info, KernelDirReader, SnapshotLines, SnapshotReader } from './files.ts';
import { dirname, normalize, resolve } from './paths.ts';
import { nativeWatch, type PollOptions, pollWatch, RESCAN_MS } from './watch.ts';

export interface KernelEnvOptions {
  cwd: string;
  id?: string;
  watch?: PollOptions;
  activity?: Activity;
}

type FileResult<T> = Promise<Result<T, FileError>>;

export class SliccKernelEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #client: KernelClient;
  readonly #watchers = new Set<FileWatcher>();
  readonly #poll: PollOptions;
  readonly #activity: Activity | undefined;

  constructor(client: KernelClient, options: KernelEnvOptions) {
    this.#client = client;
    this.cwd = options.cwd;
    this.id = options.id ?? 'slicc-kernel';
    this.#poll = options.watch ?? {};
    this.#activity = options.activity;
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
      return new SnapshotReader(await this.#fs.readFile(resolved), info(resolved, stat));
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
      const native =
        this.#poll.mode === 'polling'
          ? undefined
          : await nativeWatch(this.#fs, this.cwd, targets, onChange);
      const intervalMs = native ? (this.#poll.rescanMs ?? RESCAN_MS) : this.#poll.intervalMs;
      const polled = await pollWatch(this.#fs, this.cwd, targets, onChange, {
        ...(intervalMs === undefined ? {} : { intervalMs }),
      });
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
    return execute(this.#client, this.cwd, command, options, context).finally(ended);
  }

  async cleanup(context: Context): Promise<void> {
    for (const watcher of [...this.#watchers]) await watcher.close(context);
    this.#watchers.clear();
  }
}

export const HOME = '/home';

export function kernelEnvironment(
  client: KernelClient,
  options: Omit<KernelEnvOptions, 'cwd'> = {}
): (target: { cwd?: string }) => SliccKernelEnv {
  return (target) => new SliccKernelEnv(client, { ...options, cwd: target.cwd ?? HOME });
}
