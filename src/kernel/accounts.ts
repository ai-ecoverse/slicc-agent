import type { Agents, AgentsState } from '../agents.ts';
import { callerOf } from '../scoops/identity.ts';
import type { KernelClient } from './client.ts';
import type { KernelGroups, UserClients, UserSpec } from './users.ts';

export type UsersMode = 'off' | 'report' | 'enforce';

export const SCOOP_UMASK = 0o027;
export const CONE_UMASK = 0o077;
export const CONE_HOME_MODE = 0o710;
export const SCOOP_HOME_MODE = 0o2750;
export const SUDO_GROUP = 'sudo';
export const CONE_PREFIX = 'cone:';
export const SCOOP_USER = 'scoop-';

export function scoopUser(folder: string): string {
  return `${SCOOP_USER}${folder}`;
}

export function homeOf(user: string): string {
  return `/home/${user}`;
}

export function userOf(state: Readonly<AgentsState>, agentId: string): string | undefined {
  if (agentId.startsWith(CONE_PREFIX)) return agentId.slice(CONE_PREFIX.length);
  const record = state.scoops[agentId];
  return record ? scoopUser(record.folder) : undefined;
}

export type Wanted = { agentId: string; cone: string | null; spec: UserSpec };

export function wanted(state: Readonly<AgentsState>): Wanted[] {
  const cones = new Set([
    ...Object.keys(state.cones),
    ...Object.values(state.frozen ?? {}).map((frozen) => frozen.cone),
  ]);
  const out: Wanted[] = [...cones].map((cone) => ({
    agentId: `${CONE_PREFIX}${cone}`,
    cone: null,
    spec: { name: cone, groups: [SUDO_GROUP], homeMode: CONE_HOME_MODE, umask: CONE_UMASK },
  }));
  for (const [id, record] of Object.entries(state.scoops)) {
    if (record.gone || record.removed || record.dropped !== null) continue;
    out.push({
      agentId: id,
      cone: `${CONE_PREFIX}${record.cone}`,
      spec: {
        name: scoopUser(record.folder),
        groups: [record.cone],
        homeGroup: record.cone,
        homeMode: SCOOP_HOME_MODE,
        umask: SCOOP_UMASK,
      },
    });
  }
  return out;
}

export interface Accounts {
  readonly mode: UsersMode;
  agentOf(conversation: number | undefined): string | undefined;
  home(agentId: string): string | undefined;
  client(agentId: string): Promise<KernelClient>;
  reconcile(): Promise<void>;
  boot(): Promise<void>;
}

export function createAccounts(
  pool: UserClients,
  agents: () => Agents | undefined,
  mode: UsersMode = 'off',
  groups?: KernelGroups
): Accounts {
  const added = new Map<string, { name: string; group: string | null; ready: Promise<void> }>();
  let chain: Promise<void> = Promise.resolve();
  const state = (): Readonly<AgentsState> =>
    agents()?.state() ?? { cones: {}, active: 'cone', next: 2, scoops: {} };
  const groupOf = (want: Wanted) => (want.cone ? want.cone.slice(CONE_PREFIX.length) : null);
  const moved = async (want: Wanted, from: string) => {
    await groups?.removeMember(from, want.spec.name).catch(() => undefined);
    await pool.drop(want.agentId);
  };
  const ensure = (want: Wanted): Promise<void> => {
    const known = added.get(want.agentId);
    const group = groupOf(want);
    if (known?.name === want.spec.name && known.group === group) return known.ready;
    const parent = want.cone
      ? wanted(state()).find((cone) => cone.agentId === want.cone)
      : undefined;
    const before = known?.group && known.group !== group ? moved(want, known.group) : undefined;
    const ready = Promise.all([parent ? ensure(parent) : undefined, before])
      .then(() => pool.users.add(want.spec))
      .then(() => undefined);
    added.set(want.agentId, { name: want.spec.name, group, ready });
    ready.catch(() => {
      if (added.get(want.agentId)?.ready === ready) added.delete(want.agentId);
    });
    return ready;
  };
  const retire = async (agentId: string, name: string) => {
    added.delete(agentId);
    await pool.drop(agentId);
    await pool.users.remove(name).catch(() => false);
  };
  const reconcile = async (stale: readonly string[] = []) => {
    const want = wanted(state());
    const names = new Set(want.map((entry) => entry.agentId));
    for (const entry of want) await ensure(entry).catch(() => undefined);
    const gone = [...added].filter(([agentId]) => !names.has(agentId));
    const scoopsFirst = gone.sort(
      ([a], [b]) => Number(a.startsWith(CONE_PREFIX)) - Number(b.startsWith(CONE_PREFIX))
    );
    for (const [agentId, entry] of scoopsFirst) await retire(agentId, entry.name);
    for (const name of stale) await pool.users.remove(name).catch(() => false);
  };
  const queue = (run: () => Promise<void>) => {
    chain = chain.then(run, run);
    return chain;
  };
  const home = (agentId: string) => {
    const user = userOf(state(), agentId);
    return user === undefined ? undefined : homeOf(user);
  };
  return {
    mode,
    agentOf(conversation) {
      const current = agents();
      return (
        callerOf(current, conversation) ??
        (current ? `${CONE_PREFIX}${current.activeCone()}` : undefined)
      );
    },
    home,
    async client(agentId) {
      const want = wanted(state()).find((entry) => entry.agentId === agentId);
      if (!want)
        throw Object.assign(new Error(`${agentId} has no kernel user`), { code: 'ENOENT' });
      await ensure(want);
      return pool.client(agentId, want.spec.name);
    },
    reconcile: () => queue(() => reconcile()),
    boot: () =>
      queue(async () => {
        const known = new Set(
          Object.values(state().scoops).map((record) => scoopUser(record.folder))
        );
        const keep = new Set(wanted(state()).map((entry) => entry.spec.name));
        const listed = await pool.users.list().catch(() => []);
        const stale = listed
          .map((user) => user.name)
          .filter((name) => known.has(name) && !keep.has(name));
        await reconcile(stale);
      }),
  };
}
