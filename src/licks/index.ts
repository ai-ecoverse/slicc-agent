import type { Context } from '@earendil-works/chord';
import type { Conversation, ConversationId, Harness, Registry } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { Activity } from '../kernel/activity.ts';
import { cronTask, licksExtension } from './extension.ts';
import type { LickChannel, LickTarget } from './lick.ts';
import { createLicks, type Licks, type LicksHost } from './licks.ts';
import { createLickSources, type LickSources } from './sources.ts';

export interface LicksAgent {
  harness: Harness;
  root: Conversation;
  agents: Agents;
  cone(): Conversation;
}

const UNTRUSTED = new Set<LickChannel>(['webhook']);

export function lickResolver(agent: LicksAgent) {
  return async (target: LickTarget, channel: LickChannel, context: Context) => {
    const cone = agent.cone();
    if (target === 'cone') return cone;
    if (target.startsWith('cone:'))
      return (await agent.agents.conversation(target.slice('cone:'.length), context)) ?? cone;
    if (UNTRUSTED.has(channel)) return cone;
    const scoop = agent.agents.state().scoops[target];
    if (!scoop || !live(scoop)) return cone;
    return (await agent.agents.conversation(target, context)) ?? cone;
  };
}

export interface LicksSetup {
  licks: Licks;
  attach(
    agent: LicksAgent,
    options: {
      env: ExecutionEnv;
      home: string;
      now?: () => number;
      flushEvery?: number;
      activity?: Activity;
    }
  ): LickSources;
}

export function setupLicks(registry: Registry): LicksSetup {
  let bind: (host: LicksHost) => void = () => undefined;
  const host = new Promise<LicksHost>((resolve) => {
    bind = resolve;
  });
  const licks = createLicks(host);
  const cron = cronTask(licks);
  const lookup = async (id: ConversationId, context: Context) => {
    const found = await (await host).harness.conversation(id, context);
    if (!found) throw new Error(`conversation ${id} is gone`);
    return found;
  };
  registry.install(licksExtension(licks, lookup, cron));
  return {
    licks,
    attach(agent, options) {
      const { harness, root } = agent;
      bind({ harness, resolve: lickResolver(agent) });
      return createLickSources({
        ...options,
        harness,
        root,
        cone: () => agent.cone(),
        licks,
        cron,
      });
    },
  };
}

export type { Lick, LickChannel } from './lick.ts';
export type { LickEvent, Licks } from './licks.ts';
export type { LickSources, WebhookDelivery } from './sources.ts';
