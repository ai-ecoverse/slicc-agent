import type { Harness } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import type { Clock } from '../clock.ts';
import { type LeasePort, type LeaseRuntime, serveLease, watchLease } from './runtime.ts';
import { type LeaseHold, leaseExtension } from './tool.ts';

export {
  checkReason,
  checkUrl,
  REFUSALS,
  sentText,
} from './check.ts';
export {
  acceptWorkerMessage,
  type BiosMessage,
  type CancelMessage,
  EPOCH_HEX,
  type HelloMessage,
  LEASE_V,
  newEpoch,
  type ProposalMessage,
  parseBiosMessage,
  parseWorkerMessage,
  WITHDRAW_REASONS,
  type WithdrawnMessage,
  type WithdrawReason,
  type WorkerMessage,
} from './protocol.ts';
export {
  coneEligible,
  HOUR_MS,
  HOURLY_CAP,
  type LeasePort,
  type LeaseRuntime,
  liveSeatsOnCone,
  type OpenProposal,
  serveLease,
  TTL_MS,
  watchLease,
} from './runtime.ts';
export {
  LEASE_MEMO,
  LEASE_SECTION,
  LEASE_TOOL,
  type LeaseHold,
  type LeaseToolHost,
  leaseExtension,
  leaseProposeTool,
} from './tool.ts';

export type LeaseHoldScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

export type HoldLeaseAt = 'published' | 'reserve';

export function holdPublished(
  scope: LeaseHoldScope,
  wanted: HoldLeaseAt | undefined
): LeaseHold | undefined {
  if (wanted !== 'published' && wanted !== 'reserve') return undefined;
  let waiting = Promise.withResolvers<void>();
  scope.addEventListener('message', ({ data }) => {
    if (!(data as { releaseLease?: boolean } | null)?.releaseLease) return;
    const current = waiting;
    waiting = Promise.withResolvers<void>();
    current.resolve();
  });
  return () => waiting.promise;
}

export type LeaseOptions = {
  port: LeasePort;
  hold?: LeaseHold;
  holdAt?: HoldLeaseAt;
  clock?: Pick<Clock, 'now' | 'setTimer'>;
};

export type Lease = {
  extension: ReturnType<typeof leaseExtension>;
  runtime: () => LeaseRuntime | undefined;
  attach(agents: Agents, harness: Harness): () => void;
  close(): void;
};

export function setupLease(options: LeaseOptions): Lease {
  const now = options.clock?.now ?? Date.now;
  const setTimer =
    options.clock?.setTimer ??
    ((callback: () => void, delayMs: number) => {
      const id = setTimeout(callback, delayMs);
      return () => clearTimeout(id);
    });
  let runtime: LeaseRuntime | undefined = serveLease(options.port, { now, setTimer });
  let attached: { agents: Agents; harness: Harness } | undefined;
  let stopWatch: () => void = () => undefined;
  const host = {
    runtime: () => runtime,
    harness: () => attached?.harness,
    now,
    ...(options.hold ? { hold: options.hold, holdAt: options.holdAt ?? 'published' } : {}),
  };
  return {
    extension: leaseExtension(host),
    runtime: () => runtime,
    attach(agents, harness) {
      attached = { agents, harness };
      stopWatch();
      stopWatch = watchLease(runtime as LeaseRuntime, {
        agents: () => attached?.agents,
        harness: () => attached?.harness,
        now,
      });
      return () => {
        stopWatch();
        stopWatch = () => undefined;
      };
    },
    close() {
      stopWatch();
      runtime?.close();
      runtime = undefined;
      attached = undefined;
    },
  };
}
