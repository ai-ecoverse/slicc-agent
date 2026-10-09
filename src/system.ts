import type { KernelClient } from './kernel/client.ts';
import type { Transport } from './net.ts';

export interface SystemFacts {
  version: string;
  commands: string[];
  transport: string;
  browser?: boolean;
}

const LIST_PATH = 'IFS=:; for d in $PATH; do [ -d "$d" ] && ls -1 "$d"; done';
const RUNTIMES = ['node', 'python3'];

export async function commandsOnPath(client: KernelClient): Promise<string[]> {
  const decoder = new TextDecoder();
  let out = '';
  try {
    const process = await client.spawn(['bash', '-c', LIST_PATH], {
      onStdout: (bytes) => {
        out += decoder.decode(bytes, { stream: true });
      },
    });
    await process.exited;
  } catch {
    return [];
  }
  const names = out.split('\n').map((name) => name.trim());
  return [...new Set(names.filter(Boolean))].sort();
}

const BROWSER = '[ -n "$SLICC_CDP_URL" ] && command -v playwright-cli >/dev/null';

export async function browserConnected(client: KernelClient): Promise<boolean> {
  try {
    const process = await client.spawn(['bash', '-c', BROWSER], {});
    return (await process.exited) === 0;
  } catch {
    return false;
  }
}

export function transportName(transport: Transport | undefined): string {
  const traits = transport?.traits;
  if (traits?.crossOrigin === 'cors') {
    return "the page's own fetch, so only servers that allow CORS answer";
  }
  if (traits?.manualRedirects) return 'a local proxy (slicc-node) that fetches without CORS';
  return 'a relay that fetches without CORS';
}

export async function agentVersion(
  fetcher: (url: URL) => Promise<Response>,
  url = new URL('../package.json', import.meta.url)
): Promise<string> {
  try {
    const response = await fetcher(url);
    const manifest = response.ok ? ((await response.json()) as { version?: string }) : {};
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function systemSection(facts: SystemFacts): string {
  const missing = RUNTIMES.filter((name) => !facts.commands.includes(name));
  return [
    `You are SLICC's agent in seven: slicc-agent ${facts.version}, installed in /opt/agent. Your bash runs on the page's shared slicc-kernel, a WebAssembly sandbox in the user's browser, not on a server or the user's machine.`,
    "Files: / is the browser's private file system (OPFS). Work in /home and /tmp. /os and /opt are the system; change them only when asked.",
    `Commands on PATH: ${facts.commands.join(' ') || 'none found'}.`,
    "Install command-line tools with `pnpm add -g <package>`. There is no ipk. Tested packages that aren't preinstalled: `@ai-ecoverse/wasm-git` (git), `@ai-ecoverse/wasi-esbuild` (esbuild), `@ai-ecoverse/wasi-typescript` (tsc, TypeScript 7) and `@ai-ecoverse/wasi-biome` (biome: check, format, lint).",
    `Network: requests go through ${facts.transport}. localhost and 127.0.0.1 are this sandbox's own loopback, not the user's computer.`,
    ...(facts.browser
      ? [
          `Browser: ${facts.commands.includes('curlwright') ? 'playwright-cli and curlwright drive' : 'playwright-cli drives'} the user's own browser through the SLICC extension, with their logins. Read the browser skill before you use it.`,
        ]
      : []),
    facts.commands.includes('git')
      ? 'Git: local repositories work (init, add, commit, status, diff, restore, branch, checkout, log). Clone, fetch and push over HTTPS need slicc-node or the SLICC extension; through the page alone they fail with a CORS or 502 error.'
      : 'Git: not installed. When you need it, install it with `pnpm add -g @ai-ecoverse/wasm-git`.',
    `Not here yet: ${[...missing, ...(facts.browser ? [] : ['a browser or CDP tool']), 'GitHub credentials'].join(', ')}.`,
  ].join('\n');
}

export async function kernelBoot(client: KernelClient): Promise<string | null> {
  const decoder = new TextDecoder();
  let out = '';
  try {
    const process = await client.spawn(['cat', '/proc/stat'], {
      onStdout: (bytes) => {
        out += decoder.decode(bytes, { stream: true });
      },
    });
    await process.exited;
  } catch {
    return null;
  }
  return /^btime (\d+)$/m.exec(out)?.[1] ?? null;
}
