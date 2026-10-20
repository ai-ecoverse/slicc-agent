import { defineDoc } from '@earendil-works/pi-durable';
import type { ApprovalTier, DecidedBy } from '../approvals/record.ts';
import {
  DAY_MS,
  DEFAULT_GUEST_POLICY,
  type GuestPolicy,
  gateKind,
  gateRefusal,
  MAX_SEAT_DAYS,
} from './policy.ts';

export type GuestGate = ApprovalTier | 'off';

export type GuestGates = {
  messages: GuestGate;
  tools: GuestGate;
};

export type GuestDraft = {
  id: string;
  label: string;
  agentId: string;
  expiresAt: number | null;
  gates: GuestGates;
};

export type SeatSubmission = { id: string; approval: string | null; tools: GuestGate };

export type AlwaysTool = {
  approval: string;
  tool: string;
  argumentsHash: string;
  arguments: string;
  by: DecidedBy | null;
  at: number;
};

export type ShownAlwaysTool = Omit<AlwaysTool, 'argumentsHash'>;

export type SeatRecord = GuestDraft & {
  createdAt: number;
  epoch: number;
  revoked: number | null;
  delivered?: string[];
  submissions?: SeatSubmission[];
  always?: { by: DecidedBy | null; approval: string; at: number };
  alwaysTools?: AlwaysTool[];
};

export interface GuestSeat {
  id: string;
  label: string;
  agentId: string;
  createdAt: number;
  expiresAt: number | null;
  gates: GuestGates;
  connected: boolean;
  pending: number;
  alwaysTools: ShownAlwaysTool[];
}

export type GuestsState = { seats: Record<string, SeatRecord> };

export const GuestsDoc = defineDoc<GuestsState>({
  kind: 'slicc.guests',
  version: 1,
  scope: 'session',
  initial: () => ({ seats: {} }),
});

export const MAX_SEAT_MS = MAX_SEAT_DAYS * DAY_MS;
export const MAX_LABEL = 64;
const MAX_ID = 256;

export function cleanLabel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);
}

export function isGate(value: unknown): value is GuestGate {
  if (typeof value !== 'string') return false;
  if (value === 'user' || value === 'agent' || value === 'cone' || value === 'off') return true;
  return /^scoop:\S+$/.test(value);
}

export function checkDraft(
  draft: GuestDraft,
  now: number,
  policy: GuestPolicy = DEFAULT_GUEST_POLICY
): string | null {
  if (typeof draft?.id !== 'string' || !draft.id || draft.id.length > MAX_ID)
    return 'A guest seat needs an id from the tray hub.';
  if (!cleanLabel(draft.label)) return 'A guest seat needs a label.';
  if (!isGate(draft.gates?.messages) || !isGate(draft.gates?.tools))
    return 'A guest seat needs a known gate for messages and for tools.';
  if (!policy.allowedMessageGates.includes(gateKind(draft.gates.messages)))
    return gateRefusal("a guest's messages", policy.allowedMessageGates);
  if (!policy.allowedToolGates.includes(gateKind(draft.gates.tools)))
    return gateRefusal("a guest's tool calls", policy.allowedToolGates);
  const { expiresAt } = draft;
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)))
    return 'A guest seat expires at a time, or never.';
  if (expiresAt !== null && expiresAt <= now) return 'That expiry has already passed.';
  const days = policy.maxSeatDays;
  if (expiresAt !== null && expiresAt - now > days * DAY_MS)
    return `A guest seat lasts at most ${days} ${days === 1 ? 'day' : 'days'}.`;
  return null;
}

export function liveSeat(seat: SeatRecord | undefined, now: number): boolean {
  return Boolean(
    seat && seat.revoked === null && (seat.expiresAt === null || seat.expiresAt > now)
  );
}
