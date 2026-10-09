import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { type Agents, live } from '../agents.ts';
import type { Licks } from '../licks/licks.ts';
import type { Roles } from '../roles/roles.ts';
import type { Scoops } from '../scoops/service.ts';
import { skillFromText } from '../skills/skills.ts';
import { fold, open, readStore, STORE, type Suggestion, validate, writeStore } from './store.ts';

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
  gelatiere install <id>    install a suggested skill from its source into ~/.pi/agent/skills
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

type G = {
  options: GelatiereAttach;
  now: () => number;
  crontab: string;
  procedure: string;
  load: (context: Context) => Promise<Suggestion[]>;
  mark: (id: string, field: 'dismissedAt' | 'takenAt', context: Context) => Promise<boolean>;
};

const fail = (out: string): Answer => ({ code: 1, out: `gelatiere: ${out}\n` });

async function schedule(g: G, handle: string, context: Context): Promise<void> {
  const { env, home } = g.options;
  const read = await env.readTextFile(g.crontab, context);
  const kept = (read.ok ? read.value : '')
    .split('\n')
    .filter((entry) => entry.trim() && !scheduleOf(entry));
  await env.createDir(`${home}/.slicc`, { recursive: true }, context);
  await env.writeFile(g.crontab, `${[...kept, line(handle)].join('\n')}\n`, context);
}

async function seed(g: G, context: Context): Promise<void> {
  const { env, assets } = g.options;
  const existing = await env.exists(g.procedure, context);
  if ((existing.ok && existing.value) || !assets) return;
  const text = await assets(PROCEDURE).catch(() => undefined);
  if (text !== undefined) await env.writeFile(g.procedure, text, context);
}

async function init(g: G, context: Context): Promise<Answer> {
  const { options } = g;
  await seed(g, context);
  let handle = handleOf(options.agents);
  if (!handle) {
    const roles = await options.roles(context);
    const role = roles.roles.find((entry) => entry.name === ROLE);
    if (!role) return fail('the gelatiere role is missing');
    const spawned = await options.scoops.spawn(
      {
        cone: 'cone',
        kind: 'async',
        name: ROLE,
        role,
        prompts: [],
        target: null,
        fromAgent: false,
        request: `gelatiere-init-${g.now()}`,
        limits: roles.limits,
      },
      context
    );
    if (spawned.code !== 0) return { code: 1, out: `gelatiere: ${spawned.out}` };
    handle = spawned.out.trim();
  }
  await schedule(g, handle, context);
  return {
    code: 0,
    out: `the gelatiere is scoop ${handle}; it runs at ${SCHEDULE} (crontab) and with gelatiere run, following ${g.procedure}\n`,
  };
}

async function run(g: G, context: Context): Promise<Answer> {
  const handle = handleOf(g.options.agents);
  if (!handle) return fail('there is no gelatiere yet; run gelatiere init');
  await g.options.licks.deliver(
    {
      channel: 'sprinkle',
      source: 'sprinkle:gelatiere',
      title: 'Gelatiere',
      text: 'run',
      body: `Run a pass now: read ${g.procedure} and follow it.`,
      target: `scoop:${handle}`,
    },
    context
  );
  return { code: 0, out: `asked scoop ${handle} for a pass\n` };
}

async function suggest(g: G, path: string | undefined, context: Context): Promise<Answer> {
  if (!path) return { code: 2, out: USAGE };
  const read = await g.options.env.readTextFile(path, context);
  if (!read.ok) return fail(`can't read ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch (error) {
    return fail(`${path} is not JSON (${(error as Error).message})`);
  }
  const folded = fold(await g.load(context), parsed, g.now());
  await writeStore(g.options.env, folded.store, context);
  const rejected = folded.rejected.map((reason) => `rejected ${reason}\n`).join('');
  return {
    code: 0,
    out: `added ${folded.added}, updated ${folded.updated}, rejected ${folded.rejected.length}\n${rejected}`,
  };
}

async function deliver(g: G, context: Context): Promise<Answer> {
  const store = await g.load(context);
  const fresh = open(store).filter((item) => !item.deliveredAt);
  const cones = Object.keys(g.options.agents.state().cones);
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
    await g.options.licks.deliver(
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
  for (const item of fresh) item.deliveredAt = g.now();
  if (fresh.length) await writeStore(g.options.env, store, context);
  return {
    code: 0,
    out: `delivered ${fresh.length} to ${[...byCone.keys()].join(', ') || 'nobody'}\n`,
  };
}

async function fetchText(env: ExecutionEnv, url: string, temp: string, context: Context) {
  const fetched = await env.exec(
    ['curl', '-fsSL', '--max-time', '30', '-o', temp, url],
    undefined,
    context
  );
  const read = await env.readTextFile(temp, context);
  await env.remove(temp, { force: true }, context);
  return fetched.ok && fetched.value.exitCode === 0 && read.ok ? read.value : undefined;
}

async function install(g: G, id: string, context: Context): Promise<Answer> {
  const { env, home } = g.options;
  const item = (await g.load(context)).find((entry) => entry.id === id && entry.kind === 'skill');
  const checked = item ? validate(item) : `there is no skill suggestion ${id}`;
  if (typeof checked === 'string') return fail(checked);
  const { skill, source } = checked as Required<Pick<Suggestion, 'skill' | 'source'>>;
  const dir = `${home}/.pi/agent/skills/${skill}`;
  const present = await env.exists(`${dir}/SKILL.md`, context);
  if (present.ok && present.value) return fail(`${skill} is already installed in ${dir}`);
  const text = await fetchText(env, source, `${home}/.gelatiere-${id}.md`, context);
  if (text === undefined) return fail(`couldn't fetch ${source}`);
  const parsed = skillFromText(text, `${dir}/SKILL.md`, 'user');
  if (parsed.skills[0]?.name !== skill) {
    const why = parsed.diagnostics[0] ? ` (${parsed.diagnostics[0].message})` : '';
    return fail(`${source} is not a SKILL.md for ${skill}${why}`);
  }
  await env.createDir(dir, { recursive: true }, context);
  await env.writeFile(`${dir}/SKILL.md`, text, context);
  await g.mark(id, 'takenAt', context);
  return {
    code: 0,
    out: `installed ${skill} in ${dir}; it is /skill:${skill} once the skills reload\n`,
  };
}

async function list(g: G, argv: readonly string[], context: Context): Promise<Answer> {
  const store = await g.load(context);
  const shown = argv.includes('--all') ? store : open(store);
  if (argv.includes('--json')) return { code: 0, out: `${JSON.stringify(shown, null, 2)}\n` };
  return { code: 0, out: shown.length ? `${shown.map(row).join('\n')}\n` : 'no suggestions\n' };
}

async function status(g: G, context: Context): Promise<Answer> {
  const { env, agents } = g.options;
  const store = await readStore(env, context);
  const handle = handleOf(agents);
  const read = await env.readTextFile(g.crontab, context);
  const scheduled = (read.ok ? read.value : '').split('\n').map(scheduleOf).find(Boolean);
  const counts = store
    ? `${open(store).length} open, ${store.filter((item) => item.takenAt).length} taken, ${store.filter((item) => item.dismissedAt).length} dismissed`
    : 'none yet';
  const lines = [
    `scoop: ${handle ?? 'none (gelatiere init)'}`,
    `schedule: ${scheduled ?? 'none'}`,
    `store: ${counts}`,
  ];
  return { code: 0, out: `${lines.join('\n')}\n` };
}

async function dismiss(g: G, id: string, context: Context): Promise<Answer> {
  return (await g.mark(id, 'dismissedAt', context))
    ? { code: 0, out: `dismissed ${id}\n` }
    : fail(`there is no suggestion ${id}`);
}

const VERBS: Record<string, (g: G, argv: readonly string[], context: Context) => Promise<Answer>> =
  {
    init: (g, _argv, context) => init(g, context),
    run: (g, _argv, context) => run(g, context),
    suggest: (g, argv, context) => suggest(g, argv[1], context),
    deliver: (g, _argv, context) => deliver(g, context),
    install: (g, argv, context) => install(g, argv[1] ?? '', context),
    list: (g, argv, context) => list(g, argv, context),
    status: (g, _argv, context) => status(g, context),
    dismiss: (g, argv, context) => dismiss(g, argv[1] ?? '', context),
  };

export function attachGelatiere(options: GelatiereAttach): GelatiereRuntime {
  const { env, home } = options;
  const now = options.now ?? Date.now;
  const load = async (context: Context) => (await readStore(env, context)) ?? [];
  const g: G = {
    options,
    now,
    crontab: `${home}/.slicc/crontab`,
    procedure: `${home}/.pi/agent/GELATIERE.md`,
    load,
    async mark(id, field, context) {
      const store = await load(context);
      const item = store.find((entry) => entry.id === id);
      if (!item) return false;
      item[field] ??= now();
      await writeStore(env, store, context);
      return true;
    },
  };
  return {
    command(argv, _caller, context) {
      const verb = argv[0] ?? 'help';
      const handler = VERBS[verb];
      if (handler) return handler(g, argv, context);
      return Promise.resolve({ code: verb === 'help' || verb === '--help' ? 0 : 2, out: USAGE });
    },
    async intercept(action, data, context) {
      const id = String((data as { id?: unknown } | null)?.id ?? '');
      if (action === 'gelatiere-dismiss') {
        await g.mark(id, 'dismissedAt', context);
        return true;
      }
      if (action === 'gelatiere-install' || action === 'gelatiere-try')
        await g.mark(id, 'takenAt', context);
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
