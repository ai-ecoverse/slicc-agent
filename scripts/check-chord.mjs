import { existsSync, readFileSync } from 'node:fs';
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

const PROTOCOL = /PROTOCOL_VERSION = (\d+)/;
const OURS = /CHORD_PROTOCOL = (\d+)/;

export function protocol(chord, wire) {
  if (chord === undefined || wire === undefined) return [];
  const theirs = PROTOCOL.exec(chord)?.[1];
  const ours = OURS.exec(wire)?.[1];
  if (theirs === undefined) return [`${ROOT} has no PROTOCOL_VERSION`];
  if (ours === undefined) return ['src/wire.ts has no CHORD_PROTOCOL'];
  return theirs === ours
    ? []
    : [
        `${ROOT} speaks link protocol ${theirs} but src/wire.ts says CHORD_PROTOCOL = ${ours}: update CHORD_PROTOCOL`,
      ];
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

export const run = (root) => [
  ...check(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))),
  ...protocol(read(join(root, ROOT, 'dist/data/errors.js')), read(join(root, 'src/wire.ts'))),
];

if (isMain(import.meta.url)) {
  const problems = run(process.cwd());
  for (const problem of problems) console.error(`check-chord: ${problem}`);
  if (problems.length) {
    console.log(`check-chord: FAIL ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    process.exit(1);
  }
  console.log('check-chord: PASS 1 chord');
}
