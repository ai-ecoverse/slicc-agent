import type { ApprovalTier } from '../approvals/record.ts';

export type GateKind = 'user' | 'agent' | 'scoop' | 'cone' | 'off';

export type GuestPolicy = {
  manageGuests: 'deny' | ApprovalTier;
  allowedToolGates: GateKind[];
  allowedMessageGates: GateKind[];
  maxSeatDays: number;
  always: { messages: boolean; tools: boolean };
};

export type GuestPolicyChange = Partial<GuestPolicy>;

export const GATE_KINDS: readonly GateKind[] = ['user', 'agent', 'cone', 'scoop', 'off'];

export const DEFAULT_GUEST_POLICY: GuestPolicy = {
  manageGuests: 'deny',
  allowedToolGates: ['user', 'agent'],
  allowedMessageGates: ['user', 'agent', 'cone', 'off'],
  maxSeatDays: 30,
  always: { messages: false, tools: false },
};

export const SCOOP_REVIEW_LATER = "This review isn't available yet.";

export const MAX_SEAT_DAYS = 365;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const GUESTS_MANAGE_DENIED = "The owner's guest policy doesn't let guests manage guests.";
export const GUESTS_MANAGE_LATER = "Guests can't manage guests yet, whatever the policy says.";
export const POLICY_MANAGE_DENY_ONLY =
  "manageGuests can only be deny: guests can't manage guests yet.";

export const gateKind = (gate: string): GateKind =>
  gate.startsWith('scoop:') ? 'scoop' : (gate as GateKind);

const BY: Record<GateKind, string> = {
  user: 'a person',
  agent: 'the judge',
  scoop: 'a scoop',
  cone: 'the cone',
  off: '',
};

export function gateRefusal(what: string, allowed: readonly GateKind[]): string {
  const by = allowed.filter((kind) => kind !== 'off').map((kind) => BY[kind]);
  if (!by.length) return `The owner's guest policy allows no review for ${what}.`;
  const listed = by.length > 1 ? `${by.slice(0, -1).join(', ')} or ${by.at(-1)}` : by[0];
  return `${what[0]?.toUpperCase()}${what.slice(1)} need a review: by ${listed}.`;
}

type Entry = (value: unknown, next: GuestPolicy) => string | null;

const gatesOf =
  (name: 'allowedToolGates' | 'allowedMessageGates'): Entry =>
  (value, next) => {
    if (!Array.isArray(value) || !value.every((kind) => GATE_KINDS.includes(kind as GateKind)))
      return `${name} lists gates from ${GATE_KINDS.join(', ')}.`;
    next[name] = GATE_KINDS.filter((kind) => value.includes(kind));
    return null;
  };

const ALWAYS_KEYS = new Set(['messages', 'tools']);

const ENTRIES: Record<keyof GuestPolicy, Entry> = {
  manageGuests: (value) => (value === 'deny' ? null : POLICY_MANAGE_DENY_ONLY),
  allowedToolGates: gatesOf('allowedToolGates'),
  allowedMessageGates: gatesOf('allowedMessageGates'),
  maxSeatDays(value, next) {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_SEAT_DAYS)
      return `maxSeatDays is a whole number from 1 to ${MAX_SEAT_DAYS}.`;
    next.maxSeatDays = value as number;
    return null;
  },
  always(value, next) {
    const given = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (
      !given ||
      Object.entries(given).some(([key, on]) => !ALWAYS_KEYS.has(key) || typeof on !== 'boolean')
    )
      return 'always says, for messages and tools, true or false.';
    next.always = { ...next.always, ...(given as Partial<GuestPolicy['always']>) };
    return null;
  },
};

export function changedGuests(next: GuestPolicy, change: unknown): string | null {
  if (!change || typeof change !== 'object' || Array.isArray(change))
    return 'The guests policy is an object of policy entries.';
  for (const [name, value] of Object.entries(change)) {
    const entry = Object.hasOwn(ENTRIES, name) ? ENTRIES[name as keyof GuestPolicy] : undefined;
    const error = entry ? entry(value, next) : `There is no guest policy entry ${name}.`;
    if (error) return error;
  }
  return null;
}
