export const CGI_DIR = 'cgi-bin';
export const CGI_TAG = 'sprinkle:';
export const CGI_LIMITS = {
  input: 64 * 1024,
  output: 4 * 1024 * 1024,
  stderr: 64 * 1024,
  head: 64 * 1024,
  timeoutMs: 30_000,
  parallel: 4,
  pollMs: 20_000,
  keepMs: 60_000,
  log: 1024 * 1024,
};

export type CgiHeaders = [string, string][];

export interface CgiRequest {
  method: string;
  path: string;
  query: string;
  headers: CgiHeaders;
  body: Uint8Array | null;
  tab: string | null;
}

export interface CgiHead {
  status: number;
  statusText: string;
  headers: CgiHeaders;
}

export type CgiParsed =
  | { kind: 'head'; head: CgiHead; body: Uint8Array }
  | { kind: 'body' }
  | { kind: 'more' }
  | { kind: 'bad'; reason: string };

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PREFIX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]*$/;
const HEADER = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/;
const STATUS = /^([2-5][0-9][0-9])(?:[ \t]+(.*))?$/;
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  302: 'Found',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function scriptOf(path: unknown): { script: string; pathInfo: string } | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  const segments: string[] = [];
  for (const raw of path.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) return undefined;
    segments.push(segment);
  }
  const [script, ...rest] = segments as [string, ...string[]];
  if (!script || script.startsWith('.')) return undefined;
  return { script, pathInfo: rest.length ? `/${rest.join('/')}` : '' };
}

export function methodOf(method: unknown): string | undefined {
  return typeof method === 'string' && TOKEN.test(method) ? method.toUpperCase() : undefined;
}

const clean = (value: string) => value.replace(/[\r\n\0]/g, ' ');

export function requestHeaders(headers: CgiHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!TOKEN.test(name)) continue;
    const key = name.toLowerCase();
    if (key === 'content-type' || key === 'content-length' || key === 'proxy') continue;
    const at = `HTTP_${key.toUpperCase().replace(/-/g, '_')}`;
    out[at] = out[at] === undefined ? clean(value) : `${out[at]}, ${clean(value)}`;
  }
  return out;
}

export interface CgiContext {
  request: CgiRequest;
  script: string;
  pathInfo: string;
  folder: string;
  sprinkle: string;
  owner: string;
  user: string;
}

export function cgiEnv(at: CgiContext): Record<string, string> {
  const { request, script, pathInfo, folder } = at;
  const type = request.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  return {
    ...requestHeaders(request.headers),
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
    SERVER_SOFTWARE: 'slicc-agent',
    SERVER_NAME: 'localhost',
    SERVER_PORT: '80',
    REMOTE_ADDR: '127.0.0.1',
    REQUEST_METHOD: request.method,
    QUERY_STRING: request.query,
    SCRIPT_NAME: `/${CGI_DIR}/${script}`,
    SCRIPT_FILENAME: `${folder}/${CGI_DIR}/${script}`,
    DOCUMENT_ROOT: folder,
    REQUEST_URI: `/${CGI_DIR}/${request.path}${request.query ? `?${request.query}` : ''}`,
    PATH_INFO: pathInfo,
    ...(pathInfo ? { PATH_TRANSLATED: `${folder}${pathInfo}` } : {}),
    ...(request.body ? { CONTENT_LENGTH: String(request.body.length) } : {}),
    ...(request.body && type !== undefined ? { CONTENT_TYPE: clean(type) } : {}),
    REMOTE_USER: at.user,
    SLICC_SPRINKLE: at.sprinkle,
    SLICC_OWNER: at.owner,
    ...(request.tab ? { SLICC_TAB: request.tab } : {}),
  };
}

function lineEnd(bytes: Uint8Array, from: number): number {
  return bytes.indexOf(10, from);
}

function decoded(bytes: Uint8Array, from: number, to: number): string {
  const end = to > from && bytes[to - 1] === 13 ? to - 1 : to;
  return new TextDecoder().decode(bytes.subarray(from, end));
}

export function headOf(lines: readonly string[]): CgiHead | string {
  let status: number | undefined;
  let statusText = '';
  const headers: CgiHeaders = [];
  for (const line of lines) {
    const [, name, value] = HEADER.exec(line) as unknown as [string, string, string];
    const key = name.toLowerCase();
    if (key === 'status') {
      const found = STATUS.exec(value);
      if (!found) return `bad Status header: ${value}`;
      status = Number(found[1]);
      statusText = found[2] ?? '';
    } else if (!HOP.has(key)) headers.push([name, value]);
  }
  const location = headers.some(([name]) => name.toLowerCase() === 'location');
  const code = status ?? (location ? 302 : 200);
  if (!location && !headers.some(([name]) => name.toLowerCase() === 'content-type'))
    headers.push(['Content-Type', 'text/plain']);
  return { status: code, statusText: statusText || REASONS[code] || '', headers };
}

export function parseHead(bytes: Uint8Array, ended: boolean): CgiParsed {
  const lines: string[] = [];
  let at = 0;
  for (;;) {
    const end = lineEnd(bytes, at);
    if (end < 0) break;
    const line = decoded(bytes, at, end);
    at = end + 1;
    if (line === '') {
      if (!lines.length) return { kind: 'body' };
      const head = headOf(lines);
      return typeof head === 'string'
        ? { kind: 'bad', reason: head }
        : { kind: 'head', head, body: bytes.subarray(at) };
    }
    if (!HEADER.test(line)) return { kind: 'body' };
    lines.push(line);
  }
  const rest = decoded(bytes, at, bytes.length);
  if (rest && !HEADER.test(rest) && (ended || !PREFIX.test(rest))) return { kind: 'body' };
  if (!ended) return bytes.length > CGI_LIMITS.head ? { kind: 'body' } : { kind: 'more' };
  if (rest) lines.push(rest);
  if (!lines.length) return { kind: 'body' };
  const head = headOf(lines);
  return typeof head === 'string'
    ? { kind: 'bad', reason: head }
    : { kind: 'head', head, body: new Uint8Array() };
}

export function shebang(bytes: Uint8Array): string[] | undefined {
  if (bytes[0] !== 35 || bytes[1] !== 33) return undefined;
  const end = bytes.indexOf(10);
  const line = decoded(bytes, 2, end < 0 ? Math.min(bytes.length, 256) : end).trim();
  const space = line.search(/[ \t]/);
  if (!line) return undefined;
  if (space < 0) return [line];
  const arg = line.slice(space).trim();
  return arg ? [line.slice(0, space), arg] : [line.slice(0, space)];
}

export interface Mode {
  mode?: number;
  uid?: number;
}

export function openTo(stat: Mode, uid: number): string | undefined {
  if (stat.mode !== undefined && (stat.mode & 0o022) !== 0)
    return `its group or others can write it (mode ${(stat.mode & 0o777).toString(8)})`;
  if (stat.uid !== undefined && stat.uid !== 0 && stat.uid !== uid)
    return `uid ${stat.uid} owns it, not the sprinkle's owner`;
  return undefined;
}

export function inside(path: string, root: string): boolean {
  return path.startsWith(`${root}/`);
}

export function tagOf(id: string): string {
  return `${CGI_TAG}${id}`;
}

export function sprinklesOf(tags: readonly string[]): string[] {
  return [
    ...new Set(
      tags.filter((tag) => tag.startsWith(CGI_TAG)).map((tag) => tag.slice(CGI_TAG.length))
    ),
  ];
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(out);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at++) out[at] = raw.charCodeAt(at);
  return out;
}
