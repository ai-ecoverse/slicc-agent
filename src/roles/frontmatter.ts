export type FrontmatterValue = string | number | boolean | string[];

export interface Frontmatter {
  fields: Record<string, FrontmatterValue>;
  body: string;
  problems: string[];
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  if (!quoted) return value;
  return quoted[1] === '"'
    ? (quoted[2] as string).replace(/\\(["\\])/g, '$1')
    : (quoted[2] as string).replace(/''/g, "'");
}

function scalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (/^\[.*\]$/s.test(value))
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter(Boolean);
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match)
    return { fields: {}, body: normalized.trim(), problems: ['no frontmatter between --- lines'] };
  const fields: Record<string, FrontmatterValue> = {};
  const problems: string[] = [];
  let list: string | undefined;
  const nested = new Set<string>();
  for (const line of (match[1] as string).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      (fields[list] as string[]).push(unquote((item[1] as string).trim()));
      continue;
    }
    if (/^\s/.test(line) && list) {
      nested.add(list);
      continue;
    }
    const pair = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!pair) {
      problems.push(`can't read the line "${line.trim()}"`);
      list = undefined;
      continue;
    }
    const key = pair[1] as string;
    const value = pair[2]?.trim() ?? '';
    if (value === '') {
      fields[key] = [];
      list = key;
    } else {
      fields[key] = scalar(value);
      list = undefined;
    }
  }
  for (const key of nested) {
    delete fields[key];
    problems.push(`"${key}" has nested values, which SLICC doesn't read`);
  }
  return { fields, body: normalized.slice(match[0].length).trim(), problems };
}
