import {
  type Context,
  type JsonValue,
  type ReplicatedState,
  replicatedState,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type Harness, type JsonObject } from '@earendil-works/pi-durable';
import { deltasOnly } from '../checkpoints.ts';
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

type Overrides = Partial<Record<keyof ApprovalPolicy, JsonObject>>;

export const ApprovalPolicyDoc = defineDoc<{ overrides: Overrides }>({
  kind: 'slicc.approval-policy',
  checkpointWhen: deltasOnly,
  version: 1,
  scope: 'session',
  initial: () => ({ overrides: {} }),
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

export function resolvedPolicy(overrides: Overrides): ApprovalPolicy {
  const guests = (overrides.guests ?? {}) as Partial<GuestPolicy>;
  return copy({
    guests: {
      ...DEFAULT_GUEST_POLICY,
      ...guests,
      always: { ...DEFAULT_GUEST_POLICY.always, ...guests.always },
    },
    sudo: { ...DEFAULT_APPROVAL_POLICY.sudo, ...overrides.sudo },
  });
}

export function overridden(
  overrides: Overrides,
  change: Record<string, Record<string, unknown>>,
  policy: ApprovalPolicy
): Overrides {
  const next = copy(overrides);
  for (const [section, entries] of Object.entries(change)) {
    const key = section as keyof ApprovalPolicy;
    const into = next[key] ?? {};
    const resolved = policy[key] as unknown as JsonObject;
    for (const name of Object.keys(entries))
      into[name] = (
        name === 'always'
          ? { ...(into.always as object), ...(entries.always as object) }
          : resolved[name]
      ) as JsonValue;
    next[key] = into;
  }
  return next;
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
  let overrides = await harness.commit(
    async (tx) => copy((await tx.doc(ApprovalPolicyDoc)).overrides ?? {}),
    context
  );
  const state = replicatedState<ApprovalPolicy>(resolvedPolicy(overrides));
  let line: Promise<unknown> = Promise.resolve();
  return {
    state,
    current: () => copy(state.value as ApprovalPolicy),
    set(change, using) {
      const run = line.then(async () => {
        const made = changedPolicy(state.value as ApprovalPolicy, change);
        if (!made.policy) return made;
        const next = overridden(
          overrides,
          change as Record<string, Record<string, unknown>>,
          made.policy
        );
        await harness.commit(async (tx) => {
          (await tx.doc(ApprovalPolicyDoc)).overrides = copy(next);
        }, using);
        overrides = next;
        const policy = resolvedPolicy(next);
        state.replace(using, copy(policy));
        return { policy: copy(policy), error: null };
      });
      line = run.catch(() => undefined);
      return run;
    },
  };
}
