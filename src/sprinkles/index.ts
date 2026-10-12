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
}

function targetOf(agentId: string): LickTarget {
  return agentId.startsWith('scoop:') ? (agentId as LickTarget) : `cone:${agentId}`;
}

export function ownerOf(agents: Agents, owner: string | undefined): string {
  const state = agents.state();
  if (owner && state.cones[owner]) return owner;
  const scoop = owner ? state.scoops[owner] : undefined;
  return scoop && live(scoop) ? (owner as string) : agents.activeCone();
}

function entry(name: string, html: string, agentId: string): Sprinkle {
  return { id: name, name, ...describe(name, html), agentId, html };
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
    const stored =
      suggestions === undefined ? undefined : await env.exists(SUGGESTIONS_STORE, using);
    const offered = stored?.ok === true && stored.value;
    const reserved = new Set([WELCOME, ...(offered ? [SUGGESTIONS] : [])]);
    const out: Sprinkle[] = [];
    for (const { name, path } of await sprinkleFiles(env, dir, using)) {
      if (reserved.has(name)) continue;
      const read = await env.readTextFile(path, using);
      if (read.ok) out.push(entry(name, read.value, ownerOf(agents, owned[name])));
    }
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
      const setOwner = async (name: string, agentId: string, using: Context) => {
        await harness.commit(async (tx) => {
          (await tx.doc(SprinklesDoc)).owners[name] = agentId;
        }, using);
        await reload(using);
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
      const watched = await env.watch(
        [{ path: dir, recursive: true }, { path: SUGGESTIONS_DIR }],
        () => {
          clearTimeout(timer);
          timer = setTimeout(() => void reload(context).catch(() => undefined), options.reloadMs);
        },
        context
      );
      const watcher: FileWatcher | undefined = watched.ok ? watched.value : undefined;
      return {
        sprinkles,
        async send(id, payload, using) {
          const sprinkle = find(id);
          if (!sprinkle) return { delivered: false };
          if (await options.intercept?.(id, payload, using)) return { delivered: true };
          if (id === WELCOME && payload.action === 'onboarding-complete') {
            await env.writeFile(WELCOMED, `${new Date().toISOString()}\n`, using);
            if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data))
              await env.writeFile(
                WELCOME_PROFILE,
                `${JSON.stringify(payload.data, null, 2)}\n`,
                using
              );
          }
          await licks.deliver(
            {
              channel: 'sprinkle',
              source: `sprinkle:${id}`,
              title: sprinkle.title,
              text: payload.action || '(no action)',
              ...(payload.data === null ? {} : { body: JSON.stringify(payload.data, null, 2) }),
              target: targetOf(ownerOf(agents, (await owners(using))[id])),
            },
            using
          );
          return { delivered: true };
        },
        async call(id, method, args, using) {
          if (!find(id)) throw new Error(`there is no sprinkle ${id}`);
          const handlers: Record<SprinkleMethod, () => Promise<JsonValue>> = {
            async readFile() {
              const read = await env.readTextFile(await inside(args[0], using), using);
              if (!read.ok) throw new Error(read.error.message);
              return read.value;
            },
            async exists() {
              const found = await env.exists(await inside(args[0], using), using);
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
          await setOwner(id, cone, using);
        },
        reload,
        async close(using) {
          offCone();
          clearTimeout(timer);
          await watcher?.close(using);
        },
      };
    },
  };
}
