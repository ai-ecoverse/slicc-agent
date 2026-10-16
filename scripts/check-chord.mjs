import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHORD = '@earendil-works/chord';
export const OWNERS = new Set(['@earendil-works/pi-durable']);
export const ALLOWED = {
  '': new Set(['copyJson', 'replicatedState']),
  context: null,
  delta: null,
  json: null,
  output: null,
  state: null,
};

const statement =
  /(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function names(clause) {
  const braces = clause.match(/\{([^}]*)\}/);
  if (!braces) return ['*'];
  return braces[1]
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => part.split(/\s+as\s+/)[0]);
}

export function chordImports(source) {
  const found = [];
  for (const match of source.matchAll(statement)) {
    const specifier = match[3] ?? match[4];
    if (specifier !== CHORD && !specifier.startsWith(`${CHORD}/`)) continue;
    const subpath = specifier.slice(CHORD.length + 1);
    if (match[1]) continue;
    found.push({ subpath, names: match[4] ? ['*'] : names(match[2]) });
  }
  return found;
}

export function checkImports(file, source) {
  const problems = [];
  for (const { subpath, names: imported } of chordImports(source)) {
    const label = subpath ? `${CHORD}/${subpath}` : CHORD;
    if (!(subpath in ALLOWED)) {
      problems.push(`${file} imports ${label}, outside Chord's state and context layer`);
      continue;
    }
    const allowed = ALLOWED[subpath];
    for (const name of imported) {
      if (allowed && !allowed.has(name)) {
        problems.push(
          `${file} imports ${name} from ${label}, outside Chord's state and context layer`
        );
      }
    }
  }
  return problems;
}

export function nestedChords(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([path]) => path.endsWith(`/node_modules/${CHORD}`))
    .map(([path, entry]) => ({ path, version: entry.version }))
    .filter(({ path }) => !path.startsWith('node_modules/slicc-agent-4/'));
}

function owner(path) {
  const parent = path.slice(0, -`/node_modules/${CHORD}`.length);
  return parent.startsWith('node_modules/') ? parent.slice('node_modules/'.length) : undefined;
}

function scripts(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(dir, name));
}

export function run(root) {
  const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const problems = [];
  for (const { path, version } of nestedChords(json('package-lock.json'))) {
    const parent = owner(path);
    if (!parent || !OWNERS.has(parent)) {
      problems.push(`${path} (${version}) is nested under ${parent ?? 'nothing'}, not pi-durable`);
      continue;
    }
    for (const file of scripts(join(root, 'node_modules', parent, 'dist'))) {
      problems.push(...checkImports(file.slice(root.length + 1), readFileSync(file, 'utf8')));
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = run(process.cwd());
  for (const problem of problems) console.error(`check-chord: ${problem}`);
  if (problems.length) process.exit(1);
  console.log('check-chord: ok');
}
