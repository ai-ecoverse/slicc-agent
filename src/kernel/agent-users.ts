import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Agents } from '../agents.ts';
import { type Layout, ROOT_USER, SESSIONS, usersLayout } from '../layout.ts';
import type { Spools } from '../scoops/index.ts';
import { type Accounts, createAccounts, type UsersMode, wanted } from './accounts.ts';
import type { KernelClient } from './client.ts';
import { type EnvRoute, type EnvTargetLike, quote, SliccKernelEnv } from './env.ts';
import type { UserClients } from './users.ts';

export interface AgentUsers {
  readonly accounts: Accounts;
  readonly layout: Layout;
  readonly spools: Spools;
  readonly enforced: boolean;
  route(target: EnvTargetLike): Promise<EnvRoute | undefined>;
  start(agents: Agents): Promise<void>;
  close(): void;
}

export function modeOf(client: KernelClient): UsersMode {
  const mode = (client as { users?: unknown }).users;
  return mode === 'report' || mode === 'enforce' ? mode : 'off';
}

export function spoolScript(user: string, dir: string): string {
  const at = quote(dir);
  const made = `mkdir -p ${at}/in ${at}/out`;
  if (user === ROOT_USER) return made;
  return `${made} && chown -R ${quote(`${user}:${user}`)} ${at} && chmod 700 ${at} ${at}/in ${at}/out`;
}

export function agentUsers(
  pool: UserClients,
  client: KernelClient,
  root: SliccKernelEnv,
  agents: () => Agents | undefined
): AgentUsers {
  const mode = modeOf(client);
  const accounts = createAccounts(pool, agents, mode, pool.groups);
  const state = () => agents()?.state() ?? { cones: {}, active: 'cone', next: 2, scoops: {} };
  const envOf = async (agentId: string, home: string) =>
    new SliccKernelEnv(await accounts.client(agentId), { cwd: home });
  const layout = usersLayout(state, envOf, root);
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let off: () => void = () => undefined;
  return {
    accounts,
    layout,
    enforced: mode === 'enforce',
    spools: {
      users: () => [ROOT_USER, ...wanted(state()).map((entry) => entry.spec.name)],
      async prepare(user, dir, context) {
        await root.exec(spoolScript(user, dir), undefined, context);
      },
    },
    async route(target) {
      await started;
      const agentId = accounts.agentOf(target.conversationId);
      const home = agentId ? accounts.home(agentId) : undefined;
      if (!agentId || !home) return undefined;
      return { client: await accounts.client(agentId), home };
    },
    async start(opened) {
      await root.exec(
        `mkdir -p ${SESSIONS.tmp} && chmod 1777 ${SESSIONS.tmp}`,
        undefined,
        BACKGROUND_CONTEXT
      );
      await accounts.boot();
      off = opened.onChange(() => void accounts.reconcile());
      ready();
    },
    close() {
      off();
    },
  };
}
