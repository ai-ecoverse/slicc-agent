import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './main.mjs';

const CHORD = '@earendil-works/chord';
const ROOT = `node_modules/${CHORD}`;

export function chords(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path, entry]) => (path === ROOT || path.endsWith(`/${ROOT}`)) && !entry.dev)
    .map(([path, entry]) => ({ path, version: entry.version }));
}

export function check(lock) {
  const found = chords(lock);
  const problems = found
    .filter(({ path }) => path !== ROOT)
    .map(({ path, version }) => `${path} (${version}) is a second Chord; only ${ROOT} may load`);
  if (!found.some(({ path }) => path === ROOT)) problems.push(`${ROOT} is missing`);
  return problems;
}

export const run = (root) =>
  check(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')));

if (isMain(import.meta.url)) {
  const problems = run(process.cwd());
  for (const problem of problems) console.error(`check-chord: ${problem}`);
  if (problems.length) {
    console.log(`check-chord: FAIL ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    process.exit(1);
  }
  console.log('check-chord: PASS 1 chord');
}
