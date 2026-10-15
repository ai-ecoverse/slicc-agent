import { defineDoc } from '@earendil-works/pi-durable';

export type GuestGate = 'user' | 'agent' | 'cone' | `scoop:${string}` | 'off';

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

export type SeatRecord = GuestDraft & {
  createdAt: number;
  epoch: number;
  revoked: number | null;
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
}

export type GuestsState = { seats: Record<string, SeatRecord> };

export const GuestsDoc = defineDoc<GuestsState>({
  kind: 'slicc.guests',
  version: 1,
  scope: 'session',
  initial: () => ({ seats: {} }),
});

export const MAX_SEAT_MS = 30 * 24 * 60 * 60 * 1000;
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

export function checkDraft(draft: GuestDraft, now: number): string | null {
  if (typeof draft?.id !== 'string' || !draft.id || draft.id.length > MAX_ID)
    return 'A guest seat needs an id from the tray hub.';
  if (!cleanLabel(draft.label)) return 'A guest seat needs a label.';
  if (!isGate(draft.gates?.messages) || !isGate(draft.gates?.tools))
    return 'A guest seat needs a known gate for messages and for tools.';
  const { expiresAt } = draft;
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)))
    return 'A guest seat expires at a time, or never.';
  if (expiresAt !== null && expiresAt <= now) return 'That expiry has already passed.';
  if (expiresAt !== null && expiresAt - now > MAX_SEAT_MS)
    return 'A guest seat lasts at most 30 days.';
  return null;
}

export function liveSeat(seat: SeatRecord | undefined, now: number): boolean {
  return Boolean(
    seat && seat.revoked === null && (seat.expiresAt === null || seat.expiresAt > now)
  );
}
