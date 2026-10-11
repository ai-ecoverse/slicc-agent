import type { Context } from '@earendil-works/chord';
import type { Harness, Registry, ToolRegistration } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { ProcessGroups } from '../kernel/groups.ts';
import { type Layout, LEGACY } from '../layout.ts';
import type { Licks } from '../licks/licks.ts';
import { DEFAULT_LIMITS, loadRoles, packageDirs, type Roles } from '../roles/roles.ts';
import { type CliOptions, createCli, RUN_DIR } from './cli.ts';
import { guardExtension, scoopsExtension, scoopTasks } from './extension.ts';
import {
  CONTROL_DIR,
  type ControlPlane,
  controlPlane,
  type PlaneOptions,
  PROTOCOL,
} from './requests.ts';
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
  memory?: CliOptions['memory'];
  gelatiere?: CliOptions['gelatiere'];
  freezer?: CliOptions['freezer'];
  models?: CliOptions['models'];
  panel?: CliOptions['panel'];
  mcp?: (names: readonly string[]) => ToolRegistration[];
  layout?: Layout;
  enforced?: boolean;
  spools?: Spools;
}

export interface Spools {
  users(): readonly string[];
  prepare(user: string, dir: string, context: Context): Promise<void>;
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

export const COMMANDS = ['agent', 'subagent', 'memory', 'gelatiere', 'freezer', 'models', 'panel'];

export const RETIRED_COMMANDS = ['sprinkle'];

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
  for (const name of RETIRED_COMMANDS) {
    const text = await env.readTextFile(`${binDir}/${name}`, context);
    if (text.ok && text.value.includes(PROTOCOL))
      await env.remove(`${binDir}/${name}`, { force: true }, context);
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
  for (const name of [...COMMANDS, ...RETIRED_COMMANDS]) {
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

function planeOf(
  env: ExecutionEnv,
  cli: ReturnType<typeof createCli>,
  options: AttachOptions,
  context: Context
): ControlPlane {
  const common: PlaneOptions & { dir: string } = {
    ...(options.sweepEvery ? { sweepEvery: options.sweepEvery } : {}),
    mirror: mirror(options.agents, env),
    dir: options.controlDir ?? CONTROL_DIR,
  };
  if (!options.spools) return controlPlane(env, cli, common);
  return spooled(env, cli, options.spools, options.agents, common, context);
}

function spooled(
  env: ExecutionEnv,
  cli: ReturnType<typeof createCli>,
  spools: Spools,
  agents: Agents,
  options: PlaneOptions & { dir: string },
  context: Context
): ControlPlane {
  const planes = new Map<string, Promise<ControlPlane | undefined>>();
  let off: () => void = () => undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const open = async (user: string): Promise<ControlPlane | undefined> => {
    const dir = `${options.dir}/${user}`;
    try {
      await spools.prepare(user, dir, context);
      const plane = controlPlane(env, cli, { ...options, dir, user });
      await plane.start(context);
      return plane;
    } catch {
      planes.delete(user);
      return undefined;
    }
  };
  const sync = () => {
    const step = async () => {
      const wanted = new Set(spools.users());
      for (const user of wanted)
        if (!planes.has(user)) {
          const opened = open(user);
          planes.set(user, opened);
          await opened;
        }
      for (const [user, plane] of [...planes])
        if (!wanted.has(user)) {
          planes.delete(user);
          await (await plane)?.close(context);
        }
    };
    chain = chain.then(step, step);
    return chain;
  };
  const all = async () =>
    (await Promise.all(planes.values())).filter((plane): plane is ControlPlane => !!plane);
  return {
    async start() {
      off = agents.onChange(() => void sync());
      await sync();
    },
    async sweep(using) {
      for (const plane of await all()) await plane.sweep(using);
    },
    async close(using) {
      off();
      await chain;
      for (const plane of await all()) await plane.close(using);
      planes.clear();
    },
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
  let layout = LEGACY;
  registry.install(scoopsExtension(tasks, () => layout));
  registry.install(guardExtension(lookup, fileTools));
  return {
    scoops,
    async attach(options, context) {
      const { harness, agents, groups, env, home } = options;
      const assets = options.assets ?? packageAssets();
      layout = options.layout ?? LEGACY;
      bind({
        harness,
        agents,
        licks,
        tools: fileTools,
        groups,
        reads: options.reads,
        files: env,
        layout,
        ...(options.enforced ? { enforced: true } : {}),
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
        ...(options.memory ? { memory: options.memory } : {}),
        ...(options.gelatiere ? { gelatiere: options.gelatiere } : {}),
        ...(options.freezer ? { freezer: options.freezer } : {}),
        ...(options.models ? { models: options.models } : {}),
        layout,
        ...(options.panel ? { panel: options.panel } : {}),
      });
      const plane = planeOf(env, cli, options, context);
      await plane.start(context);
      return { roles, plane, close: (using) => plane.close(using) };
    },
  };
}

export type { Rewound, Scoops } from './service.ts';
