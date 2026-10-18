import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import {
  checkLicks,
  checkManifest,
  checkTranscript,
  type Licks,
  type Manifest,
  type Transcript,
} from './v6-schema.ts';
import { ImportError, isLink, readEntry, type ZipEntry, zipEntries } from './zip.ts';

const MiB = 1024 ** 2;
export const LIMITS = {
  archive: 2048 * MiB,
  entries: 60_000,
  file: 256 * MiB,
  transcript: 64 * MiB,
  total: 4096 * MiB,
  ratio: 200,
};

export interface ImportPreview {
  exportId: string;
  origin: string;
  createdAt: string;
  cones: number;
  scoops: number;
  frozen: number;
  bytes: number;
  skills: string[];
  crons: number;
  webhooks: number;
  flagged: number;
  providers: string[];
  mounts: string[];
  text: string;
}

export type ImportSource = { path: string } | { bytes: Uint8Array };

export type Opened = {
  manifest: Manifest;
  entries: Map<string, ZipEntry>;
  bytes: Uint8Array;
  key: string;
};

export type Where =
  | { kind: 'data' | 'skip' | 'attachment' }
  | { kind: 'cone' | 'scoop' | 'home-user' | 'skill' | 'sprinkle'; folder: string; rest: string };

export const day = (at: number | string) => new Date(at).toISOString().slice(0, 10);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function textOf(bytes: Uint8Array, name: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ImportError(`${name} is not UTF-8 text`);
  }
}

function json(bytes: Uint8Array, name: string): unknown {
  const text = textOf(bytes, name);
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError(`${name} is not JSON`);
  }
}

const safe = (name: string) =>
  !/^\/|^[A-Za-z]:|\\|\0/.test(name) &&
  name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

const HOOKS = /(^|\/)\.git\/hooks\//;

export function whereOf(manifest: Manifest, name: string): Where {
  const where = placeOf(manifest, name);
  const tree = where.kind === 'cone' || where.kind === 'scoop' || where.kind === 'home-user';
  return tree && HOOKS.test(name) ? { kind: 'skip' } : where;
}

function placeOf(manifest: Manifest, name: string): Where {
  const [top = '', second = '', ...more] = name.split('/');
  const rest = more.join('/');
  if (
    ['transcripts', 'frozen', 'memory'].includes(top) ||
    [manifest.licks, manifest.gitconfig].includes(name)
  )
    return { kind: 'data' };
  if (top === 'attachments' && /^[0-9a-f]{64}$/.test(second) && !rest)
    return { kind: 'attachment' };
  if (top === 'files' && second === 'home-user' && rest)
    return { kind: 'home-user', folder: '', rest };
  const folder = more[0] as string;
  const inner = more.slice(1).join('/');
  if (
    top === 'files' &&
    second === 'cones' &&
    inner &&
    manifest.cones.some((cone) => cone.folder === folder)
  )
    return { kind: 'cone', folder, rest: inner };
  const scoops = manifest.cones.flatMap((cone) => cone.scoops);
  if (
    top === 'files' &&
    second === 'scoops' &&
    inner &&
    scoops.some((scoop) => scoop.folder === folder)
  )
    return { kind: 'scoop', folder, rest: inner };
  const listed = top === 'skills' ? manifest.skills : top === 'sprinkles' ? manifest.sprinkles : [];
  if (rest && listed.some((item) => item.name === second))
    return { kind: top === 'skills' ? 'skill' : 'sprinkle', folder: second, rest };
  throw new ImportError(`${name} has no place in a SLICC 6 profile`);
}

function scan(list: readonly ZipEntry[], archive: number): Map<string, ZipEntry> {
  const entries = new Map<string, ZipEntry>();
  let total = 0;
  for (const entry of list) {
    if (!safe(entry.name))
      throw new ImportError(`refused the entry name ${JSON.stringify(entry.name)}`);
    if (isLink(entry)) throw new ImportError(`${entry.name} is a symlink`);
    if (entries.has(entry.name)) throw new ImportError(`${entry.name} is in the zip twice`);
    const big = entry === list[0] || /^(transcripts|frozen)\//.test(entry.name);
    const cap = big ? LIMITS.transcript : LIMITS.file;
    if (entry.size > cap) throw new ImportError(`${entry.name} is over ${cap / MiB} MiB`);
    total += entry.size;
    entries.set(entry.name, entry);
  }
  if (total > LIMITS.total) throw new ImportError('the files add up to over 4 GiB');
  if (total > LIMITS.ratio * archive)
    throw new ImportError('the zip expands over 200:1, like a zip bomb');
  return entries;
}

export async function openProfile(bytes: Uint8Array): Promise<Opened> {
  if (bytes.length > LIMITS.archive) throw new ImportError('the zip is over 2 GiB');
  const list = zipEntries(bytes);
  if (list.length > LIMITS.entries)
    throw new ImportError(`the zip has over ${LIMITS.entries} entries`);
  if (list[0]?.name !== 'manifest.json')
    throw new ImportError('manifest.json must be the first entry');
  const entries = scan(list, bytes.length);
  const manifest = checkManifest(json(await readEntry(bytes, list[0]), 'manifest.json'));
  const listed = new Set<string>();
  for (const file of manifest.files) {
    if (entries.get(file.path)?.size !== file.size || file.path === 'manifest.json')
      throw new ImportError(
        `${file.path} is in the manifest but not in the zip, or not at that size`
      );
    listed.add(file.path);
  }
  for (const name of entries.keys()) {
    if (name === 'manifest.json') continue;
    if (!listed.has(name)) throw new ImportError(`${name} is not listed in the manifest`);
    whereOf(manifest, name);
  }
  const { exportId, part } = manifest;
  return { manifest, entries, bytes, key: part ? `${exportId}#${part.index}` : exportId };
}

const noLicks: Licks = { crontasks: [], tasks: [], webhooks: [] };

async function licksIn(opened: Opened, data?: Map<string, Uint8Array>): Promise<Licks> {
  const name = opened.manifest.licks;
  if (!name) return noLicks;
  const entry = opened.entries.get(name);
  if (!entry) throw new ImportError(`${name} is named in the manifest but not in the zip`);
  return checkLicks(json(data?.get(name) ?? (await readEntry(opened.bytes, entry)), name));
}

const UNITS = [
  [1e9, 'GB'],
  [1e6, 'MB'],
  [1e3, 'KB'],
] as const;

export async function previewOf(opened: Opened): Promise<ImportPreview> {
  const { manifest } = opened;
  const licks = await licksIn(opened);
  const bytes = manifest.files
    .filter((file) => file.path.startsWith('files/'))
    .reduce((sum, file) => sum + file.size, 0);
  const scoops = manifest.cones.reduce((sum, cone) => sum + cone.scoops.length, 0);
  const mounts = manifest.skipped
    .filter((item) => item.reason === 'mount')
    .map((item) => item.path.replace(/^\/mnt\//, ''));
  const crons =
    licks.crontasks.length + licks.tasks.filter((task) => task.scheduleType === 'cron').length;
  const host = URL.canParse(manifest.producer.origin)
    ? new URL(manifest.producer.origin).host
    : manifest.producer.origin;
  const [at, unit] = UNITS.find(([at]) => bytes >= at) ?? (UNITS[2] as (typeof UNITS)[2]);
  const size = `${(bytes / at).toFixed(1)} ${unit}`;
  const parts = [
    plural(manifest.cones.length, 'cone'),
    plural(scoops, 'scoop'),
    plural(manifest.frozen.length, 'frozen session'),
    `${size} of files`,
    `${plural(manifest.skills.length, 'skill')} (for every agent)`,
    `${plural(crons, 'cron')} (imported off)`,
    `${plural(licks.webhooks.length, 'webhook')} (new URLs needed)`,
    `${plural(manifest.flagged.length, 'credential-like file')} to review`,
  ];
  return {
    exportId: manifest.exportId,
    origin: manifest.producer.origin,
    createdAt: manifest.createdAt,
    cones: manifest.cones.length,
    scoops,
    frozen: manifest.frozen.length,
    bytes,
    skills: manifest.skills.map((skill) => skill.name),
    crons,
    webhooks: licks.webhooks.length,
    flagged: manifest.flagged.length,
    providers: manifest.providers,
    mounts,
    text: `SLICC 6 profile from ${host}, exported ${day(manifest.createdAt)}: ${parts.join(', ')}. Re-enter in Settings: ${manifest.providers.join(', ') || 'nothing'}. Not imported: ${plural(mounts.length, 'mount')}.`,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verify(opened: Opened): Promise<Map<string, Uint8Array>> {
  const data = new Map<string, Uint8Array>();
  for (const file of opened.manifest.files) {
    const bytes = await readEntry(opened.bytes, opened.entries.get(file.path) as ZipEntry);
    if ((await sha256(bytes)) !== file.sha256.toLowerCase())
      throw new ImportError(`${file.path} doesn't match its sha256`);
    if (whereOf(opened.manifest, file.path).kind === 'data') data.set(file.path, bytes);
  }
  return data;
}

function transcriptIn(data: Map<string, Uint8Array>, name: string | null): Transcript | undefined {
  if (!name) return undefined;
  const bytes = data.get(name);
  if (!bytes) throw new ImportError(`${name} is named in the manifest but not in the zip`);
  const value = json(bytes, name);
  try {
    return checkTranscript(value);
  } catch (error) {
    throw new ImportError(`${name}: ${(error as Error).message}`);
  }
}

function present(data: Map<string, Uint8Array>, name: string | null | undefined) {
  if (name && !data.has(name))
    throw new ImportError(`${name} is named in the manifest but not in the zip`);
}

function attached(manifest: Manifest, name: string, doc: Transcript) {
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  for (const item of doc.attachments) {
    const file = files.get(item.path);
    const same =
      file !== undefined &&
      file.size === item.byteLength &&
      file.sha256.toLowerCase() === item.sha256.toLowerCase();
    if (item.present && !(item.path.startsWith('attachments/') && same))
      throw new ImportError(`${name}: attachment ${item.id} doesn't match ${item.path}`);
  }
}

function related(manifest: Manifest, data: Map<string, Uint8Array>) {
  const transcripts = [
    ...manifest.cones.map((cone) => cone.transcript),
    ...manifest.frozen.map((item) => item.transcript),
  ].filter((name): name is string => name !== null);
  const twice = transcripts.find((name, at) => transcripts.indexOf(name) !== at);
  if (twice) throw new ImportError(`${twice} is named twice in the manifest`);
  for (const name of [...manifest.cones.map((cone) => cone.memory), manifest.gitconfig])
    present(data, name);
  for (const [kind, items] of [
    ['skills', manifest.skills],
    ['sprinkles', manifest.sprinkles],
  ] as const)
    for (const item of items)
      if (
        item.path !== `${kind}/${item.name}/` ||
        !manifest.files.some((file) => file.path.startsWith(item.path))
      )
        throw new ImportError(`${item.path} is named in the manifest but has no files`);
  for (const cone of manifest.cones) {
    const doc = transcriptIn(data, cone.transcript);
    const ids = new Set(doc?.conversations.map((item) => item.id));
    for (const id of [cone.conversation, ...cone.scoops.map((scoop) => scoop.conversation)])
      if (id !== null && !ids.has(id))
        throw new ImportError(`${cone.transcript ?? cone.folder} has no conversation ${id}`);
  }
  for (const name of transcripts) attached(manifest, name, transcriptIn(data, name) as Transcript);
}

async function checked(opened: Opened, data: Map<string, Uint8Array>): Promise<void> {
  for (const [name, bytes] of data)
    if (name.startsWith('memory/') || name === opened.manifest.gitconfig) textOf(bytes, name);
  related(opened.manifest, data);
  await licksIn(opened, data);
}

async function bytesOf(
  env: ExecutionEnv,
  source: ImportSource,
  context: Context
): Promise<Uint8Array> {
  if ('bytes' in source) return source.bytes;
  const info = await env.fileInfo(source.path, context);
  if (!info.ok) throw new ImportError(`can't read ${source.path}: ${info.error.message}`);
  if (info.value.size > LIMITS.archive) throw new ImportError('the zip is over 2 GiB');
  const read = await env.readBinaryFile(source.path, context);
  if (!read.ok) throw new ImportError(`can't read ${source.path}: ${read.error.message}`);
  return read.value;
}

export async function checkProfile(
  env: ExecutionEnv,
  source: ImportSource,
  context: Context
): Promise<ImportPreview> {
  const opened = await openProfile(await bytesOf(env, source, context));
  const preview = await previewOf(opened);
  await checked(opened, await verify(opened));
  return preview;
}
