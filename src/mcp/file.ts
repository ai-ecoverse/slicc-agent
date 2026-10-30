import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { quote } from '../kernel/env.ts';
import type { McpEdit } from '../services.ts';
import {
  isRecord,
  type McpServerConfig,
  type McpServerEntry,
  parseMcpConfig,
  usesOAuth,
  validateServer,
} from './config.ts';
import { shown } from './paths.ts';

export type McpRemoved = McpEdit & { removed?: McpServerEntry };

export interface McpFile {
  add(name: string, entry: unknown): Promise<McpEdit>;
  remove(name: string): Promise<McpRemoved>;
}

interface McpDocument {
  root: Record<string, unknown>;
  servers: Record<string, unknown>;
  text: string;
}

const refused = (reason: string) => ({ ok: false as const, reason });

export function tokenName(server: string): string {
  return `MCP_${server.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
}

function entryOf(name: string, given: unknown): McpServerConfig | { reason: string } {
  if (!isRecord(given)) return { reason: 'must be an object' };
  const { token, ...entry } = given;
  if (token !== undefined && typeof token !== 'boolean')
    return { reason: 'token must be true or false' };
  const checked = validateServer(name, entry);
  if ('message' in checked) return { reason: checked.message };
  if (!token) return checked;
  if (!usesOAuth(checked))
    return { reason: 'a token and an Authorization header exclude each other' };
  const authorization = `Bearer \${${tokenName(name)}}`;
  const headers = { ...checked.headers, Authorization: authorization };
  const signed = validateServer(name, { ...checked, headers });
  return 'message' in signed ? { reason: signed.message } : signed;
}

function rendered(root: Record<string, unknown>, servers: Record<string, unknown>): string {
  return `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
}

async function replace(
  env: ExecutionEnv,
  path: string,
  text: string,
  context: Context
): Promise<boolean> {
  const staged = `${path}.${crypto.randomUUID()}.tmp`;
  const dir = quote(path.slice(0, path.lastIndexOf('/')));
  const made = await env.exec(
    `mkdir -p ${dir} && (umask 077 && : > ${quote(staged)}) && chmod 600 ${quote(staged)}`,
    undefined,
    context
  );
  if (made.ok && made.value.exitCode === 0) {
    const wrote = await env.writeFile(staged, text, context);
    if (wrote.ok && (await env.renameFile(staged, path, context)).ok) return true;
  }
  await env.remove(staged, { force: true }, context);
  return false;
}

export function mcpFile(env: ExecutionEnv, path: string, home: string, context: Context): McpFile {
  const named = shown(path, home);
  const unwritten = `Couldn't write ${named}, so it is unchanged.`;
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  const load = async (): Promise<McpDocument | { reason: string }> => {
    const read = await env.readTextFile(path, context);
    if (!read.ok && read.error.code !== 'not_found')
      return { reason: `Couldn't read ${named}, so it is unchanged.` };
    const text = read.ok ? read.value : '';
    if (text.trim() === '') return { root: {}, servers: {}, text };
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      return { reason: `${named} isn't valid JSON, so it is unchanged. Fix the file first.` };
    }
    if (!isRecord(root) || (root.mcpServers !== undefined && !isRecord(root.mcpServers)))
      return { reason: `${named} needs an object of mcpServers, so it is unchanged.` };
    return { root, servers: (root.mcpServers ?? {}) as Record<string, unknown>, text };
  };
  return {
    add: (name, entry) =>
      inTurn(async () => {
        const file = await load();
        if ('reason' in file) return refused(file.reason);
        if (Object.hasOwn(file.servers, name))
          return refused(`${named} already has a server called "${name}". Remove it first.`);
        const config = entryOf(name, entry);
        if ('reason' in config) return refused(config.reason);
        const text = rendered(file.root, { ...file.servers, [name]: config });
        const clash = parseMcpConfig(text).problems.find((problem) => problem.server === name);
        if (clash) return refused(clash.message);
        return (await replace(env, path, text, context)) ? { ok: true } : refused(unwritten);
      }),
    remove: (name) =>
      inTurn(async () => {
        const file = await load();
        if ('reason' in file) return refused(file.reason);
        if (!Object.hasOwn(file.servers, name))
          return refused(`${named} has no server called "${name}".`);
        const removed = parseMcpConfig(file.text).servers.find((entry) => entry.name === name);
        const { [name]: _gone, ...servers } = file.servers;
        const text = rendered(file.root, servers);
        if (!(await replace(env, path, text, context))) return refused(unwritten);
        return { ok: true, ...(removed ? { removed } : {}) };
      }),
  };
}
