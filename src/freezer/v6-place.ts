import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { coneSpec } from '../kernel/accounts.ts';
import { ROOT_HOME } from '../layout.ts';
import type { LickTarget } from '../licks/lick.ts';
import { memoryRoot } from '../memory/store.ts';
import { GLOBAL_DIR } from '../skills/index.ts';
import { validateName } from '../skills/skills.ts';
import type { ImportDeps } from './v6.ts';
import {
  accountsOf,
  type Opened,
  type Parsed,
  textOf,
  type Unit,
  type Where,
  whereOf,
} from './v6.ts';
import { lickName, skillName } from './v6-schema.ts';
import {
  type CronLine,
  installCrons,
  ownTree,
  remember,
  same,
  userSection,
  type Writer,
} from './v6-write.ts';
import { ImportError } from './zip.ts';

export const V6_ROOT = `${ROOT_HOME}/v6`;

export type Notes = {
  lines: string[];
  skipped: string[];
  shadowed: string[];
  tasks: string[];
  sprinkles: Map<string, Set<string>>;
  crons: string[];
  webhooks: string[];
  placed: Map<string, string>;
};

export type Run = {
  deps: ImportDeps;
  opened: Opened;
  parsed: Parsed;
  writer: Writer;
  stage: string;
  date: string;
  notes: Notes;
  show: (phase: 'writing', done: number, total: number) => void;
  fresh: Map<string, boolean>;
  ready: Set<Unit>;
};

type Source = Uint8Array | { zip: string };

async function staged(run: Run, zip: string): Promise<Uint8Array> {
  const read = await run.writer.env.readBinaryFile(`${run.stage}/${zip}`, run.writer.context);
  if (!read.ok) throw new ImportError(`the staged copy of ${zip} is gone`);
  return read.value;
}

async function prepare(run: Run, unit: Unit): Promise<void> {
  if (run.ready.has(unit)) return;
  run.ready.add(unit);
  const { users, layout, env } = run.deps;
  if (unit.fresh)
    run.writer.later(async () => {
      await users?.remove(unit.cone).catch(() => false);
      await env.remove(unit.home, { recursive: true, force: true }, BACKGROUND_CONTEXT);
    });
  if (layout.users && users) await users.add(coneSpec(unit.cone));
}

async function envOf(run: Run, unit: Unit | null): Promise<ExecutionEnv | undefined> {
  if (!unit || unit.fresh || !run.deps.layout.users) return undefined;
  const env = await run.deps.envOf?.(unit.cone);
  if (!env) throw new ImportError(`there is no kernel user ${unit.cone} to write its files as`);
  return env;
}

async function putIn(run: Run, unit: Unit | null, root: string, rest: string, source: Source) {
  if (unit) await prepare(run, unit);
  const env = await envOf(run, unit);
  let fresh = run.fresh.get(root);
  if (fresh === undefined) {
    fresh = unit?.fresh || (await run.writer.tree(root, env));
    run.fresh.set(root, fresh);
  }
  if (unit?.fresh) unit.roots.add(root);
  const path = `${root}/${rest}`;
  await run.writer.put(path, 'zip' in source ? await staged(run, source.zip) : source, fresh, env);
  if ('zip' in source && !run.notes.placed.has(source.zip)) run.notes.placed.set(source.zip, path);
}

const clean = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';

type Maps = { byFolder: Map<string, Unit>; owners: Map<string, Unit>; primary?: Unit };

function targets(run: Run, maps: Maps, where: Where, zip: string): [Unit, string, string][] {
  if (where.kind === 'cone' || where.kind === 'scoop') {
    const unit = (where.kind === 'cone' ? maps.byFolder : maps.owners).get(where.folder) as Unit;
    const root =
      where.kind === 'cone'
        ? `${unit.home}/workspace${unit.suffix}`
        : `${unit.home}/scoops${unit.suffix}/${where.folder}`;
    return [[unit, root, where.rest]];
  }
  if (where.kind === 'sprinkle') {
    if (!maps.primary)
      run.notes.skipped.push(`the sprinkle ${where.folder}: there is no cone to put it in`);
    return maps.primary
      ? [
          [
            maps.primary,
            `${maps.primary.home}/sprinkles/${lickName(where.folder, 'sprinkle')}`,
            where.rest,
          ],
        ]
      : [];
  }
  if (where.kind !== 'attachment') return [];
  return run.parsed.units.flatMap((unit) =>
    (unit.doc?.attachments ?? [])
      .filter((item) => item.present && item.path === zip)
      .map((item): [Unit, string, string] => {
        const rest = `${item.sha256.slice(0, 12)}-${clean(item.originalName)}`;
        unit.files.set(item.id, `${unit.home}/v6-attachments/${rest}`);
        return [unit, `${unit.home}/v6-attachments`, rest];
      })
  );
}

function sprinkleCalls(run: Run, name: string, bytes: Uint8Array) {
  const found = [...new TextDecoder().decode(bytes).matchAll(/\bslicc\.([A-Za-z_$][\w$]*)/g)]
    .map((match) => `slicc.${match[1]}`)
    .filter((call) => call !== 'slicc.lick');
  if (!found.length) return;
  const known = run.notes.sprinkles.get(name) ?? new Set<string>();
  for (const call of found) known.add(call);
  run.notes.sprinkles.set(name, known);
}

async function alike(
  run: Run,
  dir: string,
  six: string,
  rests: readonly string[]
): Promise<boolean> {
  for (const rest of rests) {
    const old = await run.writer.env.readBinaryFile(`${dir}/${rest}`, run.writer.context);
    if (!old.ok || !same(old.value, await staged(run, `skills/${six}/${rest}`))) return false;
  }
  return true;
}

async function placeSkills(run: Run, skills: Map<string, string[]>, primary: Unit | undefined) {
  const seen = new Set<string>();
  for (const [six, rests] of skills) {
    const name = skillName(six);
    if (!name || validateName(name).length || seen.has(name)) {
      run.notes.skipped.push(
        `the skill ${six}: its name doesn't fit seven's rule (a-z, 0-9 and -)`
      );
      continue;
    }
    seen.add(name);
    const global = `${GLOBAL_DIR}/${name}`;
    const exists = await run.writer.exists(global);
    if (exists && (await alike(run, global, six, rests))) {
      run.notes.lines.push(`the skill ${name}: already in ${GLOBAL_DIR}`);
      continue;
    }
    const own = primary && exists ? `${primary.home}/.pi/agent/skills/${name}` : undefined;
    if (exists && !own) {
      run.notes.skipped.push(`the skill ${name}: ${GLOBAL_DIR} has another skill of that name`);
      continue;
    }
    for (const rest of rests)
      await putIn(run, own ? (primary as Unit) : null, own ?? global, rest, {
        zip: `skills/${six}/${rest}`,
      });
    if (own)
      run.notes.shadowed.push(
        `the skill ${name}: ${GLOBAL_DIR} has another skill of that name, so SLICC 6's copy is in ${own}, for ${(primary as Unit).cone} only`
      );
    else run.notes.lines.push(`the skill ${name}, for every agent, in ${global}`);
  }
}

async function placeMemory(run: Run) {
  const root = memoryRoot(run.deps.memoryHome);
  const { data, units } = run.parsed;
  const places = [
    { name: 'memory/global.md', file: `${root}/MEMORY.md`, rest: `${V6_ROOT}/memory/global.md` },
    ...units
      .filter((unit) => unit.memory)
      .map((unit) => ({
        name: unit.memory as string,
        file: `${root}/${unit.cone}/MEMORY.md`,
        rest: `${V6_ROOT}/memory/${unit.cone}.md`,
      })),
  ];
  for (const place of places) {
    const bytes = data.get(place.name);
    const done = bytes
      ? await remember(run.writer, place.file, textOf(bytes, place.name), {
          file: place.rest,
          date: run.date,
        })
      : 'none';
    if (done === 'merged')
      run.notes.lines.push(`memory, under "Imported from SLICC 6 (${run.date})", in ${place.file}`);
    if (done === 'aside')
      run.notes.lines.push(`memory, in ${place.rest}: ${place.file} has no room left for it`);
  }
}

function earlier(run: Run, unit: Unit, name: string): LickTarget | undefined {
  const found = Object.entries(run.deps.agents.state().scoops).filter(
    ([, record]) => record.cone === unit.cone && record.name === name && !record.removed
  );
  return found.at(-1)?.[0] as LickTarget | undefined;
}

function router(run: Run, maps: Maps) {
  return (folder: string | null | undefined): [Unit, LickTarget] | undefined => {
    const cone = folder ? maps.byFolder.get(folder) : undefined;
    if (cone) return [cone, 'cone'];
    const owner = folder ? maps.owners.get(folder) : undefined;
    const scoop = owner?.scoops.find((item) => item.six === folder);
    const target =
      owner && scoop
        ? owner.record
          ? (`scoop:${scoop.folder}` as LickTarget)
          : earlier(run, owner, scoop.name)
        : undefined;
    if (owner && target) return [owner, target];
    const unit = owner ?? maps.primary;
    return unit ? [unit, 'cone'] : undefined;
  };
}

const FIELD = '[0-9A-Za-z*,/-]+';
const SCHEDULE = new RegExp(
  `^(@(yearly|annually|monthly|weekly|daily|midnight|hourly|reboot)|${FIELD}( ${FIELD}){4})$`
);

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

async function placeLicks(run: Run, maps: Maps) {
  const { licks } = run.parsed;
  const route = router(run, maps);
  const crons = new Map<Unit, CronLine[]>();
  const add = (found: [Unit, LickTarget] | undefined, line: Omit<CronLine, 'target'>) => {
    const why = !SCHEDULE.test(line.schedule)
      ? `"${line.schedule}" is not a cron schedule`
      : !found && 'there is no cone to send it to';
    if (why) run.notes.skipped.push(`the cron ${line.name}: ${why}`);
    else if (found)
      crons.set(found[0], [...(crons.get(found[0]) ?? []), { ...line, target: found[1] }]);
  };
  for (const [at, task] of licks.crontasks.entries())
    add(route(task.targetFolder), {
      name: lickName(task.name, `v6-cron-${at + 1}`),
      schedule: flat(task.cron),
      message: '',
      ...(task.filter ? { filter: task.filter } : {}),
    });
  for (const [at, task] of licks.tasks.entries()) {
    if (task.scheduleType === 'cron')
      add(route(task.groupFolder), {
        name: `v6-task-${at + 1}`,
        schedule: flat(task.scheduleValue),
        message: flat(task.prompt),
      });
    else
      run.notes.tasks.push(
        `${task.scheduleType} ${task.scheduleValue}: ${flat(task.prompt).slice(0, 80)}`
      );
  }
  for (const [unit, list] of crons) {
    await prepare(run, unit);
    const user = run.deps.layout.users ? unit.cone : 'root';
    const count = await installCrons(run.writer, user, list, run.date);
    if (count) run.notes.crons.push(`${count} in crontab -u ${user}`);
  }
  for (const [at, hook] of licks.webhooks.entries()) {
    const found = route(hook.targetFolder);
    const name = lickName(hook.name, `v6-webhook-${at + 1}`);
    if (!found) run.notes.skipped.push(`the webhook ${name}: there is no cone to send it to`);
    if (!found) continue;
    const root = `${found[0].home}/.slicc/webhooks`;
    await putIn(
      run,
      found[0],
      root,
      `${name}.json.v6`,
      new TextEncoder().encode(`${JSON.stringify({ target: found[1] }, null, 2)}\n`)
    );
    run.notes.webhooks.push(`${root}/${name}.json.v6`);
  }
}

async function placeGit(run: Run) {
  const name = run.opened.manifest.gitconfig;
  const bytes = name ? run.parsed.data.get(name) : undefined;
  const section = bytes ? userSection(textOf(bytes, name as string)) : '';
  if (!section) return;
  const file = `${ROOT_HOME}/.gitconfig`;
  const read = await run.writer.env.readTextFile(file, run.writer.context);
  const before = read.ok ? read.value.trimEnd() : '';
  if (/^\s*\[user\]/im.test(before)) {
    run.notes.skipped.push(`SLICC 6's git [user]: ${file} already has one`);
    return;
  }
  await run.writer.put(file, `${before ? `${before}\n` : ''}${section}`, false);
  run.notes.lines.push(`your git name and email, in ${file}`);
}

export async function place(run: Run): Promise<void> {
  const { manifest } = run.opened;
  const units = run.parsed.units;
  const byFolder = new Map(
    units.filter((unit) => unit.six).map((unit) => [unit.six as string, unit])
  );
  const owners = new Map(
    units.flatMap((unit) =>
      unit.scoops.filter((scoop) => scoop.six).map((scoop) => [scoop.six as string, unit])
    )
  );
  const maps: Maps = {
    byFolder,
    owners,
    primary: byFolder.get('cone') ?? units.find((unit) => unit.six !== null),
  };
  const skills = new Map<string, string[]>();
  const later: [string, string][] = [];
  for (const [at, file] of manifest.files.entries()) {
    const where = whereOf(manifest, file.path);
    if (where.kind === 'skill')
      skills.set(where.folder, [...(skills.get(where.folder) ?? []), where.rest]);
    if (where.kind === 'home-user') later.push([file.path, where.rest]);
    if (where.kind === 'sprinkle') sprinkleCalls(run, where.folder, await staged(run, file.path));
    for (const [unit, root, rest] of targets(run, maps, where, file.path))
      await putIn(run, unit, root, rest, { zip: file.path });
    run.show('writing', at + 1, manifest.files.length);
  }
  await placeSkills(run, skills, maps.primary);
  await placeMemory(run);
  await placeLicks(run, maps);
  await placeGit(run);
  for (const [zip, rest] of later) await putIn(run, null, `${V6_ROOT}/home-user`, rest, { zip });
  if (run.deps.layout.users)
    for (const unit of units) await ownTree(run.writer, unit.cone, unit.home, unit.roots);
}

const WHY: Record<string, string> = {
  env: 'environment file, often holds keys',
  pem: 'PEM file, may be a private key',
  'git-credentials': 'git credentials in plain text',
  npmrc: 'npm config, may hold an auth token',
  'slicc-oauth': 'SLICC 6 OAuth state',
};

const NEVER: Record<string, string> = {
  'secrets-env': '~/.slicc/secrets.env, which stays on the host',
  'github-token': 'the GitHub token',
  'mcp-tokens': 'MCP tokens',
  'chrome-storage': "the extension's chrome.storage secrets",
};

const bullets = (items: readonly string[], none: string) =>
  (items.length ? items : [none]).map((item) => `- ${item}`);

function nextSteps(run: Run, mounts: readonly string[]): string[] {
  const { manifest } = run.opened;
  const { notes } = run;
  const sprinkles = [...notes.sprinkles].map(
    ([name, calls]) => `${name} (${[...calls].join(', ')})`
  );
  return [
    'Re-enter your keys and logins in Settings.',
    ...(mounts.length ? [`Mount these folders again: ${mounts.join(', ')}.`] : []),
    ...(manifest.mcp?.length
      ? [
          `Add these MCP servers again: ${manifest.mcp.map((item) => `${item.name} (${item.url})`).join(', ')}.`,
        ]
      : []),
    ...(notes.crons.length
      ? [
          `Turn crons on with sudo crontab -u <user> -e: remove the leading "# " from a job's two lines.`,
        ]
      : []),
    ...(notes.webhooks.length
      ? [
          "Turn a webhook on by renaming <name>.json.v6 to <name>.json, then point its sender at seven's webhook URL.",
        ]
      : []),
    ...(sprinkles.length
      ? [
          `These sprinkles call SLICC APIs other than slicc.lick and may need edits: ${sprinkles.join(', ')}.`,
        ]
      : []),
  ];
}

export async function reportOf(run: Run, made: readonly string[]): Promise<string> {
  const { manifest } = run.opened;
  const { notes, date, parsed } = run;
  const known = new Set(run.deps.providers ?? []);
  const recorded = parsed.units.filter((unit) => unit.record);
  const imported = [
    ...recorded.map(
      (unit, at) =>
        `${unit.title}: frozen cone ${made[at]}, home ${unit.home}${unit.suffix ? `, new files in ${unit.home}/workspace${unit.suffix}` : ''}${unit.scoops.length ? `, with ${unit.scoops.map((scoop) => scoop.name).join(', ')}` : ''}`
    ),
    ...notes.lines,
    ...notes.crons.map((line) => `crons, imported off: ${line}`),
    ...notes.webhooks.map((path) => `a webhook, imported off: ${path}`),
  ];
  const mounts = manifest.skipped
    .filter((item) => item.reason === 'mount')
    .map((item) => item.path);
  const skipped = [
    ...manifest.skipped.map((item) => `${item.path}: ${item.reason}`),
    ...parsed.units
      .filter((unit) => !unit.record)
      .map((unit) => `${unit.title}: unchanged since the last import`),
    ...notes.skipped,
    ...notes.shadowed,
    ...notes.tasks.map((task) => `a SLICC 6 task that cron can't express: ${task}`),
  ];
  const flagged = manifest.flagged.map(
    (item) => `| ${notes.placed.get(item.path) ?? item.path} | ${item.size} B | ${WHY[item.rule]} |`
  );
  const providers = accountsOf(manifest.providers).map((name) =>
    known.size && !known.has(name)
      ? `${name}: seven doesn't know this provider`
      : `${name}: re-enter in Settings`
  );
  const never = (manifest.secrets ?? []).map((name) => NEVER[name] ?? name);
  const part = manifest.part ? `, part ${manifest.part.index} of ${manifest.part.of}` : '';
  const text = [
    `# SLICC 6 import, ${date}`,
    '',
    `From ${manifest.producer.origin} (SLICC ${manifest.producer.slicc}), exported ${manifest.createdAt}, export ${manifest.exportId}${part}.`,
    '',
    '## Imported',
    '',
    ...bullets(imported, 'nothing new'),
    '',
    '## Skipped',
    '',
    ...bullets(skipped, 'nothing'),
    '',
    ...(flagged.length
      ? [
          '## Review these files',
          '',
          '| Path | Size | Why |',
          '| --- | --- | --- |',
          ...flagged,
          '',
          "Delete or move these if you don't need them here.",
          '',
        ]
      : []),
    '## Re-enter in Settings',
    '',
    ...bullets(providers, 'no providers'),
    ...(never.length ? ['', `These never move: ${never.join(', ')}.`] : []),
    '',
    '## Next steps',
    '',
    ...nextSteps(run, mounts).map((step) => `- ${step}`),
    '',
  ].join('\n');
  let file = `${ROOT_HOME}/v6-import-${date}.md`;
  for (let n = 2; await run.writer.exists(file); n++)
    file = `${ROOT_HOME}/v6-import-${date}-${n}.md`;
  const written = await run.writer.env.writeFile(file, text, BACKGROUND_CONTEXT);
  if (!written.ok)
    throw new ImportError(`couldn't write the report ${file}: ${written.error.message}`);
  return file;
}
