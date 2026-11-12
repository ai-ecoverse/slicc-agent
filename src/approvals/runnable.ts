import { type ReplicatedState, replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { type AgentsState, live } from '../agents.ts';
import { frozenTarget } from '../freezer/index.ts';
import type { LickTarget } from '../licks/lick.ts';
import { type Approval, MAX_DELAY, REASONS } from './record.ts';

export type Runnable = true | { reason: string };

export type RunGates = {
  maxAgeMinutes: number;
  kernel: true | string;
  frozen?: (agentId: string) => string | undefined;
  gone?: (agentId: string) => boolean;
};

export const SUDO_RUN_PROTOCOL: readonly [number, number] = [1, 16];

export const RUN_REASONS = {
  kind: 'Only a sudo request can run now.',
  open: 'This request is still open: answer it instead.',
  untimed: 'Only a request that timed out can run now.',
  running: 'This request is already running.',
  ran: 'This request already ran.',
  terminal: 'Run it again in the terminal.',
  validate: 'sudo -v has no command to run.',
  stdin: 'Its input is gone, so it must be asked again.',
  old: 'This request is from before Run now, so it must be asked again.',
  off: 'Run now is off in the approval policy.',
  gone: 'The agent that asked is gone, so it must be asked again.',
  kernel: `Needs slicc-kernel protocol ${SUDO_RUN_PROTOCOL.join('.')} or later.`,
} as const;

const MINUTE = 60_000;

export function tooOld(minutes: number): string {
  const hours = minutes / 60;
  const span = Number.isInteger(hours) ? `${hours} h` : `${minutes} min`;
  return `It timed out over ${span} ago, so it must be asked again.`;
}

export const thawFirst = (cone: string): string => `Thaw ${cone} first.`;

export function runnable(item: Approval, now: number, gates: RunGates): Runnable {
  if (item.kind !== 'sudo') return { reason: RUN_REASONS.kind };
  if (item.state === 'pending') return { reason: RUN_REASONS.open };
  if (item.state !== 'unanswered' || item.reason !== REASONS.timeout)
    return { reason: RUN_REASONS.untimed };
  if (item.run)
    return {
      reason:
        item.run.state === 'starting' || item.run.state === 'running'
          ? RUN_REASONS.running
          : RUN_REASONS.ran,
    };
  const agentId = item.requester.agentId;
  if (item.requester.kind !== 'agent' || !agentId) return { reason: RUN_REASONS.terminal };
  if (item.detail.validate || item.replay?.validate) return { reason: RUN_REASONS.validate };
  const stdin = item.replay?.stdin ?? item.detail.stdin;
  if (stdin === 'pipe' || stdin === 'file') return { reason: RUN_REASONS.stdin };
  if (!item.replay?.rootOnly) return { reason: RUN_REASONS.old };
  if (gates.maxAgeMinutes <= 0) return { reason: RUN_REASONS.off };
  const since = item.decidedAt ?? item.expiresAt;
  if (now - since > gates.maxAgeMinutes * MINUTE) return { reason: tooOld(gates.maxAgeMinutes) };
  const frozen = gates.frozen?.(agentId);
  if (frozen) return { reason: thawFirst(frozen) };
  if (gates.gone?.(agentId)) return { reason: RUN_REASONS.gone };
  if (gates.kernel !== true) return { reason: gates.kernel };
  return true;
}

export function runEnds(item: Approval, maxAgeMinutes: number): number | undefined {
  if (item.kind !== 'sudo' || item.state !== 'unanswered' || item.run || maxAgeMinutes <= 0)
    return undefined;
  return (item.decidedAt ?? item.expiresAt) + maxAgeMinutes * MINUTE + 1;
}

export function agentTarget(state: Readonly<AgentsState>, agentId: string): LickTarget {
  if (!agentId.startsWith('scoop:')) return `cone:${agentId}`;
  const scoop = state.scoops[agentId];
  return scoop && !live(scoop) && !scoop.frozen ? `cone:${scoop.cone}` : (agentId as LickTarget);
}

export const frozenOf =
  (state: () => Readonly<AgentsState>) =>
  (agentId: string): string | undefined =>
    frozenTarget(state(), agentTarget(state(), agentId))?.name;

export const goneOf =
  (state: () => Readonly<AgentsState>) =>
  (agentId: string): boolean => {
    const now = state();
    const target = agentTarget(now, agentId);
    return target.startsWith('cone:') ? !now.cones[target.slice(5)] : !now.scoops[agentId];
  };

type Protocol = { protocol?: readonly number[]; sudoRun?: unknown };

export function kernelGate(client: Protocol | undefined): true | string {
  if (typeof client?.sudoRun !== 'function') return RUN_REASONS.kernel;
  const [major = 0, minor = 0] = client.protocol ?? SUDO_RUN_PROTOCOL;
  const [needMajor, needMinor] = SUDO_RUN_PROTOCOL;
  return major > needMajor || (major === needMajor && minor >= needMinor)
    ? true
    : RUN_REASONS.kernel;
}

type Watched = { subscribe(listener: () => void): () => void };

export interface RunnableWatch {
  readonly state: ReplicatedState<Record<string, Runnable>>;
  refresh(): void;
  dispose(): void;
}

const listed = (item: Approval) =>
  item.kind === 'sudo' && item.state === 'unanswered' && item.reason === REASONS.timeout;

export function watchRunnable(
  approvals: Watched & { readonly value: readonly Approval[] | undefined },
  changes: readonly Watched[],
  gates: () => RunGates,
  clock: { now?: () => number; setTimer?: (callback: () => void, ms: number) => () => void } = {}
): RunnableWatch {
  const now = clock.now ?? Date.now;
  const setTimer =
    clock.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const state = replicatedState<Record<string, Runnable>>({});
  let shown = '{}';
  let disarm: () => void = () => undefined;
  const refresh = () => {
    disarm();
    const at = now();
    const given = gates();
    const items = (approvals.value ?? []).filter(listed);
    const map = Object.fromEntries(items.map((item) => [item.id, runnable(item, at, given)]));
    const text = JSON.stringify(map);
    if (text !== shown) {
      shown = text;
      state.replace(BACKGROUND_CONTEXT, map);
    }
    const due = items
      .map((item) => runEnds(item, given.maxAgeMinutes))
      .filter((end): end is number => end !== undefined && end > at);
    if (due.length) disarm = setTimer(refresh, Math.min(MAX_DELAY, Math.min(...due) - at));
  };
  const offs = [
    approvals.subscribe(refresh),
    ...changes.map((watched) => watched.subscribe(refresh)),
  ];
  refresh();
  return {
    state,
    refresh,
    dispose() {
      disarm();
      for (const off of offs) off();
    },
  };
}
