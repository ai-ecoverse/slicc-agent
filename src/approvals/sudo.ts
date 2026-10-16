import type { Context, ReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentsState } from '../agents.ts';
import type { Licks } from '../licks/licks.ts';
import type { Approvals } from './index.ts';
import {
  type Approval,
  type ApprovalRequester,
  cleanReason,
  REASONS,
  type SudoDetail,
} from './record.ts';

export type SudoAnswer = 'once' | 'always' | 'deny';

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
  tty?: string;
  createdAt?: number;
  expiresAt: number;
  always?: boolean;
}

export type SudoAsked = { id: string; error: null } | { id: null; error: string };

export interface AgentSudo {
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
  if (typeof request !== 'object' || request === null) return null;
  const { argv, user, expiresAt } = request;
  if (!Array.isArray(argv) || !argv.length || !argv.every(text)) return null;
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

export function sudoDetail(request: SudoRequest): SudoDetail {
  const command = [request.path || request.argv[0], ...request.argv.slice(1)]
    .map((word) => shellWord(String(word)))
    .join(' ');
  return {
    command,
    ...(text(request.target) ? { target: request.target } : {}),
    ...(text(request.cwd) ? { cwd: request.cwd } : {}),
    ...(request.always === true ? { alwaysScope: 'cwd' as const } : {}),
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
  const { command, target, cwd } = detail;
  const as = target ? ` as ${target}` : '';
  const at = cwd ? ` in ${cwd}` : '';
  return {
    channel: 'sudo-request' as const,
    source: id,
    title: `${scoop.name} waits for sudo`,
    text: `[scoop ${scoop.name} waits for a person to approve sudo]`,
    body: `${scoop.name} asked to run ${command}${as}${at}. A person answers it in the approvals dialog; you can't approve it. It ends when someone answers or it times out.`,
    target: `cone:${scoop.cone}` as const,
  };
}

export interface SudoAttach {
  approvals: Approvals;
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
          always: request.always === true,
          expiresAt: request.expiresAt,
          detail,
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
