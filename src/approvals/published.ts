import { type ReplicatedState, replicatedState } from '@earendil-works/chord';
import type { Approval } from './record.ts';

function stripped(item: Approval, view: boolean): Approval {
  if (item.kind !== 'sudo') return item;
  const { replay: _replay, ...rest } = item;
  if (!view || !rest.run) return rest;
  const { stdout: _stdout, stderr: _stderr, ...run } = rest.run;
  return { ...rest, run };
}

export function publishedApprovals(
  state: ReplicatedState<Approval[]>,
  view: boolean
): ReplicatedState<Approval[]> {
  const shown = (items: readonly Approval[] | undefined) =>
    (items ?? []).map((item) => stripped(item, view));
  const out = replicatedState<Approval[]>(shown(state.value));
  state.subscribe((items, context) => out.replace(context, shown(items)));
  return out;
}
