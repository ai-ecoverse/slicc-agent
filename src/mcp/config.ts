import { hash } from '../licks/sources.ts';

export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

export interface McpServerConfig {
  url: string;
  headers?: Record<string, string>;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  enabled?: boolean;
  timeout?: number;
  description?: string;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
}

export interface McpConfigProblem {
  server?: string;
  field?: string;
  message: string;
}

export interface McpConfig {
  servers: McpServerEntry[];
  problems: McpConfigProblem[];
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const EXPOSURES: readonly string[] = ['codemode', 'deferred', 'direct', 'hidden'];
const ALIASES: Record<string, McpExposure> = { 'codemode-deferred': 'codemode' };
const ACCEPTED = new Set([
  'type',
  'url',
  'headers',
  'exposure',
  'toolExposure',
  'enabled',
  'timeout',
  'description',
]);
const SECRET_HEADER = /authorization|cookie|token|key|secret|password|session/i;
const SECRET_PARAM = /token|key|secret|password|signature|sig|auth|code/i;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SCHEME = /^\s*(?:bearer|basic|token|apikey|api-key)\s+/i;
const MAX_TOOL_NAME = 64;
export const DEFAULT_TIMEOUT_SECONDS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function alias(value: unknown): unknown {
  return typeof value === 'string' ? (ALIASES[value] ?? value) : value;
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && EXPOSURES.includes(value);
}

export function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

export function literalSecret(header: string, value: string): boolean {
  if (!SECRET_HEADER.test(header)) return false;
  return value.replace(PLACEHOLDER, '').replace(SCHEME, '').trim() !== '';
}

function urlSecret(url: URL): string | undefined {
  if (url.username || url.password) return 'url';
  for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) return `url ?${name}`;
  return undefined;
}

type Checked = McpServerConfig | McpConfigProblem;

function fail(server: string, message: string, field?: string): McpConfigProblem {
  return { server, ...(field ? { field } : {}), message };
}

function checkHeaders(name: string, headers: unknown): McpConfigProblem | undefined {
  if (headers === undefined) return undefined;
  if (!isRecord(headers) || !Object.values(headers).every((value) => typeof value === 'string'))
    return fail(name, 'headers must map names to strings', 'headers');
  for (const [header, value] of Object.entries(headers as Record<string, string>)) {
    if (value.trim().startsWith('!'))
      return fail(
        name,
        `headers.${header} runs a command, which SLICC can't do`,
        `headers.${header}`
      );
    if (literalSecret(header, value))
      return fail(
        name,
        `headers.${header} holds a literal secret. mcp.json is readable by every agent: write \${NAME} instead, and add the value in Settings › Accounts`,
        `headers.${header}`
      );
  }
  return undefined;
}

function checkExposures(
  name: string,
  value: Record<string, unknown>
): McpConfigProblem | undefined {
  const allowed = EXPOSURES.map((item) => `"${item}"`).join(', ');
  if (value.exposure !== undefined && !isExposure(value.exposure))
    return fail(name, `exposure must be one of ${allowed}`, 'exposure');
  if (value.toolExposure === undefined) return undefined;
  if (!isRecord(value.toolExposure))
    return fail(name, 'toolExposure must map tool names to exposures', 'toolExposure');
  for (const [tool, exposure] of Object.entries(value.toolExposure))
    if (!isExposure(exposure))
      return fail(name, `toolExposure "${tool}" must be one of ${allowed}`, `toolExposure.${tool}`);
  return undefined;
}

function checkFields(name: string, value: Record<string, unknown>): McpConfigProblem | undefined {
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    return fail(name, 'enabled must be a boolean', 'enabled');
  if (value.description !== undefined && typeof value.description !== 'string')
    return fail(name, 'description must be a string', 'description');
  if (value.timeout !== undefined && (typeof value.timeout !== 'number' || !(value.timeout > 0)))
    return fail(name, 'timeout must be a positive number of seconds', 'timeout');
  return undefined;
}

function checkTransport(
  name: string,
  value: Record<string, unknown>
): McpConfigProblem | undefined {
  if (value.command !== undefined || value.type === 'stdio')
    return fail(name, 'stdio servers need slicc-kernel#68, so this one is skipped', 'command');
  if (value.type === 'sse')
    return fail(
      name,
      'the legacy SSE transport is not supported; use the streamable HTTP URL',
      'type'
    );
  if (value.type !== undefined && value.type !== 'http' && value.type !== 'streamable-http')
    return fail(name, 'type must be "http" or "streamable-http"', 'type');
  if (typeof value.url !== 'string') return fail(name, 'needs a "url" (streamable HTTP)', 'url');
  if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol))
    return fail(name, 'url must be an http or https URL', 'url');
  const secret = urlSecret(new URL(value.url));
  if (secret)
    return fail(
      name,
      `${secret} holds a literal secret. Put it in a header as \${NAME} and add the value in Settings › Accounts`,
      'url'
    );
  return undefined;
}

export function validateServer(name: string, raw: unknown): Checked {
  if (!SERVER_NAME.test(name))
    return fail(name, `invalid server name "${name}" (use letters, digits, "_" and "-")`);
  if (!isRecord(raw)) return fail(name, 'must be an object');
  const value: Record<string, unknown> = { ...raw, exposure: alias(raw.exposure) };
  if (raw.exposure === undefined) delete value.exposure;
  if (isRecord(raw.toolExposure))
    value.toolExposure = Object.fromEntries(
      Object.entries(raw.toolExposure).map(([tool, exposure]) => [tool, alias(exposure)])
    );
  for (const key of Object.keys(value))
    if (key === 'oauth' || key === 'auth')
      return fail(name, `${key} is not supported in SLICC yet`, key);
  const problem =
    checkTransport(name, value) ??
    checkHeaders(name, value.headers) ??
    checkExposures(name, value) ??
    checkFields(name, value);
  if (problem) return problem;
  const config: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    if (ACCEPTED.has(key) && key !== 'type') config[key] = entry;
  return config as unknown as McpServerConfig;
}

function canonical(name: string): string {
  return name.replace(/-/g, '_');
}

export function parseMcpConfig(text: string | undefined): McpConfig {
  if (text === undefined || text.trim() === '') return { servers: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { servers: [], problems: [{ message: `not valid JSON: ${(error as Error).message}` }] };
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)))
    return { servers: [], problems: [{ message: 'mcpServers must be an object' }] };
  const servers: McpServerEntry[] = [];
  const problems: McpConfigProblem[] = [];
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries((parsed.mcpServers ?? {}) as Record<string, unknown>)) {
    const checked = validateServer(name, raw);
    if ('message' in checked) {
      problems.push(checked);
      continue;
    }
    if (seen.has(canonical(name))) {
      problems.push(fail(name, 'names that differ only in "-" and "_" count as the same server'));
      continue;
    }
    seen.add(canonical(name));
    servers.push({ name, config: checked });
  }
  return { servers, problems };
}

function patternRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

export function nameMatcher(entries: readonly string[]): (name: string) => boolean {
  const names = new Set(entries.filter((entry) => !entry.includes('*')));
  const patterns = entries.filter((entry) => entry.includes('*')).map(patternRegExp);
  return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

export function toolExposure(config: McpServerConfig, tool: string): McpExposure {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[tool];
  if (exact !== undefined) return exact;
  for (const [pattern, exposure] of Object.entries(overrides))
    if (pattern.includes('*') && patternRegExp(pattern).test(tool)) return exposure;
  return config.exposure ?? 'codemode';
}

export function mcpNamespace(server: string): string {
  return `mcp__${canonical(server)}`;
}

export function mcpToolName(
  server: string,
  tool: string,
  taken: (name: string) => boolean = () => false
): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (name.length <= MAX_TOOL_NAME && !taken(name)) return name;
  const suffix = hash(`${server}\0${tool}`).padStart(7, '0').slice(0, 7);
  return `${name.slice(0, MAX_TOOL_NAME - suffix.length - 1)}_${suffix}`;
}

export function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
