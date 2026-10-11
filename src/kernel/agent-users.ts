import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Agents } from '../agents.ts';
import { FIRST_CONE } from '../agents.ts';
import type { GelatiereAttach } from '../gelatiere/index.ts';
import { AGENT_DIR, type Layout, ROOT_HOME, ROOT_USER, SESSIONS, usersLayout } from '../layout.ts';
import type { LickDir } from '../licks/sources.ts';
import type { Spools } from '../scoops/index.ts';
import type { SkillPeople } from '../skills/index.ts';
import type { SprinklePlace } from '../sprinkles/index.ts';
import {
  type Accounts,
  CONE_PREFIX,
  createAccounts,
  homeOf,
  type UsersMode,
  wanted,
} from './accounts.ts';
import type { KernelClient } from './client.ts';
import { type EnvRoute, type EnvTargetLike, HOME, quote, SliccKernelEnv } from './env.ts';
import type { UserClients } from './users.ts';

export interface AgentUsers {
  readonly accounts: Accounts;
  readonly layout: Layout;
  readonly spools: Spools;
  readonly enforced: boolean;
  readonly people: SkillPeople;
  follow(
    runtimes: readonly {
      reload?(context: Context): Promise<void>;
      reconcile?(context: Context): Promise<void>;
    }[]
  ): void;
  lickDirs(): Promise<LickDir[]>;
  sprinklePlaces(): SprinklePlace[];
  envOfAgent(agentId: string): Promise<SliccKernelEnv | undefined>;
  gelatiere(root: SliccKernelEnv): Promise<Partial<GelatiereAttach>>;
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
  const homes = () => wanted(state()).map((entry) => homeOf(entry.spec.name));
  const listeners = new Set<() => void>();
  let known = '';
  const changed = () => {
    const key = homes().join('\n');
    if (key === known) return;
    known = key;
    for (const listener of listeners) listener();
  };
  return {
    accounts,
    layout,
    enforced: mode === 'enforce',
    people: {
      homes,
      homeOf(conversationId) {
        const agentId = accounts.agentOf(conversationId);
        return agentId ? accounts.home(agentId) : undefined;
      },
    },
    sprinklePlaces() {
      return wanted(state())
        .filter((entry) => !entry.cone)
        .map((entry) => ({ dir: `${homeOf(entry.spec.name)}/sprinkles`, cone: entry.spec.name }));
    },
    async envOfAgent(agentId) {
      const home = accounts.home(agentId);
      return home ? envOf(agentId, home).catch(() => undefined) : undefined;
    },
    async gelatiere(root) {
      const first = `${CONE_PREFIX}${FIRST_CONE}`;
      const files = await this.envOfAgent(first);
      return {
        home: homeOf(FIRST_CONE),
        profile: HOME,
        ...(files ? { files } : {}),
        as: async (caller) => {
          const env = caller ? await this.envOfAgent(caller) : undefined;
          const home = caller ? accounts.home(caller) : undefined;
          return env && home ? { env, home } : { env: root, home: ROOT_HOME };
        },
      };
    },
    async lickDirs() {
      const cones = wanted(state()).filter((entry) => !entry.cone);
      const out: LickDir[] = [{ dir: `${ROOT_HOME}/.slicc`, home: ROOT_HOME, cone: null }];
      for (const entry of cones) {
        const home = homeOf(entry.spec.name);
        const env = await envOf(entry.agentId, home).catch(() => undefined);
        out.push({ dir: `${home}/.slicc`, home, cone: entry.spec.name, ...(env ? { env } : {}) });
      }
      return out;
    },
    follow(runtimes) {
      listeners.add(() => {
        for (const runtime of runtimes)
          void (runtime.reconcile ?? runtime.reload)
            ?.call(runtime, BACKGROUND_CONTEXT)
            .catch(() => undefined);
      });
    },
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
        `mkdir -p ${SESSIONS.tmp} ${AGENT_DIR} && chmod 1777 ${SESSIONS.tmp} && chmod 755 ${AGENT_DIR}`,
        undefined,
        BACKGROUND_CONTEXT
      );
      await accounts.boot();
      known = homes().join('\n');
      off = opened.onChange(() => {
        void accounts.reconcile();
        changed();
      });
      ready();
    },
    close() {
      off();
    },
  };
}
