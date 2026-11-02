import { isAlias, LineCounter, parseDocument, visit } from 'yaml';

export type FrontmatterValue = string | number | boolean | string[];

export interface Frontmatter {
  fields: Record<string, FrontmatterValue>;
  body: string;
  problems: string[];
}

function primitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function fieldsFrom(
  parsed: unknown,
  mappings: readonly string[],
  problems: string[]
): Record<string, FrontmatterValue> {
  if (parsed === null) return {};
  if (!(parsed instanceof Map)) {
    problems.push('frontmatter must be a mapping');
    return {};
  }
  const fields = new Map<string, FrontmatterValue>();
  for (const [key, value] of parsed) {
    if (primitive(value)) fields.set(key, value);
    else if (value === null) fields.set(key, []);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      fields.set(key, value);
    else if (
      value instanceof Map &&
      mappings.includes(key) &&
      [...value].every(([name, item]) => typeof name === 'string' && primitive(item))
    )
      fields.set(key, `{ ${[...value].map(([name, item]) => `${name}: ${item}`).join(', ')} }`);
    else if (value instanceof Map)
      problems.push(`"${key}" has nested values, which SLICC doesn't read`);
    else problems.push(`"${key}" needs a scalar or a list of strings`);
  }
  return Object.fromEntries(fields);
}

export function parseFrontmatter(text: string, mappings: readonly string[] = []): Frontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match)
    return { fields: {}, body: normalized.trim(), problems: ['no frontmatter between --- lines'] };
  const body = normalized.slice(match[0].length).trim();
  const lineCounter = new LineCounter();
  const document = parseDocument(`---\n${match[1]}\n`, {
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    stringKeys: true,
    lineCounter,
  });
  const problems = [...document.errors, ...document.warnings].map((error) => error.message);
  if (problems.length) return { fields: {}, body, problems };
  let aliasOffset = 0;
  visit(document, (_, node) => {
    if (!isAlias(node)) return;
    aliasOffset = node.range?.[0] ?? 0;
    return visit.BREAK;
  });
  let parsed: unknown;
  try {
    parsed = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  } catch (error) {
    const { line } = lineCounter.linePos(aliasOffset);
    return { fields: {}, body, problems: [`${(error as Error).message} at line ${line}`] };
  }
  return { fields: fieldsFrom(parsed, mappings, problems), body, problems };
}
