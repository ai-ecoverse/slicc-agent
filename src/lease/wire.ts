import type { Extension, Harness, Registry } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import {
  type HoldLeaseAt,
  holdPublished,
  type Lease,
  type LeaseHoldScope,
  setupLease,
} from './index.ts';

export function createWorkerLease(
  port: MessagePort | undefined,
  scope: LeaseHoldScope,
  holdLease?: HoldLeaseAt
): Lease | undefined {
  if (!port) return undefined;
  const hold = holdPublished(scope, holdLease);
  return setupLease({ port, ...(hold ? { hold, holdAt: holdLease } : {}) });
}

export function installWorkerLease(
  registry: Pick<Registry, 'install'>,
  lease: Lease | undefined
): void {
  if (lease) registry.install(lease.extension as Extension);
}

export function attachWorkerLease(
  lease: Lease | undefined,
  agents: Agents,
  harness: Harness
): void {
  lease?.attach(agents, harness);
}

export function closeWorkerLease(lease: Lease | undefined): void {
  lease?.close();
}
