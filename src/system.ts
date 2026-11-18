import type { KernelClient } from './kernel/client.ts';
import { linkedExit, pageOnly, type Transport } from './net.ts';

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

const EXITS: Record<string, string> = {
  local: 'a linked slicc exit that fetches without CORS',
  remote: 'a linked slicc exit on another device that fetches without CORS',
  tailnet: "your tailnet's exit node, which fetches without CORS",
};

export function transportName(transport: Transport | undefined): string {
  const exit = linkedExit(transport);
  if (exit) return EXITS[exit.kind] ?? 'a linked exit that fetches without CORS';
  if (pageOnly(transport)) return "the page's own fetch, so only servers that allow CORS answer";
  if (transport?.traits?.manualRedirects) return 'a local proxy that fetches without CORS';
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
  const git = facts.commands.includes('git');
  const missing = RUNTIMES.filter((name) => !facts.commands.includes(name));
  return [
    `You run in seven, with slicc-agent ${facts.version} in /opt/agent. Work in /home and /tmp; /os and /opt are the system, so change them only when asked.`,
    'Install tools with `pnpm add -g <package>` (there is no ipk); /etc/slicc/optional.json lists the tested packages and their commands.',
    `Network: requests go through ${facts.transport}. localhost and 127.0.0.1 are this sandbox's own loopback, not the user's computer.`,
    ...(facts.browser
      ? [
          `Browser: one may be available (SLICC_CDP_URL is set), but nothing has checked that one is attached, so don't tell the user it's connected. ${facts.commands.includes('curlwright') ? 'playwright-cli and curlwright drive' : 'playwright-cli drives'} the user's own browser through the SLICC extension, with their logins. Read the browser skill and run its check before you use it.`,
        ]
      : []),
    ...(git
      ? [
          'Git: local repositories work. Clone, fetch and push over HTTPS need slicc linked or the SLICC extension connected; through the page alone they fail with a CORS or 502 error.',
        ]
      : []),
    `Not here yet: ${[...(git ? [] : ['git']), ...missing, ...(facts.browser ? [] : ['a browser or CDP tool']), 'GitHub credentials'].join(', ')}.`,
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
