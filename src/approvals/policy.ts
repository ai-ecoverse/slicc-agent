import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type Harness } from '@earendil-works/pi-durable';
import {
  changedGuests,
  DEFAULT_GUEST_POLICY,
  type GuestPolicy,
  type GuestPolicyChange,
} from '../guests/policy.ts';
import type { ApprovalKind } from './record.ts';

export type SudoPolicy = { approver: 'user' | 'agent' };

export type ApprovalPolicy = { guests: GuestPolicy; sudo: SudoPolicy };

export type ApprovalPolicyChange = { guests?: GuestPolicyChange; sudo?: Partial<SudoPolicy> };

export type ApprovalPolicySet =
  | { policy: ApprovalPolicy; error: null }
  | { policy: null; error: string };

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  guests: DEFAULT_GUEST_POLICY,
  sudo: { approver: 'user' },
};

export const ApprovalPolicyDoc = defineDoc<{ policy: ApprovalPolicy | null }>({
  kind: 'slicc.approval-policy',
  version: 1,
  scope: 'session',
  initial: () => ({ policy: null }),
});

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function changedSudo(next: ApprovalPolicy, change: unknown): string | null {
  if (!change || typeof change !== 'object' || Array.isArray(change))
    return 'The sudo policy is an object of policy entries.';
  for (const [name, value] of Object.entries(change)) {
    if (name !== 'approver') return `There is no sudo policy entry ${name}.`;
    if (value !== 'user' && value !== 'agent')
      return 'A sudo request is approved by user or agent.';
    next.sudo.approver = value;
  }
  return null;
}

export function changedPolicy(base: ApprovalPolicy, change: unknown): ApprovalPolicySet {
  if (!change || typeof change !== 'object' || Array.isArray(change))
    return { policy: null, error: 'An approval policy change is an object of sections.' };
  const next = copy(base);
  for (const [name, value] of Object.entries(change)) {
    const error =
      name === 'guests'
        ? changedGuests(next.guests, value)
        : name === 'sudo'
          ? changedSudo(next, value)
          : `There is no approval policy section ${name}.`;
    if (error) return { policy: null, error };
  }
  return { policy: next, error: null };
}

function kept(stored: Partial<ApprovalPolicy> | null): ApprovalPolicy {
  return {
    guests: { ...DEFAULT_GUEST_POLICY, ...stored?.guests },
    sudo: { ...DEFAULT_APPROVAL_POLICY.sudo, ...stored?.sudo },
  };
}

export interface ApprovalPolicies {
  readonly state: ReplicatedState<ApprovalPolicy>;
  current(): ApprovalPolicy;
  set(change: unknown, context: Context): Promise<ApprovalPolicySet>;
}

export const alwaysFor =
  (policy: Pick<ApprovalPolicies, 'current'>) =>
  (kind: ApprovalKind): boolean => {
    const { always } = policy.current().guests;
    return kind === 'guest-tool' ? always.tools : always.messages;
  };

export async function attachApprovalPolicy(
  harness: Pick<Harness, 'commit'>,
  context: Context = BACKGROUND_CONTEXT
): Promise<ApprovalPolicies> {
  const stored = await harness.commit(async (tx) => {
    const found = (await tx.doc(ApprovalPolicyDoc)).policy;
    return found ? copy(found) : null;
  }, context);
  const state = replicatedState<ApprovalPolicy>(kept(stored));
  let line: Promise<unknown> = Promise.resolve();
  return {
    state,
    current: () => copy(state.value as ApprovalPolicy),
    set(change, using) {
      const run = line.then(async () => {
        const made = changedPolicy(state.value as ApprovalPolicy, change);
        if (!made.policy) return made;
        const policy = made.policy;
        await harness.commit(async (tx) => {
          (await tx.doc(ApprovalPolicyDoc)).policy = copy(policy);
        }, using);
        state.replace(using, copy(policy));
        return { policy: copy(policy), error: null };
      });
      line = run.catch(() => undefined);
      return run;
    },
  };
}
