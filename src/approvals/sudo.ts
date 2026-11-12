import type { Context, ReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentsState } from '../agents.ts';
import type { AgentCapture } from '../guests/capture.ts';
import type { Licks } from '../licks/licks.ts';
import { sprinklesOf } from '../sprinkles/cgi.ts';
import type { Approvals } from './index.ts';
import {
  type Approval,
  type ApprovalRequester,
  cleanReason,
  REASONS,
  type SudoDetail,
  type SudoFile,
  type SudoReplay,
  type SudoStdin,
} from './record.ts';

export type SudoAnswer = 'once' | 'always' | 'deny';

export type SudoDenial = { answer: 'deny'; message: string };

export type SudoTimestamp = { answer: 'once' | 'always'; timestamp: true };

export type SudoReply = SudoAnswer | SudoDenial | SudoTimestamp;

export interface SudoRequest {
  id: string;
  kind: 'sudo';
  user: string;
  uid?: number;
  target?: string;
  argv: string[];
  path?: string;
  cwd?: string;
  pid?: number;
  tag?: string;
  tags?: string[];
  tty?: string;
  createdAt?: number;
  expiresAt: number;
  always?: boolean;
  stdin?: SudoStdin;
  rootOnly?: Record<string, boolean>;
  userWritable?: SudoFile[];
  timestamp?: boolean;
  validate?: boolean;
}

export type SudoAsked = { id: string; error: null } | { id: null; error: string };

export interface AgentSudo extends AgentCapture {
  readonly approvals: ReplicatedState<Approval[]>;
  request(request: SudoRequest, where: string | null, context: Context): Promise<SudoAsked>;
  withdraw(id: string, reason: string | null, context: Context): Promise<void>;
}

const SAFE = /^[\w@%+=:,./-]+$/;

export const shellWord = (word: string): string =>
  SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const text = (value: unknown): value is string => typeof value === 'string';

export function sudoRequest(value: unknown): SudoRequest | null {
  const request = value as Partial<SudoRequest> | null;
  if (typeof request !== 'object' || request === null || request.kind !== 'sudo') return null;
  const { argv, user, expiresAt } = request;
  if (!Array.isArray(argv) || !argv.every(text)) return null;
  if (!argv.length && request.validate !== true) return null;
  if (!text(user) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return request as SudoRequest;
}

function tagOf(tag: unknown): { kind?: unknown; agentId?: unknown; where?: unknown } | null {
  if (!text(tag)) return null;
  try {
    const parsed = JSON.parse(tag);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

const TERMINAL = 'terminal:';
const FOLLOWER = 'follower:';

function shownWhere(where: string, given: string | undefined): string {
  if (given) return given;
  if (where.startsWith(TERMINAL)) return 'a terminal';
  if (where.startsWith(FOLLOWER)) return 'a linked device';
  return where;
}

export function sudoRequester(
  request: SudoRequest,
  agents: Readonly<AgentsState> | undefined,
  where?: string | null
): { requester: ApprovalRequester; agentId: string } {
  const tag = tagOf(request.tag);
  const name = request.user;
  const sprinkle = sprinklesOf(Array.isArray(request.tags) ? request.tags.filter(text) : [])[0];
  if (sprinkle)
    return { requester: { kind: 'user', name, where: `the ${sprinkle} sprinkle` }, agentId: '' };
  if (tag?.kind === 'agent' && text(tag.agentId)) {
    const id = tag.agentId.startsWith('cone:') ? tag.agentId.slice('cone:'.length) : tag.agentId;
    const known = agents?.cones[id]?.name ?? agents?.scoops[id]?.name ?? name;
    return { requester: { kind: 'agent', name: known, agentId: id }, agentId: id };
  }
  if (tag?.kind === 'user' && text(tag.where)) {
    const given = cleanReason(where);
    const device = tag.where.startsWith(FOLLOWER) ? tag.where.slice(FOLLOWER.length) : '';
    return {
      requester: {
        kind: 'user',
        name,
        where: shownWhere(tag.where, given),
        ...(device ? { device } : {}),
      },
      agentId: '',
    };
  }
  return { requester: { kind: 'user', name }, agentId: '' };
}

const STDIN: readonly unknown[] = ['tty', 'none', 'pipe', 'file'];

function rootOnlyOf(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const kept = Object.entries(value).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
  );
  return Object.fromEntries(kept);
}

function kernelFacts(request: SudoRequest): Partial<SudoDetail> {
  const rootOnly = rootOnlyOf(request.rootOnly);
  return {
    ...(STDIN.includes(request.stdin) ? { stdin: request.stdin } : {}),
    ...(rootOnly ? { rootOnly } : {}),
    ...(typeof request.always === 'boolean' ? { writable: request.always } : {}),
  };
}

export const validating = (request: Pick<SudoRequest, 'validate'>): boolean =>
  request.validate === true;

export const timestampFor = (user: string): string =>
  `start a sudo timestamp for ${user} (no command)`;

export function sudoDetail(request: SudoRequest): SudoDetail {
  if (validating(request))
    return { command: timestampFor(request.user), validate: true, writable: false };
  const command = [request.path || request.argv[0], ...request.argv.slice(1)]
    .map((word) => shellWord(String(word)))
    .join(' ');
  return {
    command,
    ...(text(request.target) ? { target: request.target } : {}),
    ...(text(request.cwd) ? { cwd: request.cwd } : {}),
    ...(request.always === true ? { alwaysScope: 'cwd' as const } : {}),
    ...kernelFacts(request),
  };
}

function filesOf(value: unknown): SudoFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(
      (file): file is SudoFile =>
        typeof file === 'object' && file !== null && text(file.path) && text(file.sha256)
    )
    .map(({ path, sha256 }) => ({ path, sha256 }));
}

export function sudoReplay(request: SudoRequest): SudoReplay {
  const rootOnly = rootOnlyOf(request.rootOnly);
  const userWritable = filesOf(request.userWritable);
  const tags = Array.isArray(request.tags) ? request.tags.filter(text) : undefined;
  return {
    id: request.id,
    user: request.user,
    ...(typeof request.uid === 'number' ? { uid: request.uid } : {}),
    ...(text(request.target) ? { target: request.target } : {}),
    argv: [...request.argv],
    ...(text(request.path) ? { path: request.path } : {}),
    ...(text(request.cwd) ? { cwd: request.cwd } : {}),
    ...(STDIN.includes(request.stdin) ? { stdin: request.stdin } : {}),
    ...(rootOnly ? { rootOnly } : {}),
    ...(userWritable ? { userWritable } : {}),
    ...(text(request.tag) ? { tag: request.tag } : {}),
    ...(tags ? { tags } : {}),
    ...(validating(request) ? { validate: true } : {}),
  };
}

function scoopLick(
  id: string,
  agentId: string,
  detail: SudoDetail,
  agents: Readonly<AgentsState> | undefined
) {
  const scoop = agents?.scoops[agentId];
  if (!scoop) return undefined;
  const { command, target, cwd, validate } = detail;
  const as = target ? ` as ${target}` : '';
  const at = cwd ? ` in ${cwd}` : '';
  const asked = validate ? 'to start a sudo timestamp' : `to run ${command}${as}${at}`;
  return {
    channel: 'sudo-request' as const,
    source: id,
    title: `${scoop.name} waits for sudo`,
    text: `[scoop ${scoop.name} waits for a person to approve sudo]`,
    body: `${scoop.name} asked ${asked}. A person answers it in the approvals dialog; you can't approve it. It ends when someone answers or it times out.`,
    target: `cone:${scoop.cone}` as const,
  };
}

export interface SudoAttach {
  approvals: Approvals;
  capture: AgentCapture;
  agents?: () => Readonly<AgentsState> | undefined;
  licks?: Pick<Licks, 'deliver'>;
}

type SudoLick = NonNullable<ReturnType<typeof scoopLick>>;

export function createSudo(options: SudoAttach): AgentSudo & { close(): void } {
  const { approvals } = options;
  const agents = () => options.agents?.();
  const waiting = new Map<string, SudoLick>();
  const send = (lick: SudoLick) =>
    void options.licks?.deliver(lick, BACKGROUND_CONTEXT).catch(() => undefined);
  const watch = (items: readonly Approval[]) => {
    for (const [id, lick] of waiting) {
      const item = items.find((entry) => entry.id === id);
      if (item?.state === 'pending' && item.tier !== 'user') continue;
      waiting.delete(id);
      if (item?.state === 'pending') send(lick);
    }
  };
  const off = approvals.state.subscribe((items) => watch(items));
  return {
    approvals: approvals.state,
    capture: (request, where, context) => options.capture.capture(request, where, context),
    async request(value, where, context) {
      const request = sudoRequest(value);
      if (!request) return { id: null, error: 'This is not a sudo request.' };
      const { requester, agentId } = sudoRequester(request, agents(), where);
      const detail = sudoDetail(request);
      const item = await approvals.request(
        {
          kind: 'sudo',
          agentId,
          requester,
          tier: 'user',
          always: request.always !== false && !validating(request),
          expiresAt: request.expiresAt,
          detail,
          replay: sudoReplay(request),
        },
        context
      );
      const lick = scoopLick(item.id, agentId, detail, agents());
      if (lick) {
        waiting.set(item.id, lick);
        watch(approvals.state.value as Approval[]);
      }
      return { id: item.id, error: null };
    },
    async withdraw(id, reason, context) {
      await approvals.withdraw(id, reason, context);
    },
    close() {
      off();
      waiting.clear();
    },
  };
}

export function ownedSudo(sudo: AgentSudo): AgentSudo & { release(): void } {
  const mine = new Set<string>();
  const forget = () => {
    const open = new Set(
      (sudo.approvals.value as Approval[])
        .filter((item) => item.state === 'pending')
        .map(({ id }) => id)
    );
    for (const id of mine) if (!open.has(id)) mine.delete(id);
  };
  return {
    approvals: sudo.approvals,
    capture: (request, where, context) => sudo.capture(request, where, context),
    async request(request, where, context) {
      forget();
      const asked = await sudo.request(request, where, context);
      if (asked.id) mine.add(asked.id);
      return asked;
    },
    async withdraw(id, reason, context) {
      if (!mine.delete(id)) return;
      await sudo.withdraw(id, reason, context);
    },
    release() {
      forget();
      for (const id of mine)
        void sudo.withdraw(id, REASONS.disconnected, BACKGROUND_CONTEXT).catch(() => undefined);
      mine.clear();
    },
  };
}
