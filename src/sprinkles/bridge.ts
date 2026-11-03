import type { Context, JsonValue } from '@earendil-works/chord';
import type { InheritedTaint } from '../guests/guard.ts';
import type { LickTarget } from '../licks/lick.ts';
import type { Licks } from '../licks/licks.ts';
import { CGI_DIR, type CgiHeaders, type CgiRequest, fromBase64 } from './cgi.ts';
import { type CgiKernel, cgiReply, cgiRunner } from './cgi-run.ts';
import type { Sprinkle } from './kind.ts';

export const NO_OWNER = 'this sprinkle has no owner, so it can only be shown';

export interface SprinkleLick {
  target: string;
  source: string | null;
  text: string;
  user: string | null;
  taints: readonly InheritedTaint[];
}

export interface CgiBridgeOptions {
  licks: Pick<Licks, 'deliver'>;
  kernelOf?: (agentId: string) => Promise<CgiKernel | undefined>;
  find(id: string): Sprinkle | undefined;
  folder(id: string): string | undefined;
  owner(id: string, context: Context): Promise<string | undefined>;
}

export function targetOf(agentId: string): LickTarget {
  return agentId.startsWith('scoop:') ? (agentId as LickTarget) : `cone:${agentId}`;
}

function kernelId(agentId: string): string {
  return agentId.startsWith('scoop:') ? agentId : `cone:${agentId}`;
}

export function folderOf(name: string, path: string): string | undefined {
  return path.endsWith(`/${name}/${name}.shtml`)
    ? path.slice(0, -`/${name}.shtml`.length)
    : undefined;
}

function pairsOf(value: unknown): CgiHeaders {
  return (Array.isArray(value) ? value : [])
    .filter(
      (pair): pair is [string, string] =>
        Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
    )
    .map(([name, text]) => [name, text]);
}

export function cgiRequest(value: unknown): CgiRequest {
  const given = (value ?? {}) as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === 'string' ? field : '');
  return {
    method: text(given.method) || 'GET',
    path: text(given.path),
    query: text(given.query).replace(/^\?/, ''),
    headers: pairsOf(given.headers),
    body: text(given.body) ? fromBase64(text(given.body)) : null,
    tab: text(given.tab) || null,
  };
}

export function cgiBridge(options: CgiBridgeOptions) {
  const runner = cgiRunner();
  const kernelOf = async (owner: string) => options.kernelOf?.(kernelId(owner));
  return {
    methods(
      id: string,
      args: readonly unknown[],
      using: Context
    ): Record<string, () => Promise<JsonValue>> {
      return {
        async cgi() {
          const request = cgiRequest(args[0]);
          const folder = options.folder(id);
          if (!folder) return { ...cgiReply(404, `${id} has no folder, so no ${CGI_DIR}/`) };
          const owner = await options.owner(id, using);
          const kernel = owner ? await kernelOf(owner) : undefined;
          if (!owner || !kernel) return { ...cgiReply(403, NO_OWNER) };
          return { ...(await runner.start({ id, folder, owner }, kernel, request)) };
        },
        async cgiRead() {
          return { ...(await runner.read(String(args[0]), id)) };
        },
        async cgiClose() {
          runner.close(String(args[0]), id);
          return null;
        },
      };
    },
    async lick(id: string, ask: SprinkleLick, using: Context): Promise<string | undefined> {
      const sprinkle = options.find(id);
      if (!sprinkle) return `there is no sprinkle ${id}`;
      const owner = await options.owner(id, using);
      if (!owner) return NO_OWNER;
      const kernel = await kernelOf(owner);
      if (!kernel || kernel.user !== (ask.user ?? 'root'))
        return `only ${id}'s own scripts, running as its owner, send its licks`;
      if (ask.target !== owner && ask.target !== targetOf(owner))
        return `a sprinkle's lick goes to its owner: agent send ${owner} --lick=sprinkle`;
      if (ask.source !== null && ask.source !== sprinkle.name && ask.source !== id)
        return `this process belongs to sprinkle ${id}, so it can't send for ${ask.source}`;
      await options.licks.deliver(
        {
          channel: 'sprinkle',
          source: `sprinkle:${id}`,
          title: sprinkle.title,
          text: ask.text,
          target: targetOf(owner),
          ...(ask.taints.length ? { taints: ask.taints } : {}),
        },
        using
      );
      return undefined;
    },
    stop: () => runner.stop(),
  };
}
