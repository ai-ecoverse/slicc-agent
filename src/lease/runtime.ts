import type { Context } from '@earendil-works/chord/context';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, Harness } from '@earendil-works/pi-durable';
import { type Agents, AgentsDoc, type AgentsState } from '../agents.ts';
import { gatedRun, runTaints } from '../guests/guard.ts';
import { GuestsDoc, liveSeat, type SeatRecord } from '../guests/seats.ts';
import { whoIs } from '../memory/prompt.ts';
import { REFUSALS } from './check.ts';
import {
  newEpoch,
  type ProposalMessage,
  parseBiosMessage,
  TTL_MS,
  type WithdrawnMessage,
  type WithdrawReason,
} from './protocol.ts';

export { TTL_MS };
export const HOUR_MS = 60 * 60 * 1000;
export const HOURLY_CAP = 6;

export type OpenProposal = {
  proposal: number;
  coneId: string;
  conversationId: number;
  at: number;
  expiresAt: number;
  published: boolean;
  clear: () => void;
};

export type LeasePort = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?: () => void;
  close?: () => void;
};

export type LeaseRuntime = {
  readonly epoch: string;
  readonly life: string;
  readonly open: boolean;
  waiting(conversationId: number): boolean;
  reserved(coneId: string): boolean;
  reserve(
    coneId: string,
    conversationId: number,
    at: number
  ): { proposal: number } | { refuse: string };
  publish(coneId: string, url: string, reason: string): boolean;
  revalidate(state: Readonly<AgentsState>, seats: Record<string, SeatRecord>, now: number): void;
  abandon(coneId: string): void;
  withdrawCone(coneId: string, reason: WithdrawReason): void;
  withdrawConversation(conversationId: number, reason: WithdrawReason): void;
  close(): void;
};

type Host = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => () => void;
};

export function liveSeatsOnCone(
  seats: Record<string, SeatRecord>,
  coneId: string,
  now: number
): boolean {
  return Object.values(seats).some((seat) => seat.agentId === coneId && liveSeat(seat, now));
}

export function coneEligible(
  state: Readonly<AgentsState>,
  conversationId: number,
  now: number,
  seats: Record<string, SeatRecord>
): { coneId: string } | { refuse: string } {
  const who = whoIs(state, conversationId);
  if (who.kind === 'scoop') return { refuse: REFUSALS.scoop };
  if (who.kind !== 'cone') {
    const cold = Object.values(state.frozen ?? {}).find(
      (record) => record.conversation === conversationId
    );
    if (cold) return { refuse: REFUSALS.frozen };
    return { refuse: REFUSALS.gone };
  }
  if (liveSeatsOnCone(seats, who.id, now)) return { refuse: REFUSALS.seat };
  return { coneId: who.id };
}

export function serveLease(port: LeasePort, host: Host): LeaseRuntime {
  const epoch = newEpoch();
  const life = newEpoch();
  const open = new Map<string, OpenProposal>();
  const byProposal = new Map<number, string>();
  const hourly = new Map<string, number[]>();
  let next = 1;
  let alive = true;

  const send = (
    message: ProposalMessage | WithdrawnMessage | { v: 1; type: 'hello'; epoch: string }
  ) => {
    if (!alive) return;
    try {
      port.postMessage(message);
    } catch {
      alive = false;
    }
  };

  send({ v: 1, type: 'hello', epoch });

  const forget = (coneId: string) => {
    const held = open.get(coneId);
    if (!held) return undefined;
    held.clear();
    open.delete(coneId);
    byProposal.delete(held.proposal);
    if (!held.published) {
      const times = (hourly.get(coneId) ?? []).filter((when) => when !== held.at);
      hourly.set(coneId, times);
    }
    return held;
  };

  const withdraw = (coneId: string, reason: WithdrawReason) => {
    const held = forget(coneId);
    if (!held?.published) return;
    send({ v: 1, type: 'withdrawn', epoch, proposal: held.proposal, reason });
  };

  const pruneHourly = (coneId: string, at: number) => {
    const times = (hourly.get(coneId) ?? []).filter((when) => at - when < HOUR_MS);
    hourly.set(coneId, times);
    return times;
  };

  port.addEventListener('message', ({ data }) => {
    const message = parseBiosMessage(data);
    if (!message) return;
    if (message.epoch !== epoch) return;
    const coneId = byProposal.get(message.proposal);
    if (!coneId) return;
    withdraw(coneId, 'cancelled');
  });
  port.start?.();

  return {
    get epoch() {
      return epoch;
    },
    get life() {
      return life;
    },
    get open() {
      return alive;
    },
    waiting(conversationId) {
      for (const held of open.values()) if (held.conversationId === conversationId) return true;
      return false;
    },
    reserved(coneId) {
      return open.has(coneId);
    },
    reserve(coneId, conversationId, at) {
      if (!alive) return { refuse: REFUSALS.unavailable };
      if (open.has(coneId)) return { refuse: REFUSALS.open };
      const times = pruneHourly(coneId, at);
      if (times.length >= HOURLY_CAP) return { refuse: REFUSALS.hourly };
      const proposal = next++;
      const expiresAt = at + TTL_MS;
      const clear = host.setTimer(
        () => withdraw(coneId, 'expired'),
        Math.max(0, expiresAt - host.now())
      );
      open.set(coneId, {
        proposal,
        coneId,
        conversationId,
        at,
        expiresAt,
        published: false,
        clear,
      });
      byProposal.set(proposal, coneId);
      times.push(at);
      hourly.set(coneId, times);
      return { proposal };
    },
    publish(coneId, url, reason) {
      const held = open.get(coneId);
      if (!held || !alive || held.published) return false;
      send({
        v: 1,
        type: 'proposal',
        epoch,
        proposal: held.proposal,
        agentId: coneId,
        url,
        reason,
        at: held.at,
        expiresAt: held.expiresAt,
      });
      if (!alive) return false;
      held.published = true;
      return true;
    },
    revalidate(state, seats, now) {
      for (const [coneId, held] of [...open]) {
        const cone = state.cones[coneId];
        if (
          !cone ||
          cone.conversation !== held.conversationId ||
          liveSeatsOnCone(seats, coneId, now)
        )
          withdraw(coneId, 'stale');
      }
    },
    abandon(coneId) {
      forget(coneId);
    },
    withdrawCone(coneId, reason) {
      withdraw(coneId, reason);
    },
    withdrawConversation(conversationId, reason) {
      for (const [coneId, held] of [...open])
        if (held.conversationId === conversationId) withdraw(coneId, reason);
    },
    close() {
      alive = false;
      for (const held of open.values()) held.clear();
      open.clear();
      byProposal.clear();
      try {
        port.close?.();
      } catch {
        undefined;
      }
    },
  };
}

export function watchLease(
  runtime: LeaseRuntime,
  host: {
    agents: () => Agents | undefined;
    harness: () => Harness | undefined;
    now: () => number;
  }
): () => void {
  const agents = host.agents();
  if (!agents) return () => undefined;
  let seats: Record<string, SeatRecord> = {};
  let stopped = false;
  const react = () => {
    if (stopped) return;
    const state = host.agents()?.state();
    if (!state) return;
    runtime.revalidate(state, seats, host.now());
  };
  const off = agents.onChange(() => {
    react();
  });
  const offCone = agents.onCone(() => {
    react();
  });
  let seatsOff: () => void = () => undefined;
  const harness = host.harness();
  if (harness)
    void harness.watchDoc(GuestsDoc, BACKGROUND_CONTEXT).then((watch) => {
      if (!watch || stopped) {
        if (watch && stopped) void watch.stop();
        return;
      }
      const onSeats = () => {
        if (stopped) return;
        seats = watch.value.seats;
        react();
      };
      watch.start(async () => {
        onSeats();
      });
      onSeats();
      seatsOff = () => {
        void watch.stop();
      };
    });
  return () => {
    stopped = true;
    off();
    offCone();
    seatsOff();
  };
}

export async function eligibility(
  api: {
    conversationId: ConversationId;
    snapshot: Harness['snapshot'];
    memo: {
      <T>(name: string, context: Context): Promise<T | undefined>;
      <T>(name: string, candidate: T, context: Context): Promise<T>;
    };
  },
  context: Context,
  runtime: LeaseRuntime | undefined,
  now: number,
  harness: Harness | undefined
): Promise<{ coneId: string; conversationId: number } | { refuse: string }> {
  if (!runtime?.open) return { refuse: REFUSALS.unavailable };
  if (await gatedRun(api, context)) return { refuse: REFUSALS.gated };
  if (harness && (await taintedConversation(harness, api.conversationId, context)))
    return { refuse: REFUSALS.gated };
  const state = await api.snapshot(AgentsDoc, context);
  if (!state) return { refuse: REFUSALS.gone };
  const seats = (await api.snapshot(GuestsDoc, context))?.seats ?? {};
  const conversationId = Number(api.conversationId);
  const found = coneEligible(state, conversationId, now, seats);
  if ('refuse' in found) return found;
  return { coneId: found.coneId, conversationId };
}

export async function taintedConversation(
  harness: Harness,
  conversationId: ConversationId,
  context: Context
): Promise<boolean> {
  return (await runTaints(harness, conversationId, context)).length > 0;
}
