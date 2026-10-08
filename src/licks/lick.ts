export const LICK_CHANNELS = [
  'webhook',
  'cron',
  'sprinkle',
  'fswatch',
  'session-reload',
  'navigate',
  'discovery',
  'upgrade',
  'workflow',
  'bash',
  'jshd',
  'preview',
  'cherry',
  'scoop-notify',
  'scoop-idle',
  'scoop-wait',
  'sudo-request',
] as const;

export type LickChannel = (typeof LICK_CHANNELS)[number];

export type LickAction = 'confirm' | 'dismiss';

export type LickSeverity = 'warn' | 'error';

export type LickTarget = 'cone' | `cone:${string}` | `scoop:${string}`;

export type Lick = {
  id: string;
  channel: LickChannel;
  source: string;
  title: string;
  text: string;
  body?: string;
  count: number;
  at: number;
  actions?: LickAction[];
  severity?: LickSeverity;
};

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\n': '&#10;',
  '\r': '&#13;',
};

const DECODE: Record<string, string> = Object.fromEntries(
  Object.entries(ENTITIES).map(([raw, entity]) => [entity, raw])
);

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (char) => ENTITIES[char] as string).replace(/\r/g, '&#13;');
}

export function escapeAttribute(value: string): string {
  return value.replace(/[&<>"\n\r]/g, (char) => ENTITIES[char] as string);
}

export function unescape(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#10|#13);/g, (entity) => DECODE[entity] as string);
}

export function lickId(): string {
  return `lk-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function formatLick(lick: Lick): string {
  const attributes: [string, string][] = [
    ['id', lick.id],
    ['channel', lick.channel],
    ['source', lick.source],
    ['title', oneLine(lick.title)],
    ['count', String(lick.count)],
    ['at', new Date(lick.at).toISOString()],
  ];
  if (lick.actions?.length) attributes.push(['actions', lick.actions.join(' ')]);
  if (lick.severity) attributes.push(['severity', lick.severity]);
  const head = attributes.map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(' ');
  const lines = [escapeText(oneLine(lick.text))];
  if (lick.body) lines.push(escapeText(lick.body));
  return `<lick ${head}>\n${lines.join('\n')}\n</lick>`;
}

const LICK = /^<lick ((?:[a-z]+="[^"<>\n]*" ?)+)>\n([^\n]*)(?:\n([\s\S]*?))?\n<\/lick>$/;
const ATTRIBUTE = /([a-z]+)="([^"]*)"/g;

function isChannel(value: string | undefined): value is LickChannel {
  return (LICK_CHANNELS as readonly string[]).includes(value ?? '');
}

function severityOf(value: string | undefined): { severity?: LickSeverity } {
  return value === 'warn' || value === 'error' ? { severity: value } : {};
}

export function parseLick(text: string): Lick | undefined {
  const match = LICK.exec(text);
  if (!match) return undefined;
  const attributes = new Map<string, string>();
  for (const [, name, value] of (match[1] as string).matchAll(ATTRIBUTE))
    attributes.set(name as string, unescape(value as string));
  const channel = attributes.get('channel');
  const id = attributes.get('id');
  if (!id || !isChannel(channel)) return undefined;
  const at = Date.parse(attributes.get('at') ?? '');
  const count = Number(attributes.get('count'));
  const actions = (attributes.get('actions') ?? '')
    .split(' ')
    .filter((action): action is LickAction => action === 'confirm' || action === 'dismiss');
  const body = match[3] === undefined ? undefined : unescape(match[3]);
  return {
    id,
    channel,
    source: attributes.get('source') ?? '',
    title: attributes.get('title') ?? '',
    text: unescape(match[2] as string),
    ...(body ? { body } : {}),
    count: Number.isSafeInteger(count) && count > 0 ? count : 1,
    at: Number.isNaN(at) ? 0 : at,
    ...(actions.length ? { actions } : {}),
    ...severityOf(attributes.get('severity')),
  };
}
