const SPECIAL = /[.+^$()|\\]/;

function braces(pattern: string, at: number): [string, number] | undefined {
  const end = pattern.indexOf('}', at);
  if (end < 0) return undefined;
  const options = pattern.slice(at + 1, end).split(',');
  if (options.length < 2) return undefined;
  return [`(?:${options.map((option) => source(option)).join('|')})`, end];
}

function klass(pattern: string, at: number): [string, number] | undefined {
  const end = pattern.indexOf(']', at + 2);
  if (end < 0) return undefined;
  const inner = pattern.slice(at + 1, end);
  const negated = inner.startsWith('!');
  const body = (negated ? inner.slice(1) : inner).replace(/[\\\]^]/g, '\\$&');
  return [`[${negated ? '^/' : ''}${body}]`, end];
}

function source(pattern: string): string {
  let out = '';
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at] as string;
    if (char === '*' && pattern[at + 1] === '*') {
      const slash = pattern[at + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      at += slash ? 2 : 1;
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if (char === '{' && braces(pattern, at)) {
      const [group, end] = braces(pattern, at) as [string, number];
      out += group;
      at = end;
    } else if (char === '[' && klass(pattern, at)) {
      const [group, end] = klass(pattern, at) as [string, number];
      out += group;
      at = end;
    } else
      out +=
        SPECIAL.test(char) || char === '{' || char === '}' || char === '[' || char === ']'
          ? `\\${char}`
          : char;
  }
  return out;
}

export function glob(pattern: string): (path: string) => boolean {
  const expression = new RegExp(`^${source(pattern)}$`);
  return (path) => expression.test(path);
}
