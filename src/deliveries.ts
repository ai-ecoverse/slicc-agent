import { type Context, type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import type { ConversationView, Harness, SubmissionId } from '@earendil-works/pi-durable';
import type { Delivered } from './services.ts';

type WhenBusy = 'steer' | 'followUp' | 'reject' | undefined;

export interface Deliveries {
  readonly state: MutableReplicatedState<Record<string, Delivered>>;
  expect(submissionId: SubmissionId, whenBusy: WhenBusy): void;
  settle(): Promise<void>;
  dispose(): void;
}

export function delivery(
  view: ConversationView | undefined,
  entry: number,
  whenBusy: WhenBusy,
  queued: boolean
): Delivered | undefined {
  const entries = view?.entries ?? [];
  const at = entries.findIndex((candidate) => Number(candidate.id) === entry);
  if (at < 0) return undefined;
  if (entries[at - 1]?.kind === 'pi.tool-result') return 'steer';
  if (!queued) return 'run';
  return whenBusy === 'followUp' ? 'follow-up' : 'steer';
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
  const pending = new Map<SubmissionId, { whenBusy: WhenBusy; queued: boolean }>();
  const settle = async () => {
    for (const [id, item] of [...pending]) {
      const record = await (await harness.submission(id, context))?.status(context);
      if (record?.status === 'queued') {
        item.queued = true;
        continue;
      }
      const entry = record && 'entry' in record ? record.entry : undefined;
      if (entry === undefined) {
        pending.delete(id);
        continue;
      }
      const delivered = delivery(view.value, Number(entry), item.whenBusy, item.queued);
      if (!delivered) continue;
      pending.delete(id);
      state.change(context, (draft) => {
        draft[String(entry)] = delivered;
      });
    }
  };
  const off = view.subscribe(() => void settle().catch(() => undefined));
  return {
    state,
    expect(submissionId, whenBusy) {
      pending.set(submissionId, { whenBusy, queued: false });
      void settle().catch(() => undefined);
    },
    settle,
    dispose: off,
  };
}
