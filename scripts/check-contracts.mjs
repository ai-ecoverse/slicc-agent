import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './main.mjs';

export const LOCK = 'contracts.lock.json';

const WRITE = 'node scripts/check-contracts.mjs --write';

const sorted = (list) => [...list].sort();

const shapeOf = (variants) =>
  Object.fromEntries(
    Object.entries(variants ?? {})
      .sort(([one], [other]) => one.localeCompare(other))
      .map(([variant, members]) => [
        variant,
        Object.fromEntries(
          ['methods', 'state']
            .filter((kind) => (members[kind] ?? []).length > 0)
            .map((kind) => [kind, sorted(members[kind])])
        ),
      ])
  );

export function printsOf(contracts, historyOf, variantsOf) {
  return Object.fromEntries(
    contracts
      .map((made) => [
        made.name,
        Object.fromEntries(
          historyOf(made).map((step) => [
            String(step.version),
            { fingerprint: step.fingerprint, variants: shapeOf(variantsOf(step)) },
          ])
        ),
      ])
      .sort(([one], [other]) => one.localeCompare(other))
  );
}

const numbers = (versions) => Object.keys(versions).map(Number);

const membersOf = (entry) =>
  Object.entries(entry?.variants ?? {}).flatMap(([variant, members]) =>
    Object.entries(members ?? {}).flatMap(([kind, names]) =>
      (Array.isArray(names) ? names : []).map((name) => `${variant}.${kind}.${name}`)
    )
  );

const changes = (was, now) => {
  const before = new Set(membersOf(was));
  const after = new Set(membersOf(now));
  return [
    ...[...after].filter((member) => !before.has(member)).map((member) => `+${member}`),
    ...[...before].filter((member) => !after.has(member)).map((member) => `-${member}`),
  ].sort((one, other) => one.slice(1).localeCompare(other.slice(1)));
};

const printOf = (entry) => entry?.fingerprint;

function compare(name, locked, now) {
  const breaks = [];
  const missing = [];
  const lowest = Math.min(...numbers(now));
  const highest = Math.max(...numbers(locked));
  const next = Math.max(...numbers(now)) + 1;
  for (const [version, entry] of Object.entries(now)) {
    const was = locked[version];
    const moved = changes(entry, was);
    if (was === undefined && Number(version) <= highest)
      breaks.push(
        `${name} v${version} is new but v${highest} is locked: a new history starts above v${highest} (since: ${highest + 1})`
      );
    else if (was === undefined) missing.push(`${name} v${version} is not in ${LOCK}`);
    else if (printOf(was) !== entry.fingerprint)
      breaks.push(
        `${name} v${version} changed (${printOf(was)} -> ${entry.fingerprint}): declare the new members as v${next} (added: { ${next}: [...] }), or start a new history above v${highest} (since: ${highest + 1}) for a break`
      );
    else if (moved.length > 0)
      breaks.push(
        `${name} v${version} has other members in ${LOCK} than in src (${moved.join(', ')}): a recorded version keeps the members it was recorded with`
      );
  }
  for (const version of Object.keys(locked))
    if (now[version] === undefined && Number(version) > lowest)
      breaks.push(`${name} v${version} was removed: versions are only added`);
  return { breaks, missing };
}

export function check(lock, prints) {
  const breaks = [];
  const missing = [];
  for (const [name, now] of Object.entries(prints)) {
    const locked = lock[name];
    if (locked === undefined) {
      missing.push(`${name} is not in ${LOCK}`);
      continue;
    }
    const found = compare(name, locked, now);
    breaks.push(...found.breaks);
    missing.push(...found.missing);
  }
  for (const name of Object.keys(lock))
    if (prints[name] === undefined)
      breaks.push(`${name} is in ${LOCK} but no longer served: a recorded contract stays served`);
  return { breaks, missing };
}

export function immutable(base, lock, label) {
  const breaks = [];
  for (const [name, versions] of Object.entries(base))
    for (const [version, was] of Object.entries(versions)) {
      const now = lock[name]?.[version];
      const moved = changes(was, now);
      if (now === undefined)
        breaks.push(
          `${name} v${version} is recorded in ${LOCK} on ${label} but no longer in ${LOCK}: a recorded version is never removed`
        );
      else if (printOf(now) !== printOf(was))
        breaks.push(
          `${name} v${version} is recorded as ${printOf(was)} on ${label} but as ${printOf(now)} in ${LOCK}: a recorded version is never edited, so declare the change as a new version (added) or a new history (since)`
        );
      else if (moved.length > 0)
        breaks.push(
          `${name} v${version} has other members in ${LOCK} than on ${label} (${moved.join(', ')}): a recorded version is never edited`
        );
    }
  return breaks;
}

const WIDTH = 100;

const flat = (line, indent, key, items, comma) => {
  const one = `${indent}${key}[${items.join(', ')}]${comma}`;
  return one.length <= WIDTH ? one : line;
};

export const formatted = (value) =>
  `${JSON.stringify(value, null, 2).replace(
    /^( *)("[^"\n]*": )\[\n((?: *"[^"\n]*",?\n)+) *\](,?)$/gm,
    (line, indent, key, body, comma) => flat(line, indent, key, body.trim().split(/,\n */), comma)
  )}\n`;

export const merged = (lock, prints) =>
  Object.fromEntries(
    Object.entries({ ...lock, ...prints })
      .map(([name, versions]) => [name, { ...lock[name], ...versions }])
      .sort(([one], [other]) => one.localeCompare(other))
  );

const git = (root, ...args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : undefined;
};

const commitOf = (root, ref) => git(root, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);

const fetched = (root, ref) =>
  commitOf(root, ref) ??
  (git(root, 'fetch', '--no-tags', '--quiet', '--depth=1', 'origin', ref) === undefined
    ? undefined
    : commitOf(root, 'FETCH_HEAD'));

const eventBase = (env) => {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const sha =
      event.pull_request?.base?.sha ?? event.merge_group?.base_sha ?? event.before ?? undefined;
    return typeof sha === 'string' && !/^0+$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
};

function baseOf(root, env) {
  const named = [
    ['BASE_SHA', env.BASE_SHA],
    ['the GitHub event', eventBase(env)],
    ['GITHUB_BASE_REF', env.GITHUB_BASE_REF],
  ].find(([, ref]) => ref);
  if (named) {
    const commit = fetched(root, named[1]);
    return commit
      ? { commit, label: `${named[1]} (${named[0]})` }
      : { problem: `the base ${named[1]} from ${named[0]} is not reachable with git` };
  }
  if (env.CI)
    return {
      problem: `no base to compare ${LOCK} with in CI: set BASE_SHA, or run in a pull request, merge group or push`,
    };
  const upstream = commitOf(root, 'origin/main') && git(root, 'merge-base', 'HEAD', 'origin/main');
  if (upstream)
    return { commit: upstream, label: `origin/main (merge base ${upstream.slice(0, 12)})` };
  const head = commitOf(root, 'HEAD');
  if (head) return { commit: head, label: 'HEAD' };
  return { note: `no git base, so the recorded versions in ${LOCK} are not compared with a base` };
}

function recorded(root, env) {
  const base = baseOf(root, env);
  if (!base.commit) return base;
  const text = git(root, 'show', `${base.commit}:./${LOCK}`);
  if (text === undefined)
    return { lock: {}, label: base.label, note: `${base.label} has no ${LOCK} yet` };
  try {
    return { lock: JSON.parse(text), label: base.label };
  } catch {
    return { problem: `${LOCK} on ${base.label} is not JSON` };
  }
}

export async function run(root, write, env = process.env) {
  const { CONTRACTS } = await import(join(root, 'src/services.ts'));
  const { historyOf, variantsOf } = await import(join(root, 'src/serving.ts'));
  const path = join(root, LOCK);
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  const prints = printsOf(CONTRACTS, historyOf, variantsOf);
  const base = recorded(root, env);
  const notes = base.note ? [base.note] : [];
  const edited = base.lock ? immutable(base.lock, lock, base.label) : [];
  const { breaks, missing } = check(lock, prints);
  const broken = [...(base.problem ? [base.problem] : []), ...edited, ...breaks];
  const count = Object.keys(prints).length;
  if (write && broken.length === 0 && missing.length > 0) {
    writeFileSync(path, formatted(merged(lock, prints)));
    return { problems: [], count, notes };
  }
  const told = missing.map((line) => `${line}: run ${WRITE}`);
  return { problems: [...broken, ...told], count, notes };
}

if (isMain(import.meta.url)) {
  const { problems, count, notes } = await run(process.cwd(), process.argv.includes('--write'));
  for (const note of notes) console.log(`check-contracts: ${note}`);
  for (const problem of problems) console.error(`check-contracts: ${problem}`);
  if (problems.length) {
    console.log(
      `check-contracts: FAIL ${problems.length} problem${problems.length === 1 ? '' : 's'}`
    );
    process.exit(1);
  }
  console.log(`check-contracts: PASS ${count} contracts`);
}
