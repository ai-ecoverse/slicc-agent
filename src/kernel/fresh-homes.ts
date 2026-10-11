import type { Context } from '@earendil-works/chord';
import type { Conversation } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { AGENT_DIR, SCOOPS_ROOT } from '../layout.ts';
import { quote } from './env.ts';

export const HOMES_MARKER = '/var/lib/slicc/agent/users-v1';
export const HOMES_KIND = 'slicc.homes';
export const WORKSPACE = '/workspace';
export const SHARED_STATE = new Set(['.gelatiere', '.welcomed', '.welcome.json']);

export function homesNotice(cone: string, legacy: readonly string[]): string {
  return [
    `SLICC now gives each cone and scoop its own user and home. This cone works in /home/${cone}, and its scoops in /home/scoop-<name>.`,
    `Your earlier files weren't moved: ${legacy.join(', ')} stay where they were, owned by root, and only root can read them now.`,
    `Agent-wide settings, MCP servers, skills and roles now live in ${AGENT_DIR}, memory in /root/.pi/agent/memory, licks in each cone's ~/.slicc and sprinkles in each cone's ~/sprinkles.`,
    `To keep something, move it from the terminal, which runs as root, for example: mv /home/sprinkles/board.shtml /home/${cone}/sprinkles/ && chown -R ${cone}:${cone} /home/${cone}/sprinkles`,
  ].join('\n\n');
}

export async function legacyPaths(
  root: Pick<ExecutionEnv, 'listDir' | 'exists'>,
  users: readonly string[],
  context: Context
): Promise<string[]> {
  const listed = await root.listDir('/home', context);
  const kept = new Set([...users, ...SHARED_STATE]);
  const inHome = (listed.ok ? listed.value : [])
    .filter((entry) => !kept.has(entry.name))
    .map((entry) => `/home/${entry.name}`)
    .sort();
  const others: string[] = [];
  for (const path of [SCOOPS_ROOT, WORKSPACE]) {
    const found = await root.exists(path, context);
    if (found.ok && found.value) others.push(path);
  }
  return [...inHome, ...others];
}

export async function freshHomes(
  root: Pick<ExecutionEnv, 'listDir' | 'exists' | 'exec' | 'writeFile'>,
  users: readonly string[],
  cone: { id: string; conversation: Conversation | undefined },
  context: Context
): Promise<string[] | undefined> {
  const marked = await root.exists(HOMES_MARKER, context);
  if (marked.ok && marked.value) return undefined;
  const legacy = await legacyPaths(root, users, context);
  if (legacy.length) {
    await root.exec(`chmod -R go-rwx ${legacy.map(quote).join(' ')}`, undefined, context);
    const text = homesNotice(cone.id, legacy);
    await cone.conversation?.submit(
      {
        type: 'write',
        entry: {
          kind: HOMES_KIND,
          data: { legacy },
          model: [{ role: 'user', content: text, timestamp: Date.now() }],
        },
      },
      context
    );
  }
  await root.writeFile(HOMES_MARKER, `${new Date().toISOString()}\n`, context);
  return legacy;
}
