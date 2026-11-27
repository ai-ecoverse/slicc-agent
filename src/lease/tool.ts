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
import { checkReason, checkUrl, REFUSALS, sentText } from './check.ts';
import { eligibility, type LeaseRuntime, taintedConversation } from './runtime.ts';

export const LEASE_TOOL = 'lease_propose';
export const LEASE_MEMO = 'slicc.lease-propose';
export const LEASE_SECTION =
  'lease_propose asks the owner to let a browser job read one page; it only proposes, returns no page content and reports no status.';

type Memo = { epoch: string; text: string };

export type LeaseHold = () => Promise<void>;

export type LeaseToolHost = {
  runtime: () => LeaseRuntime | undefined;
  harness: () => Harness | undefined;
  now: () => number;
  hold?: LeaseHold;
};

function answered(text: string) {
  return { output: [{ type: 'text' as const, text }] };
}

async function remember(
  api: { memo: (name: string, value: Memo, context: Context) => Promise<Memo> },
  runtime: LeaseRuntime | undefined,
  text: string,
  context: Context
) {
  await api.memo(LEASE_MEMO, { epoch: runtime?.epoch ?? '', text }, context);
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
    replay: 'unsafe',
    async execute(args, api, context: Context) {
      const runtime = host.runtime();
      const prior = await api.memo<Memo>(LEASE_MEMO, context);
      if (prior) {
        if (!runtime || prior.epoch !== runtime.epoch) return answered(REFUSALS.restarted);
        return answered(prior.text);
      }
      const refused = checkUrl(args.url) ?? checkReason(args.reason);
      if (refused) return remember(api, runtime, refused, context);
      const ready = await eligibility(api, context, runtime, host.now());
      if ('refuse' in ready) return remember(api, runtime, ready.refuse, context);
      const published = runtime?.propose(
        ready.coneId,
        ready.conversationId,
        args.url,
        args.reason,
        host.now()
      );
      if (!published || 'refuse' in published) {
        const text = published && 'refuse' in published ? published.refuse : REFUSALS.unavailable;
        return remember(api, runtime, text, context);
      }
      const text = sentText(published.proposal);
      await api.memo(LEASE_MEMO, { epoch: runtime?.epoch ?? '', text }, context);
      if (host.hold) await host.hold();
      return answered(text);
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
  if (!(await taintedConversation(harness, conversationId, context))) return;
  const state = await harness.snapshot(AgentsDoc, context);
  if (!state) return;
  for (const [coneId, cone] of Object.entries(state.cones))
    if (cone.conversation === Number(conversationId)) runtime.withdrawCone(coneId, 'stale');
}
