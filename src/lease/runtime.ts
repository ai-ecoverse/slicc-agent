import type { Context } from '@earendil-works/chord/context';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, Harness } from '@earendil-works/pi-durable';
import { type Agents, AgentsDoc, type AgentsState } from '../agents.ts';
import { frozenTarget } from '../freezer/index.ts';
import { gatedRun, runTaints } from '../guests/guard.ts';
import { GuestsDoc, liveSeat, type SeatRecord } from '../guests/seats.ts';
import { whoIs } from '../memory/prompt.ts';
import { REFUSALS } from './check.ts';
import {
  newEpoch,
  type ProposalMessage,
  parseBiosMessage,
  type WithdrawnMessage,
  type WithdrawReason,
} from './protocol.ts';

export const TTL_MS = 5 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const HOURLY_CAP = 6;

export type OpenProposal = {
  proposal: number;
  coneId: string;
  conversationId: number;
  at: number;
  expiresAt: number;
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
  readonly open: boolean;
  waiting(conversationId: number): boolean;
  reserve(
    coneId: string,
    conversationId: number,
    at: number
  ): { proposal: number } | { refuse: string };
  publish(coneId: string, url: string, reason: string): void;
  propose(
    coneId: string,
    conversationId: number,
    url: string,
    reason: string,
    at: number
  ): { proposal: number } | { refuse: string };
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
  if (!state.cones[who.id]) return { refuse: REFUSALS.gone };
  if (frozenTarget(state, `cone:${who.id}`)) return { refuse: REFUSALS.frozen };
  if (liveSeatsOnCone(seats, who.id, now)) return { refuse: REFUSALS.seat };
  return { coneId: who.id };
}

export function serveLease(port: LeasePort, host: Host): LeaseRuntime {
  const epoch = newEpoch();
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
    return held;
  };

  const withdraw = (coneId: string, reason: WithdrawReason) => {
    const held = forget(coneId);
    if (!held) return;
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
    get open() {
      return alive;
    },
    waiting(conversationId) {
      for (const held of open.values()) if (held.conversationId === conversationId) return true;
      return false;
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
      open.set(coneId, { proposal, coneId, conversationId, at, expiresAt, clear });
      byProposal.set(proposal, coneId);
      times.push(at);
      hourly.set(coneId, times);
      return { proposal };
    },
    publish(coneId, url, reason) {
      const held = open.get(coneId);
      if (!held || !alive) return;
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
    },
    propose(coneId, conversationId, url, reason, at) {
      const reserved = this.reserve(coneId, conversationId, at);
      if ('refuse' in reserved) return reserved;
      this.publish(coneId, url, reason);
      return reserved;
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
  let prior = snapshot(agents.state());
  const react = (state: Readonly<AgentsState>) => {
    const next = snapshot(state);
    for (const [coneId, conversationId] of prior.cones) {
      if (!next.cones.has(coneId)) {
        runtime.withdrawCone(coneId, 'stale');
        continue;
      }
      if (next.cones.get(coneId) !== conversationId) runtime.withdrawCone(coneId, 'stale');
    }
    for (const coneId of next.frozen) runtime.withdrawCone(coneId, 'stale');
    prior = next;
  };
  const off = agents.onChange(react);
  const offCone = agents.onCone(() => {
    react(agents.state());
  });
  let seatsOff: () => void = () => undefined;
  const harness = host.harness();
  if (harness)
    void harness.watchDoc(GuestsDoc, BACKGROUND_CONTEXT).then((watch) => {
      if (!watch) return;
      const react = () => {
        const at = host.now();
        const seats = watch.value.seats;
        const state = host.agents()?.state();
        if (!state) return;
        for (const coneId of Object.keys(state.cones))
          if (liveSeatsOnCone(seats, coneId, at)) runtime.withdrawCone(coneId, 'stale');
      };
      watch.start(async () => {
        react();
      });
      react();
      seatsOff = () => {
        void watch.stop();
      };
    });
  return () => {
    off();
    offCone();
    seatsOff();
  };
}

function snapshot(state: Readonly<AgentsState>) {
  return {
    cones: new Map(
      Object.entries(state.cones).map(([id, cone]) => [id, cone.conversation] as const)
    ),
    frozen: new Set(Object.values(state.frozen ?? {}).map((record) => record.cone)),
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
  now: number
): Promise<{ coneId: string; conversationId: number } | { refuse: string }> {
  if (!runtime?.open) return { refuse: REFUSALS.unavailable };
  if (await gatedRun(api, context)) return { refuse: REFUSALS.gated };
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
