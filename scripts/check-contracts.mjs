import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './main.mjs';

export const LOCK = 'contracts.lock.json';

const WRITE = 'node scripts/check-contracts.mjs --write';

export function printsOf(contracts, historyOf) {
  return Object.fromEntries(
    contracts
      .map((made) => [
        made.name,
        Object.fromEntries(historyOf(made).map((step) => [String(step.version), step.fingerprint])),
      ])
      .sort(([one], [other]) => one.localeCompare(other))
  );
}

const numbers = (versions) => Object.keys(versions).map(Number);

function compare(name, locked, now) {
  const breaks = [];
  const missing = [];
  const lowest = Math.min(...numbers(now));
  const highest = Math.max(...numbers(locked));
  const next = Math.max(...numbers(now)) + 1;
  for (const [version, print] of Object.entries(now)) {
    const was = locked[version];
    if (was === undefined && Number(version) <= highest)
      breaks.push(
        `${name} v${version} is new but v${highest} is locked: a new history starts above v${highest} (since: ${highest + 1})`
      );
    else if (was === undefined) missing.push(`${name} v${version} is not in ${LOCK}`);
    else if (was !== print)
      breaks.push(
        `${name} v${version} changed (${was} -> ${print}): declare the new members as v${next} (added: { ${next}: [...] }), or start a new history above v${highest} (since: ${highest + 1}) for a break`
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
      breaks.push(`${name} is in ${LOCK} but no longer served: remove it from ${LOCK} by hand`);
  return { breaks, missing };
}

export const merged = (lock, prints) =>
  Object.fromEntries(
    Object.entries({ ...lock, ...prints })
      .map(([name, versions]) => [name, { ...lock[name], ...versions }])
      .sort(([one], [other]) => one.localeCompare(other))
  );

export async function run(root, write) {
  const { CONTRACTS } = await import(join(root, 'src/services.ts'));
  const { historyOf } = await import(join(root, 'src/serving.ts'));
  const path = join(root, LOCK);
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  const prints = printsOf(CONTRACTS, historyOf);
  const { breaks, missing } = check(lock, prints);
  if (write && breaks.length === 0 && missing.length > 0) {
    writeFileSync(path, `${JSON.stringify(merged(lock, prints), null, 2)}\n`);
    return { problems: [], count: Object.keys(prints).length };
  }
  const told = missing.map((line) => `${line}: run ${WRITE}`);
  return { problems: [...breaks, ...told], count: Object.keys(prints).length };
}

if (isMain(import.meta.url)) {
  const { problems, count } = await run(process.cwd(), process.argv.includes('--write'));
  for (const problem of problems) console.error(`check-contracts: ${problem}`);
  if (problems.length) {
    console.log(
      `check-contracts: FAIL ${problems.length} problem${problems.length === 1 ? '' : 's'}`
    );
    process.exit(1);
  }
  console.log(`check-contracts: PASS ${count} contracts`);
}
