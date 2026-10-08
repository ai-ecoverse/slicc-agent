import type { Context } from '@earendil-works/chord';
import type { Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { ProcessGroups } from '../kernel/groups.ts';
import type { Licks } from '../licks/licks.ts';
import { DEFAULT_LIMITS, loadRoles, packageDirs, type Roles } from '../roles/roles.ts';
import { createCli, RUN_DIR } from './cli.ts';
import { guardExtension, scoopsExtension, scoopTasks } from './extension.ts';
import { type ControlPlane, controlPlane } from './requests.ts';
import { createScoops, type Scoops, type ScoopsHost } from './service.ts';

export const BUILTIN_ROLES = ['scout', 'worker', 'reviewer', 'oracle', 'delegate'];
export const PNPM_HOME = '/home/.local/share/pnpm';

export type Assets = (path: string) => Promise<string>;

export function packageAssets(base: URL = new URL('../../', import.meta.url)): Assets {
  return async (path) => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.text();
  };
}

export interface AttachOptions {
  harness: Harness;
  agents: Agents;
  groups?: ProcessGroups;
  env: ExecutionEnv;
  home: string;
  assets?: Assets;
  pnpmHome?: string;
  controlDir?: string;
  sweepEvery?: number;
  alive?: (pid: number) => Promise<boolean>;
}

export interface ScoopsRuntime {
  roles(context: Context): Promise<Roles>;
  plane: ControlPlane;
  close(context: Context): Promise<void>;
}

export interface ScoopsSetup {
  scoops: Scoops;
  attach(options: AttachOptions, context: Context): Promise<ScoopsRuntime>;
}

export const COMMANDS = ['agent', 'subagent'];

async function install(env: ExecutionEnv, script: string, pnpmHome: string, context: Context) {
  await env.createDir(`${pnpmHome}/bin`, { recursive: true }, context);
  for (const name of COMMANDS) {
    const path = `${pnpmHome}/bin/${name}`;
    await env.writeFile(path, script, context);
    await env.exec(['chmod', '+x', path], undefined, context);
  }
}

function mirror(agents: Agents, env: ExecutionEnv) {
  return async (context: Context) => {
    for (const [id, record] of Object.entries(agents.state().scoops)) {
      const state = record.gone ? 'gone' : live(record) ? 'live' : 'stopped';
      const metadata = {
        handle: record.folder,
        id,
        name: record.name,
        role: record.role,
        cone: record.cone,
        state,
      };
      await env.writeFile(
        `${RUN_DIR}/${record.folder}/metadata.json`,
        `${JSON.stringify(metadata, null, 2)}\n`,
        context
      );
    }
  };
}

export function setupScoops(
  registry: Registry,
  licks: Licks,
  fileTools: readonly ToolRegistration[] = []
): ScoopsSetup {
  let bind: (host: ScoopsHost) => void = () => undefined;
  const host = new Promise<ScoopsHost>((resolve) => {
    bind = resolve;
  });
  const lookup = () => host;
  const tasks = scoopTasks(lookup);
  const scoops = createScoops(host, () => tasks);
  let cached: Roles = { roles: [], warnings: [], limits: { ...DEFAULT_LIMITS } };
  registry.install(scoopsExtension(tasks));
  registry.install(guardExtension(lookup, fileTools));
  return {
    scoops,
    async attach(options, context) {
      const { harness, agents, groups, env, home } = options;
      const assets = options.assets ?? packageAssets();
      bind({ harness, agents, licks, tools: fileTools, ...(groups ? { groups } : {}) });
      const builtin = async () => {
        const out: { path: string; text: string }[] = [];
        for (const name of BUILTIN_ROLES) {
          const path = `packages/vfs-root/agents/${name}.md`;
          out.push({ path: `builtin:${name}`, text: await assets(path) });
        }
        return out;
      };
      const roles = async (using: Context) => {
        cached = await loadRoles(
          {
            files: env,
            builtin,
            dirs: [
              ...(await packageDirs(env, '/node_modules', using)).map((dir) => ({
                source: 'package' as const,
                dir,
              })),
              { source: 'user', dir: `${home}/.pi/agent/agents` },
            ],
            settingsPath: `${home}/.pi/agent/settings.json`,
          },
          using
        );
        return cached;
      };
      await roles(context).catch(() => cached);
      const script = await assets('bin/agent').catch(() => undefined);
      if (script)
        await install(env, script, options.pnpmHome ?? PNPM_HOME, context).catch(() => undefined);
      const cli = createCli({
        env,
        harness,
        agents,
        scoops,
        roles: () => roles(context),
        ...(options.alive ? { alive: options.alive } : {}),
      });
      const plane = controlPlane(env, cli, {
        ...(options.controlDir ? { dir: options.controlDir } : {}),
        ...(options.sweepEvery ? { sweepEvery: options.sweepEvery } : {}),
        mirror: mirror(agents, env),
      });
      await plane.start(context);
      return { roles, plane, close: (using) => plane.close(using) };
    },
  };
}

export type { Rewound, Scoops } from './service.ts';
