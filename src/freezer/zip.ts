export class ImportError extends Error {}

export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  compressed: number;
  size: number;
  offset: number;
  mode: number;
};

export interface ZipSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const WIDE = 0xffffffff;
const UNIX = 3;
const TAIL = 22 + 0xffff;

const damaged = (what: string) => new ImportError(`the zip is damaged: ${what}`);

export function bytesSource(bytes: Uint8Array): ZipSource {
  return { size: bytes.length, read: async (at, length) => bytes.subarray(at, at + length) };
}

export function blobSource(blob: Blob): ZipSource {
  return {
    size: blob.size,
    async read(at, length) {
      const part = await blob
        .slice(at, at + length)
        .arrayBuffer()
        .catch(() => {
          throw new ImportError('the zip changed or went away while it was being read');
        });
      return new Uint8Array(part);
    },
  };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function endOf(bytes: Uint8Array, view: DataView): number {
  for (let at = bytes.length - 22; at >= 0; at--) if (view.getUint32(at, true) === END) return at;
  throw new ImportError('this is not a zip file');
}

export async function zipEntries(source: ZipSource): Promise<ZipEntry[]> {
  const from = Math.max(0, source.size - TAIL);
  const tail = await source.read(from, source.size - from);
  const end = endOf(tail, viewOf(tail));
  const count = viewOf(tail).getUint16(end + 10, true);
  const length = viewOf(tail).getUint32(end + 12, true);
  const start = viewOf(tail).getUint32(end + 16, true);
  if (count === 0xffff || start === WIDE) throw new ImportError('ZIP64 archives are not supported');
  if (start + length > from + end) throw damaged('a bad directory');
  const directory = await source.read(start, length);
  const view = viewOf(directory);
  const names = new TextDecoder('utf-8', { fatal: true });
  const out: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directory.length || view.getUint32(at, true) !== CENTRAL)
      throw damaged('a bad directory');
    const named = view.getUint16(at + 28, true);
    const skip = named + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (at + 46 + named > directory.length) throw damaged('a bad directory');
    const entry = {
      name: names.decode(directory.subarray(at + 46, at + 46 + named)),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      compressed: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
      mode: view.getUint16(at + 4, true) >> 8 === UNIX ? view.getUint32(at + 38, true) >>> 16 : 0,
    };
    if (entry.size === WIDE || entry.compressed === WIDE || entry.offset === WIDE)
      throw new ImportError('ZIP64 archives are not supported');
    out.push(entry);
    at += 46 + skip;
  }
  return out;
}

export function isLink(entry: ZipEntry): boolean {
  return (entry.mode & 0o170000) === 0o120000;
}

async function inflate(data: Uint8Array, size: number, name: string): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(size);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => {
      throw damaged(`${name} does not inflate`);
    });
    if (done) break;
    if (filled + value.length > size) {
      await reader.cancel();
      throw damaged(`${name} is bigger than it says`);
    }
    out.set(value, filled);
    filled += value.length;
  }
  if (filled !== size) throw damaged(`${name} is smaller than it says`);
  return out;
}

export async function readEntry(source: ZipSource, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.flags & 1) throw new ImportError(`${entry.name} is encrypted`);
  const head = await source.read(entry.offset, 30);
  if (head.length < 30 || viewOf(head).getUint32(0, true) !== LOCAL)
    throw damaged(`no local header for ${entry.name}`);
  const start =
    entry.offset + 30 + viewOf(head).getUint16(26, true) + viewOf(head).getUint16(28, true);
  if (start + entry.compressed > source.size) throw damaged(`${entry.name} is cut off`);
  const data = await source.read(start, entry.compressed);
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) throw damaged(`${entry.name} has two sizes`);
    return data;
  }
  if (entry.method !== 8) throw new ImportError(`${entry.name} uses compression ${entry.method}`);
  return inflate(data, entry.size, entry.name);
}
