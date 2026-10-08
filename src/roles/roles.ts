import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type FrontmatterValue, parseFrontmatter } from './frontmatter.ts';

export type RoleSource = 'builtin' | 'package' | 'user' | 'project';
export type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface Role {
  name: string;
  description: string;
  prompt: string;
  mode: 'replace' | 'append';
  tools?: string[];
  model?: string;
  thinking?: Thinking;
  aliases: string[];
  output?: string;
  source: RoleSource;
  path: string;
}

export interface Roles {
  roles: Role[];
  warnings: string[];
  limits: { maxLiveScoops: number; maxPerTurn: number };
}

export const DEFAULT_LIMITS = { maxLiveScoops: 16, maxPerTurn: 64 };

const TOOLS: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'bash',
  find: 'bash',
  ls: 'bash',
};

const THINKING = new Set<string>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const APPLIED = new Set([
  'name',
  'description',
  'tools',
  'model',
  'thinking',
  'systemPromptMode',
  'aliases',
  'output',
  'package',
  'advertise',
  'inheritProjectContext',
  'inheritSkills',
  'skills',
  'defaultReads',
]);

const LATER: Record<string, string> = {
  memory: 'per-agent memory comes with SLICC’s memory panel',
};

export type RoleFiles = Pick<ExecutionEnv, 'readTextFile' | 'listDir'>;

export interface RoleSourceDir {
  source: RoleSource;
  dir: string;
}

function list(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

function tools(names: string[], where: string, warnings: string[]): string[] {
  const mapped: string[] = [];
  for (const name of names) {
    const tool = TOOLS[name];
    if (tool) {
      if (!mapped.includes(tool)) mapped.push(tool);
    } else warnings.push(`${where}: tool "${name}" isn't available in SLICC; it's left out`);
  }
  return mapped;
}

export function parseRole(
  text: string,
  source: RoleSource,
  path: string,
  warnings: string[]
): Role | undefined {
  const { fields, body, problems } = parseFrontmatter(text);
  for (const problem of problems) warnings.push(`${path}: ${problem}`);
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== 'string' || typeof description !== 'string') {
    warnings.push(`${path}: an agent file needs a name and a description; skipped`);
    return undefined;
  }
  for (const key of Object.keys(fields))
    if (!APPLIED.has(key))
      warnings.push(
        `${path}: "${key}" ${LATER[key] ? `is not read yet (${LATER[key]})` : "isn't supported in SLICC; it's ignored"}`
      );
  const thinking =
    typeof fields.thinking === 'string' && THINKING.has(fields.thinking)
      ? (fields.thinking as Thinking)
      : undefined;
  if (fields.thinking !== undefined && !thinking)
    warnings.push(`${path}: thinking "${String(fields.thinking)}" is unknown; ignored`);
  const pkg = typeof fields.package === 'string' && fields.package ? `${fields.package}.` : '';
  return {
    name: `${pkg}${name}`,
    description,
    prompt: body,
    mode: fields.systemPromptMode === 'append' ? 'append' : 'replace',
    ...(fields.tools !== undefined ? { tools: tools(list(fields.tools), path, warnings) } : {}),
    ...(typeof fields.model === 'string' ? { model: fields.model } : {}),
    ...(thinking ? { thinking } : {}),
    aliases: list(fields.aliases),
    ...(typeof fields.output === 'string' ? { output: fields.output } : {}),
    source,
    path,
  };
}

async function markdown(
  files: RoleFiles,
  dir: string,
  context: Context,
  depth = 0
): Promise<string[]> {
  if (dir.endsWith('.md')) return [dir];
  const listed = await files.listDir(dir, context);
  if (!listed.ok || depth > 4) return [];
  const out: string[] = [];
  for (const info of listed.value) {
    const path = `${dir}/${info.name}`;
    if (info.kind === 'directory') out.push(...(await markdown(files, path, context, depth + 1)));
    else if (info.name.endsWith('.md') && !info.name.endsWith('.chain.md')) out.push(path);
  }
  return out.sort();
}

type Override = {
  model?: unknown;
  thinking?: unknown;
  tools?: unknown;
  systemPrompt?: unknown;
  description?: unknown;
  disabled?: unknown;
};

interface Settings {
  overrides: Record<string, Override>;
  limits: Roles['limits'];
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

async function settings(
  files: RoleFiles,
  path: string,
  context: Context,
  warnings: string[]
): Promise<Settings> {
  const read = await files.readTextFile(path, context);
  const empty = { overrides: {}, limits: { ...DEFAULT_LIMITS } };
  if (!read.ok) return empty;
  let parsed: {
    subagents?: {
      agentOverrides?: Record<string, Override>;
      maxLiveScoops?: unknown;
      maxPerTurn?: unknown;
    };
  };
  try {
    parsed = JSON.parse(read.value);
  } catch (error) {
    warnings.push(`${path}: not valid JSON (${(error as Error).message}); overrides ignored`);
    return empty;
  }
  const subagents = parsed.subagents ?? {};
  return {
    overrides: subagents.agentOverrides ?? {},
    limits: {
      maxLiveScoops: positive(subagents.maxLiveScoops, DEFAULT_LIMITS.maxLiveScoops),
      maxPerTurn: positive(subagents.maxPerTurn, DEFAULT_LIMITS.maxPerTurn),
    },
  };
}

function apply(role: Role, override: Override | undefined, warnings: string[]): Role | undefined {
  if (!override) return role;
  if (override.disabled === true) return undefined;
  const next: Role = { ...role };
  if (typeof override.model === 'string') next.model = override.model;
  if (typeof override.thinking === 'string' && THINKING.has(override.thinking))
    next.thinking = override.thinking as Thinking;
  if (typeof override.description === 'string') next.description = override.description;
  if (typeof override.systemPrompt === 'string') next.prompt = override.systemPrompt;
  if (Array.isArray(override.tools))
    next.tools = tools(override.tools.map(String), `override for ${role.name}`, warnings);
  return next;
}

export interface LoadOptions {
  files: RoleFiles;
  builtin: () => Promise<{ path: string; text: string }[]>;
  dirs: RoleSourceDir[];
  settingsPath: string;
}

const ORDER: RoleSource[] = ['builtin', 'package', 'user', 'project'];

export async function loadRoles(options: LoadOptions, context: Context): Promise<Roles> {
  const warnings: string[] = [];
  const byName = new Map<string, Role>();
  const add = (role: Role | undefined) => {
    if (role) byName.set(role.name, role);
  };
  for (const { path, text } of await options.builtin())
    add(parseRole(text, 'builtin', path, warnings));
  const dirs = [...options.dirs].sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
  for (const { source, dir } of dirs)
    for (const path of await markdown(options.files, dir, context)) {
      const read = await options.files.readTextFile(path, context);
      if (read.ok) add(parseRole(read.value, source, path, warnings));
    }
  const { overrides, limits } = await settings(
    options.files,
    options.settingsPath,
    context,
    warnings
  );
  const roles: Role[] = [];
  for (const role of byName.values()) {
    const applied = apply(role, overrides[role.name], warnings);
    if (applied) roles.push(applied);
  }
  return { roles, warnings, limits };
}

export function findRole(roles: readonly Role[], name: string): Role | undefined {
  return (
    roles.find((role) => role.name === name) ?? roles.find((role) => role.aliases.includes(name))
  );
}

async function manifestDirs(files: RoleFiles, root: string, context: Context): Promise<string[]> {
  const top = await files.listDir(root, context);
  if (!top.ok) return [];
  const out: string[] = [];
  for (const entry of top.value) {
    if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
    if (!entry.name.startsWith('@')) {
      out.push(`${root}/${entry.name}`);
      continue;
    }
    const scoped = await files.listDir(`${root}/${entry.name}`, context);
    if (scoped.ok)
      for (const inner of scoped.value)
        if (inner.kind === 'directory') out.push(`${root}/${entry.name}/${inner.name}`);
  }
  return out;
}

type Manifest = {
  'pi-subagents'?: { agents?: unknown };
  pi?: { subagents?: { agents?: unknown } };
};

export function agentPaths(dir: string, text: string): string[] {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(text) as Manifest;
  } catch {
    return [];
  }
  const agents = manifest['pi-subagents']?.agents ?? manifest.pi?.subagents?.agents;
  const listed = Array.isArray(agents) ? agents : typeof agents === 'string' ? [agents] : [];
  return listed
    .filter((path): path is string => typeof path === 'string')
    .map((path) => `${dir}/${path.replace(/^\.\//, '').replace(/\/$/, '')}`);
}

export async function packageDirs(
  files: RoleFiles,
  root: string,
  context: Context
): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await manifestDirs(files, root, context)) {
    const read = await files.readTextFile(`${dir}/package.json`, context);
    if (read.ok) out.push(...agentPaths(dir, read.value));
  }
  return out;
}
