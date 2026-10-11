import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { AgentsState } from './agents.ts';
import { CONE_PREFIX, homeOf, SCOOP_USER, scoopUser } from './kernel/accounts.ts';
import { quote } from './kernel/env.ts';

export const SCOOPS_ROOT = '/scoops';
export const SESSIONS = { tmp: '/tmp/agent-sessions', durable: '/home/sessions' };
export const ROOT_USER = 'root';
export const AGENT_DIR = '/etc/slicc/agent';

export type Persist = 'tmp' | 'durable';

export interface Layout {
  readonly users: boolean;
  scoopRoot(folder: string): string;
  workspace(folder: string): string;
  reports(folder: string, cone: string): string;
  sessions(persist: Persist, user: string | null): string;
  homeOf(user: string | null): string;
  envFor(user: string | null, context: Context): Promise<ExecutionEnv | undefined>;
  ownDir(path: string, user: string | null, context: Context): Promise<void>;
}

export const LEGACY: Layout = {
  users: false,
  scoopRoot: (folder) => `${SCOOPS_ROOT}/${folder}`,
  workspace: (folder) => `${SCOOPS_ROOT}/${folder}/workspace`,
  reports: (folder) => `${SCOOPS_ROOT}/${folder}/reports`,
  sessions: (persist) => SESSIONS[persist],
  homeOf: () => '/home',
  envFor: async () => undefined,
  ownDir: async () => undefined,
};

export function agentOfUser(state: Readonly<AgentsState>, user: string): string | undefined {
  if (user.startsWith(SCOOP_USER)) {
    const folder = user.slice(SCOOP_USER.length);
    return Object.entries(state.scoops).find(([, record]) => record.folder === folder)?.[0];
  }
  return state.cones[user] || Object.values(state.frozen ?? {}).some((f) => f.cone === user)
    ? `${CONE_PREFIX}${user}`
    : undefined;
}

export function usersLayout(
  state: () => Readonly<AgentsState>,
  envOf: (agentId: string, home: string) => Promise<ExecutionEnv>,
  root: Pick<ExecutionEnv, 'exec'>
): Layout {
  const homeOfUser = (user: string | null) => (user && user !== ROOT_USER ? homeOf(user) : '/root');
  return {
    users: true,
    scoopRoot: (folder) => homeOf(scoopUser(folder)),
    workspace: (folder) => homeOf(scoopUser(folder)),
    reports: (folder, cone) => `${homeOf(cone)}/.slicc/reports/${folder}`,
    sessions: (persist, user) =>
      persist === 'tmp' ? `${SESSIONS.tmp}/${user ?? ROOT_USER}` : `${homeOfUser(user)}/sessions`,
    homeOf: homeOfUser,
    async ownDir(path, user, context) {
      if (!user || user === ROOT_USER) return;
      const dir = quote(path);
      await root.exec(
        `mkdir -p ${dir} && chown ${quote(user)} ${dir} && chmod 700 ${dir}`,
        undefined,
        context
      );
    },
    async envFor(user) {
      if (!user || user === ROOT_USER) return undefined;
      const agentId = agentOfUser(state(), user);
      return agentId ? envOf(agentId, homeOf(user)) : undefined;
    },
  };
}
