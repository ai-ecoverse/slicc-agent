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

type Block = { key: string; folded: boolean; strip: boolean; lines: string[] };

const BLOCK = /^([|>])([+-]?)$/;

function blockValue(block: Block): string {
  const indents = block.lines
    .filter((line) => line.trim())
    .map((line) => (/^\s*/.exec(line) as RegExpExecArray)[0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const lines = block.lines.map((line) => line.slice(indent));
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const text = block.folded
    ? lines.reduce(
        (out, line) =>
          !line.trim()
            ? `${out}\n`
            : out && !out.endsWith('\n')
              ? `${out} ${line}`
              : `${out}${line}`,
        ''
      )
    : lines.join('\n');
  return block.strip || !text ? text : `${text}\n`;
}

type State = {
  fields: Record<string, FrontmatterValue>;
  problems: string[];
  nested: Set<string>;
  list: string | undefined;
  block: Block | undefined;
};

function pair(state: State, line: string): void {
  const found = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
  state.list = undefined;
  if (!found) {
    state.problems.push(`can't read the line "${line.trim()}"`);
    return;
  }
  const key = found[1] as string;
  const value = found[2]?.trim() ?? '';
  const style = BLOCK.exec(value);
  if (style) state.block = { key, folded: style[1] === '>', strip: style[2] === '-', lines: [] };
  else if (value === '') {
    state.fields[key] = [];
    state.list = key;
  } else state.fields[key] = scalar(value);
}

function line(state: State, text: string): void {
  const { block, list } = state;
  if (block && (!text.trim() || /^\s/.test(text))) {
    block.lines.push(text);
    return;
  }
  if (block) state.fields[block.key] = blockValue(block);
  state.block = undefined;
  if (!text.trim() || text.trimStart().startsWith('#')) return;
  const item = /^\s+-\s+(.*)$/.exec(text);
  if (item && list) (state.fields[list] as string[]).push(unquote((item[1] as string).trim()));
  else if (/^\s/.test(text) && list) state.nested.add(list);
  else pair(state, text);
}

export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match)
    return { fields: {}, body: normalized.trim(), problems: ['no frontmatter between --- lines'] };
  const state: State = {
    fields: {},
    problems: [],
    nested: new Set(),
    list: undefined,
    block: undefined,
  };
  for (const text of (match[1] as string).split('\n')) line(state, text);
  if (state.block) state.fields[state.block.key] = blockValue(state.block);
  for (const key of state.nested) {
    delete state.fields[key];
    state.problems.push(`"${key}" has nested values, which SLICC doesn't read`);
  }
  return {
    fields: state.fields,
    body: normalized.slice(match[0].length).trim(),
    problems: state.problems,
  };
}
