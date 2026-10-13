import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { RoleMemory } from '../memory/store.ts';
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
  memory?: RoleMemory;
  context?: { project: boolean; global: boolean };
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
  memory_write: 'memory_write',
};

const WRITERS = new Set(['write', 'edit', 'bash']);

const PASSED = new Set([
  'codemode',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

function passThrough(name: string): boolean {
  return PASSED.has(name) || /^mcp__[A-Za-z0-9_*]+$/.test(name);
}

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
  'inheritGlobalContext',
  'inheritSkills',
  'memory',
  'skills',
  'defaultReads',
]);

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
    const tool = TOOLS[name] ?? (passThrough(name) ? name : undefined);
    if (tool) {
      if (!mapped.includes(tool)) mapped.push(tool);
    } else warnings.push(`${where}: tool "${name}" isn't available in SLICC; it's left out`);
  }
  return mapped;
}

export function roleMemory(value: FrontmatterValue): RoleMemory | undefined {
  if (typeof value !== 'string') return undefined;
  const inline = /^\{(.*)\}$/s.exec(value.trim());
  const pairs = new Map<string, string>();
  for (const part of (inline ? (inline[1] as string) : value).split(/[,\n]/)) {
    const found = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(part);
    if (found) pairs.set(found[1] as string, (found[2] as string).replace(/^(["'])(.*)\1$/, '$2'));
  }
  const scope = pairs.get('scope');
  const path = pairs.get('path');
  if ((scope !== 'user' && scope !== 'project') || !path) return undefined;
  return { scope, path };
}

function withMemoryWrite(
  listed: string[] | undefined,
  memory: RoleMemory | undefined
): string[] | undefined {
  if (memory && listed?.some((tool) => WRITERS.has(tool)) && !listed.includes('memory_write'))
    return [...listed, 'memory_write'];
  return listed;
}

function memoryFields(
  fields: Record<string, FrontmatterValue>,
  path: string,
  warnings: string[]
): Pick<Role, 'memory' | 'context'> & { listed: string[] | undefined } {
  const memory = fields.memory === undefined ? undefined : roleMemory(fields.memory);
  if (fields.memory !== undefined && !memory)
    warnings.push(`${path}: memory needs a scope (user or project) and a path; ignored`);
  const listed = withMemoryWrite(
    fields.tools !== undefined ? tools(list(fields.tools), path, warnings) : undefined,
    memory
  );
  const inherits =
    fields.inheritProjectContext !== undefined || fields.inheritGlobalContext !== undefined;
  return {
    ...(memory ? { memory } : {}),
    listed,
    ...(inherits
      ? {
          context: {
            project: fields.inheritProjectContext !== false,
            global: fields.inheritGlobalContext === true,
          },
        }
      : {}),
  };
}

export function parseRole(
  text: string,
  source: RoleSource,
  path: string,
  warnings: string[]
): Role | undefined {
  const { fields, body, problems } = parseFrontmatter(text, ['memory']);
  for (const problem of problems) warnings.push(`${path}: ${problem}`);
  const name = fields.name;
  const description = fields.description;
  if (typeof name !== 'string' || typeof description !== 'string') {
    warnings.push(`${path}: an agent file needs a name and a description; skipped`);
    return undefined;
  }
  for (const key of Object.keys(fields))
    if (!APPLIED.has(key))
      warnings.push(`${path}: "${key}" isn't supported in SLICC; it's ignored`);
  const thinking =
    typeof fields.thinking === 'string' && THINKING.has(fields.thinking)
      ? (fields.thinking as Thinking)
      : undefined;
  if (fields.thinking !== undefined && !thinking)
    warnings.push(`${path}: thinking "${String(fields.thinking)}" is unknown; ignored`);
  const { memory, listed, context } = memoryFields(fields, path, warnings);
  const pkg = typeof fields.package === 'string' && fields.package ? `${fields.package}.` : '';
  return {
    name: `${pkg}${name}`,
    description,
    prompt: body,
    mode: fields.systemPromptMode === 'append' ? 'append' : 'replace',
    ...(listed ? { tools: listed } : {}),
    ...(typeof fields.model === 'string' ? { model: fields.model } : {}),
    ...(thinking ? { thinking } : {}),
    aliases: list(fields.aliases),
    ...(typeof fields.output === 'string' ? { output: fields.output } : {}),
    ...(memory ? { memory } : {}),
    ...(context ? { context } : {}),
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
    next.tools = withMemoryWrite(
      tools(override.tools.map(String), `override for ${role.name}`, warnings),
      role.memory
    );
  return next;
}

export interface LoadOptions {
  files: RoleFiles;
  builtin: () => Promise<{ path: string; text: string }[]>;
  dirs: RoleSourceDir[];
  settingsPath: string;
}

const ORDER: RoleSource[] = ['project', 'user', 'builtin', 'package'];

export async function loadRoles(options: LoadOptions, context: Context): Promise<Roles> {
  const warnings: string[] = [];
  const byName = new Map<string, Role>();
  const add = (role: Role | undefined) => {
    if (!role) return;
    const earlier = byName.get(role.name);
    if (!earlier) byName.set(role.name, role);
    else if (role.source === 'package')
      warnings.push(
        `${role.path}: role "${role.name}" is already provided by ${earlier.path}; ignored`
      );
  };
  const dirs = [...options.dirs].sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
  const read = async (dir: RoleSourceDir) => {
    for (const path of await markdown(options.files, dir.dir, context)) {
      const text = await options.files.readTextFile(path, context);
      if (text.ok) add(parseRole(text.value, dir.source, path, warnings));
    }
  };
  for (const dir of dirs.filter((item) => ORDER.indexOf(item.source) < 2)) await read(dir);
  for (const { path, text } of await options.builtin())
    add(parseRole(text, 'builtin', path, warnings));
  for (const dir of dirs.filter((item) => ORDER.indexOf(item.source) >= 2)) await read(dir);
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

function folder(kind: string): boolean {
  return kind === 'directory' || kind === 'symlink';
}

export async function manifestDirs(
  files: RoleFiles,
  root: string,
  context: Context
): Promise<string[]> {
  const top = await files.listDir(root, context);
  if (!top.ok) return [];
  const out: string[] = [];
  for (const entry of top.value) {
    if (!folder(entry.kind) || entry.name.startsWith('.')) continue;
    if (!entry.name.startsWith('@')) {
      out.push(`${root}/${entry.name}`);
      continue;
    }
    const scoped = await files.listDir(`${root}/${entry.name}`, context);
    if (scoped.ok)
      for (const inner of scoped.value)
        if (folder(inner.kind)) out.push(`${root}/${entry.name}/${inner.name}`);
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

export const PACKAGE_ROOTS = ['/node_modules', '/opt/user/node_modules'];

export interface PiPackage {
  dir: string;
  manifest: string;
}

export interface PiPackages {
  packages: PiPackage[];
  skipped: { path: string; message: string }[];
}

function declaresPi(text: string): boolean {
  try {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    return manifest.pi !== undefined || manifest['pi-subagents'] !== undefined;
  } catch {
    return false;
  }
}

export async function piPackages(
  files: RoleFiles,
  roots: readonly string[],
  context: Context
): Promise<PiPackages> {
  const out: PiPackages = { packages: [], skipped: [] };
  const seen = new Map<string, string>();
  for (const root of roots)
    for (const dir of await manifestDirs(files, root, context)) {
      const read = await files.readTextFile(`${dir}/package.json`, context);
      if (!read.ok) continue;
      const name = dir.slice(root.length + 1);
      const earlier = seen.get(name);
      if (earlier === undefined) {
        seen.set(name, dir);
        out.packages.push({ dir, manifest: read.value });
      } else if (declaresPi(read.value))
        out.skipped.push({
          path: dir,
          message: `package "${name}" is already installed at ${earlier}, so this copy's skills, prompts and roles are ignored`,
        });
    }
  return out;
}

export async function packageDirs(
  files: RoleFiles,
  roots: readonly string[],
  context: Context
): Promise<string[]> {
  const { packages } = await piPackages(files, roots, context);
  return packages.flatMap(({ dir, manifest }) => agentPaths(dir, manifest));
}
