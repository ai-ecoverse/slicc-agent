import { type Context, type ReplicatedState, replicatedState } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  type Registry,
  section,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import type { Licks } from '../licks/licks.ts';
import { manifestDirs } from '../roles/roles.ts';
import type { Command } from '../services.ts';
import {
  type Diagnostic,
  expandSkillCommand,
  formatSkillsForPrompt,
  loadSkills,
  type Skill,
  type SkillRoot,
} from './skills.ts';
import { expandPromptTemplate, loadTemplates, type PromptTemplate } from './templates.ts';

export const BUILTIN_SKILLS = ['agent', 'licks', 'skill-authoring'];
export const BUILTIN_PROMPTS = ['parallel-review', 'review-loop'];
export const SKILLS_DIR = '/var/lib/slicc/agent/skills';
export const PROMPTS_DIR = '/var/lib/slicc/agent/prompts';
export const COMPAT_DIR = '/workspace/skills';
export const RELOAD_MS = 300;

export interface SkillsRuntime {
  readonly commands: ReplicatedState<Command[]>;
  skills(): readonly Skill[];
  dirs(): string[];
  templates(): readonly PromptTemplate[];
  expand(text: string, context: Context): Promise<string>;
  reload(context: Context): Promise<void>;
  close(context: Context): Promise<void>;
}

export interface SkillsAttach {
  env: ExecutionEnv;
  home: string;
  assets?: (path: string) => Promise<string>;
  reloadMs: number;
}

export interface SkillsSetup {
  extension: Extension;
  attach(options: SkillsAttach, context: Context): Promise<SkillsRuntime>;
}

type Manifest = { pi?: { skills?: unknown; prompts?: unknown } };

export function piResources(dir: string, text: string, kind: 'skills' | 'prompts'): string[] {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text) as Manifest;
  } catch {
    return [];
  }
  const listed = manifest.pi?.[kind];
  const paths = Array.isArray(listed) ? listed : typeof listed === 'string' ? [listed] : [];
  return paths
    .filter((path): path is string => typeof path === 'string')
    .map((path) => `${dir}/${path.replace(/^\.\//, '').replace(/\/$/, '')}`);
}

async function packaged(env: ExecutionEnv, kind: 'skills' | 'prompts', context: Context) {
  const out: string[] = [];
  for (const dir of await manifestDirs(env, '/node_modules', context)) {
    const read = await env.readTextFile(`${dir}/package.json`, context);
    if (read.ok) out.push(...piResources(dir, read.value, kind));
  }
  return out;
}

async function installBuiltins(
  env: ExecutionEnv,
  assets: (path: string) => Promise<string>,
  context: Context
): Promise<void> {
  await env.remove(SKILLS_DIR, { recursive: true, force: true }, context);
  await env.remove(PROMPTS_DIR, { recursive: true, force: true }, context);
  for (const name of BUILTIN_SKILLS) {
    const text = await assets(`packages/vfs-root/skills/${name}/SKILL.md`).catch(() => undefined);
    if (text === undefined) continue;
    await env.createDir(`${SKILLS_DIR}/${name}`, { recursive: true }, context);
    await env.writeFile(`${SKILLS_DIR}/${name}/SKILL.md`, text, context);
  }
  await env.createDir(PROMPTS_DIR, { recursive: true }, context);
  for (const name of BUILTIN_PROMPTS) {
    const text = await assets(`packages/vfs-root/prompts/${name}.md`).catch(() => undefined);
    if (text !== undefined) await env.writeFile(`${PROMPTS_DIR}/${name}.md`, text, context);
  }
}

export function problemLick(problem: Diagnostic, home: string) {
  const path = problem.path.startsWith(`${home}/`)
    ? `~${problem.path.slice(home.length)}`
    : problem.path;
  return {
    channel: 'fswatch' as const,
    source: `skills:${path}`,
    title: `Skill or prompt template problem: ${path}`,
    text: problem.message,
    body: 'The file is used with this problem, or skipped if it has no description.\nThe rules are in the slicc-agent README.',
    target: 'cone' as const,
    severity: 'warn' as const,
    eventId: `${path}\n${problem.message}`,
  };
}

export function commandsOf(
  skills: readonly Skill[],
  templates: readonly PromptTemplate[]
): Command[] {
  return [
    ...templates.map((template) => ({
      name: template.name,
      description: template.description,
      kind: 'prompt' as const,
    })),
    ...skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      kind: 'skill' as const,
    })),
  ];
}

export function setupSkills(registry: Registry, licks: Licks): SkillsSetup {
  let current: Skill[] = [];
  const extension = defineExtension({
    name: 'slicc-skills',
    sections: [section('skills', async () => formatSkillsForPrompt(current) || undefined)],
  });
  registry.install(extension);
  return {
    extension,
    async attach(options, context) {
      const { env, home } = options;
      if (options.assets)
        await installBuiltins(env, options.assets, context).catch(() => undefined);
      let templates: PromptTemplate[] = [];
      const commands = replicatedState<Command[]>([]);
      const reported = new Set<string>();
      const reload = async (using: Context) => {
        const roots: SkillRoot[] = [
          { dir: `${home}/.pi/agent/skills`, source: 'user' },
          { dir: `${home}/.agents/skills`, source: 'user' },
          { dir: COMPAT_DIR, source: 'compat' },
          ...(await packaged(env, 'skills', using)).map((dir) => ({
            dir,
            source: 'package' as const,
          })),
          { dir: SKILLS_DIR, source: 'builtin' },
        ];
        const loaded = await loadSkills(env, roots, using);
        const prompts = await loadTemplates(
          env,
          [`${home}/.pi/agent/prompts`, ...(await packaged(env, 'prompts', using)), PROMPTS_DIR],
          using
        );
        current = loaded.skills;
        templates = prompts.templates;
        commands.replace(using, commandsOf(current, templates));
        for (const problem of [...loaded.diagnostics, ...prompts.diagnostics]) {
          const key = `${problem.path}\n${problem.message}`;
          if (reported.has(key)) continue;
          reported.add(key);
          await licks.deliver(problemLick(problem, home), using).catch(() => undefined);
        }
      };
      await reload(context);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void reload(context).catch(() => undefined), options.reloadMs);
      };
      const watched = await env.watch(
        [
          { path: `${home}/.pi/agent/skills`, recursive: true },
          { path: `${home}/.pi/agent/prompts` },
          { path: `${home}/.agents/skills`, recursive: true },
          { path: COMPAT_DIR, recursive: true },
        ],
        schedule,
        context
      );
      const watcher: FileWatcher | undefined = watched.ok ? watched.value : undefined;
      return {
        commands,
        skills: () => current,
        dirs: () => current.map((skill) => skill.baseDir),
        templates: () => templates,
        async expand(text, using) {
          const expanded = await expandSkillCommand(text, current, env, using);
          return expanded === text ? expandPromptTemplate(text, templates) : expanded;
        },
        reload,
        async close(using) {
          clearTimeout(timer);
          await watcher?.close(using);
        },
      };
    },
  };
}
