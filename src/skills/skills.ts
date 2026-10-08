import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { parseFrontmatter } from '../roles/frontmatter.ts';

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;

export type SkillFiles = Pick<ExecutionEnv, 'readTextFile' | 'listDir'>;

export type SkillSource = 'user' | 'compat' | 'package' | 'builtin';

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  disableModelInvocation: boolean;
}

export interface Diagnostic {
  path: string;
  message: string;
}

export interface Loaded {
  skills: Skill[];
  diagnostics: Diagnostic[];
}

export interface SkillRoot {
  dir: string;
  source: SkillSource;
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function validateName(name: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH)
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name))
    errors.push('name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)');
  if (name.startsWith('-') || name.endsWith('-'))
    errors.push('name must not start or end with a hyphen');
  if (name.includes('--')) errors.push('name must not contain consecutive hyphens');
  return errors;
}

function validateDescription(description: unknown): string[] {
  if (typeof description !== 'string' || description.trim() === '')
    return ['description is required'];
  if (description.length > MAX_DESCRIPTION_LENGTH)
    return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
  return [];
}

export function skillFromText(text: string, filePath: string, source: SkillSource): Loaded {
  const declared = basename(filePath) === 'SKILL.md';
  const { fields, problems } = parseFrontmatter(text);
  const diagnostics: Diagnostic[] = [];
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!declared && !description) return { skills: [], diagnostics };
  for (const problem of problems.filter((item) => !item.includes('nested values')))
    diagnostics.push({ path: filePath, message: problem });
  for (const message of validateDescription(description))
    diagnostics.push({ path: filePath, message });
  const baseDir = dirname(filePath);
  const name = (typeof fields.name === 'string' && fields.name) || basename(baseDir);
  for (const message of validateName(name)) diagnostics.push({ path: filePath, message });
  if (!description) return { skills: [], diagnostics };
  const skill: Skill = {
    name,
    description,
    filePath,
    baseDir,
    source,
    disableModelInvocation: fields['disable-model-invocation'] === true,
  };
  return { skills: [skill], diagnostics };
}

async function loadFile(
  files: SkillFiles,
  filePath: string,
  source: SkillSource,
  context: Context
): Promise<Loaded> {
  const read = await files.readTextFile(filePath, context);
  if (!read.ok)
    return { skills: [], diagnostics: [{ path: filePath, message: read.error.message }] };
  return skillFromText(read.value, filePath, source);
}

export async function loadSkillsFromDir(
  files: SkillFiles,
  dir: string,
  source: SkillSource,
  context: Context,
  root = true
): Promise<Loaded> {
  const out: Loaded = { skills: [], diagnostics: [] };
  const listed = await files.listDir(dir, context);
  if (!listed.ok) return out;
  const merge = (found: Loaded) => {
    out.skills.push(...found.skills);
    out.diagnostics.push(...found.diagnostics);
  };
  if (listed.value.some((entry) => entry.name === 'SKILL.md' && entry.kind !== 'directory')) {
    merge(await loadFile(files, `${dir}/SKILL.md`, source, context));
    return out;
  }
  const entries = [...listed.value].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.kind === 'directory' || entry.kind === 'symlink')
      merge(await loadSkillsFromDir(files, path, source, context, false));
    if (entry.kind !== 'directory' && root && entry.name.endsWith('.md'))
      merge(await loadFile(files, path, source, context));
  }
  return out;
}

export async function loadSkills(
  files: SkillFiles,
  roots: readonly SkillRoot[],
  context: Context
): Promise<Loaded> {
  const byName = new Map<string, Skill>();
  const seen = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const collisions: Diagnostic[] = [];
  for (const root of roots) {
    const found = await loadSkillsFromDir(files, root.dir, root.source, context);
    diagnostics.push(...found.diagnostics);
    for (const skill of found.skills) {
      if (seen.has(skill.filePath)) continue;
      const existing = byName.get(skill.name);
      if (existing)
        collisions.push({
          path: skill.filePath,
          message: `name "${skill.name}" collision; ${existing.filePath} is used`,
        });
      else {
        byName.set(skill.name, skill);
        seen.add(skill.filePath);
      }
    }
  }
  return { skills: [...byName.values()], diagnostics: [...diagnostics, ...collisions] };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function formatSkillsForPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (!visible.length) return '';
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  for (const skill of visible)
    lines.push(
      '  <skill>',
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      '  </skill>'
    );
  lines.push('</available_skills>');
  return lines.join('\n');
}

export async function expandSkillCommand(
  text: string,
  skills: readonly Skill[],
  files: SkillFiles,
  context: Context
): Promise<string> {
  if (!text.startsWith('/skill:')) return text;
  const space = text.indexOf(' ');
  const name = space === -1 ? text.slice(7) : text.slice(7, space);
  const args = space === -1 ? '' : text.slice(space + 1).trim();
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) return text;
  const read = await files.readTextFile(skill.filePath, context);
  if (!read.ok) return text;
  const body = parseFrontmatter(read.value).body.trim();
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}
