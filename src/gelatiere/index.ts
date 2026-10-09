import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { Licks } from '../licks/licks.ts';
import type { Roles } from '../roles/roles.ts';
import type { Scoops } from '../scoops/service.ts';
import { fold, open, readStore, STORE, type Suggestion, writeStore } from './store.ts';

export type Answer = { code: number; out: string };

export const ROLE = 'gelatiere';
export const SPRINKLE = 'suggestions';
export const PROCEDURE = 'packages/vfs-root/gelatiere/GELATIERE.md';
export const SCHEDULE = '0 3 * * *';

export interface GelatiereAttach {
  agents: Agents;
  licks: Licks;
  env: ExecutionEnv;
  home: string;
  scoops: Scoops;
  roles: (context: Context) => Promise<Roles>;
  assets?: (path: string) => Promise<string>;
  now?: () => number;
}

export interface GelatiereRuntime {
  command(argv: readonly string[], caller: string | null, context: Context): Promise<Answer>;
  intercept(action: string, data: unknown, context: Context): Promise<boolean>;
}

export const USAGE = `usage:
  gelatiere init            start the gelatiere scoop and its nightly crontab line
  gelatiere run             ask the gelatiere for a pass now
  gelatiere suggest <file>  fold a JSON array of suggestions into the store
  gelatiere deliver         lick each cone with the suggestions that are new for it
  gelatiere list [--all] [--json]
  gelatiere dismiss <id>    mark a suggestion as not wanted
  gelatiere status

The store is ${STORE}; the suggestions sprinkle shows it.
`;

function line(handle: string): string {
  return `${SCHEDULE} ${ROLE} scoop:${handle} Nightly pass: read ~/.pi/agent/GELATIERE.md and follow it.`;
}

const JOB = new RegExp(`^((?:\\S+\\s+){4}\\S+|@\\w+)\\s+${ROLE}(?:\\s|$)`);

export function scheduleOf(entry: string): string | undefined {
  return JOB.exec(entry.trim())?.[1]?.replace(/\s+/g, ' ');
}

function handleOf(agents: Agents): string | undefined {
  const found = Object.entries(agents.state().scoops).find(
    ([, record]) => record.role === ROLE && live(record)
  );
  return found?.[1].folder;
}

function row(item: Suggestion): string {
  const state = item.takenAt ? 'taken' : item.dismissedAt ? 'dismissed' : 'open';
  return `${item.id}\t${item.kind}\t${state}\t${item.title}`;
}

export function attachGelatiere(options: GelatiereAttach): GelatiereRuntime {
  const { agents, licks, env, home } = options;
  const now = options.now ?? Date.now;
  const crontab = `${home}/.slicc/crontab`;
  const procedure = `${home}/.pi/agent/GELATIERE.md`;
  const load = async (context: Context) => (await readStore(env, context)) ?? [];
  const mark = async (id: string, field: 'dismissedAt' | 'takenAt', context: Context) => {
    const store = await load(context);
    const item = store.find((entry) => entry.id === id);
    if (!item) return false;
    item[field] ??= now();
    await writeStore(env, store, context);
    return true;
  };
  const schedule = async (handle: string, context: Context) => {
    const read = await env.readTextFile(crontab, context);
    const kept = (read.ok ? read.value : '')
      .split('\n')
      .filter((entry) => entry.trim() && !scheduleOf(entry));
    await env.createDir(`${home}/.slicc`, { recursive: true }, context);
    await env.writeFile(crontab, `${[...kept, line(handle)].join('\n')}\n`, context);
  };
  const init = async (context: Context): Promise<Answer> => {
    const existing = await env.exists(procedure, context);
    if (!(existing.ok && existing.value) && options.assets) {
      const text = await options.assets(PROCEDURE).catch(() => undefined);
      if (text !== undefined) await env.writeFile(procedure, text, context);
    }
    let handle = handleOf(agents);
    if (!handle) {
      const role = (await options.roles(context)).roles.find((entry) => entry.name === ROLE);
      if (!role) return { code: 1, out: 'gelatiere: the gelatiere role is missing\n' };
      const spawned = await options.scoops.spawn(
        {
          cone: 'cone',
          kind: 'async',
          name: ROLE,
          role,
          prompts: [],
          target: null,
          fromAgent: false,
          request: `gelatiere-init-${now()}`,
          limits: (await options.roles(context)).limits,
        },
        context
      );
      if (spawned.code !== 0) return { code: 1, out: `gelatiere: ${spawned.out}` };
      handle = spawned.out.trim();
    }
    await schedule(handle, context);
    return {
      code: 0,
      out: `the gelatiere is scoop ${handle}; it runs at ${SCHEDULE} (crontab) and with gelatiere run, following ${procedure}\n`,
    };
  };
  const run = async (context: Context): Promise<Answer> => {
    const handle = handleOf(agents);
    if (!handle)
      return { code: 1, out: 'gelatiere: there is no gelatiere yet; run gelatiere init\n' };
    await licks.deliver(
      {
        channel: 'sprinkle',
        source: 'sprinkle:gelatiere',
        title: 'Gelatiere',
        text: 'run',
        body: `Run a pass now: read ${procedure} and follow it.`,
        target: `scoop:${handle}`,
      },
      context
    );
    return { code: 0, out: `asked scoop ${handle} for a pass\n` };
  };
  const suggest = async (path: string | undefined, context: Context): Promise<Answer> => {
    if (!path) return { code: 2, out: USAGE };
    const read = await env.readTextFile(path, context);
    if (!read.ok) return { code: 1, out: `gelatiere: can't read ${path}\n` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.value);
    } catch (error) {
      return { code: 1, out: `gelatiere: ${path} is not JSON (${(error as Error).message})\n` };
    }
    const folded = fold(await load(context), parsed, now());
    await writeStore(env, folded.store, context);
    const rejected = folded.rejected.map((reason) => `rejected ${reason}\n`).join('');
    return {
      code: 0,
      out: `added ${folded.added}, updated ${folded.updated}, rejected ${folded.rejected.length}\n${rejected}`,
    };
  };
  const deliver = async (context: Context): Promise<Answer> => {
    const store = await load(context);
    const fresh = open(store).filter((item) => !item.deliveredAt);
    const cones = Object.keys(agents.state().cones);
    const byCone = new Map<string, Suggestion[]>();
    for (const item of fresh) {
      const named = item.cones.filter((cone) => cones.includes(cone));
      for (const cone of named.length ? named : ['cone'])
        byCone.set(cone, [...(byCone.get(cone) ?? []), item]);
    }
    for (const [cone, items] of byCone) {
      const body = {
        added: items.length,
        open: open(store).length,
        suggestions: items.map(({ id, kind, title, body: text }) => ({
          id,
          kind,
          title,
          body: text,
        })),
        path: STORE,
      };
      await licks.deliver(
        {
          channel: 'sprinkle',
          source: `sprinkle:${SPRINKLE}`,
          title: 'Suggestions',
          text: 'gelatiere-suggestions',
          body: JSON.stringify(body, null, 2),
          target: `cone:${cone}`,
        },
        context
      );
    }
    for (const item of fresh) item.deliveredAt = now();
    if (fresh.length) await writeStore(env, store, context);
    return {
      code: 0,
      out: `delivered ${fresh.length} to ${[...byCone.keys()].join(', ') || 'nobody'}\n`,
    };
  };
  const list = async (argv: readonly string[], context: Context): Promise<Answer> => {
    const store = await load(context);
    const shown = argv.includes('--all') ? store : open(store);
    if (argv.includes('--json')) return { code: 0, out: `${JSON.stringify(shown, null, 2)}\n` };
    return { code: 0, out: shown.length ? `${shown.map(row).join('\n')}\n` : 'no suggestions\n' };
  };
  const status = async (context: Context): Promise<Answer> => {
    const store = await readStore(env, context);
    const handle = handleOf(agents);
    const read = await env.readTextFile(crontab, context);
    const scheduled = (read.ok ? read.value : '').split('\n').map(scheduleOf).find(Boolean);
    const lines = [
      `scoop: ${handle ?? 'none (gelatiere init)'}`,
      `schedule: ${scheduled ?? 'none'}`,
      `store: ${store ? `${open(store).length} open, ${store.filter((item) => item.takenAt).length} taken, ${store.filter((item) => item.dismissedAt).length} dismissed` : 'none yet'}`,
    ];
    return { code: 0, out: `${lines.join('\n')}\n` };
  };
  return {
    async command(argv, _caller, context) {
      const verb = argv[0] ?? 'help';
      if (verb === 'init') return init(context);
      if (verb === 'run') return run(context);
      if (verb === 'suggest') return suggest(argv[1], context);
      if (verb === 'deliver') return deliver(context);
      if (verb === 'list') return list(argv, context);
      if (verb === 'status') return status(context);
      if (verb === 'dismiss')
        return (await mark(argv[1] ?? '', 'dismissedAt', context))
          ? { code: 0, out: `dismissed ${argv[1]}\n` }
          : { code: 1, out: `gelatiere: there is no suggestion ${argv[1] ?? ''}\n` };
      return { code: verb === 'help' || verb === '--help' ? 0 : 2, out: USAGE };
    },
    async intercept(action, data, context) {
      const id = String((data as { id?: unknown } | null)?.id ?? '');
      if (action === 'gelatiere-dismiss') {
        await mark(id, 'dismissedAt', context);
        return true;
      }
      if (action === 'gelatiere-install' || action === 'gelatiere-try')
        await mark(id, 'takenAt', context);
      return false;
    },
  };
}

export function lateGelatiere() {
  let runtime: GelatiereRuntime | undefined;
  return {
    async intercept(
      id: string,
      payload: { action: string; data: unknown },
      context: Context
    ): Promise<boolean> {
      return id === SPRINKLE && runtime !== undefined
        ? runtime.intercept(payload.action, payload.data, context)
        : false;
    },
    command(argv: readonly string[], caller: string | null, context: Context): Promise<Answer> {
      return runtime
        ? runtime.command(argv, caller, context)
        : Promise.resolve({ code: 1, out: 'gelatiere: not ready yet\n' });
    },
    attach(options: GelatiereAttach): GelatiereRuntime {
      runtime = attachGelatiere(options);
      return runtime;
    },
  };
}
