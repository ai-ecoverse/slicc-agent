import { isAlias, isCollection, isScalar, LineCounter, parseDocument, visit } from 'yaml';

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

function retryValue(raw: string, source: string): string | undefined {
  const scalar = parseDocument(source, {
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
  });
  const clean = !scalar.errors.length && !scalar.warnings.length;
  if (/^[[{]/.test(raw) && clean && isCollection(scalar.contents)) return undefined;
  const typed = clean && isScalar(scalar.contents) && typeof scalar.contents.value !== 'string';
  return typed ? raw : JSON.stringify(raw);
}

function tolerantSource(source: string): string {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const found = /^([A-Za-z][\w-]*):[ \t]+(.*)$/.exec(lines[index] as string);
    if (!found) continue;
    const value = (found[2] as string).replace(/[ \t]+#.*$/, '').trim();
    if (
      !value ||
      value.startsWith('#') ||
      /^["']/.test(value) ||
      /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(value)
    )
      continue;
    let raw = value;
    let blanks = 0;
    const continuation: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next] as string;
      if (!line.trim()) {
        continuation.push(line);
        blanks++;
        continue;
      }
      if (line.trimStart().startsWith('#')) {
        continuation.push(line);
        continue;
      }
      if (!/^[ \t]/.test(line)) break;
      continuation.push(line);
      const continued = line.replace(/[ \t]+#.*$/, '').trim();
      raw += `${blanks ? '\n'.repeat(blanks) : ' '}${continued}`;
      blanks = 0;
    }
    const quoted = retryValue(raw, [found[2], ...continuation].join('\n'));
    if (quoted === undefined) continue;
    for (let offset = 1; offset <= continuation.length; offset++) lines[index + offset] = '';
    lines[index] = `${found[1]}: ${quoted}`;
  }
  return lines.join('\n');
}

function salvageSource(
  source: string,
  issues: readonly { pos: [number, number]; message: string; code: string }[],
  counter: LineCounter
) {
  const lines = source.split('\n');
  const owners: number[] = [];
  const ends = new Map<number, number>();
  let owner = 0;
  for (let index = 0; index < lines.length; index++) {
    if (/^[^\s#]/.test(lines[index] as string)) {
      ends.set(owner, index);
      owner = index;
    }
    owners.push(owner);
  }
  ends.set(owner, lines.length);
  const dropped = new Map<number, { end: number; message: string }>();
  for (const issue of issues) {
    if (issue.code === 'MISSING_CHAR') return undefined;
    const index = counter.linePos(issue.pos[0]).line - 1;
    const line = lines[index];
    if (!line?.trim() || index === 0) return undefined;
    const start = owners[index] as number;
    const stray = start === index && !/^[^:]+:(?:\s|$)/.test(line);
    dropped.set(stray ? index : start, {
      end: stray ? index + 1 : (ends.get(start) as number),
      message: issue.message,
    });
  }
  const removed = new Set<number>();
  for (const [start, { end }] of dropped)
    for (let index = start; index < end; index++) removed.add(index);
  const kept = lines.map((_, index) => index).filter((index) => !removed.has(index));
  return {
    source: kept.map((index) => lines[index]).join('\n'),
    lines: kept,
    problems: [...dropped.values()].map(({ message }) => message),
  };
}

export function parseFrontmatter(text: string, mappings: readonly string[] = []): Frontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match)
    return { fields: {}, body: normalized.trim(), problems: ['no frontmatter between --- lines'] };
  const body = normalized.slice(match[0].length).trim();
  let lineCounter = new LineCounter();
  const options = {
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    stringKeys: true,
    uniqueKeys: false,
  };
  const source = `---\n${match[1]}\n`;
  let document = parseDocument(source, { ...options, lineCounter });
  if (document.errors.length || document.warnings.length) {
    lineCounter = new LineCounter();
    document = parseDocument(tolerantSource(source), { ...options, lineCounter });
  }
  let issues = [...document.errors, ...document.warnings];
  const problems: string[] = [];
  let sourceLines: number[] | undefined;
  if (issues.length) {
    const salvaged = salvageSource(source, issues, lineCounter);
    if (!salvaged) return { fields: {}, body, problems: issues.map((issue) => issue.message) };
    problems.push(...salvaged.problems);
    sourceLines = salvaged.lines;
    lineCounter = new LineCounter();
    document = parseDocument(tolerantSource(salvaged.source), { ...options, lineCounter });
    issues = [...document.errors, ...document.warnings];
    if (issues.length) {
      for (const issue of issues) {
        const line = (sourceLines[lineCounter.linePos(issue.pos[0]).line - 1] as number) + 1;
        problems.push(`${issue.message.split(' at line ')[0]} at line ${line}`);
      }
      return { fields: {}, body, problems };
    }
  }
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
    const position = lineCounter.linePos(aliasOffset).line;
    const line = sourceLines ? (sourceLines[position - 1] as number) + 1 : position;
    return {
      fields: {},
      body,
      problems: [...problems, `${(error as Error).message} at line ${line}`],
    };
  }
  return { fields: fieldsFrom(parsed, mappings, problems), body, problems };
}
