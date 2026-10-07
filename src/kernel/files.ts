import type { Context } from '@earendil-works/chord';
import {
  type BinaryReader,
  type DirReader,
  err,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type LineScan,
  LineScanner,
  ok,
  type Result,
  type TextLine,
  type TextLineReader,
} from '@earendil-works/pi-durable/env';
import type { KernelFs, KernelStat } from './client.ts';
import { basename } from './paths.ts';

const codes: Record<string, FileErrorCode> = {
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOTDIR: 'not_directory',
  EISDIR: 'is_directory',
  EINVAL: 'invalid',
  ELOOP: 'invalid',
  ENOSYS: 'not_supported',
  ENOTSUP: 'not_supported',
};

export function fileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error;
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  return new FileError((code && codes[code]) || 'unknown', message, path, cause);
}

export function aborted(context: Context, path?: string): Result<never, FileError> | undefined {
  if (!context.abortSignal?.aborted) return undefined;
  return err(new FileError('aborted', 'The operation was aborted', path));
}

export async function attempt<T>(
  context: Context,
  path: string,
  run: () => Promise<T>
): Promise<Result<T, FileError>> {
  const before = aborted(context, path);
  if (before) return before;
  try {
    const value = await run();
    return aborted(context, path) ?? ok(value);
  } catch (error) {
    return err(fileError(error, path));
  }
}

export function info(path: string, stat: KernelStat): FileInfo {
  const kind = stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file';
  return {
    name: basename(path),
    path,
    kind,
    size: stat.size,
    mtimeMs: new Date(stat.mtime).getTime(),
  };
}

function closed<T>(what: string, path: string): Result<T, FileError> {
  return err(new FileError('invalid', `${what} is closed`, path));
}

export class SnapshotReader implements BinaryReader {
  readonly #bytes: Uint8Array;
  readonly #info: FileInfo;
  #closed = false;

  constructor(bytes: Uint8Array, fileInfo: FileInfo) {
    this.#bytes = bytes;
    this.#info = fileInfo;
  }

  async info(): Promise<Result<FileInfo, FileError>> {
    return this.#closed ? closed('Binary reader', this.#info.path) : ok(this.#info);
  }

  async read(
    offset: number,
    length: number,
    context: Context
  ): Promise<Result<Uint8Array, FileError>> {
    const path = this.#info.path;
    const stop = aborted(context, path);
    if (stop) return stop;
    if (this.#closed) return closed('Binary reader', path);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      return err(new FileError('invalid', 'Offset and length must be non-negative integers', path));
    }
    return ok(this.#bytes.slice(offset, offset + length));
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    context: Context
  ): Promise<Result<LineScan, FileError>> {
    const path = this.#info.path;
    const stop = aborted(context, path);
    if (stop) return stop;
    if (this.#closed) return closed('Binary reader', path);
    let scanner: LineScanner;
    try {
      scanner = new LineScanner(options.startLine, options.endLine);
    } catch {
      return err(new FileError('invalid', 'Invalid line range', path));
    }
    scanner.push(this.#bytes);
    return ok(scanner.finish());
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

export class SnapshotLines implements TextLineReader {
  readonly #lines: TextLine[];
  #next = 0;

  constructor(text: string) {
    const parts = text.split('\n');
    const last = parts.pop() as string;
    this.#lines = parts.map((part) => ({ text: part, terminated: true }));
    if (last !== '') this.#lines.push({ text: last, terminated: false });
  }

  async readLine(): Promise<Result<TextLine | undefined, FileError>> {
    return ok(this.#lines[this.#next++]);
  }

  async close(): Promise<void> {
    this.#next = this.#lines.length;
  }
}

export class KernelDirReader implements DirReader {
  readonly #fs: KernelFs;
  readonly #path: string;
  readonly #names: string[];
  #closed = false;

  constructor(fs: KernelFs, path: string, names: string[]) {
    this.#fs = fs;
    this.#path = path;
    this.#names = names;
  }

  async next(
    maxEntries: number,
    context: Context
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    if (this.#closed) return closed('Directory reader', this.#path);
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      return err(new FileError('invalid', 'maxEntries must be a positive integer', this.#path));
    }
    const stop = aborted(context, this.#path);
    if (stop) return stop;
    const entries = await this.#take(maxEntries);
    return ok({ entries, done: this.#names.length === 0 });
  }

  rest(): Promise<FileInfo[]> {
    return this.#take(Number.MAX_SAFE_INTEGER);
  }

  async #take(max: number): Promise<FileInfo[]> {
    const entries: FileInfo[] = [];
    while (entries.length < max && this.#names.length > 0) {
      const path = `${this.#path === '/' ? '' : this.#path}/${this.#names.shift()}`;
      const stat = await this.#fs.lstat(path).catch(() => undefined);
      if (stat) entries.push(info(path, stat));
    }
    return entries;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
