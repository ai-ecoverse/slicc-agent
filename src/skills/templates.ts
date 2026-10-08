import type { Context } from '@earendil-works/chord';
import { parseFrontmatter } from '../roles/frontmatter.ts';
import type { Diagnostic, SkillFiles } from './skills.ts';

export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  filePath: string;
}

export interface LoadedTemplates {
  templates: PromptTemplate[];
  diagnostics: Diagnostic[];
}

export function parseCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = '';
    } else current += char;
  }
  if (current) args.push(current);
  return args;
}

function all(args: readonly string[], target: string): string | undefined {
  return target === '@' || target === 'ARGUMENTS'
    ? args.join(' ')
    : args[Number.parseInt(target, 10) - 1];
}

export function substituteArgs(content: string, args: readonly string[]): string {
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, fallbackTarget, fallback, sliceStart, sliceLength, simple) => {
      if (fallbackTarget) return all(args, fallbackTarget) || fallback;
      if (sliceStart) {
        const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
        const end = sliceLength ? start + Number.parseInt(sliceLength, 10) : undefined;
        return args.slice(start, end).join(' ');
      }
      return all(args, simple) ?? '';
    }
  );
}

export function templateFromText(text: string, filePath: string): PromptTemplate {
  const { fields, body } = parseFrontmatter(text);
  const name = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.md$/, '');
  let description = typeof fields.description === 'string' ? fields.description : '';
  if (!description) {
    const first = body.split('\n').find((line) => line.trim()) ?? '';
    description = first.length > 60 ? `${first.slice(0, 60)}...` : first;
  }
  const hint = fields['argument-hint'];
  return {
    name,
    description,
    ...(typeof hint === 'string' && hint ? { argumentHint: hint } : {}),
    content: body,
    filePath,
  };
}

export async function loadTemplates(
  files: SkillFiles,
  sources: readonly string[],
  context: Context
): Promise<LoadedTemplates> {
  const out: LoadedTemplates = { templates: [], diagnostics: [] };
  const add = async (path: string) => {
    if (out.templates.some((template) => template.filePath === path)) return;
    const read = await files.readTextFile(path, context);
    if (!read.ok) out.diagnostics.push({ path, message: read.error.message });
    else {
      const template = templateFromText(read.value, path);
      const existing = out.templates.find((item) => item.name === template.name);
      if (existing)
        out.diagnostics.push({
          path,
          message: `name "${template.name}" collision; ${existing.filePath} is used`,
        });
      else out.templates.push(template);
    }
  };
  for (const source of sources) {
    if (source.endsWith('.md') && !source.endsWith('*.md')) {
      await add(source);
      continue;
    }
    const dir = source.replace(/\/\*\.md$/, '');
    const listed = await files.listDir(dir, context);
    if (!listed.ok) continue;
    const names = listed.value
      .filter((entry) => entry.kind !== 'directory' && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) await add(`${dir}/${name}`);
  }
  return out;
}

export function expandPromptTemplate(text: string, templates: readonly PromptTemplate[]): string {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return text;
  const template = templates.find((item) => item.name === match[1]);
  if (!template) return text;
  return substituteArgs(template.content, parseCommandArgs(match[2] ?? ''));
}
