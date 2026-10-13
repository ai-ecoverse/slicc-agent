import {
  type Context,
  type JsonValue,
  type ReplicatedState,
  replicatedState,
} from '@earendil-works/chord';
import type { Harness } from '@earendil-works/pi-durable';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { LickTarget } from '../licks/lick.ts';
import type { Licks } from '../licks/licks.ts';
import {
  describe,
  homePath,
  NO_EXEC,
  SPRINKLE_KIND,
  SPRINKLES_DIR,
  type Sprinkle,
  type SprinkleMethod,
  SprinklesDoc,
  SUGGESTIONS,
  SUGGESTIONS_DIR,
  SUGGESTIONS_STORE,
  sharedPaths,
  sprinkleFiles,
  WELCOME,
  WELCOME_PROFILE,
  WELCOMED,
} from './sprinkles.ts';

export interface SprinklePayload {
  action: string;
  data: JsonValue | null;
  target: string | null;
}

export interface SprinklesRuntime {
  readonly sprinkles: ReplicatedState<Sprinkle[]>;
  send(id: string, payload: SprinklePayload, context: Context): Promise<{ delivered: boolean }>;
  call(id: string, method: string, args: readonly unknown[], context: Context): Promise<JsonValue>;
  claim(id: string, cone: string, context: Context): Promise<void>;
  reload(context: Context): Promise<void>;
  close(context: Context): Promise<void>;
}

export interface SprinklesAttach {
  harness: Harness;
  agents: Agents;
  licks: Licks;
  env: ExecutionEnv;
  assets?: (path: string) => Promise<string>;
  reloadMs: number;
  dir?: string;
  intercept?: (id: string, payload: SprinklePayload, context: Context) => Promise<boolean>;
  places?: () => readonly SprinklePlace[];
  envOf?: (agentId: string, context: Context) => Promise<ExecutionEnv | undefined>;
  homeOf?: (agentId: string) => string | undefined;
  shared?: string;
}

const BUILTIN = new Set([WELCOME, SUGGESTIONS]);

export interface SprinklePlace {
  dir: string;
  cone: string;
}

function targetOf(agentId: string): LickTarget {
  return agentId.startsWith('scoop:') ? (agentId as LickTarget) : `cone:${agentId}`;
}

export function liveOwner(agents: Agents, owner: string | undefined): string | undefined {
  if (!owner) return undefined;
  const state = agents.state();
  if (state.cones[owner]) return owner;
  const scoop = state.scoops[owner];
  return scoop && live(scoop) ? owner : undefined;
}

export function ownerOf(agents: Agents, owner: string | undefined): string {
  const state = agents.state();
  if (owner && state.cones[owner]) return owner;
  const scoop = owner ? state.scoops[owner] : undefined;
  return scoop && live(scoop) ? (owner as string) : agents.activeCone();
}

function entry(name: string, html: string, agentId: string, id = name): Sprinkle {
  return { id, name, ...describe(name, html), agentId, html };
}

function placesOf(options: SprinklesAttach, dir: string): readonly SprinklePlace[] {
  return options.places?.() ?? [{ dir, cone: '' }];
}

async function filesIn(
  options: SprinklesAttach,
  dir: string,
  reserved: ReadonlySet<string>,
  owned: Record<string, string>,
  using: Context,
  found: Record<string, string> = {}
): Promise<Sprinkle[]> {
  const { env, agents } = options;
  const out: Sprinkle[] = [];
  for (const place of placesOf(options, dir))
    for (const { name, path } of await sprinkleFiles(env, place.dir, using)) {
      const id = place.cone ? `${place.cone}/${name}` : name;
      if (reserved.has(name) || out.some((item) => item.id === id)) continue;
      const read = await env.readTextFile(path, using);
      if (place.cone && !owned[id]) found[id] = place.cone;
      const owner = owned[id] ?? (place.cone || undefined);
      if (read.ok) out.push(entry(name, read.value, ownerOf(agents, owner), id));
    }
  return out;
}

function reloader(
  options: SprinklesAttach,
  dir: string,
  builtins: { welcome: string | undefined; suggestions: string | undefined },
  sprinkles: ReplicatedState<Sprinkle[]> & { replace(context: Context, value: Sprinkle[]): void },
  owners: (context: Context) => Promise<Record<string, string>>
) {
  const { env, agents } = options;
  const { welcome, suggestions } = builtins;
  return async (using: Context) => {
    const owned = await owners(using);
    const store = options.shared ? sharedPaths(options.shared).suggestions : SUGGESTIONS_STORE;
    const stored = suggestions === undefined ? undefined : await env.exists(store, using);
    const offered = stored?.ok === true && stored.value;
    const reserved = new Set([WELCOME, ...(offered ? [SUGGESTIONS] : [])]);
    const found: Record<string, string> = {};
    const out = await filesIn(options, dir, reserved, owned, using, found);
    if (Object.keys(found).length)
      await options.harness.commit(async (tx) => {
        const doc = await tx.doc(SprinklesDoc);
        for (const [id, cone] of Object.entries(found)) doc.owners[id] ??= cone;
      }, using);
    if (offered)
      out.push(entry(SUGGESTIONS, suggestions as string, ownerOf(agents, owned[SUGGESTIONS])));
    if (welcome !== undefined)
      out.push({
        ...entry(WELCOME, welcome, ownerOf(agents, owned[WELCOME] ?? 'cone')),
        inline: true,
      });
    sprinkles.replace(using, out);
  };
}

export const NO_OWNER = 'this sprinkle has no owner, so it can only be shown';

function readerFor(
  options: SprinklesAttach,
  owners: (context: Context) => Promise<Record<string, string>>,
  inside: (path: unknown, context: Context) => Promise<string>
) {
  const { env, agents } = options;
  const none = async () => undefined;
  return async (id: string, path: unknown, using: Context) => {
    if (options.shared && BUILTIN.has(id))
      return { files: env, path: homePath(path, options.shared, options.shared), check: none };
    if (!options.places) return { files: env, path: await inside(path, using), check: none };
    const owner = liveOwner(agents, (await owners(using))[id]);
    if (!owner) throw new Error(NO_OWNER);
    const agentId = owner.startsWith('scoop:') ? owner : `cone:${owner}`;
    const home = options.homeOf?.(agentId);
    const files = await options.envOf?.(agentId, using);
    if (!home || !files) throw new Error(NO_OWNER);
    return { files, path: homePath(path, home, home), check: none };
  };
}

export function setupSprinkles() {
  return {
    async attach(options: SprinklesAttach, context: Context): Promise<SprinklesRuntime> {
      const { harness, agents, licks, env } = options;
      const dir = options.dir ?? SPRINKLES_DIR;
      const sprinkles = replicatedState<Sprinkle[]>([]);
      const builtin = (name: string) =>
        options.assets
          ? options.assets(`packages/vfs-root/sprinkles/${name}.shtml`).catch(() => undefined)
          : Promise.resolve(undefined);
      const welcome = await builtin(WELCOME);
      const suggestions = await builtin(SUGGESTIONS);
      const owners = async (using: Context) =>
        (await harness.snapshot(SprinklesDoc, using))?.owners ?? {};
      const reload = reloader(options, dir, { welcome, suggestions }, sprinkles, owners);
      const inside = async (path: unknown, using: Context) => {
        const asked = homePath(path);
        const real = await env.canonicalPath(asked, using);
        return real.ok ? homePath(real.value) : asked;
      };
      const paths = options.shared ? sharedPaths(options.shared) : undefined;
      const reader = readerFor(options, owners, inside);
      const offCone = agents.onCone(() => reload(context).catch(() => undefined));
      const find = (id: string) => sprinkles.value.find((item) => item.id === id);
      const post = async (id: string, agentId: string, using: Context) => {
        const conversation = await agents.conversation(agentId, using);
        if (!conversation) throw new Error(`there is no agent ${agentId}`);
        await conversation.submit(
          { type: 'write', entry: { kind: SPRINKLE_KIND, data: { sprinkle: id, at: Date.now() } } },
          using
        );
      };
      await reload(context);
      const state = await harness.snapshot(SprinklesDoc, context);
      if (welcome !== undefined && !state?.welcomed) {
        await post(WELCOME, 'cone', context);
        await harness.commit(async (tx) => {
          (await tx.doc(SprinklesDoc)).welcomed = true;
        }, context);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watcher: FileWatcher | undefined;
      let seen = '';
      const watch = async (using: Context) => {
        const dirs = placesOf(options, dir).map((place) => place.dir);
        const key = dirs.join('\n');
        if (key === seen) return;
        seen = key;
        await watcher?.close(using);
        const watched = await env.watch(
          [
            ...dirs.map((path) => ({ path, recursive: true })),
            { path: paths?.suggestionsDir ?? SUGGESTIONS_DIR },
          ],
          () => {
            clearTimeout(timer);
            timer = setTimeout(() => void reload(context).catch(() => undefined), options.reloadMs);
          },
          using
        );
        watcher = watched.ok ? watched.value : undefined;
      };
      await watch(context);
      return {
        sprinkles,
        async send(id, payload, using) {
          const sprinkle = find(id);
          if (!sprinkle) return { delivered: false };
          if (await options.intercept?.(id, payload, using)) return { delivered: true };
          if (id === WELCOME && payload.action === 'onboarding-complete') {
            await env.writeFile(
              paths?.welcomed ?? WELCOMED,
              `${new Date().toISOString()}\n`,
              using
            );
            if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data))
              await env.writeFile(
                paths?.profile ?? WELCOME_PROFILE,
                `${JSON.stringify(payload.data, null, 2)}\n`,
                using
              );
          }
          const owner = (await owners(using))[id];
          if (options.places && !BUILTIN.has(id) && !liveOwner(agents, owner))
            return { delivered: false };
          await licks.deliver(
            {
              channel: 'sprinkle',
              source: `sprinkle:${id}`,
              title: sprinkle.title,
              text: payload.action || '(no action)',
              ...(payload.data === null ? {} : { body: JSON.stringify(payload.data, null, 2) }),
              target: targetOf(ownerOf(agents, owner)),
            },
            using
          );
          return { delivered: true };
        },
        async call(id, method, args, using) {
          if (!find(id)) throw new Error(`there is no sprinkle ${id}`);
          const handlers: Record<SprinkleMethod, () => Promise<JsonValue>> = {
            async readFile() {
              const { files, path, check } = await reader(id, args[0], using);
              const read = await files.readTextFile(path, using);
              if (!read.ok) throw new Error(read.error.message);
              await check();
              return read.value;
            },
            async exists() {
              const { files, path } = await reader(id, args[0], using);
              const found = await files.exists(path, using);
              return found.ok && found.value;
            },
            async getState() {
              return (await harness.snapshot(SprinklesDoc, using))?.state[id] ?? null;
            },
            async setState() {
              await harness.commit(async (tx) => {
                (await tx.doc(SprinklesDoc)).state[id] = (args[0] ?? null) as JsonValue;
              }, using);
              return null;
            },
          };
          const handler = handlers[method as SprinkleMethod];
          if (!handler) throw new Error(NO_EXEC);
          return handler();
        },
        async claim(id, cone, using) {
          await reload(using);
          if (id === SUGGESTIONS || !find(id) || (await owners(using))[id]) return;
          await harness.commit(async (tx) => {
            const doc = await tx.doc(SprinklesDoc);
            doc.owners[id] ??= cone;
          }, using);
          await reload(using);
        },
        async reload(using) {
          await watch(using);
          await reload(using);
        },
        async close(using) {
          offCone();
          clearTimeout(timer);
          await watcher?.close(using);
        },
      };
    },
  };
}
