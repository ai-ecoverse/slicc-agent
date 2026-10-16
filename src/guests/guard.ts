import {
  defineExtension,
  type Extension,
  type Harness,
  hook,
  LiveDoc,
  ToolTask,
} from '@earendil-works/pi-durable';

export const GUEST_GUARD = 'slicc-guest-guard';
export const GUEST_REQUEST = 'guest:';
export const GUEST_TOOLS_BLOCKED =
  "Tool calls in a run a guest started need a review, which this agent can't do yet.";

export function guestGuard(harness: () => Pick<Harness, 'submission'> | undefined): Extension {
  return defineExtension({
    name: GUEST_GUARD,
    hooks: [
      hook(ToolTask, {
        async beforeTool(_call, api, context) {
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          const inputs = live?.run?.inputs ?? [];
          if (!inputs.length) return undefined;
          const held = harness();
          if (!held) return { block: GUEST_TOOLS_BLOCKED };
          for (const id of inputs) {
            const submission = await held.submission(id, context);
            const record = submission ? await submission.status(context) : undefined;
            if (record?.requestId?.startsWith(GUEST_REQUEST)) return { block: GUEST_TOOLS_BLOCKED };
          }
          return undefined;
        },
      }),
    ],
  });
}
