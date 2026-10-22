import type { CheckpointInfo } from '@earendil-works/pi-durable';

export const BASE_EVERY = 64;

export const deltasOnly = (): boolean => false;

export const boundedDeltas = (_value: unknown, _ops: unknown, info: CheckpointInfo): boolean =>
  info.deltasSinceBase >= BASE_EVERY;
