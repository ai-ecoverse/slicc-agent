import type { McpServerEntry } from '@ai-ecoverse/slicc-vault';
import type { ModelRoute } from './fetch.ts';
import type { AgentRecord } from './records.ts';
import type { Vault } from './vault.ts';

export const BEDROCK_ENDPOINTS = [
  'https://bedrock-runtime.{region}.amazonaws.com',
  'https://bedrock-runtime-fips.{region}.amazonaws.com',
];

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KERNEL = /^(\d{1,5})\.kernel\.localhost$/;
const FACADE = 9222;

function plain(url: URL): boolean {
  return !url.username && !url.password && (url.port === '' || url.port === '443');
}

export function modelUrl(raw: string): boolean {
  const url = URL.parse(raw);
  return !!url && url.protocol === 'https:' && plain(url) && !raw.includes('{');
}

function kernelUrl(url: URL): boolean {
  const port = Number(KERNEL.exec(url.hostname)?.[1] ?? 0);
  return (
    url.protocol === 'http:' && url.port === '' && port >= 1 && port <= 65535 && port !== FACADE
  );
}

export function mcpUrl(raw: string): boolean {
  const url = URL.parse(raw);
  return (
    !!url &&
    !url.username &&
    !url.password &&
    (kernelUrl(url) || (url.protocol === 'https:' && plain(url)))
  );
}

const escaped = (text: string) => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

export function pattern(base: string): RegExp {
  const trimmed = base.replace(/\/+$/, '');
  const source = trimmed
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? '[^./]+' : escaped(part)))
    .join('');
  return new RegExp(`^${source}(?:[/?#]|$)`, 'i');
}

export interface ModelBases {
  provider: string;
  urls: readonly string[];
}

export function modelRoute(
  bases: () => readonly ModelBases[],
  records: () => readonly AgentRecord[]
): ModelRoute {
  return (request) => {
    const url = request.url;
    const matched = bases()
      .filter(({ urls }) => urls.some((base) => pattern(base).test(url)))
      .map(({ provider }) => provider);
    const head = [url, ...[...request.headers].map(([, value]) => value)].join('\n');
    const held = records()
      .filter((record) => record.kind === 'model' && head.includes(record.placeholder))
      .map((record) => record.provider);
    const owned = matched.filter((provider) => held.includes(provider));
    if (owned.length === 1) return owned[0];
    if (matched.length === 1 && !held.length) return matched[0];
    return matched.length || held.length ? null : undefined;
  };
}

export interface McpServerSource {
  server: string;
  url: string;
  names: readonly string[];
}

export function mcpEndpoints(
  servers: readonly McpServerSource[],
  tokens: ReadonlyMap<string, string>
): McpServerEntry[] {
  return servers
    .filter((entry) => mcpUrl(entry.url))
    .map(({ server, url, names }) => {
      const tokenUrl = tokens.get(server);
      const valid = names.filter((name) => NAME.test(name));
      return {
        server,
        url,
        ...(valid.length ? { names: valid } : {}),
        ...(tokenUrl && modelUrl(tokenUrl) ? { tokenUrl } : {}),
      };
    });
}

export interface Endpoints {
  servers(servers: readonly McpServerSource[]): Promise<void>;
  token(server: string, url: string): Promise<void>;
  close(): void;
}

export function vaultEndpoints(vault: Pick<Vault, 'state' | 'connected' | 'endpoints'>): Endpoints {
  let servers: readonly McpServerSource[] = [];
  const tokens = new Map<string, string>();
  let last = '';
  const send = async (force = false) => {
    const set = { mcp: mcpEndpoints(servers, tokens) };
    const key = JSON.stringify(set);
    if (!vault.connected || (!force && key === last)) return;
    last = key;
    await vault.endpoints(set).catch((error: unknown) => {
      if (last === key) last = '';
      throw error;
    });
  };
  let port = vault.state.value.port;
  const off = vault.state.subscribe((value) => {
    const opened = port === 'none' && value.port !== 'none';
    port = value.port;
    if (opened) void send(true).catch(() => undefined);
  });
  return {
    servers(next) {
      servers = next;
      return send();
    },
    token(server, url) {
      if (!tokens.has(server)) tokens.set(server, new URL(url).href);
      return send();
    },
    close: off,
  };
}
