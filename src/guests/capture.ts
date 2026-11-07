import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { Approval, Approvals } from '../approvals/index.ts';
import {
  type ApprovalAnswer,
  type CaptureDetail,
  type CaptureWhat,
  cleanReason,
  REASONS,
} from '../approvals/record.ts';
import type { InheritedTaint } from './guard.ts';
import { type GuestPolicy, gateKind } from './policy.ts';
import { type AlwaysCapture, GuestsDoc, isGate, liveSeat, type SeatRecord } from './seats.ts';
import { taggedTaints } from './tags.ts';

export type CaptureAnswer = ApprovalAnswer;

export type CaptureDenial = { answer: 'deny'; message: string };

export type CaptureReply = CaptureAnswer | CaptureDenial;

export interface CaptureRequest {
  kind: string;
  options?: Record<string, unknown>;
  stamp?: { tags?: unknown; argv0?: unknown };
}

export interface AgentCapture {
  capture(request: unknown, where: string | null, context: Context): Promise<CaptureReply>;
}

export interface CaptureHost {
  harness: Pick<Harness, 'snapshot' | 'commit'>;
  approvals: Pick<Approvals, 'request' | 'settled' | 'withdraw'>;
  policy(): GuestPolicy;
  now?: () => number;
}

export const NOT_CAPTURE = 'capture: not a capture kind';
export const CAPTURE_JUDGED = 'capture: denied by the approval judge';
export const PROGRAM = 'a program';
export const LABEL_LENGTH = 200;

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const textOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, LABEL_LENGTH) : undefined;
};

const secondsOf = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? { seconds: value } : {};

const VISUAL: Record<string, CaptureWhat> = {
  'capture.screen': 'screen',
  'capture.camera': 'camera',
};

export function captureDetail(request: unknown): CaptureDetail | null {
  const asked = objectOf(request);
  const options = objectOf(asked.options);
  const program = textOf(objectOf(asked.stamp).argv0) ?? PROGRAM;
  const device = textOf(options.device);
  const named = device ? { device } : {};
  if (asked.kind === 'audio.record')
    return { what: 'microphone', mode: 'audio', ...secondsOf(options.seconds), ...named, program };
  const kind = typeof asked.kind === 'string' ? asked.kind : '';
  const what = Object.hasOwn(VISUAL, kind) ? VISUAL[kind] : undefined;
  if (!what) return null;
  const video = typeof options.type === 'string' && options.type.startsWith('video/');
  return {
    what,
    mode: video ? 'video' : 'still',
    ...(video ? secondsOf(options.duration) : {}),
    ...(video && options.system === true ? { system: true } : {}),
    ...(video && (options.microphone === true || typeof options.microphone === 'string')
      ? { microphone: true }
      : {}),
    ...named,
    program,
  };
}

const tagsOf = (request: unknown): string[] => {
  const tags = objectOf(objectOf(request).stamp).tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
};

const kept = (seat: SeatRecord, detail: CaptureDetail) =>
  seat.alwaysCaptures?.some((rule) => rule.what === detail.what && rule.mode === detail.mode);

function early(
  seat: SeatRecord,
  tier: string,
  detail: CaptureDetail,
  policy: GuestPolicy,
  at: number
): CaptureAnswer | null {
  if (!isGate(tier)) return 'deny';
  if (!policy.allowedToolGates.includes(gateKind(tier))) return 'deny';
  if (!liveSeat(seat, at)) return 'deny';
  if (tier === 'off') return 'once';
  return policy.always.tools && kept(seat, detail) ? 'always' : null;
}

function denialOf(item: Approval): CaptureReply {
  if (item.state !== 'rejected' || item.decidedBy !== 'judge') return 'deny';
  const reason = item.verdict?.reason;
  return { answer: 'deny', message: reason ? `${CAPTURE_JUDGED}: ${reason}` : CAPTURE_JUDGED };
}

async function settledOr(host: CaptureHost, id: string, context: Context): Promise<Approval> {
  try {
    return await host.approvals.settled(id, context);
  } catch (error) {
    await host.approvals.withdraw(id, REASONS.aborted, BACKGROUND_CONTEXT).catch(() => undefined);
    throw error;
  }
}

export function captureGate(host: CaptureHost): AgentCapture {
  const now = host.now ?? Date.now;
  const seatOf = async (id: string | null, context: Context) =>
    id === null ? undefined : (await host.harness.snapshot(GuestsDoc, context))?.seats[id];
  const remember = (seat: string, rule: AlwaysCapture) =>
    host.harness.commit(async (tx) => {
      const record = (await tx.doc(GuestsDoc)).seats[seat];
      if (record?.revoked === null)
        record.alwaysCaptures = [
          ...(record.alwaysCaptures ?? []).filter(
            (entry) => entry.what !== rule.what || entry.mode !== rule.mode
          ),
          rule,
        ];
    }, BACKGROUND_CONTEXT);
  const review = async (
    taint: InheritedTaint,
    detail: CaptureDetail,
    where: string | undefined,
    context: Context
  ): Promise<CaptureReply> => {
    const seat = await seatOf(taint.seat, context);
    if (!seat) return 'deny';
    const settled = early(seat, taint.tier, detail, host.policy(), now());
    if (settled) return settled;
    const asked = await host.approvals.request(
      {
        kind: 'capture',
        seat: seat.id,
        agentId: seat.agentId,
        requester: { kind: 'guest', name: seat.label, seat: seat.id, ...(where ? { where } : {}) },
        tier: taint.tier,
        detail,
      },
      BACKGROUND_CONTEXT
    );
    const item = asked.state === 'pending' ? await settledOr(host, asked.id, context) : asked;
    if (item.state !== 'approved') return denialOf(item);
    if (!liveSeat(await seatOf(seat.id, context), now())) return 'deny';
    if (item.answer !== 'always' || !host.policy().always.tools) return 'once';
    const { what, mode } = detail;
    await remember(seat.id, {
      approval: item.id,
      what,
      mode,
      by: item.decidedBy,
      at: item.decidedAt as number,
    });
    return 'always';
  };
  return {
    async capture(request, where, context) {
      const detail = captureDetail(request);
      if (!detail) return { answer: 'deny', message: NOT_CAPTURE };
      const taints = await taggedTaints(host.harness, tagsOf(request), context);
      let answer: CaptureAnswer = 'always';
      for (const taint of taints) {
        const given = await review(taint, detail, cleanReason(where), context);
        if (given === 'once') answer = 'once';
        else if (given !== 'always') return given;
      }
      return taints.length ? answer : 'once';
    },
  };
}
