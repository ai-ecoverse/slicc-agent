import type { Context } from '@earendil-works/chord';
import type { Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { ProcessGroups } from '../kernel/groups.ts';
import type { Licks } from '../licks/licks.ts';
import { DEFAULT_LIMITS, loadRoles, packageDirs, type Roles } from '../roles/roles.ts';
import { type CliOptions, createCli, RUN_DIR } from './cli.ts';
import { guardExtension, scoopsExtension, scoopTasks } from './extension.ts';
import { type ControlPlane, controlPlane, PROTOCOL } from './requests.ts';
import { createScoops, type Scoops, type ScoopsHost } from './service.ts';

export const BUILTIN_ROLES = ['scout', 'worker', 'reviewer', 'oracle', 'delegate', 'gelatiere'];
export const PNPM_HOME = '/home/.local/share/pnpm';
export const BIN_DIR = '/usr/local/bin';

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
  groups: ProcessGroups;
  env: ExecutionEnv;
  home: string;
  assets?: Assets;
  binDir?: string;
  controlDir?: string;
  sweepEvery?: number;
  alive?: (pid: number) => Promise<boolean>;
  reads: () => readonly string[];
  sprinkle?: CliOptions['sprinkle'];
  memory?: CliOptions['memory'];
  gelatiere?: CliOptions['gelatiere'];
  freezer?: CliOptions['freezer'];
  models?: CliOptions['models'];
  panel?: CliOptions['panel'];
  mcp?: (names: readonly string[]) => ToolRegistration[];
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

export const COMMANDS = [
  'agent',
  'subagent',
  'sprinkle',
  'memory',
  'gelatiere',
  'freezer',
  'models',
  'panel',
];

export async function pnpmHomeOf(env: ExecutionEnv, context: Context): Promise<string> {
  let out = '';
  const ran = await env
    .exec(
      'printf %s "$PNPM_HOME"',
      {
        onOutput: (text) => {
          out += text;
        },
      },
      context
    )
    .catch(() => undefined);
  return ran?.ok && ran.value.exitCode === 0 && /^\/\S*$/.test(out) ? out : PNPM_HOME;
}

export interface Installed {
  done: boolean;
  skipped: string[];
}

async function theirs(env: ExecutionEnv, path: string, context: Context): Promise<boolean> {
  const found = await env.fileInfo(path, context);
  if (!found.ok) return found.error.code !== 'not_found';
  if (found.value.kind !== 'file') return true;
  const read = await env.readTextFile(path, context);
  return !read.ok || !read.value.includes(PROTOCOL);
}

async function install(
  env: ExecutionEnv,
  script: string,
  binDir: string,
  context: Context
): Promise<Installed> {
  const skipped: string[] = [];
  if (!(await env.createDir(binDir, { recursive: true }, context)).ok)
    return { done: false, skipped };
  for (const name of COMMANDS) {
    const path = `${binDir}/${name}`;
    if (await theirs(env, path, context)) {
      skipped.push(name);
      continue;
    }
    if (!(await env.writeFile(path, script, context)).ok) return { done: false, skipped };
    const mode = await env.exec(['chmod', '755', path], undefined, context);
    if (!mode.ok || mode.value.exitCode !== 0) return { done: false, skipped };
  }
  return { done: true, skipped };
}

export async function installCommands(
  env: ExecutionEnv,
  script: string,
  binDir: string,
  context: Context,
  warn: (message: string) => void = (message) => console.warn(message)
): Promise<Installed> {
  const installed = await install(env, script, binDir, context).catch(
    (): Installed => ({ done: false, skipped: [] })
  );
  if (installed.skipped.length) {
    const paths = installed.skipped.map((name) => `${binDir}/${name}`).join(', ');
    warn(`slicc-agent: left ${paths} alone, because it isn't slicc-agent's command`);
  }
  if (installed.done) await retire(env, binDir, context).catch(() => undefined);
  return installed;
}

export async function retire(env: ExecutionEnv, binDir: string, context: Context) {
  const old = `${await pnpmHomeOf(env, context)}/bin`;
  if (old === binDir) return;
  for (const name of COMMANDS) {
    const path = `${old}/${name}`;
    const text = await env.readTextFile(path, context);
    if (text.ok && text.value.includes(PROTOCOL)) await env.remove(path, { force: true }, context);
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
      bind({
        harness,
        agents,
        licks,
        tools: fileTools,
        groups,
        reads: options.reads,
        files: env,
        ...(options.mcp ? { mcp: options.mcp } : {}),
      });
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
      if (script) {
        const binDir = options.binDir ?? BIN_DIR;
        await installCommands(env, script, binDir, context);
      }
      const cli = createCli({
        env,
        harness,
        agents,
        scoops,
        roles: () => roles(context),
        ...(options.alive ? { alive: options.alive } : {}),
        ...(options.sprinkle ? { sprinkle: options.sprinkle } : {}),
        ...(options.memory ? { memory: options.memory } : {}),
        ...(options.gelatiere ? { gelatiere: options.gelatiere } : {}),
        ...(options.freezer ? { freezer: options.freezer } : {}),
        ...(options.models ? { models: options.models } : {}),
        ...(options.panel ? { panel: options.panel } : {}),
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
