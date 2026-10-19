import type { Context } from '@earendil-works/chord';
import type { Models } from '@earendil-works/pi-ai/models';
import type { Conversation, ConversationId, Harness, Registry } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { Activity } from '../kernel/activity.ts';
import type { Jobs } from '../kernel/jobs.ts';
import { licksExtension } from './extension.ts';
import type { LickChannel, LickTarget } from './lick.ts';
import { createLicks, type Licks, type LicksHost } from './licks.ts';
import { createLickSources, type LickDir, type LickSources } from './sources.ts';

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

export function modelReady(models: Pick<Models, 'getModel'>) {
  return async (conversation: Conversation, context: Context) => {
    const { model } = await conversation.agent(context);
    return model !== undefined && models.getModel(model.provider, model.modelId) !== undefined;
  };
}

export interface LicksSetup {
  licks: Licks;
  attach(
    agent: LicksAgent,
    options: {
      env: ExecutionEnv;
      home: string;
      models?: Pick<Models, 'getModel'>;
      flushEvery?: number;
      activity?: Activity;
      jobs?: Jobs;
      dirs?: () => Promise<readonly LickDir[]>;
      cronUser?: (target: LickTarget, place: LickDir) => string | undefined;
    }
  ): LickSources;
}

export function setupLicks(registry: Registry, fetcher?: typeof fetch): LicksSetup {
  let bind: (host: LicksHost) => void = () => undefined;
  const host = new Promise<LicksHost>((resolve) => {
    bind = resolve;
  });
  const licks = createLicks(host);
  const lookup = async (id: ConversationId, context: Context) => {
    const found = await (await host).harness.conversation(id, context);
    if (!found) throw new Error(`conversation ${id} is gone`);
    return found;
  };
  registry.install(licksExtension(licks, lookup));
  return {
    licks,
    attach(agent, { models, ...options }) {
      const { harness, root } = agent;
      bind({
        harness,
        resolve: lickResolver(agent),
        ...(models ? { runnable: modelReady(models) } : {}),
      });
      return createLickSources({
        ...options,
        harness,
        root,
        cone: () => agent.cone(),
        licks,
        ...(fetcher ? { fetch: fetcher } : {}),
      });
    },
  };
}

export type { Lick, LickChannel } from './lick.ts';
export type { LickEvent, Licks } from './licks.ts';
export type { LickSources, WebhookDelivery } from './sources.ts';
