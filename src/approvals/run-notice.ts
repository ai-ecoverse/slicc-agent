import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type Licks, LicksOutbox } from '../licks/licks.ts';
import type { SudoRun } from './record.ts';
import { endLick, type LickHost, type RunFacts, startLick } from './run-licks.ts';
import { frozenOf, goneOf } from './runnable.ts';

export type RunNotice = {
  id: string;
  phase: 'start' | 'end';
  agentId: string;
  command: string;
  requestedAt: number;
  at: number;
  pid?: number;
  endedAt?: number;
  status?: number;
  signal?: string;
  survivors?: number[];
  stopped?: boolean;
  capped?: number;
  stdout?: string;
  stderr?: string;
  tags: string[];
};

export type NoticeAnswer = { delivered: boolean; reason?: string };

export type NoticeHost = LickHost & { licks?: Pick<Licks, 'deliver'> };

export const NOTICE_LIMITS = {
  id: 128,
  agentId: 256,
  command: 1024,
  path: 1024,
  tag: 256,
  tags: 16,
  survivors: 64,
} as const;

export const NOTICE_REASONS = {
  shape: 'A run notice is an object.',
  id: 'A run notice id is bios:<kernel id>.',
  phase: 'A run notice phase is start or end.',
  agentId: 'A run notice needs the agentId of the cone or scoop that asked.',
  command: `A run notice needs its command, at most ${NOTICE_LIMITS.command} characters.`,
  time: 'A run notice needs requestedAt and at as times.',
  endedAt: 'endedAt is a time, no earlier than at.',
  pid: 'pid is a process id.',
  status: 'status is an exit status from 0 to 255.',
  signal: 'signal is a signal name such as SIGTERM.',
  survivors: `survivors is a list of at most ${NOTICE_LIMITS.survivors} process ids.`,
  stopped: 'stopped is true or false.',
  capped: 'capped is a size in bytes.',
  path: `stdout and stderr are absolute paths, at most ${NOTICE_LIMITS.path} characters.`,
  tagsMissing:
    "A run notice needs tags, the kernel's tags for the run exactly (an empty list when it has none).",
  tags: `tags is a list of at most ${NOTICE_LIMITS.tags} tags of at most ${NOTICE_LIMITS.tag} characters.`,
  licks: 'This agent has no licks.',
  gone: 'The agent that asked is gone, so nobody was told.',
  seen: 'This notice was already delivered.',
  ended: 'This run already ended.',
  failed: "The notice couldn't be delivered.",
} as const;

export const unknownKey = (key: string): string => `A run notice has no ${key.slice(0, 64)} field.`;

export const frozenNoticed = (name: string): string => `${name} is frozen, so nobody was told.`;

const KEYS = new Set([
  'id',
  'phase',
  'agentId',
  'command',
  'requestedAt',
  'at',
  'pid',
  'endedAt',
  'status',
  'signal',
  'survivors',
  'stopped',
  'capped',
  'stdout',
  'stderr',
  'tags',
]);

const ID = /^bios:[\w.:-]+$/;
const AGENT = /^[^\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const PATH = /^\/[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;
const TAG = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
const SIGNAL = /^SIG[A-Z0-9+-]{1,12}$/;

const shown = (text: string) =>
  text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const time = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const whole = (value: unknown, least: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least;

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

const list = (value: unknown, max: number, each: (one: unknown) => boolean) =>
  Array.isArray(value) && value.length <= max && value.every(each);

const path = (value: unknown) => text(value, NOTICE_LIMITS.path) && PATH.test(value as string);

const CHECKS: [keyof RunNotice, (value: unknown, notice: Record<string, unknown>) => boolean][] = [
  ['pid', (value) => whole(value, 1)],
  ['endedAt', (value, notice) => time(value) && value >= (notice.at as number)],
  ['status', (value) => whole(value, 0) && value <= 255],
  ['signal', (value) => typeof value === 'string' && SIGNAL.test(value)],
  ['survivors', (value) => list(value, NOTICE_LIMITS.survivors, (one) => whole(one, 1))],
  ['stopped', (value) => typeof value === 'boolean'],
  ['capped', (value) => whole(value, 1)],
  ['stdout', path],
  ['stderr', path],
  [
    'tags',
    (value) =>
      list(value, NOTICE_LIMITS.tags, (one) => text(one, NOTICE_LIMITS.tag) && TAG.test(one)),
  ],
];

const REASON_OF: Partial<Record<keyof RunNotice, string>> = {
  ...NOTICE_REASONS,
  stdout: NOTICE_REASONS.path,
  stderr: NOTICE_REASONS.path,
};

function optional(notice: Record<string, unknown>): string | undefined {
  const bad = CHECKS.find(
    ([key, check]) => notice[key] !== undefined && !check(notice[key], notice)
  );
  return bad ? REASON_OF[bad[0]] : undefined;
}

export function checkNotice(raw: unknown): RunNotice | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NOTICE_REASONS.shape;
  const notice = raw as Record<string, unknown>;
  const extra = Object.keys(notice).find((key) => !KEYS.has(key));
  if (extra !== undefined) return unknownKey(extra);
  const { id, phase, agentId, command } = notice;
  if (!(text(id, NOTICE_LIMITS.id) && ID.test(id))) return NOTICE_REASONS.id;
  if (phase !== 'start' && phase !== 'end') return NOTICE_REASONS.phase;
  if (!(text(agentId, NOTICE_LIMITS.agentId) && AGENT.test(agentId))) return NOTICE_REASONS.agentId;
  if (!(text(command, NOTICE_LIMITS.command) && shown(command))) return NOTICE_REASONS.command;
  if (!time(notice.requestedAt) || !time(notice.at)) return NOTICE_REASONS.time;
  if (!Array.isArray(notice.tags)) return NOTICE_REASONS.tagsMissing;
  return optional(notice) ?? (notice as RunNotice);
}

function factsOf(notice: RunNotice, agentId: string): RunFacts {
  const paths = [notice.stdout, notice.stderr].filter((path): path is string => !!path);
  const run: SudoRun = {
    state: notice.stopped ? 'stopped' : 'done',
    by: 'owner',
    at: notice.at,
    ...(notice.pid !== undefined ? { pid: notice.pid } : {}),
    ...(notice.endedAt !== undefined ? { endedAt: notice.endedAt } : {}),
    ...(notice.status !== undefined ? { status: notice.status } : {}),
    ...(notice.signal ? { signal: notice.signal } : {}),
    ...(notice.survivors?.length ? { survivors: notice.survivors } : {}),
    ...(notice.capped ? { capped: notice.capped } : {}),
  };
  const command = shown(notice.command);
  return {
    id: notice.id,
    agentId,
    typed: command,
    where: command,
    requestedAt: notice.requestedAt,
    run,
    tags: notice.tags,
    started: paths.length ? ` Output: ${paths.join(' and ')}` : '',
    ended: paths.length ? ` Read it with your shell if you need it: ${paths.join(' and ')}.` : '',
  };
}

async function seen(host: NoticeHost, id: string, eventId: string, context: Context) {
  const events = (await host.harness.snapshot(LicksOutbox, context))?.events ?? {};
  return (events[`sudo-run|${id}`] ?? []).includes(eventId);
}

export async function deliverNotice(host: NoticeHost, raw: unknown): Promise<NoticeAnswer> {
  const notice = checkNotice(raw);
  if (typeof notice === 'string') return { delivered: false, reason: notice };
  const licks = host.licks;
  if (!licks) return { delivered: false, reason: NOTICE_REASONS.licks };
  const agentId = notice.agentId.startsWith('cone:')
    ? notice.agentId.slice('cone:'.length)
    : notice.agentId;
  const state = () => host.agents.state();
  const frozen = frozenOf(state)(agentId);
  if (frozen) return { delivered: false, reason: frozenNoticed(frozen) };
  if (goneOf(state)(agentId)) return { delivered: false, reason: NOTICE_REASONS.gone };
  const eventId = `${notice.id}:${notice.phase}`;
  try {
    if (
      notice.phase === 'start' &&
      (await seen(host, notice.id, `${notice.id}:end`, BACKGROUND_CONTEXT))
    )
      return { delivered: false, reason: NOTICE_REASONS.ended };
    if (await seen(host, notice.id, eventId, BACKGROUND_CONTEXT))
      return { delivered: false, reason: NOTICE_REASONS.seen };
    const facts = factsOf(notice, agentId);
    const event = await (notice.phase === 'start' ? startLick : endLick)(host, facts);
    await licks.deliver(event, BACKGROUND_CONTEXT);
  } catch {
    return { delivered: false, reason: NOTICE_REASONS.failed };
  }
  return { delivered: true };
}
