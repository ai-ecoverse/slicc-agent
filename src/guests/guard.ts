import type { Context } from '@earendil-works/chord';
import { awaitWithContext, BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  defineExtension,
  type Extension,
  type Harness,
  type HookApi,
  hook,
  LiveDoc,
  type SubmissionId,
  type TaskId,
  type ToolHookCall,
  ToolTask,
} from '@earendil-works/pi-durable';
import type { Approval, Approvals } from '../approvals/index.ts';
import { REASONS, scoopTier } from '../approvals/record.ts';
import { type GuestPolicy, gateKind, gateRefusal } from './policy.ts';
import { type AlwaysTool, GuestsDoc, isGate, liveSeat, type SeatRecord } from './seats.ts';

export const GUEST_GUARD = 'slicc-guest-guard';
export const GUEST_REQUEST = 'guest:';
export const GUEST_TOOL_MEMO = 'slicc.guest-tool';
export const SUMMARY_LENGTH = 2000;

export const GATE_REASONS = {
  unknown:
    'A guest started this run, and its seat names no review for tool calls that this agent knows.',
  ended: "A guest started this run, and that guest's seat has ended.",
  rejected: 'The owner declined this tool call in a run a guest started.',
  judged: 'The automatic check declined this tool call in a run a guest started',
  unanswered: 'Nobody approved this tool call in a run a guest started in time.',
  unroutable: "The cone can't review a tool call it is itself waiting on.",
  withdrawn: 'The review of this tool call was withdrawn.',
} as const;

export interface GateHost {
  approvals: Pick<Approvals, 'state' | 'request' | 'settled' | 'withdraw'>;
  policy(): GuestPolicy;
  now?: () => number;
}

export interface GuestToolGate {
  readonly extension: Extension;
  bind(host: GateHost): void;
}

type Held = Pick<Harness, 'submission' | 'commit' | 'waitForTask'>;

type Taint = { seat: SeatRecord | null; tier: string };

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function summaryOf(args: Record<string, unknown>): string {
  const values = Object.values(args);
  const text = values.length === 1 && typeof values[0] === 'string' ? values[0] : canonical(args);
  return text.length > SUMMARY_LENGTH ? `${text.slice(0, SUMMARY_LENGTH - 1)}…` : text;
}

const SCOOP_SAID: Record<string, (name: string) => string> = {
  [REASONS.noScoop]: (name) => `there is no scoop ${name} in this cone to review it.`,
  [REASONS.scoopStopped]: (name) => `the scoop ${name} is stopped, so it can't review it.`,
  [REASONS.scoopAsked]: (name) =>
    `the scoop ${name} can't review a call that asks something of it.`,
  [REASONS.scoopUndecided]: (name) => `the scoop ${name} ended its review without deciding.`,
};

function scoopReason(item: Approval): string | null {
  const name = item.tier.slice('scoop:'.length);
  if (item.decidedBy?.startsWith('scoop:'))
    return `The scoop ${name} declined this tool call in a run a guest started${item.reason ? `: ${item.reason}` : '.'}`;
  const said = SCOOP_SAID[item.reason ?? ''];
  return said ? `A guest started this run, and ${said(name)}` : null;
}

export function reasonOf(item: Approval): string {
  const scooped = item.state === 'rejected' && scoopTier(item.tier) ? scoopReason(item) : null;
  if (scooped) return scooped;
  if (item.state === 'rejected' && item.decidedBy === 'judge')
    return item.verdict
      ? `${GATE_REASONS.judged}: ${item.verdict.reason}`
      : `${GATE_REASONS.judged}.`;
  if (item.state === 'rejected')
    return item.reason && item.reason !== REASONS.unknownAnswer
      ? `${GATE_REASONS.rejected} ${item.reason}`
      : GATE_REASONS.rejected;
  if (item.state === 'withdrawn') return GATE_REASONS.withdrawn;
  if (item.reason === REASONS.unknownTier) return GATE_REASONS.unknown;
  if (item.reason === REASONS.unroutable) return GATE_REASONS.unroutable;
  return GATE_REASONS.unanswered;
}

async function taintsOf(
  inputs: readonly SubmissionId[],
  seats: Readonly<Record<string, SeatRecord>>,
  harness: Held,
  context: Context
): Promise<Taint[]> {
  const found = new Map<string, Taint>();
  for (const id of inputs) {
    const seat = Object.values(seats).find((record) =>
      record.submissions?.some((entry) => entry.id === String(id))
    );
    const tier = seat?.submissions?.find((entry) => entry.id === String(id))?.tools;
    if (seat) {
      found.set(`${seat.id}\n${tier}`, { seat, tier: String(tier) });
      continue;
    }
    const submission = await harness.submission(id, context);
    const record = submission ? await submission.status(context) : undefined;
    if (record?.requestId?.startsWith(GUEST_REQUEST)) return [{ seat: null, tier: '' }];
  }
  return [...found.values()];
}

function settledEarly(
  seat: SeatRecord,
  tier: string,
  policy: GuestPolicy,
  at: number,
  tool: string,
  args: string
): string | null {
  if (!policy.allowedToolGates.includes(gateKind(tier)))
    return gateRefusal("a guest's tool calls", policy.allowedToolGates);
  if (!liveSeat(seat, at)) return GATE_REASONS.ended;
  if (tier === 'off') return '';
  const kept = seat.alwaysTools?.some((rule) => rule.tool === tool && rule.arguments === args);
  return policy.always.tools && kept ? '' : null;
}

const ended = (status: string) => status === 'terminal' || status === 'completing';

export function guestToolGate(harness: () => Held | undefined): GuestToolGate {
  let resolveHost: (host: GateHost) => void = () => {};
  const bound = new Promise<GateHost>((resolve) => {
    resolveHost = resolve;
  });
  const watched = new Set<string>();
  const watch = (host: GateHost, id: string, task: number) => {
    const held = harness();
    if (!held || watched.has(id)) return;
    watched.add(id);
    void held
      .waitForTask(task as unknown as TaskId, BACKGROUND_CONTEXT)
      .then((record) =>
        ended(record.state.status)
          ? host.approvals.withdraw(id, REASONS.aborted, BACKGROUND_CONTEXT)
          : undefined
      )
      .catch(() => undefined)
      .finally(() => watched.delete(id));
  };
  const remember = (seat: string, rule: AlwaysTool) =>
    (harness() as Held).commit(async (tx) => {
      const record = (await tx.doc(GuestsDoc)).seats[seat];
      if (!record || record.revoked !== null) return;
      const kept = (record.alwaysTools ?? []).filter(
        (entry) => entry.tool !== rule.tool || entry.arguments !== rule.arguments
      );
      record.alwaysTools = [...kept, rule];
    }, BACKGROUND_CONTEXT);
  const review = async (
    taint: Taint,
    call: ToolHookCall,
    api: HookApi,
    context: Context
  ): Promise<string | undefined> => {
    const { seat } = taint;
    if (seat === null || !isGate(taint.tier)) return GATE_REASONS.unknown;
    const host = await awaitWithContext(bound, context);
    const policy = host.policy();
    const now = host.now ?? Date.now;
    const args = canonical(call.arguments);
    const always = policy.always.tools;
    const early = settledEarly(seat, taint.tier, policy, now(), call.name, args);
    if (early !== null) return early || undefined;
    const id = await api.memo<string>(
      `${GUEST_TOOL_MEMO}:${seat.id}:${taint.tier}`,
      `apr-${crypto.randomUUID()}`,
      context
    );
    const task = Number(api.taskId);
    const asked = await host.approvals.request(
      {
        id,
        kind: 'guest-tool',
        seat: seat.id,
        agentId: seat.agentId,
        requester: { kind: 'guest', name: seat.label, seat: seat.id },
        tier: taint.tier,
        detail: { tool: call.name, summary: summaryOf(call.arguments), arguments: args, task },
      },
      BACKGROUND_CONTEXT
    );
    watch(host, id, task);
    const live = async () =>
      liveSeat((await api.snapshot(GuestsDoc, context))?.seats[seat.id], now());
    if (!(await live())) {
      await host.approvals.withdraw(id, REASONS.revoked, BACKGROUND_CONTEXT);
      return GATE_REASONS.ended;
    }
    const item = asked.state === 'pending' ? await host.approvals.settled(id, context) : asked;
    if (item.state !== 'approved') return reasonOf(item);
    if (!(await live())) return GATE_REASONS.ended;
    if (item.answer === 'always' && always)
      await remember(seat.id, {
        approval: item.id,
        tool: call.name,
        arguments: args,
        by: item.decidedBy,
        at: item.decidedAt ?? now(),
      });
    return undefined;
  };
  return {
    extension: defineExtension({
      name: GUEST_GUARD,
      hooks: [
        hook(ToolTask, {
          async beforeTool(call, api, context) {
            const live = await api.snapshot(LiveDoc, api.conversationId, context);
            const inputs = live?.run?.inputs ?? [];
            if (!inputs.length) return undefined;
            const seats = (await api.snapshot(GuestsDoc, context))?.seats ?? {};
            const held = harness() as Held;
            for (const taint of await taintsOf(inputs, seats, held, context)) {
              const block = await review(taint, call, api, context);
              if (block) return { block };
            }
            return undefined;
          },
        }),
      ],
    }),
    bind(host) {
      resolveHost(host);
      for (const item of host.approvals.state.value ?? [])
        if (item.kind === 'guest-tool' && item.state === 'pending' && item.detail.task)
          watch(host, item.id, item.detail.task);
    },
  };
}
