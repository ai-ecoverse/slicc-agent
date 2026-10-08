import { type Context, type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import type { ConversationView, Harness, SubmissionId } from '@earendil-works/pi-durable';
import type { Delivered } from './services.ts';
import { isBusy } from './spectrum/messages.ts';

export interface Deliveries {
  readonly state: MutableReplicatedState<Record<string, Delivered>>;
  classify(whenBusy: 'steer' | 'followUp' | 'reject' | undefined): Delivered;
  expect(submissionId: SubmissionId, delivered: Delivered): void;
  settle(): Promise<void>;
  dispose(): void;
}

export function trackDeliveries(
  harness: Pick<Harness, 'submission'>,
  view: {
    readonly value: ConversationView | undefined;
    subscribe(listener: () => void): () => void;
  },
  context: Context
): Deliveries {
  const state = replicatedState<Record<string, Delivered>>({});
  const pending = new Map<SubmissionId, Delivered>();
  const settle = async () => {
    for (const [id, delivered] of [...pending]) {
      const record = await (await harness.submission(id, context))?.status(context);
      if (record?.status === 'queued') continue;
      pending.delete(id);
      const entry = record && 'entry' in record ? record.entry : undefined;
      if (entry !== undefined) {
        state.change(context, (draft) => {
          draft[String(entry)] = delivered;
        });
      }
    }
  };
  const off = view.subscribe(() => void settle().catch(() => undefined));
  return {
    state,
    classify(whenBusy) {
      if (!isBusy(view.value)) return 'run';
      return whenBusy === 'followUp' ? 'follow-up' : 'steer';
    },
    expect(submissionId, delivered) {
      pending.set(submissionId, delivered);
      void settle().catch(() => undefined);
    },
    settle,
    dispose: off,
  };
}
