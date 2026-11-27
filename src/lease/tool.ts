import type { Context } from '@earendil-works/chord/context';
import {
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  section,
  type ToolRegistration,
  ToolTask,
} from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';
import { AgentsDoc } from '../agents.ts';
import { GuestsDoc } from '../guests/seats.ts';
import { checkReason, checkUrl, REFUSALS, sentText } from './check.ts';
import { eligibility, type LeaseRuntime, taintedConversation } from './runtime.ts';

export const LEASE_TOOL = 'lease_propose';
export const LEASE_MEMO = 'slicc.lease-propose';
export const LEASE_SECTION =
  'lease_propose asks the owner to let a browser job read one page; it only proposes, returns no page content and reports no status.';

type Memo = { life: string; text: string };

export type LeaseHold = () => Promise<void>;

export type LeaseToolHost = {
  runtime: () => LeaseRuntime | undefined;
  harness: () => Harness | undefined;
  now: () => number;
  hold?: LeaseHold;
  holdAt?: 'published' | 'reserve';
};

type ToolApi = {
  conversationId: Parameters<typeof taintedConversation>[1];
  memo: {
    <T>(name: string, context: Context): Promise<T | undefined>;
    <T>(name: string, candidate: T, context: Context): Promise<T>;
  };
  snapshot: Harness['snapshot'];
};

function answered(text: string) {
  return { output: [{ type: 'text' as const, text }] };
}

async function remember(
  api: ToolApi,
  runtime: LeaseRuntime | undefined,
  text: string,
  context: Context
) {
  await api.memo(LEASE_MEMO, { life: runtime?.life ?? '', text }, context);
  return answered(text);
}

async function snapshotSeats(api: ToolApi, context: Context) {
  const state = await api.snapshot(AgentsDoc, context);
  const seats = (await api.snapshot(GuestsDoc, context))?.seats ?? {};
  return { state, seats };
}

async function publishPath(
  host: LeaseToolHost,
  runtime: LeaseRuntime,
  api: ToolApi,
  coneId: string,
  proposal: number,
  url: string,
  reason: string,
  context: Context
) {
  if (host.hold && host.holdAt === 'reserve') await host.hold();
  const at = host.now();
  const { state, seats } = await snapshotSeats(api, context);
  if (state) runtime.revalidate(state, seats, at);
  if (!runtime.reserved(coneId)) return remember(api, runtime, REFUSALS.unavailable, context);
  const text = sentText(proposal);
  await api.memo(LEASE_MEMO, { life: runtime.life, text }, context);
  const again = await snapshotSeats(api, context);
  if (again.state) runtime.revalidate(again.state, again.seats, host.now());
  if (!runtime.reserved(coneId) || !runtime.publish(coneId, url, reason))
    return answered(REFUSALS.unavailable);
  if (host.hold && host.holdAt !== 'reserve') await host.hold();
  return answered(text);
}

export function leaseProposeTool(host: LeaseToolHost): ToolRegistration {
  return defineTool({
    name: LEASE_TOOL,
    description:
      'Ask the owner to let a browser job read one https page. Only proposes; returns no status and no page content.',
    parameters: obj({
      url: str({ description: 'The https URL to read, with no query or fragment.' }),
      reason: str({ description: 'Why the page is needed, in plain text.' }),
    }),
    replay: 'safe',
    async execute(args, api, context: Context) {
      const runtime = host.runtime();
      const prior = await api.memo<Memo>(LEASE_MEMO, context);
      if (prior) {
        if (!runtime || prior.life !== runtime.life) return answered(REFUSALS.restarted);
        return answered(prior.text);
      }
      const refused = checkUrl(args.url) ?? checkReason(args.reason);
      if (refused) return remember(api, runtime, refused, context);
      const ready = await eligibility(api, context, runtime, host.now(), host.harness());
      if ('refuse' in ready) return remember(api, runtime, ready.refuse, context);
      if (!runtime) return remember(api, runtime, REFUSALS.unavailable, context);
      const reserved = runtime.reserve(ready.coneId, ready.conversationId, host.now());
      if ('refuse' in reserved) return remember(api, runtime, reserved.refuse, context);
      try {
        return await publishPath(
          host,
          runtime,
          api,
          ready.coneId,
          reserved.proposal,
          args.url,
          args.reason,
          context
        );
      } catch (error) {
        runtime.abandon(ready.coneId);
        throw error;
      }
    },
  });
}

export function leaseExtension(host: LeaseToolHost): Extension {
  return defineExtension({
    name: 'slicc-lease',
    tools: [leaseProposeTool(host)],
    sections: [section('lease', () => LEASE_SECTION)],
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(_request, api, context) {
          await staleIfTainted(host, api.conversationId, context);
          return undefined;
        },
      }),
      hook(ToolTask, {
        async beforeTool(_call, api, context) {
          await staleIfTainted(host, api.conversationId, context);
          return undefined;
        },
      }),
    ],
  });
}

async function staleIfTainted(
  host: LeaseToolHost,
  conversationId: Parameters<typeof taintedConversation>[1],
  context: Context
) {
  const harness = host.harness();
  const runtime = host.runtime();
  if (!harness || !runtime) return;
  if (!runtime.waiting(Number(conversationId))) return;
  if (!(await taintedConversation(harness, conversationId, context))) return;
  const state = await harness.snapshot(AgentsDoc, context);
  if (!state) return;
  for (const [coneId, cone] of Object.entries(state.cones))
    if (cone.conversation === Number(conversationId)) runtime.withdrawCone(coneId, 'stale');
}
