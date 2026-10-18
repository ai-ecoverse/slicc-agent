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

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const WIDE = 0xffffffff;
const UNIX = 3;

const damaged = (what: string) => new ImportError(`the zip is damaged: ${what}`);

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function endOf(bytes: Uint8Array, view: DataView): number {
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--)
    if (view.getUint32(at, true) === END) return at;
  throw new ImportError('this is not a zip file');
}

export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = viewOf(bytes);
  const end = endOf(bytes, view);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === WIDE) throw new ImportError('ZIP64 archives are not supported');
  const names = new TextDecoder('utf-8', { fatal: true });
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) throw damaged('a bad directory');
    const length = view.getUint16(at + 28, true);
    const skip = length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const entry = {
      name: names.decode(bytes.subarray(at + 46, at + 46 + length)),
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

export async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = viewOf(bytes);
  if (entry.flags & 1) throw new ImportError(`${entry.name} is encrypted`);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== LOCAL)
    throw damaged(`no local header for ${entry.name}`);
  const start =
    entry.offset +
    30 +
    view.getUint16(entry.offset + 26, true) +
    view.getUint16(entry.offset + 28, true);
  if (start + entry.compressed > bytes.length) throw damaged(`${entry.name} is cut off`);
  const data = bytes.subarray(start, start + entry.compressed);
  if (entry.method === 0) {
    if (entry.compressed !== entry.size) throw damaged(`${entry.name} has two sizes`);
    return data;
  }
  if (entry.method !== 8) throw new ImportError(`${entry.name} uses compression ${entry.method}`);
  return inflate(data, entry.size, entry.name);
}
