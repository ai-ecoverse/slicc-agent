import { isAlias, isCollection, isMap, isScalar, LineCounter, parseDocument, visit } from 'yaml';

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

function entryBoundaries(source: string) {
  if (/[\r\u0085\u2028\u2029]/.test(source)) return undefined;
  const lines = source.split('\n');
  const owners: number[] = [0];
  const ends = new Map<number, number>();
  let owner = 0;
  let keyOwner = false;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.startsWith('\t')) return undefined;
    if (!/^ *$/.test(line) && !/^ *#/.test(line)) {
      if (line.startsWith(' ')) {
        if (!keyOwner) return undefined;
      } else {
        const key = /^[A-Za-z][\w-]*:(?:[ \t]|$)/.test(line);
        if (
          !key &&
          (/^\s/.test(line) ||
            /:(?:[ \t]|$)/.test(line) ||
            `?:-[]{}#&*!|>'"%@\``.includes(line[0] as string))
        )
          return undefined;
        ends.set(owner, index);
        owner = index;
        keyOwner = key;
      }
    }
    owners.push(owner);
  }
  ends.set(owner, lines.length);
  return { lines, owners, ends };
}

function salvageSource(
  source: string,
  retried: string,
  protectedKeys: readonly string[],
  issues: readonly { pos: [number, number]; message: string; code: string }[],
  counter: LineCounter
) {
  const boundaries = entryBoundaries(source);
  if (!boundaries) return undefined;
  const { lines, owners, ends } = boundaries;
  const dropped = new Map<number, { end: number; message: string }>();
  for (const issue of issues) {
    if (issue.code === 'MISSING_CHAR') return undefined;
    const index = counter.linePos(issue.pos[0]).line - 1;
    const line = lines[index];
    if (!line?.trim() || index === 0) return undefined;
    const start = owners[index] as number;
    if (dropped.has(start)) continue;
    const entry = parseDocument(lines[start] as string, {
      schema: 'core',
      customTags: [],
      resolveKnownTags: false,
      stringKeys: true,
    });
    const key = isMap(entry.contents) ? entry.contents.items[0]?.key : undefined;
    if (isScalar(key) && protectedKeys.includes(String(key.value))) return undefined;
    dropped.set(start, {
      end: ends.get(start) as number,
      message: issue.message,
    });
  }
  const removed = new Set<number>();
  for (const [start, { end }] of dropped)
    for (let index = start; index < end; index++) removed.add(index);
  return {
    source: retried
      .split('\n')
      .map((line, index) => (removed.has(index) ? '' : line))
      .join('\n'),
    problems: [...dropped.values()].map(({ message }) => message),
  };
}

export function parseFrontmatter(
  text: string,
  mappings: readonly string[] = [],
  protectedKeys: readonly string[] = []
): Frontmatter {
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
  let retried = source;
  if (document.errors.length || document.warnings.length) {
    let ambiguous = false;
    visit(document, (_, node) => {
      if ((!isCollection(node) && !isScalar(node)) || !node.range) return;
      const [start, end] = node.range;
      if (
        (isCollection(node) &&
          node.flow &&
          (lineCounter.linePos(start).line !== lineCounter.linePos(end - 1).line ||
            (source[end - 1] !== '}' && source[end - 1] !== ']'))) ||
        (isScalar(node) &&
          (((node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE') &&
            lineCounter.linePos(start).line !== lineCounter.linePos(end - 1).line) ||
            ((node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') &&
              /^[|>][^\n]*\+/.test(source.slice(start, end)))))
      )
        ambiguous = true;
    });
    if (ambiguous)
      return {
        fields: {},
        body,
        problems: [...document.errors, ...document.warnings].map((issue) => issue.message),
      };
    retried = tolerantSource(source);
    lineCounter = new LineCounter();
    document = parseDocument(retried, { ...options, lineCounter });
  }
  let issues = [...document.errors, ...document.warnings];
  const problems: string[] = [];
  if (issues.length) {
    const salvaged = salvageSource(source, retried, protectedKeys, issues, lineCounter);
    if (!salvaged) return { fields: {}, body, problems: issues.map((issue) => issue.message) };
    problems.push(...salvaged.problems);
    lineCounter = new LineCounter();
    document = parseDocument(salvaged.source, { ...options, lineCounter });
    issues = [...document.errors, ...document.warnings];
    if (issues.length) {
      for (const issue of issues) {
        const line = lineCounter.linePos(issue.pos[0]).line;
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
    const line = lineCounter.linePos(aliasOffset).line;
    return {
      fields: {},
      body,
      problems: [...problems, `${(error as Error).message} at line ${line}`],
    };
  }
  return { fields: fieldsFrom(parsed, mappings, problems), body, problems };
}
