import {
  INVENTORY_STATUSES,
  type InventorySnapshot,
  type InventoryState,
  type InventoryStatus,
} from '../services.ts';

export function narrowInventory(state: InventoryState, cone: string | null): InventorySnapshot {
  const known = (id: string | null) =>
    id !== null && state.agents.some((row) => row.kind === 'cone' && row.id === id);
  const home = known(cone) ? cone : state.active;
  const agents = state.agents
    .filter((row) => row.cone === home)
    .map(({ cone: _, ...agent }) => agent);
  const counts = Object.fromEntries(INVENTORY_STATUSES.map((status) => [status, 0])) as Record<
    InventoryStatus,
    number
  >;
  for (const agent of agents) counts[agent.status] += 1;
  return { seq: state.seq, changedAt: state.changedAt, counts, agents };
}
