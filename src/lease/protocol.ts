export const LEASE_V = 1;
export const EPOCH_HEX = /^[0-9a-f]{32}$/;
export const WITHDRAW_REASONS = ['expired', 'cancelled', 'stale'] as const;
export type WithdrawReason = (typeof WITHDRAW_REASONS)[number];

export type HelloMessage = { v: 1; type: 'hello'; epoch: string };
export type ProposalMessage = {
  v: 1;
  type: 'proposal';
  epoch: string;
  proposal: number;
  agentId: string;
  url: string;
  reason: string;
  at: number;
  expiresAt: number;
};
export type WithdrawnMessage = {
  v: 1;
  type: 'withdrawn';
  epoch: string;
  proposal: number;
  reason: WithdrawReason;
};
export type CancelMessage = { v: 1; type: 'cancel'; epoch: string; proposal: number };

export type WorkerMessage = HelloMessage | ProposalMessage | WithdrawnMessage;
export type BiosMessage = CancelMessage;

const HELLO_KEYS = ['v', 'type', 'epoch'] as const;
const PROPOSAL_KEYS = [
  'v',
  'type',
  'epoch',
  'proposal',
  'agentId',
  'url',
  'reason',
  'at',
  'expiresAt',
] as const;
const WITHDRAWN_KEYS = ['v', 'type', 'epoch', 'proposal', 'reason'] as const;
const CANCEL_KEYS = ['v', 'type', 'epoch', 'proposal'] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const seen = Object.keys(value);
  if (seen.length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(value, key));
}

function epochOf(value: unknown): string | undefined {
  return typeof value === 'string' && EPOCH_HEX.test(value) ? value : undefined;
}

function proposalOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function newEpoch(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseWorkerMessage(value: unknown): WorkerMessage | undefined {
  if (!plainObject(value) || value.v !== LEASE_V) return undefined;
  const epoch = epochOf(value.epoch);
  if (!epoch) return undefined;
  if (value.type === 'hello') {
    if (!exactKeys(value, HELLO_KEYS)) return undefined;
    return { v: 1, type: 'hello', epoch };
  }
  const proposal = proposalOf(value.proposal);
  if (!proposal) return undefined;
  if (value.type === 'withdrawn') {
    if (!exactKeys(value, WITHDRAWN_KEYS)) return undefined;
    if (!WITHDRAW_REASONS.includes(value.reason as WithdrawReason)) return undefined;
    return { v: 1, type: 'withdrawn', epoch, proposal, reason: value.reason as WithdrawReason };
  }
  if (value.type !== 'proposal') return undefined;
  if (!exactKeys(value, PROPOSAL_KEYS)) return undefined;
  if (typeof value.agentId !== 'string' || typeof value.url !== 'string') return undefined;
  if (typeof value.reason !== 'string') return undefined;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined;
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return undefined;
  return {
    v: 1,
    type: 'proposal',
    epoch,
    proposal,
    agentId: value.agentId,
    url: value.url,
    reason: value.reason,
    at: value.at,
    expiresAt: value.expiresAt,
  };
}

export function parseBiosMessage(value: unknown): BiosMessage | undefined {
  if (!plainObject(value) || value.v !== LEASE_V || value.type !== 'cancel') return undefined;
  if (!exactKeys(value, CANCEL_KEYS)) return undefined;
  const epoch = epochOf(value.epoch);
  const proposal = proposalOf(value.proposal);
  if (!epoch || !proposal) return undefined;
  return { v: 1, type: 'cancel', epoch, proposal };
}

export function acceptWorkerMessage(
  value: unknown,
  epoch: string | undefined
): WorkerMessage | undefined {
  const message = parseWorkerMessage(value);
  if (!message) return undefined;
  if (message.type === 'hello') return message;
  if (!epoch || message.epoch !== epoch) return undefined;
  return message;
}
