import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage, Message, ToolCall } from '@earendil-works/pi-ai';
import { configure, type EntryDraft, type ModelRef, type Tx } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, type AgentsState, freeFolder, type ScoopRecord, scoopId } from '../agents.ts';
import { homeOf } from '../kernel/accounts.ts';
import { quote } from '../kernel/env.ts';
import type { KernelUsers } from '../kernel/users.ts';
import type { Layout } from '../layout.ts';
import { opfsFile } from '../opfs-pool.ts';
import { TITLE_TURNS } from '../titles/extension.ts';
import { IMPORTS_DIR } from './paths.ts';
import { type Notes, place, reportOf } from './v6-place.ts';
import {
  checkLicks,
  checkManifest,
  checkTranscript,
  type Licks,
  type Manifest,
  type Transcript,
  type V6Conversation,
  type V6Message,
} from './v6-schema.ts';
import { Writer } from './v6-write.ts';
import {
  blobSource,
  bytesSource,
  ImportError,
  isLink,
  readEntry,
  type ZipEntry,
  type ZipSource,
  zipEntries,
} from './zip.ts';

export const V6_KIND = 'slicc.v6';
const MiB = 1024 ** 2;
export const LIMITS = {
  archive: 2048 * MiB,
  entries: 60_000,
  file: 256 * MiB,
  transcript: 64 * MiB,
  total: 4096 * MiB,
  ratio: 200,
};

export type ImportProgress = {
  phase: 'idle' | 'checking' | 'writing' | 'done' | 'failed';
  done: number;
  total: number;
  text: string;
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
  flagged: string[];
  providers: string[];
  mounts: string[];
  already: number | null;
  text: string;
  line: string;
}

export interface ImportResult {
  done: boolean;
  preview: ImportPreview | null;
  cones: string[];
  report: string | null;
  text: string;
  line: string;
  error: string | null;
}

type ReadSource = { path: string } | { bytes: Uint8Array };

export type ImportSource = ReadSource | { upload: string };

const UPLOAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const uploadPath = (id: string) => `${IMPORTS_DIR}/upload-${id}.zip`;

function uploaded(source: ImportSource): { path: string } | undefined {
  if (!('upload' in source)) return undefined;
  if (!UPLOAD.test(source.upload)) throw new ImportError("that upload isn't one of the agent's");
  return { path: uploadPath(source.upload) };
}

export interface ImportDeps {
  agents: Agents;
  env: ExecutionEnv;
  layout: Layout;
  memoryHome: string;
  providers?: readonly Account[];
  catalog?: { getModel(provider: string, id: string): { name: string } | undefined };
  users?: Pick<KernelUsers, 'add' | 'remove'>;
  envOf?: (cone: string) => Promise<ExecutionEnv | undefined>;
  opfs?: () => Promise<FileSystemDirectoryHandle>;
  room?: () => Promise<number | undefined>;
  now?: () => number;
}

export type Opened = {
  manifest: Manifest;
  entries: Map<string, ZipEntry>;
  source: ZipSource;
  key: string;
};

export type Where =
  | { kind: 'data' | 'skip' | 'attachment' }
  | { kind: 'cone' | 'scoop' | 'home-user' | 'skill' | 'sprinkle'; folder: string; rest: string };

export type Scoop = {
  name: string;
  six: string | null;
  folder: string;
  conversation?: V6Conversation;
};

export type Unit = {
  key: string;
  name: string;
  title: string;
  six: string | null;
  memory: string | null;
  doc?: Transcript;
  main?: V6Conversation;
  scoops: Scoop[];
  frozenAt: number;
  tail: string;
  cone: string;
  fresh: boolean;
  record: boolean;
  suffix: string;
  home: string;
  roots: Set<string>;
  files: Map<string, string>;
};

export type Parsed = { data: Map<string, Uint8Array>; licks: Licks; units: Unit[] };

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

export async function openProfile(source: ZipSource): Promise<Opened> {
  if (source.size > LIMITS.archive) throw new ImportError('the zip is over 2 GiB');
  const list = await zipEntries(source);
  if (list.length > LIMITS.entries)
    throw new ImportError(`the zip has over ${LIMITS.entries} entries`);
  if (list[0]?.name !== 'manifest.json')
    throw new ImportError('manifest.json must be the first entry');
  const entries = scan(list, source.size);
  const manifest = checkManifest(json(await readEntry(source, list[0]), 'manifest.json'));
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
  return { manifest, entries, source, key: part ? `${exportId}#${part.index}` : exportId };
}

const noLicks: Licks = { crontasks: [], tasks: [], webhooks: [] };

async function licksIn(opened: Opened, data?: Map<string, Uint8Array>): Promise<Licks> {
  const name = opened.manifest.licks;
  if (!name) return noLicks;
  const entry = opened.entries.get(name);
  if (!entry) throw new ImportError(`${name} is named in the manifest but not in the zip`);
  return checkLicks(json(data?.get(name) ?? (await readEntry(opened.source, entry)), name));
}

const ACCOUNTS: Record<string, string> = {
  'bedrock-camp': 'amazon-bedrock',
  bedrock: 'amazon-bedrock',
};

export function accountsOf(providers: readonly string[]): string[] {
  return [...new Set(providers.map((name) => ACCOUNTS[name] ?? name))];
}

const UNITS = [
  [1024 ** 3, 'GB'],
  [1024 ** 2, 'MB'],
  [1024, 'KB'],
] as const;

export type Account = { readonly id: string; readonly name?: string | undefined };

const NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'github-copilot': 'GitHub Copilot',
  google: 'Google',
  azure: 'Azure',
  'azure-openai': 'Azure OpenAI',
  'azure-ai-foundry': 'Azure AI Foundry',
  'amazon-bedrock': 'Amazon Bedrock',
  adobe: 'Adobe',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  groq: 'Groq',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  'local-llm': 'Local LLM',
};

export function listed(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

export function accountsSplit(providers: readonly string[], known?: readonly Account[]) {
  const accounts = accountsOf(providers);
  const ids = new Map((known ?? []).map((account) => [account.id, account.name]));
  const again = known ? accounts.filter((id) => ids.has(id)) : accounts;
  const missing = accounts.filter((id) => !again.includes(id));
  const nameOf = (id: string) => ids.get(id) || NAMES[id] || id;
  const lacking = missing.length
    ? `SLICC 7 has no accounts for ${listed(missing.map(nameOf))}.`
    : '';
  const settings = again.length ? `Re-enter in Settings: ${listed(again.map(nameOf))}.` : '';
  const signIn = again.length
    ? `Sign in to ${listed(again.map(nameOf))} again before you thaw them.`
    : '';
  return { again, missing, nameOf, lacking, settings, signIn };
}

const said = (...parts: string[]) => parts.filter(Boolean).join(' ');

const words = (at: string) =>
  new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const hostOf = (origin: string) => (URL.canParse(origin) ? new URL(origin).host : origin);

export async function previewOf(
  opened: Opened,
  state: Readonly<AgentsState>,
  known?: readonly Account[]
): Promise<ImportPreview> {
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
  const host = hostOf(manifest.producer.origin);
  const split = accountsSplit(manifest.providers, known);
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
    flagged: manifest.flagged.map((item) => item.path),
    providers: split.again,
    mounts,
    already: state.imports?.[opened.key]?.at ?? null,
    text: said(
      `SLICC 6 profile from ${host}, exported ${words(manifest.createdAt)}.`,
      split.lacking
    ),
    line: said(
      `SLICC 6 profile from ${host}, exported ${day(manifest.createdAt)}: ${parts.join(', ')}.`,
      split.settings,
      split.lacking,
      `Not imported: ${plural(mounts.length, 'mount')}.`
    ),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Show = (phase: ImportProgress['phase'], done: number, total: number) => void;

async function verify(opened: Opened, writer: Writer, stage: string | null, show: Show) {
  const data = new Map<string, Uint8Array>();
  const { files } = opened.manifest;
  for (const [at, file] of files.entries()) {
    writer.check();
    const bytes = await readEntry(opened.source, opened.entries.get(file.path) as ZipEntry);
    if ((await sha256(bytes)) !== file.sha256.toLowerCase())
      throw new ImportError(`${file.path} doesn't match its sha256`);
    const where = whereOf(opened.manifest, file.path);
    if (where.kind === 'data') data.set(file.path, bytes);
    else if (where.kind !== 'skip' && stage) await writer.put(`${stage}/${file.path}`, bytes, true);
    show('checking', at + 1, files.length);
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

function draft(
  fields: Pick<Unit, 'key' | 'name' | 'title' | 'six' | 'memory' | 'scoops'> & {
    doc?: Transcript;
    main?: V6Conversation;
  },
  when: (string | null | undefined)[],
  created: string
): Unit {
  const last = fields.main?.messages.at(-1)?.timestamp;
  const frozenAt = [...when, last, created]
    .map((value) => Date.parse(value ?? ''))
    .find((at) => !Number.isNaN(at)) as number;
  const tail = (fields.doc?.conversations ?? [])
    .map((item) => item.messages.at(-1)?.id ?? '')
    .join(',');
  return {
    ...fields,
    frozenAt,
    tail,
    cone: '',
    fresh: true,
    record: true,
    suffix: '',
    home: '',
    roots: new Set(),
    files: new Map(),
  };
}

export function unitsOf(manifest: Manifest, data: Map<string, Uint8Array>): Unit[] {
  const cones = manifest.cones.map((cone) => {
    const doc = transcriptIn(data, cone.transcript);
    const all = doc?.conversations ?? [];
    const main =
      all.find((item) => item.id === cone.conversation) ?? all.find((item) => item.kind === 'cone');
    const scoops = cone.scoops.map((scoop) => ({
      name: scoop.name,
      six: scoop.folder,
      folder: '',
      conversation:
        all.find((item) => item.id === scoop.conversation) ??
        all.find((item) => item.kind === 'scoop' && item.folder === scoop.folder),
    }));
    const title = doc?.session.title || cone.name;
    return draft(
      {
        key: cone.key,
        name: cone.name,
        title,
        six: cone.folder,
        memory: cone.memory,
        doc,
        main,
        scoops,
      },
      [doc?.session.updatedAt],
      manifest.createdAt
    );
  });
  const frozen = manifest.frozen.map((item) => {
    const doc = transcriptIn(data, item.transcript) as Transcript;
    const [main, ...rest] = [...doc.conversations].sort(
      (a, b) => Number(b.kind === 'cone') - Number(a.kind === 'cone')
    );
    const title = item.title || doc.session.title;
    const scoops = rest.map((conversation) => ({
      name: conversation.name,
      six: null,
      folder: '',
      conversation,
    }));
    const when = [item.frozenAt, doc.session.frozenAt, doc.session.updatedAt];
    return draft(
      { key: `frozen:${item.id}`, name: title, title, six: null, memory: null, doc, main, scoops },
      when,
      manifest.createdAt
    );
  });
  return [...cones, ...frozen];
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

async function parse(opened: Opened, data: Map<string, Uint8Array>): Promise<Parsed> {
  for (const [name, bytes] of data)
    if (name.startsWith('memory/') || name === opened.manifest.gitconfig) textOf(bytes, name);
  related(opened.manifest, data);
  return { data, licks: await licksIn(opened, data), units: unitsOf(opened.manifest, data) };
}

function prior(state: Readonly<AgentsState>, origin: string, key: string) {
  const known = new Set([
    ...Object.keys(state.cones),
    ...Object.values(state.frozen ?? {}).map((item) => item.cone),
  ]);
  return Object.values(state.imports ?? {})
    .filter((item) => item.origin === origin && known.has(item.cones[key] as string))
    .sort((a, b) => b.at - a.at)
    .map((item) => ({ cone: item.cones[key] as string, tail: item.tails[key] as string }))[0];
}

async function assign(
  deps: ImportDeps,
  opened: Opened,
  units: Unit[],
  again: boolean,
  date: string,
  context: Context
) {
  const { agents } = deps;
  const origin = opened.manifest.producer.origin;
  let fresh = 0;
  for (const unit of units) {
    const before = again ? undefined : prior(agents.state(), origin, unit.key);
    if (!before) fresh += 1;
    if (!before) continue;
    unit.cone = before.cone;
    unit.fresh = false;
    unit.record = before.tail !== unit.tail;
    if (unit.record) unit.title = `${unit.title} (updated)`;
    if (agents.state().cones[before.cone]) unit.suffix = `.v6-${date}`;
  }
  const first = fresh
    ? await agents.update((_tx, doc) => {
        doc.next += fresh;
        return doc.next - fresh;
      }, context)
    : 0;
  const taken: Record<string, ScoopRecord> = { ...agents.state().scoops };
  let next = first;
  for (const unit of units) {
    if (unit.fresh) unit.cone = `cone-${next++}`;
    unit.home = homeOf(unit.cone);
    for (const scoop of unit.scoops) {
      scoop.folder = freeFolder({ scoops: taken }, scoop.name);
      taken[scoopId(scoop.folder)] = {} as ScoopRecord;
    }
  }
}

const ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function piMessage(
  message: V6Message,
  names: Map<string, string>,
  files: Map<string, string>
): Message {
  const timestamp = Date.parse(message.timestamp);
  const texts = message.content.flatMap((part) => {
    if (part.type === 'text') return [{ type: 'text' as const, text: part.text }];
    if (part.type === 'tool-call') return [];
    const file = files.get(part.attachmentId);
    return [
      {
        type: 'text' as const,
        text: file ? `[Attached file: ${file}]` : '[An attachment SLICC 6 did not export]',
      },
    ];
  });
  if (message.role === 'user') return { role: 'user', content: texts, timestamp };
  const id = message.toolCallId as string;
  if (message.role === 'tool-result')
    return {
      role: 'toolResult',
      toolCallId: id,
      toolName: names.get(id) ?? 'tool',
      content: texts,
      isError: message.isError === true,
      timestamp,
    };
  const calls = message.content.flatMap((part) => {
    if (part.type !== 'tool-call') return [];
    names.set(part.id, part.name);
    const input = part.input;
    const object = typeof input === 'object' && input !== null && !Array.isArray(input);
    return [
      {
        type: 'toolCall' as const,
        id: part.id,
        name: part.name,
        arguments: (object ? input : { input }) as ToolCall['arguments'],
      },
    ];
  });
  const assistant: AssistantMessage = {
    role: 'assistant',
    content: [...texts, ...calls],
    api: message.model?.api ?? 'slicc-6',
    provider: message.model?.provider ?? 'slicc-6',
    model: message.model?.id ?? 'unknown',
    usage: (message.usage as typeof ZERO | undefined) ?? ZERO,
    stopReason: calls.length ? 'toolUse' : 'stop',
    timestamp,
  };
  return assistant;
}

export function entriesOf(
  conversation: V6Conversation | undefined,
  files: Map<string, string>
): EntryDraft[] {
  const names = new Map<string, string>();
  return (conversation?.messages ?? []).map((message) => ({
    kind: V6_KIND,
    data: { id: message.id },
    model: [piMessage(message, names, files)],
  }));
}

async function conversationIn(
  tx: Tx,
  conversation: V6Conversation | undefined,
  unit: Unit,
  model: ModelRef | undefined
) {
  const record = await tx.createConversation({ ownership: { kind: 'ownerless' } });
  if (model) await configure(tx, record.id, { model });
  for (const entry of entriesOf(conversation, unit.files)) await tx.appendEntry(record.id, entry);
  return record.id as number;
}

function modelOf(deps: ImportDeps, conversation: V6Conversation | undefined): string {
  const model = conversation?.messages.findLast((message) => message.model)?.model;
  if (!model) return '';
  return deps.catalog?.getModel(model.provider, model.id)?.name ?? `${model.provider}/${model.id}`;
}

async function commit(
  deps: ImportDeps,
  opened: Opened,
  units: Unit[],
  at: number,
  context: Context
) {
  const model = (await deps.agents.cone().agent(context)).model;
  const origin = opened.manifest.producer.origin;
  const last = TITLE_TURNS.at(-1) as number;
  return deps.agents.update(async (tx, doc) => {
    const made: string[] = [];
    for (const unit of units.filter((item) => item.record)) {
      const frozenId = `frozen-${doc.frozenNext ?? 1}`;
      doc.frozenNext = (doc.frozenNext ?? 1) + 1;
      const scoops: string[] = [];
      for (const scoop of unit.scoops) {
        const id = scoopId(scoop.folder);
        if (doc.scoops[id])
          throw new ImportError(`the scoop folder ${scoop.folder} was taken during the import`);
        const conversation = await conversationIn(tx, scoop.conversation, unit, model);
        doc.scoops[id] = {
          name: scoop.name,
          folder: scoop.folder,
          cone: unit.cone,
          conversation,
          anchor: 0,
          role: null,
          kind: 'async',
          parent: unit.cone,
          depth: 1,
          roots: null,
          created: null,
          dropped: null,
          gone: true,
          frozen: frozenId,
          title: scoop.name,
          titled: last,
        };
        scoops.push(id);
      }
      doc.frozen ??= {};
      doc.frozen[frozenId] = {
        cone: unit.cone,
        name: unit.name,
        conversation: await conversationIn(tx, unit.main, unit, model),
        title: unit.title,
        model: modelOf(deps, unit.main),
        messages: (unit.main?.messages ?? []).filter((message) => message.role !== 'tool-result')
          .length,
        frozenAt: unit.frozenAt,
        scoops,
        v6: { origin, key: unit.key, ...(unit.suffix ? { suffix: unit.suffix } : {}) },
      };
      made.push(frozenId);
    }
    doc.imports ??= {};
    doc.imports[opened.key] = {
      at,
      origin,
      cones: Object.fromEntries(units.map((unit) => [unit.key, unit.cone])),
      tails: Object.fromEntries(units.map((unit) => [unit.key, unit.tail])),
    };
    return made;
  }, context);
}

async function storageRoom(): Promise<number | undefined> {
  const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
  return estimate?.quota === undefined ? undefined : estimate.quota - (estimate.usage ?? 0);
}

async function importOpened(
  deps: ImportDeps,
  opened: Opened,
  options: { again: boolean; signal: AbortSignal; show: Show },
  context: Context
): Promise<ImportResult> {
  const now = (deps.now ?? Date.now)();
  const date = day(now);
  const writer = new Writer(deps.env, context, options.signal);
  const stage = `${IMPORTS_DIR}/${opened.key.replace('#', '-part')}`;
  const total = opened.manifest.files.reduce((sum, file) => sum + file.size, 0);
  const room = await (deps.room ?? storageRoom)();
  if (room !== undefined && room < 2 * total)
    throw new ImportError('there is not enough free storage for this import');
  try {
    await writer.sh(
      `mkdir -p ${IMPORTS_DIR} && chmod 700 ${IMPORTS_DIR} && rm -rf ${quote(stage)} && mkdir -p ${quote(stage)}`
    );
    const data = await verify(opened, writer, stage, options.show);
    const parsed = await parse(opened, data);
    await assign(deps, opened, parsed.units, options.again, date, context);
    const notes: Notes = {
      lines: [],
      skipped: [],
      shadowed: [],
      tasks: [],
      sprinkles: new Map(),
      crons: [],
      webhooks: [],
      placed: new Map(),
    };
    const run = {
      deps,
      opened,
      parsed,
      writer,
      stage,
      date,
      notes,
      show: options.show,
      fresh: new Map(),
      ready: new Set<Unit>(),
    };
    let made: string[];
    try {
      await place(run);
      made = await commit(deps, opened, parsed.units, now, context);
    } catch (error) {
      await writer.rollback();
      throw error;
    }
    const report = await reportOf(run, made).catch((error: Error) => `nowhere (${error.message})`);
    const split = accountsSplit(opened.manifest.providers, deps.providers);
    const { origin } = opened.manifest.producer;
    const settings = said(split.settings, split.lacking);
    return {
      done: true,
      preview: null,
      cones: made,
      report,
      text: said(`From ${hostOf(origin)}.`, split.signIn),
      line: `Imported ${plural(made.length, 'frozen cone')} from ${origin}${made.length ? `: ${made.join(', ')}` : ''}.\n${settings ? `${settings}\n` : ''}The report is ${report}.\n`,
      error: null,
    };
  } finally {
    await deps.env.remove(stage, { recursive: true, force: true }, BACKGROUND_CONTEXT);
  }
}

async function sourceOf(
  deps: ImportDeps,
  source: ReadSource,
  context: Context
): Promise<ZipSource> {
  if ('bytes' in source) return bytesSource(source.bytes);
  const { env } = deps;
  const real = await env.canonicalPath(source.path, context);
  const info = real.ok ? await env.fileInfo(real.value, context) : real;
  if (!info.ok) throw new ImportError(`can't read ${source.path}: ${info.error.message}`);
  if (info.value.size > LIMITS.archive) throw new ImportError('the zip is over 2 GiB');
  const file = await opfsFile(info.value.path, deps.opfs);
  if (file?.size === info.value.size) return blobSource(file);
  if (info.value.size > LIMITS.file)
    throw new ImportError(`${source.path} isn't on seven's own disk; copy the zip to /tmp first`);
  const read = await env.readBinaryFile(info.value.path, context);
  if (!read.ok) throw new ImportError(`can't read ${source.path}: ${read.error.message}`);
  return bytesSource(read.value);
}

export interface Importer {
  readonly progress: ReplicatedState<ImportProgress>;
  run(
    source: ImportSource,
    options: { again?: boolean; preview?: boolean },
    context: Context
  ): Promise<ImportResult>;
  cancel(): void;
}

export const IDLE: ImportProgress = { phase: 'idle', done: 0, total: 0, text: '' };

export function createImporter(deps: ImportDeps): Importer {
  const progress = replicatedState<ImportProgress>(IDLE);
  let running: AbortController | undefined;
  const result = (fields: Partial<ImportResult>): ImportResult => ({
    done: false,
    preview: null,
    cones: [],
    report: null,
    text: '',
    line: '',
    error: null,
    ...fields,
  });
  return {
    progress,
    cancel: () => running?.abort(),
    async run(source, options, context) {
      if (running) return result({ error: 'an import is already running' });
      const controller = new AbortController();
      running = controller;
      const show: Show = (phase, done, total) =>
        progress.replace(BACKGROUND_CONTEXT, {
          phase,
          done,
          total,
          text: `${phase === 'checking' ? 'Checking' : 'Importing'} ${done} of ${total}`,
        });
      let upload: { path: string } | undefined;
      try {
        upload = uploaded(source);
        const opened = await openProfile(
          await sourceOf(deps, upload ?? (source as ReadSource), context)
        );
        const preview = await previewOf(opened, deps.agents.state(), deps.providers);
        if (options.preview) {
          const writer = new Writer(deps.env, context, controller.signal);
          await parse(opened, await verify(opened, writer, null, show));
          progress.replace(BACKGROUND_CONTEXT, IDLE);
          return result({ preview, text: preview.text, line: `${preview.line}\n` });
        }
        if (preview.already !== null && !options.again)
          return result({
            preview,
            text: `Already imported on ${day(preview.already)}.`,
            line: `Already imported on ${day(preview.already)}; freezer import --again makes fresh copies.\n`,
          });
        const done = await importOpened(
          deps,
          opened,
          { again: options.again === true, signal: controller.signal, show },
          context
        );
        progress.replace(BACKGROUND_CONTEXT, { ...progress.value, phase: 'done', text: done.text });
        return { ...done, preview };
      } catch (error) {
        const message =
          error instanceof ImportError
            ? error.message
            : `the import failed: ${(error as Error).message}`;
        progress.replace(BACKGROUND_CONTEXT, { phase: 'failed', done: 0, total: 0, text: message });
        return result({ error: message });
      } finally {
        running = undefined;
        if (upload) await deps.env.remove(upload.path, { force: true }, BACKGROUND_CONTEXT);
      }
    },
  };
}
