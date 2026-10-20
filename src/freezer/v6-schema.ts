import { ImportError } from './zip.ts';

type Json = Record<string, unknown>;

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'attachment-ref'; attachmentId: string };

export type V6Message = {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool-result';
  timestamp: string;
  content: Block[];
  toolCallId?: string;
  isError?: boolean;
  model?: { provider: string; id: string; api?: string };
  usage?: Json;
  stopReason?: string;
};

export type V6Conversation = {
  id: string;
  kind: 'cone' | 'scoop';
  name: string;
  folder?: string;
  messages: V6Message[];
};

export type V6Attachment = {
  id: string;
  path: string;
  originalName: string;
  sha256: string;
  byteLength: number;
  present: boolean;
};

export type Transcript = {
  session: { id: string; title: string; updatedAt?: string; frozenAt?: string; createdAt?: string };
  conversations: V6Conversation[];
  attachments: V6Attachment[];
};

export type ManifestScoop = {
  key: string;
  folder: string;
  name: string;
  conversation: string | null;
};

export type ManifestCone = ManifestScoop & {
  transcript: string | null;
  memory: string | null;
  scoops: ManifestScoop[];
};

export type Manifest = {
  exportId: string;
  producer: { slicc: string; origin: string };
  createdAt: string;
  part?: { index: number; of: number };
  cones: ManifestCone[];
  frozen: { id: string; title: string; frozenAt: string | null; transcript: string }[];
  skills: { name: string; path: string }[];
  sprinkles: { name: string; path: string }[];
  licks: string | null;
  gitconfig: string | null;
  files: { path: string; size: number; sha256: string; source?: string }[];
  skipped: { path: string; reason: string }[];
  flagged: { path: string; size: number; rule: string }[];
  providers: string[];
  mcp: { name: string; url: string }[];
  secrets: string[];
};

export type Licks = {
  crontasks: { name: string; cron: string; targetFolder?: string | null; filter?: string }[];
  tasks: { groupFolder: string; prompt: string; scheduleType: string; scheduleValue: string }[];
  webhooks: { name: string; targetFolder?: string | null; filter?: string }[];
};

export const FOLDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-fA-F]{64}$/;
const REASONS = [
  'canonical-agent-history-unavailable',
  'tool-data-may-be-truncated',
  'model-metadata-unavailable',
  'scoop-history-unavailable',
  'attachment-file-missing',
  'attachment-association-unavailable',
  'complete-snapshot-unavailable',
];
const RULES = ['env', 'pem', 'git-credentials', 'npmrc', 'slicc-oauth'];

const obj = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === 'string';
const full = (value: unknown): value is string => str(value) && value !== '';
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const amount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const iso = (value: unknown) =>
  str(value) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) &&
  !Number.isNaN(Date.parse(value));
const maybe = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || value === null || check(value);

function need(ok: boolean, error: string): asserts ok {
  if (!ok) throw new ImportError(error);
}

function oneOf(value: unknown, allowed: readonly string[], label: string) {
  need(str(value) && allowed.includes(value), `${label} must be one of ${allowed.join(', ')}`);
}

function list(value: unknown, label: string, check: (item: Json, path: string) => void) {
  need(Array.isArray(value), `${label} must be an array`);
  value.forEach((item, at) => {
    need(obj(item), `${label}[${at}] must be an object`);
    check(item, `${label}[${at}]`);
  });
}

function block(item: Json, path: string) {
  oneOf(item.type, ['text', 'tool-call', 'attachment-ref'], `${path}.type`);
  if (item.type === 'text') need(str(item.text), `${path}.text must be a string`);
  else if (item.type === 'tool-call')
    need(
      full(item.id) && full(item.name) && 'input' in item,
      `${path} needs an id, a name and an input`
    );
  else need(full(item.attachmentId), `${path}.attachmentId must be a non-empty string`);
}

const TOKENS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const COSTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];

function message(item: Json, path: string) {
  oneOf(item.role, ['user', 'assistant', 'tool-result'], `${path}.role`);
  if (item.role === 'tool-result') need(full(item.toolCallId), `${path}.toolCallId must be set`);
  need(str(item.id), `${path}.id must be a string`);
  need(
    Number.isInteger(item.sequence) && (item.sequence as number) >= 1,
    `${path}.sequence must be a positive integer`
  );
  need(iso(item.timestamp), `${path}.timestamp must be an ISO 8601 date-time`);
  list(item.content, `${path}.content`, block);
  const usage = item.usage;
  if (usage === undefined) return;
  need(
    obj(usage) &&
      TOKENS.every((key) => count(usage[key])) &&
      obj(usage.cost) &&
      COSTS.every((key) => amount((usage.cost as Json)[key])),
    `${path}.usage is malformed`
  );
}

function attachment(item: Json, path: string) {
  const fields = [
    'id',
    'path',
    'originalName',
    'mimeType',
    'sha256',
    'sourceConversationId',
    'sourceMessageId',
  ];
  need(
    fields.every((key) => str(item[key])),
    `${path} needs ${fields.join(', ')}`
  );
  need(
    typeof item.byteLength === 'number' && typeof item.present === 'boolean',
    `${path} needs byteLength and present`
  );
  oneOf(item.handling, ['text-redacted', 'binary-unchanged'], `${path}.handling`);
  if (item.present)
    need(
      item.path !== '' &&
        SHA.test(item.sha256 as string) &&
        count(item.byteLength) &&
        item.missingReason === undefined,
      `${path} is present but malformed`
    );
  else {
    need(
      item.path === '' && item.sha256 === '' && item.byteLength === 0,
      `${path} is missing but has a file`
    );
    oneOf(item.missingReason, REASONS.slice(4, 6), `${path}.missingReason`);
  }
}

function redaction(item: Json, path: string) {
  need(str(item.id) && str(item.category) && obj(item.target), `${path} is malformed`);
  oneOf(
    item.detector,
    ['known-secret', 'credential-pattern', 'pre-obfuscated'],
    `${path}.detector`
  );
  const target = item.target as Json;
  oneOf(target.kind, ['json', 'attachment'], `${path}.target.kind`);
  if (target.kind === 'json')
    need(
      str(target.pointer) && (target.pointer === '' || target.pointer.startsWith('/')),
      `${path}.target.pointer is not a JSON pointer`
    );
  else need(full(target.attachmentId), `${path}.target.attachmentId must be set`);
}

function sections(doc: Json) {
  need(doc.schemaVersion === 1, 'schemaVersion must equal 1');
  const exported = doc.export;
  need(
    obj(exported) &&
      str(exported.id) &&
      str(exported.generatedAt) &&
      exported.format === 'slicc-transcript' &&
      obj(exported.producer) &&
      exported.producer.application === 'slicc' &&
      str(exported.producer.version),
    'export is malformed'
  );
  const session = doc.session;
  need(
    obj(session) && str(session.id) && str(session.title) && obj(session.completeness),
    'session is malformed'
  );
  oneOf(session.state, ['active', 'frozen'], 'session.state');
  const completeness = session.completeness as Json;
  oneOf(completeness.status, ['complete', 'partial'], 'session.completeness.status');
  need(
    Array.isArray(completeness.missing) &&
      completeness.missing.every((reason) => REASONS.includes(reason)),
    'session.completeness.missing is malformed'
  );
  const privacy = doc.privacy;
  need(
    obj(privacy) &&
      privacy.reasoningExcluded === true &&
      count(privacy.excludedReasoningBlocks) &&
      privacy.binaryAttachments === 'included-unchanged' &&
      obj(privacy.redactionCounts),
    'privacy is malformed'
  );
  list(privacy.redactions, 'privacy.redactions', redaction);
  list(doc.conversations, 'conversations', (item, path) => {
    need(str(item.id) && str(item.name), `${path} needs an id and a name`);
    oneOf(item.kind, ['cone', 'scoop'], `${path}.kind`);
    list(item.messages, `${path}.messages`, message);
  });
  list(doc.delegations, 'delegations', (item, path) =>
    need(str(item.sourceConversationId) && str(item.targetConversationId), `${path} is malformed`)
  );
  list(doc.attachments, 'attachments', attachment);
}

function relations(doc: Json) {
  const conversations = new Map<string, { messages: Set<string>; calls: Set<string> }>();
  const messages = new Set<string>();
  const calls = new Set<string>();
  const results: string[] = [];
  const refs: string[] = [];
  for (const conversation of doc.conversations as Json[]) {
    const id = conversation.id as string;
    need(!conversations.has(id), `duplicate conversation id "${id}"`);
    const own = { messages: new Set<string>(), calls: new Set<string>() };
    conversations.set(id, own);
    let previous = 0;
    for (const item of conversation.messages as V6Message[]) {
      need(!messages.has(item.id), `duplicate message id "${item.id}"`);
      need(
        item.sequence > previous,
        `sequences in conversation "${id}" must be strictly increasing`
      );
      previous = item.sequence;
      messages.add(item.id);
      own.messages.add(item.id);
      if (item.role === 'tool-result') results.push(item.toolCallId as string);
      for (const part of item.content)
        if (part.type === 'tool-call') {
          calls.add(part.id);
          own.calls.add(part.id);
        } else if (part.type === 'attachment-ref') refs.push(part.attachmentId);
    }
  }
  for (const id of results)
    need(calls.has(id), `tool-result message references unknown toolCallId "${id}"`);
  const attached = new Set((doc.attachments as Json[]).map((item) => item.id as string));
  for (const id of refs)
    need(attached.has(id), `attachment-ref references unknown attachmentId "${id}"`);
  for (const item of doc.attachments as Json[])
    need(
      conversations
        .get(item.sourceConversationId as string)
        ?.messages.has(item.sourceMessageId as string) === true,
      `attachment ${item.id as string} comes from an unknown message`
    );
  for (const item of doc.delegations as Json[]) {
    const source = conversations.get(item.sourceConversationId as string);
    need(
      source !== undefined && conversations.has(item.targetConversationId as string),
      'a delegation names an unknown conversation'
    );
    need(
      !full(item.toolCallId) || source.calls.has(item.toolCallId),
      'a delegation names an unknown tool call'
    );
  }
  for (const item of (doc.privacy as Json).redactions as Json[]) {
    const target = item.target as Json;
    need(
      target.kind !== 'attachment' || attached.has(target.attachmentId as string),
      'a redaction names an unknown attachment'
    );
  }
}

export function checkTranscript(value: unknown): Transcript {
  need(obj(value), 'document must be a non-null object');
  sections(value);
  relations(value);
  return value as unknown as Transcript;
}

function named(item: Json, path: string) {
  need(
    str(item.key) && str(item.name) && FOLDER.test(String(item.folder)),
    `${path} needs a key, a name and a folder`
  );
  need(maybe(item.conversation, str), `${path}.conversation must be a string`);
}

export const DIRECTORY_ROOT = '/slicc-v6-upgrade';
export const SOURCE_ROOT = '/slicc-fs/';
const SIDECAR = '/slicc-fs/.metadata.json';
const MOVABLE = ['files/', 'skills/', 'sprinkles/'];

export function safeSource(path: string): boolean {
  if (!path.startsWith(SOURCE_ROOT) || path === SIDECAR) return false;
  const rest = path.slice(SOURCE_ROOT.length);
  return (
    !/\\|\0/.test(rest) &&
    rest.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function sources(value: Json, version: 1 | 2) {
  const seen = new Set<string>();
  for (const [at, file] of (value.files as Json[]).entries()) {
    if (file.source === undefined) continue;
    need(version === 2, `files[${at}].source needs version 2, the directory form`);
    need(
      str(file.source) && safeSource(file.source),
      `files[${at}].source must be a path under ${SOURCE_ROOT}`
    );
    need(
      MOVABLE.some((top) => String(file.path).startsWith(top)),
      `files[${at}] can't stay in place: only ${MOVABLE.join(', ')} entries can`
    );
    need(!seen.has(file.source), `files moves ${file.source} twice`);
    seen.add(file.source);
  }
  if (version === 2)
    need(
      (value.skipped as Json[]).every((item) => item.reason !== 'archive-limit'),
      'a directory form has no archive-limit skips'
    );
}

function manifestLists(value: Json) {
  list(value.cones, 'cones', (cone, path) => {
    named(cone, path);
    need(maybe(cone.transcript, str) && maybe(cone.memory, str), `${path} is malformed`);
    list(cone.scoops, `${path}.scoops`, named);
  });
  list(value.frozen, 'frozen', (item, path) =>
    need(
      str(item.id) && str(item.title) && str(item.transcript) && maybe(item.frozenAt, iso),
      `${path} is malformed`
    )
  );
  for (const key of ['skills', 'sprinkles'])
    list(value[key], key, (item, path) =>
      need(str(item.name) && str(item.path), `${path} is malformed`)
    );
  list(value.files, 'files', (item, path) =>
    need(
      str(item.path) && count(item.size) && SHA.test(String(item.sha256)),
      `${path} is malformed`
    )
  );
  list(value.skipped, 'skipped', (item, path) =>
    need(str(item.path) && str(item.reason), `${path} is malformed`)
  );
  list(value.flagged, 'flagged', (item, path) => {
    need(str(item.path) && count(item.size), `${path} is malformed`);
    oneOf(item.rule, RULES, `${path}.rule`);
  });
  list(value.mcp ?? [], 'mcp', (item, path) =>
    need(str(item.name) && str(item.url), `${path} is malformed`)
  );
  for (const key of ['providers', 'secrets'])
    need(
      Array.isArray(value[key] ?? []) && ((value[key] as unknown[] | undefined) ?? []).every(str),
      `${key} must be strings`
    );
}

const orNull = (value: unknown) => value ?? null;

const scoopOf = (scoop: Json) => ({ ...scoop, conversation: orNull(scoop.conversation) });

function normalised(value: Json): Manifest {
  return {
    ...value,
    cones: (value.cones as Json[]).map((cone) => ({
      ...scoopOf(cone),
      transcript: orNull(cone.transcript),
      memory: orNull(cone.memory),
      scoops: (cone.scoops as Json[]).map(scoopOf),
    })),
    frozen: (value.frozen as Json[]).map((item) => ({ ...item, frozenAt: orNull(item.frozenAt) })),
    licks: orNull(value.licks),
    gitconfig: orNull(value.gitconfig),
    providers: value.providers ?? [],
    mcp: value.mcp ?? [],
    secrets: value.secrets ?? [],
  } as unknown as Manifest;
}

export function checkManifest(value: unknown, version: 1 | 2 = 1): Manifest {
  need(obj(value) && value.format === 'slicc-profile', 'this is not a SLICC 6 profile export');
  need(
    !(typeof value.version === 'number' && value.version > 2),
    'This export is from a newer SLICC 6; update seven.'
  );
  need(
    value.version !== 2 || version === 2,
    "this is SLICC 6's directory form; import it with freezer import --in-place"
  );
  need(value.version === version, `the export version must be ${version}`);
  need(
    str(value.exportId) && /^[A-Za-z0-9-]{1,64}$/.test(value.exportId),
    'exportId must be a UUID'
  );
  need(
    obj(value.producer) && str(value.producer.slicc) && str(value.producer.origin),
    'producer is malformed'
  );
  need(
    iso(value.createdAt) && maybe(value.licks, str) && maybe(value.gitconfig, str),
    'createdAt, licks or gitconfig is malformed'
  );
  const part = value.part as Json | undefined;
  need(version === 1 || part === undefined, 'a directory form is never split into parts');
  need(
    part === undefined ||
      (obj(part) &&
        count(part.index) &&
        (part.index as number) >= 1 &&
        (part.index as number) <= (part.of as number)),
    'part is malformed'
  );
  manifestLists(value);
  sources(value, version);
  const folders = (value.cones as Manifest['cones']).flatMap((cone) => [
    `cone:${cone.folder}`,
    ...cone.scoops.map((scoop) => `scoop:${scoop.folder}`),
  ]);
  need(new Set(folders).size === folders.length, 'two cones or two scoops share a folder');
  return normalised(value);
}

const optional = (value: unknown) => value === undefined || str(value);
const target = (value: unknown) => maybe(value, (folder) => FOLDER.test(String(folder)));

export function checkLicks(value: unknown): Licks {
  need(obj(value), 'licks.json must be an object');
  list(value.crontasks, 'crontasks', (item, path) =>
    need(
      str(item.name) && str(item.cron) && target(item.targetFolder) && optional(item.filter),
      `${path} is malformed`
    )
  );
  list(value.tasks, 'tasks', (item, path) => {
    need(
      str(item.groupFolder) && str(item.prompt) && str(item.scheduleValue),
      `${path} is malformed`
    );
    oneOf(item.scheduleType, ['cron', 'interval', 'once'], `${path}.scheduleType`);
  });
  list(value.webhooks, 'webhooks', (item, path) =>
    need(
      str(item.name) && target(item.targetFolder) && optional(item.filter),
      `${path} is malformed`
    )
  );
  return value as unknown as Licks;
}

export function lickName(name: string, fallback: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return clean || fallback;
}

export function skillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}
