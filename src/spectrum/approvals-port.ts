import type {
  Approval,
  ApprovalDecision,
  ApprovalEnd,
  ApprovalRecord,
  ApprovalRequester,
  ApprovalRun,
  ApprovalsEvents,
  ApprovalsPort,
  GuestToolApproval,
} from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fits } from '../approvals/aligned.ts';
import type { Approval as Item, SudoRun } from '../approvals/record.ts';
import type { Runnable } from '../approvals/runnable.ts';
import { stoppable } from '../approvals/stoppable.ts';
import type { AgentConnection } from '../client.ts';
import { Emitter } from './emitter.ts';

const ENDS: Record<string, ApprovalEnd> = {
  approved: 'answered',
  rejected: 'answered',
  unanswered: 'expired',
  withdrawn: 'withdrawn',
};

export const ARGS_LENGTH = 65_536;

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function argsOf(text: string | undefined): Pick<GuestToolApproval, 'args' | 'argsTruncated'> {
  if (text === undefined) return {};
  const args = pretty(text);
  if (args.length <= ARGS_LENGTH) return { args };
  const end = /[\uD800-\uDBFF]/.test(args[ARGS_LENGTH - 1] as string)
    ? ARGS_LENGTH - 1
    : ARGS_LENGTH;
  return { args: args.slice(0, end), argsTruncated: true };
}

function requesterOf(item: Item): ApprovalRequester {
  const { kind, name, agentId, where } = item.requester;
  return {
    kind,
    name,
    ...(agentId ? { agentId } : {}),
    ...(where ? { where } : {}),
  };
}

function verdictOf(item: Item) {
  const { verdict, judging, verdictError } = item;
  return {
    ...(verdict
      ? {
          verdict: {
            ...(verdict.level ? { level: verdict.level } : {}),
            ...(verdict.aligned === undefined ? {} : { aligned: fits(verdict.aligned) }),
            reason: verdict.reason,
          },
        }
      : {}),
    ...(judging ? { judging: true } : {}),
    ...(verdictError ? { verdictError } : {}),
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
      ...(stoppable(item) ? { stoppable: true } : {}),
      ...verdictOf(item),
    };
  }
  const guest = {
    ...base,
    agentId: item.agentId,
    ...(agentName ? { agentName } : {}),
    always: item.always,
    ...verdictOf(item),
  };
  if (item.kind === 'capture') return { ...guest, kind: 'capture', detail: { ...item.detail } };
  if (item.kind === 'guest-tool')
    return {
      ...guest,
      kind: 'guest-tool',
      tool: item.detail.tool,
      summary: item.detail.summary,
      ...argsOf(item.detail.arguments),
    };
  return {
    ...guest,
    kind: 'guest-message',
    text: item.detail.text,
    ...(item.detail.attachments.length
      ? { attachments: item.detail.attachments.map((file) => ({ ...file })) }
      : {}),
  };
}

export type HostApprovals = ApprovalsPort;

export function runShown(run: SudoRun): ApprovalRun & { survivors?: number[] } {
  const { state, by, device, at, pid, status, signal, endedAt, error, stdout, stderr, survivors } =
    run;
  return {
    state,
    by,
    ...(device ? { device } : {}),
    at,
    ...(pid === undefined ? {} : { pid }),
    ...(status === undefined ? {} : { status }),
    ...(signal ? { signal } : {}),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(error ? { error } : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(survivors?.length ? { survivors: [...survivors] } : {}),
  };
}

export function recordOf(
  item: Item,
  agentName: string | undefined,
  runnable: Runnable | undefined
): ApprovalRecord {
  const approval = shown(item, agentName);
  if (item.state !== 'pending' && 'stoppable' in approval) delete approval.stoppable;
  return {
    approval,
    state: item.state,
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.decidedBy ? { decidedBy: item.decidedBy } : {}),
    ...(item.device ? { device: item.device } : {}),
    ...(item.decidedAt === undefined ? {} : { decidedAt: item.decidedAt }),
    ...(item.answer ? { answer: item.answer } : {}),
    ...(item.kind === 'sudo' && item.run ? { run: runShown(item.run) } : {}),
    ...(runnable === undefined ? {} : { runnable }),
  };
}

export const NOT_HERE = "This request can't be answered in this tab.";

const asked = (item: Item) => item.state === 'pending' && item.tier === 'user';

export class ApprovalsAdapter extends Emitter<ApprovalsEvents> implements ApprovalsPort {
  readonly #connection: AgentConnection;
  readonly #host: HostApprovals | undefined;
  readonly #ours: boolean;
  readonly #mine = new Set<string>();
  readonly #deciding = new Set<string>();
  #listed = new Set<string>();
  readonly decide?: (id: string, decision: ApprovalDecision, reason?: string) => Promise<void>;
  readonly history?: () => readonly ApprovalRecord[];
  readonly run?: (id: string) => Promise<void>;
  readonly stopRun?: (id: string) => Promise<void>;

  constructor(connection: AgentConnection, host?: HostApprovals) {
    super();
    this.#connection = connection;
    this.#host = host;
    this.#ours = !connection.guest;
    if (this.#ours || host?.decide) this.decide = (...args) => this.#route(...args);
    const recorded = this.#ours && Boolean(connection.approvals);
    if (recorded || host?.history) this.history = () => this.#history();
    if (recorded || host?.run) this.run = (id) => this.#running(id, 'run');
    if (recorded || host?.stopRun) this.stopRun = (id) => this.#running(id, 'stopRun');
    this.#listed = new Set(this.#agent().map((approval) => approval.id));
    connection.approvals?.subscribe(() => this.#changed());
    connection.approvalRunnable?.subscribe(() => this.#historyChanged());
    host?.on('approvals', () => this.emit('approvals', this.list()));
    host?.on('ended', (detail) => this.emit('ended', detail));
    if (host?.history) host.on('history', () => this.#historyChanged());
  }

  #historyChanged(): void {
    if (this.history) this.emit('history', this.history());
  }

  #history(): readonly ApprovalRecord[] {
    const names = new Map(
      (this.#connection.agents?.value?.agents ?? []).map((agent) => [agent.id, agent.name])
    );
    const runnable = this.#connection.approvalRunnable?.value ?? {};
    const ours = this.#ours
      ? this.#items().map((item) => recordOf(item, names.get(item.agentId), runnable[item.id]))
      : [];
    return [...(this.#host?.history?.() ?? []), ...ours].sort(
      (a, b) => b.approval.createdAt - a.approval.createdAt
    );
  }

  async #running(id: string, how: 'run' | 'stopRun'): Promise<void> {
    const host = this.#host;
    if (host?.history?.().some((record) => record.approval.id === id)) {
      const call = host[how];
      if (!call) throw new Error(NOT_HERE);
      return call.call(host, id);
    }
    if (!this.#ours || !this.#connection.approvals) throw new Error(NOT_HERE);
    const control = this.#connection.control;
    const answer = await (how === 'run'
      ? control.approvalRun(id, BACKGROUND_CONTEXT)
      : control.approvalRunStop(id, BACKGROUND_CONTEXT));
    if (!answer.done) throw new Error(answer.error);
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
    this.#historyChanged();
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
