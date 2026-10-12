export const MAX_DEPTH = 4;

const BREAKS = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const NESTING = /[\s;&|`$()<>'"\\]/;
const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  f: '\f',
  v: '\v',
};

export interface Split {
  words: string[];
  nested: string[];
}

function closing(source: string, start: number, open: string, close: string): number {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '\\') index += 2;
    else if (char === "'" || char === '"') {
      const end = source.indexOf(char, index + 1);
      index = end < 0 ? source.length : end + 1;
    } else {
      if (char === open) depth++;
      else if (char === close && --depth === 0) return index;
      index++;
    }
  }
  return source.length;
}

function ansi(source: string, start: number): { text: string; end: number } {
  let text = '';
  let index = start;
  while (index < source.length && source[index] !== "'") {
    const char = source[index] as string;
    if (char !== '\\') {
      text += char;
      index++;
      continue;
    }
    const next = source[index + 1] ?? '';
    const hex =
      /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/.exec(
        source.slice(index + 1)
      );
    if (hex) {
      const code = hex[4] ? Number.parseInt(hex[4], 8) : Number.parseInt(hex.slice(1).join(''), 16);
      text += String.fromCodePoint(Math.min(code, 0x10ffff));
      index += 1 + hex[0].length;
    } else {
      text += ESCAPES[next] ?? next;
      index += 2;
    }
  }
  return { text, end: index + 1 };
}

class Scanner {
  readonly words: string[] = [];
  readonly nested: string[] = [];
  #word: string | undefined;
  #index = 0;

  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  #at(offset = 0): string {
    return this.source[this.#index + offset] ?? '';
  }

  #append(text: string): void {
    this.#word = (this.#word ?? '') + text;
  }

  #end(): void {
    if (this.#word !== undefined) this.words.push(this.#word);
    this.#word = undefined;
  }

  #substitute(from: number, open: string, close: string, prefix: string): void {
    const stop = closing(this.source, from, open, close);
    const inner = this.source.slice(from, stop);
    this.nested.push(inner);
    this.#append(`${prefix}${inner}${close}`);
    this.#index = stop + 1;
  }

  #backtick(): void {
    let stop = this.#index + 1;
    while (stop < this.source.length && this.source[stop] !== '`')
      stop += this.source[stop] === '\\' ? 2 : 1;
    this.nested.push(this.source.slice(this.#index + 1, stop).replace(/\\(.)/g, '$1'));
    this.#append(this.source.slice(this.#index, stop + 1));
    this.#index = stop + 1;
  }

  #dollar(): boolean {
    const next = this.#at(1);
    if (next === '(') this.#substitute(this.#index + 2, '(', ')', '$(');
    else if (next === '{') this.#substitute(this.#index + 2, '{', '}', '${');
    else return false;
    return true;
  }

  #single(): void {
    const stop = this.source.indexOf("'", this.#index + 1);
    const last = stop < 0 ? this.source.length : stop;
    this.#append(this.source.slice(this.#index + 1, last));
    this.#index = last + 1;
  }

  #double(): void {
    this.#append('');
    this.#index++;
    while (this.#index < this.source.length && this.#at() !== '"') {
      const char = this.#at();
      if (char === '\\' && '$`"\\\n'.includes(this.#at(1) || 'x')) {
        if (this.#at(1) !== '\n') this.#append(this.#at(1));
        this.#index += 2;
      } else if (char === '`') this.#backtick();
      else if (!(char === '$' && this.#dollar())) this.#plain(char);
    }
    this.#index++;
  }

  #plain(char: string): void {
    this.#append(char);
    this.#index++;
  }

  #comment(): void {
    const stop = this.source.indexOf('\n', this.#index);
    this.#index = stop < 0 ? this.source.length : stop;
  }

  #escape(): void {
    if (this.#at(1) !== '\n') this.#append(this.#at(1));
    this.#index += 2;
  }

  #quote(char: string): boolean {
    if (char === "'") this.#single();
    else if (char === '"') this.#double();
    else if (char === '$' && this.#at(1) === "'") {
      const quoted = ansi(this.source, this.#index + 2);
      this.#append(quoted.text);
      this.#index = quoted.end;
    } else return false;
    return true;
  }

  #step(char: string): void {
    if ((char === '<' || char === '>') && this.#at(1) === '(') {
      this.#end();
      this.#substitute(this.#index + 2, '(', ')', `${char}(`);
      this.#end();
    } else if (char === '#' && this.#word === undefined) this.#comment();
    else if (BREAKS.has(char)) {
      this.#end();
      this.#index++;
    } else if (char === '\\') this.#escape();
    else if (this.#quote(char)) return;
    else if (char === '`') this.#backtick();
    else if (!(char === '$' && this.#dollar())) this.#plain(char);
  }

  scan(): Split {
    while (this.#index < this.source.length) this.#step(this.#at());
    this.#end();
    return { words: this.words, nested: this.nested };
  }
}

export function split(source: string): Split {
  return new Scanner(source).scan();
}

export function words(source: string, depth = 0, seen = new Set<string>()): string[] {
  seen.add(source);
  const { words: found, nested } = split(source);
  if (depth >= MAX_DEPTH) return found;
  const deeper = [...nested, ...found.filter((word) => NESTING.test(word))].filter(
    (inner) => !seen.has(inner)
  );
  for (const inner of deeper) seen.add(inner);
  return [...found, ...deeper.flatMap((inner) => words(inner, depth + 1, seen))];
}
