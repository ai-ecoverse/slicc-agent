import {
  type Context,
  type JsonValue,
  type ReplicatedState,
  replicatedState,
} from '@earendil-works/chord';
import type { Harness } from '@earendil-works/pi-durable';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import type { Agents } from '../agents.ts';
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
  WELCOMED,
} from './sprinkles.ts';

export type Answer = { code: number; out: string };

export interface SprinklePayload {
  action: string;
  data: JsonValue | null;
  target: string | null;
}

export interface SprinklesRuntime {
  readonly sprinkles: ReplicatedState<Sprinkle[]>;
  send(id: string, payload: SprinklePayload, context: Context): Promise<{ delivered: boolean }>;
  call(id: string, method: string, args: readonly unknown[], context: Context): Promise<JsonValue>;
  command(argv: readonly string[], caller: string | null, context: Context): Promise<Answer>;
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

export const USAGE = `usage:
  sprinkle list                 every sprinkle in /home/sprinkles, with its owner
  sprinkle show <name>          show a sprinkle in your chat
  sprinkle own <name> [<agent>] send its messages to <agent> (cone, cone-<n> or a scoop's handle)

A sprinkle is an .shtml file in /home/sprinkles, as <name>.shtml or <name>/<name>.shtml.
Every one of them has a button in the rail; edit the file and the open panel reloads.
`;

const RETIRED: Record<string, string> = {
  open: 'every sprinkle in /home/sprinkles already has a button in the rail; sprinkle show <name> shows one in the chat',
  reload: 'editing the .shtml file reloads the sprinkle',
  close: 'delete the .shtml file to retire a sprinkle; the user closes panels',
  send: 'a sprinkle reads data with slicc.readFile() or keeps it with slicc.setState(); write the file it reads',
  chat: 'show the sprinkle with sprinkle show <name> and wait for its lick',
};

function targetOf(agentId: string): LickTarget {
  return agentId.startsWith('scoop:') ? (agentId as LickTarget) : `cone:${agentId}`;
}

function agentOf(caller: string | null, agents: Agents): string {
  if (caller?.startsWith('cone:')) return caller.slice('cone:'.length);
  return caller ?? agents.activeCone();
}

function named(agents: Agents, value: string): string | undefined {
  const state = agents.state();
  if (value in state.cones) return value;
  const id = value.startsWith('scoop:') ? value : `scoop:${value}`;
  return id in state.scoops ? id : undefined;
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
      if (read.ok) out.push(entry(name, read.value, owned[name] ?? agents.activeCone()));
    }
    if (offered)
      out.push(
        entry(SUGGESTIONS, suggestions as string, owned[SUGGESTIONS] ?? agents.activeCone())
      );
    if (welcome !== undefined)
      out.push({ ...entry(WELCOME, welcome, owned[WELCOME] ?? 'cone'), inline: true });
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
      const commands: Record<
        string,
        (argv: readonly string[], caller: string | null, using: Context) => Promise<Answer>
      > = {
        async list(_argv, _caller, using) {
          await reload(using);
          const rows = sprinkles.value
            .filter((item) => !item.inline)
            .map((item) => `${item.name}\t${item.title}\t${item.agentId}`);
          return { code: 0, out: rows.length ? `${rows.join('\n')}\n` : 'no sprinkles\n' };
        },
        async show(argv, caller, using) {
          await reload(using);
          const name = argv[1] ?? '';
          if (!find(name)) return { code: 1, out: `sprinkle: there is no sprinkle ${name}\n` };
          const agentId = agentOf(caller, agents);
          await post(name, agentId, using);
          if (!(await owners(using))[name]) await setOwner(name, agentId, using);
          return { code: 0, out: `showed ${name} in the chat of ${agentId}\n` };
        },
        async own(argv, caller, using) {
          const name = argv[1] ?? '';
          if (!find(name)) return { code: 1, out: `sprinkle: there is no sprinkle ${name}\n` };
          const agentId = argv[2] ? named(agents, argv[2]) : agentOf(caller, agents);
          if (!agentId) return { code: 1, out: `sprinkle: there is no agent ${argv[2]}\n` };
          await setOwner(name, agentId, using);
          return { code: 0, out: `${name} now talks to ${agentId}\n` };
        },
      };
      return {
        sprinkles,
        async send(id, payload, using) {
          const sprinkle = find(id);
          if (!sprinkle) return { delivered: false };
          if (await options.intercept?.(id, payload, using)) return { delivered: true };
          if (id === WELCOME && payload.action === 'onboarding-complete')
            await env.writeFile(WELCOMED, `${new Date().toISOString()}\n`, using);
          await licks.deliver(
            {
              channel: 'sprinkle',
              source: `sprinkle:${id}`,
              title: sprinkle.title,
              text: payload.action || '(no action)',
              ...(payload.data === null ? {} : { body: JSON.stringify(payload.data, null, 2) }),
              target: targetOf((await owners(using))[id] ?? agents.activeCone()),
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
        async command(argv, caller, using) {
          const verb = argv[0] ?? 'help';
          const run = commands[verb];
          if (run) return run(argv, caller, using);
          if (verb in RETIRED)
            return { code: 2, out: `sprinkle ${verb} isn't in SLICC: ${RETIRED[verb]}\n` };
          return { code: verb === 'help' || verb === '--help' ? 0 : 2, out: USAGE };
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
