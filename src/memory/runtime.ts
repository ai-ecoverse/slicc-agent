import {
  type Context,
  type MutableReplicatedState,
  type ReplicatedState,
  replicatedState,
} from '@earendil-works/chord';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import type { Agents } from '../agents.ts';
import type { Role } from '../roles/roles.ts';
import { MEMORY_FILE, type MemoryEntry, type MemoryScope, type MemoryTag } from './format.ts';
import type { Host } from './prompt.ts';
import { MEMORY_WRITE } from './prompt.ts';
import {
  GLOBAL,
  MemoryFiles,
  memoryRoot,
  type Place,
  placeOf,
  ROLE_PREFIX,
  roleRoot,
} from './store.ts';

export type Answer = { code: number; out: string };

export interface MemoryDraft {
  id?: string;
  scope: string;
  section: string;
  title: string;
  body: string;
  tag: MemoryTag | null;
}

export interface MemoryRuntime {
  readonly memories: ReplicatedState<MemoryEntry[]>;
  readonly scopes: ReplicatedState<MemoryScope[]>;
  save(draft: MemoryDraft, context: Context): Promise<MemoryEntry>;
  remove(id: string, context: Context): Promise<boolean>;
  command(argv: readonly string[], caller: string | null, context: Context): Promise<Answer>;
  reload(context: Context): Promise<void>;
  close(context: Context): Promise<void>;
}

export interface MemoryAttach {
  agents: Agents;
  env: ExecutionEnv;
  home: string;
  reloadMs: number;
  roles?: (context: Context) => Promise<{ roles: readonly Role[] } | undefined>;
}

export const USAGE = `usage:
  memory show [<scope>]   print a memory file (yours by default)
  memory scopes           every memory scope, its entries and its file

Scopes: global (everyone), a cone's id, or role:<path> for a role's memory.
Agents write memory with the ${MEMORY_WRITE} tool; the files are plain markdown you can edit.
`;

type Listed = Place & { group?: 'cones' | 'roles'; name: string };

async function roleDirs(
  env: ExecutionEnv,
  dir: string,
  prefix: string,
  context: Context,
  depth = 0
): Promise<string[]> {
  const listed = await env.listDir(dir, context);
  if (!listed.ok || depth > 4) return [];
  const out: string[] = [];
  for (const info of listed.value) {
    if (info.kind !== 'directory') continue;
    const path = prefix ? `${prefix}/${info.name}` : info.name;
    const found = await env.exists(`${dir}/${info.name}/${MEMORY_FILE}`, context);
    if (found.ok && found.value) out.push(path);
    out.push(...(await roleDirs(env, `${dir}/${info.name}`, path, context, depth + 1)));
  }
  return out;
}

export async function listPlaces(options: MemoryAttach, context: Context): Promise<Listed[]> {
  const { agents, env, home } = options;
  const state = agents.state();
  const out: Listed[] = [{ ...(placeOf(home, GLOBAL) as Place), name: 'Everyone' }];
  const cones = new Set(Object.keys(state.cones));
  const stored = await env.listDir(memoryRoot(home), context);
  if (stored.ok)
    for (const info of stored.value) if (info.kind === 'directory') cones.add(info.name);
  for (const id of cones) {
    const place = placeOf(home, id);
    if (place) out.push({ ...place, group: 'cones', name: state.cones[id]?.name ?? id });
  }
  const roles = new Set(await roleDirs(env, roleRoot(home), '', context));
  const known = await options.roles?.(context).catch(() => undefined);
  for (const role of known?.roles ?? [])
    if (role.memory?.scope === 'user') roles.add(role.memory.path);
  for (const path of [...roles].sort()) {
    const place = placeOf(home, `${ROLE_PREFIX}${path}`);
    if (place) out.push({ ...place, group: 'roles', name: path.split('/').at(-1) ?? path });
  }
  return out;
}

function callerScope(agents: Agents, caller: string | null): string {
  if (caller?.startsWith('cone:')) return caller.slice('cone:'.length);
  const record = caller ? agents.state().scoops[caller] : undefined;
  if (record?.memory?.scope === 'user') return `${ROLE_PREFIX}${record.memory.path}`;
  return agents.activeCone();
}

type Parts = {
  options: MemoryAttach;
  files: MemoryFiles;
  memories: MutableReplicatedState<MemoryEntry[]>;
  scopes: MutableReplicatedState<MemoryScope[]>;
  reload: (context: Context) => Promise<void>;
};

function placeFor(home: string, scope: string): Place {
  const place = placeOf(home, scope);
  if (!place) throw new Error(`there is no memory scope ${scope}`);
  return place;
}

async function save(parts: Parts, draft: MemoryDraft, context: Context): Promise<MemoryEntry> {
  const { files, memories, options } = parts;
  const place = placeFor(options.home, draft.scope);
  const previous = draft.id ? memories.value.find((item) => item.id === draft.id) : undefined;
  const moved = previous && previous.scope !== draft.scope;
  if (previous && moved)
    await files.change(
      placeFor(options.home, previous.scope),
      { kind: 'remove', id: previous.id },
      context
    );
  const written = await files.change(
    place,
    {
      kind: 'save',
      ...(previous && !moved ? { id: previous.id } : {}),
      section: draft.section,
      title: draft.title,
      body: draft.body,
      tag: draft.tag,
    },
    context
  );
  await parts.reload(context);
  return written.entry as MemoryEntry;
}

async function command(
  parts: Parts,
  argv: readonly string[],
  caller: string | null,
  context: Context
): Promise<Answer> {
  const { files, memories, scopes, options } = parts;
  const verb = argv[0] ?? 'help';
  if (verb === 'scopes') {
    await parts.reload(context);
    const rows = scopes.value.map((scope) => {
      const count = memories.value.filter((item) => item.scope === scope.id).length;
      const file = placeFor(options.home, scope.id).file;
      return `${scope.id}\t${scope.label}\t${count} entr${count === 1 ? 'y' : 'ies'}\t${file}`;
    });
    return { code: 0, out: `${rows.join('\n')}\n` };
  }
  if (verb !== 'show') return { code: verb === 'help' || verb === '--help' ? 0 : 2, out: USAGE };
  const scope = argv[1] ?? callerScope(options.agents, caller);
  const place = placeOf(options.home, scope);
  if (!place) return { code: 1, out: `memory: there is no memory scope ${scope}\n` };
  const read = await files.read(place.file, context);
  return {
    code: 0,
    out: read?.text.trim()
      ? `# ${place.file}\n\n${read.text.trimEnd()}\n`
      : `${place.file} is empty\n`,
  };
}

export async function attachMemory(
  options: MemoryAttach,
  connect: (host: Host) => void,
  context: Context
): Promise<MemoryRuntime> {
  const { agents, env, home } = options;
  const files = new MemoryFiles(env);
  const memories = replicatedState<MemoryEntry[]>([]);
  const scopes = replicatedState<MemoryScope[]>([]);
  const reload = async (using: Context) => {
    const found = await listPlaces(options, using);
    const entries: MemoryEntry[] = [];
    for (const place of found) entries.push(...(await files.entries(place, using)));
    scopes.replace(
      using,
      found.map((place) => ({
        id: place.scope,
        label: place.name,
        ...(place.group ? { group: place.group } : {}),
      }))
    );
    memories.replace(using, entries);
  };
  const parts: Parts = { options, files, memories, scopes, reload };
  connect({ agents, env, home, files, changed: reload });
  await reload(context).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void reload(context).catch(() => undefined), options.reloadMs);
  };
  const offCone = agents.onCone(schedule);
  const watched = await env.watch(
    [
      { path: memoryRoot(home), recursive: true },
      { path: roleRoot(home), recursive: true },
    ],
    schedule,
    context
  );
  const watcher: FileWatcher | undefined = watched.ok ? watched.value : undefined;
  return {
    memories,
    scopes,
    save: (draft, using) => save(parts, draft, using),
    async remove(id, using) {
      const entry = memories.value.find((item) => item.id === id);
      if (!entry) return false;
      const written = await files.change(
        placeFor(home, entry.scope),
        { kind: 'remove', id },
        using
      );
      await reload(using);
      return written.found;
    },
    command: (argv, caller, using) => command(parts, argv, caller, using),
    reload,
    async close(using) {
      offCone();
      clearTimeout(timer);
      await watcher?.close(using);
    },
  };
}
