import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Approval as Item } from '../approvals/record.ts';
import type { AgentConnection } from '../client.ts';
import { Emitter } from './emitter.ts';

export type ApprovalDecision = 'once' | 'always' | 'deny';

export interface ApprovalRequester {
  kind: 'agent' | 'user' | 'guest';
  name: string;
  agentId?: string;
  where?: string;
}

export interface ApprovalVerdict {
  decision: 'allow' | 'deny';
  reason: string;
}

export interface SudoApproval {
  id: string;
  kind: 'sudo';
  requester: ApprovalRequester;
  command: string;
  target?: string;
  cwd?: string;
  createdAt: number;
  expiresAt: number;
  always: boolean;
  alwaysScope?: 'cwd';
}

interface GuestApproval {
  id: string;
  requester: ApprovalRequester;
  agentId: string;
  agentName?: string;
  createdAt: number;
  expiresAt: number;
  always: false;
  verdict?: ApprovalVerdict;
}

export interface GuestMessageApproval extends GuestApproval {
  kind: 'guest-message';
  text: string;
  attachments?: readonly { name: string; mimeType: string; size: number }[];
}

export interface GuestToolApproval extends GuestApproval {
  kind: 'guest-tool';
  tool: string;
  summary: string;
}

export type Approval = SudoApproval | GuestMessageApproval | GuestToolApproval;

export type ApprovalEnd = 'answered' | 'withdrawn' | 'expired';

export interface ApprovalsEvents {
  approvals: readonly Approval[];
  ended: { id: string; reason: ApprovalEnd };
}

const ENDS: Record<string, ApprovalEnd> = {
  approved: 'answered',
  rejected: 'answered',
  unanswered: 'expired',
  withdrawn: 'withdrawn',
};

function requesterOf(item: Item): ApprovalRequester {
  const { kind, name, agentId, where } = item.requester;
  return {
    kind,
    name,
    ...(agentId ? { agentId } : {}),
    ...(where ? { where } : {}),
  };
}

export function shown(item: Item, agentName: string | undefined): Approval {
  const base = {
    id: item.id,
    requester: requesterOf(item),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
  if (item.kind === 'sudo') {
    const { command, target, cwd, alwaysScope } = item.detail;
    return {
      ...base,
      kind: 'sudo',
      command,
      ...(target ? { target } : {}),
      ...(cwd ? { cwd } : {}),
      always: item.always,
      ...(alwaysScope ? { alwaysScope } : {}),
    };
  }
  const guest = {
    ...base,
    agentId: item.agentId,
    ...(agentName ? { agentName } : {}),
    always: false as const,
    ...(item.verdict ? { verdict: { ...item.verdict } } : {}),
  };
  if (item.kind === 'guest-tool')
    return { ...guest, kind: 'guest-tool', tool: item.detail.tool, summary: item.detail.summary };
  return {
    ...guest,
    kind: 'guest-message',
    text: item.detail.text,
    ...(item.detail.attachments.length
      ? { attachments: item.detail.attachments.map((file) => ({ ...file })) }
      : {}),
  };
}

export interface HostApprovals {
  list(): readonly Approval[];
  on<K extends keyof ApprovalsEvents>(
    type: K,
    listener: (detail: ApprovalsEvents[K]) => void
  ): () => void;
  decide?(id: string, decision: ApprovalDecision, reason?: string): Promise<void>;
}

export const NOT_HERE = "This request can't be answered in this tab.";

const asked = (item: Item) => item.state === 'pending' && item.tier === 'user';

export class ApprovalsAdapter extends Emitter<ApprovalsEvents> {
  readonly #connection: AgentConnection;
  readonly #host: HostApprovals | undefined;
  readonly #ours: boolean;
  readonly #mine = new Set<string>();
  readonly #deciding = new Set<string>();
  #listed = new Set<string>();
  readonly decide?: (id: string, decision: ApprovalDecision, reason?: string) => Promise<void>;

  constructor(connection: AgentConnection, host?: HostApprovals) {
    super();
    this.#connection = connection;
    this.#host = host;
    this.#ours = !connection.readOnly && !connection.mismatch;
    if (this.#ours || host?.decide) this.decide = (...args) => this.#route(...args);
    this.#listed = new Set(this.#agent().map((approval) => approval.id));
    connection.approvals?.subscribe(() => this.#changed());
    host?.on('approvals', () => this.emit('approvals', this.list()));
    host?.on('ended', (detail) => this.emit('ended', detail));
  }

  #items(): readonly Item[] {
    return this.#connection.approvals?.value ?? [];
  }

  list(): readonly Approval[] {
    return [...(this.#host?.list() ?? []), ...this.#agent()].sort(
      (a, b) => a.createdAt - b.createdAt
    );
  }

  #agent(): readonly Approval[] {
    const names = new Map(
      (this.#connection.agents?.value?.agents ?? []).map((agent) => [agent.id, agent.name])
    );
    return this.#items()
      .filter((item) => asked(item) && !this.#mine.has(item.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((item) => shown(item, names.get(item.agentId)));
  }

  #changed(): void {
    const items = new Map(this.#items().map((item) => [item.id, item]));
    const listed = this.#agent();
    const now = new Set(listed.map((approval) => approval.id));
    for (const id of this.#listed) {
      if (now.has(id) || this.#mine.has(id) || this.#deciding.has(id)) continue;
      const state = items.get(id)?.state;
      this.emit('ended', { id, reason: (state && ENDS[state]) || 'answered' });
    }
    for (const id of this.#mine) {
      const item = items.get(id);
      if (!item || !asked(item)) this.#mine.delete(id);
    }
    this.#listed = now;
    this.emit('approvals', this.list());
  }

  #route(id: string, decision: ApprovalDecision, reason?: string): Promise<void> {
    const host = this.#host;
    if (host?.list().some((approval) => approval.id === id)) {
      if (!host.decide) return Promise.reject(new Error(NOT_HERE));
      return host.decide(id, decision, reason);
    }
    if (!this.#ours) return Promise.reject(new Error(NOT_HERE));
    return this.#decide(id, decision, reason);
  }

  async #decide(id: string, decision: ApprovalDecision, reason?: string): Promise<void> {
    this.#deciding.add(id);
    try {
      const answer = await this.#connection.control.decide(
        id,
        decision,
        reason ?? null,
        BACKGROUND_CONTEXT
      );
      if (!answer.done) throw new Error(answer.error);
      this.#mine.add(id);
    } finally {
      this.#deciding.delete(id);
    }
    this.#changed();
  }
}
