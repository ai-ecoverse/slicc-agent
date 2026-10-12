const encoder = new TextEncoder();
const FRAGMENT = 16;
const MINIMUM = 8;

const bytesOf = (text) => encoder.encode(text);
const ascii = (bytes) => String.fromCharCode(...bytes);
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const urlSafe = (text) => text.replaceAll('+', '-').replaceAll('/', '_');

function base64Runs(value) {
  const bytes = bytesOf(value);
  const runs = [btoa(ascii(bytes))];
  for (const offset of [0, 1, 2]) {
    const encoded = btoa(ascii([...new Array(offset).fill(0), ...bytes, 0, 0, 0]));
    const first = Math.ceil((offset * 8) / 6);
    const last = Math.floor(((offset + bytes.length) * 8) / 6);
    const run = encoded.slice(first, last);
    if (run.length >= 8) runs.push(run);
  }
  return runs.flatMap((run) => [
    run,
    run.replace(/=+$/, ''),
    urlSafe(run),
    urlSafe(run).replace(/=+$/, ''),
  ]);
}

function escapes(value) {
  const json = JSON.stringify(value).slice(1, -1);
  const unicode = (upper) =>
    [...value]
      .map((char) => {
        const code = char.codePointAt(0);
        if (code >= 0x20 && code < 0x7f) return JSON.stringify(char).slice(1, -1);
        return [...char]
          .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
          .map((text) => (upper ? text.toUpperCase().replace('\\U', '\\u') : text))
          .join('');
      })
      .join('');
  const percent = encodeURIComponent(value);
  const html = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return [
    ['json', json],
    ['json', json.replaceAll('/', '\\/')],
    ['json', unicode(false)],
    ['json', unicode(true)],
    ['percent', percent],
    ['percent', percent.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase())],
    ['percent', percent.replaceAll('%20', '+')],
    ['html', html],
    ['html', html.replaceAll("'", '&#39;')],
    ['html', html.replaceAll("'", '&#x27;')],
    ...base64Runs(value).map((run) => ['base64', run]),
    ['hex', hex(bytesOf(value))],
    ['hex', hex(bytesOf(value)).toUpperCase()],
  ];
}

export function patternsOf(values) {
  const patterns = [];
  const seen = new Set();
  const add = (name, form, text, replacement) => {
    const bytes = typeof text === 'string' ? bytesOf(text) : text;
    const key = hex(bytes);
    if (!bytes.length || seen.has(key)) return;
    seen.add(key);
    patterns.push({ name, form, bytes, replacement: bytesOf(replacement) });
  };
  for (const { name, value, placeholder } of values) {
    if (bytesOf(value).length < MINIMUM)
      throw new Error(`${name}: values under ${MINIMUM} bytes are refused`);
    add(name, 'raw', value, placeholder);
    for (const [form, text] of escapes(value)) add(name, form, text, `[redacted:${name}]`);
    const raw = bytesOf(value);
    for (let length = raw.length - 1; length >= FRAGMENT; length--)
      for (let at = 0; at + length <= raw.length; at++)
        add(name, 'fragment', raw.slice(at, at + length), `[redacted:${name}]`);
  }
  return patterns.sort((a, b) => b.bytes.length - a.bytes.length);
}

const lower = (byte) => (byte >= 0x41 && byte <= 0x46 ? byte + 32 : byte);

function matchAt(input, at, pattern) {
  const { bytes, form } = pattern;
  if (at + bytes.length > input.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    const a = input[at + i];
    const b = bytes[i];
    if (a !== b && !(form === 'hex' && lower(a) === lower(b))) return false;
  }
  return true;
}

function prefixAt(input, at, pattern) {
  const rest = input.length - at;
  if (rest >= pattern.bytes.length) return false;
  for (let i = 0; i < rest; i++) if (input[at + i] !== pattern.bytes[i]) return false;
  return true;
}

export function compile(values, version = 1) {
  const patterns = patternsOf(values);
  const longest = patterns[0]?.bytes.length ?? 0;
  const byFirst = new Map();
  for (const pattern of patterns) {
    const first = pattern.bytes[0];
    const keys =
      pattern.form === 'hex'
        ? new Set([first, lower(first), first >= 0x61 && first <= 0x66 ? first - 32 : first])
        : [first];
    for (const key of keys) byFirst.set(key, [...(byFirst.get(key) ?? []), pattern]);
  }
  const scan = (input, final) => {
    const out = new Uint8Array(input.length * 4 + 64);
    let size = 0;
    const hits = new Map();
    let at = 0;
    let held = input.length;
    if (!final)
      for (let start = Math.max(0, input.length - longest); start < input.length; start++)
        if (patterns.some((pattern) => prefixAt(input, start, pattern))) {
          held = start;
          break;
        }
    while (at < held) {
      const found = byFirst.get(input[at])?.find((pattern) => matchAt(input, at, pattern));
      if (!found) {
        out[size++] = input[at];
        at++;
        continue;
      }
      const key = `${found.name}|${found.form}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      out.set(found.replacement, size);
      size += found.replacement.length;
      at += found.bytes.length;
    }
    return { bytes: out.slice(0, size), rest: input.slice(Math.max(at, held)), hits };
  };
  const listed = (hits) =>
    [...hits].map(([key, count]) => {
      const [name, form] = key.split('|');
      return { name, form, count };
    });
  return {
    version,
    bytes(input) {
      return scan(input, true).bytes;
    },
    text(input) {
      const done = scan(bytesOf(input), true);
      return { text: new TextDecoder().decode(done.bytes), hits: listed(done.hits) };
    },
    stream() {
      let rest = new Uint8Array();
      return {
        push(chunk) {
          const joined = new Uint8Array(rest.length + chunk.length);
          joined.set(rest);
          joined.set(chunk, rest.length);
          const done = scan(joined, false);
          rest = done.rest;
          return done.bytes;
        },
        end() {
          const done = scan(rest, true);
          rest = new Uint8Array();
          return done.bytes;
        },
      };
    },
  };
}
