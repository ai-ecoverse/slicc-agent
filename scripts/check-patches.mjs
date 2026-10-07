import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KINDS = new Set(['monkeypatch', 'patch-package', 'environment']);
const FIELDS = ['kind', 'package', 'patchedVersion', 'reason', 'removeWhen', 'verify'];
export const GROUP = 'patched dependencies';

export function patchFile(name, version) {
  return `${name.replace('/', '+')}+${version}.patch`;
}

function matches(pattern, name) {
  return pattern.endsWith('/**') ? name.startsWith(pattern.slice(0, -2)) : pattern === name;
}

function checkInstalled(id, entry, { installed, read }) {
  const version = installed(entry.package);
  if (version !== entry.patchedVersion) {
    return [
      `${id}: ${entry.package} is ${version ?? 'not installed'} but the patch is for ${entry.patchedVersion}`,
    ];
  }
  const { marker } = entry;
  if (marker && !read(entry.package, marker.file)?.includes(marker.includes)) {
    return [`${id}: ${entry.package}/${marker.file} no longer has ${marker.includes}`];
  }
  return [];
}

function checkKind(id, entry, { patchFiles, scripts, sources }, expected) {
  if (!KINDS.has(entry.kind)) return [`${id}: unknown kind ${entry.kind}`];
  if (entry.kind === 'monkeypatch') {
    return sources.includes(id) ? [] : [`${id}: no monkeypatch in src/patches.ts names it`];
  }
  if (entry.kind !== 'patch-package') return [];
  const file = patchFile(entry.package, entry.patchedVersion);
  expected.add(file);
  return [
    ...(patchFiles.includes(file) ? [] : [`${id}: patches/${file} is missing`]),
    ...(scripts.postinstall?.includes('patch-package')
      ? []
      : [`${id}: package.json needs a postinstall that runs patch-package`]),
  ];
}

function checkRouted(id, entry, rules) {
  const routed = rules.some(
    (rule) =>
      rule.automerge === false && rule.matchPackageNames?.some((p) => matches(p, entry.package))
  );
  return routed
    ? []
    : [`${id}: renovate.json does not route ${entry.package} to "${GROUP}" without automerge`];
}

export function checkPatches(inputs) {
  const problems = [];
  const expected = new Set();
  const rules = (inputs.renovate?.packageRules ?? []).filter((rule) => rule.groupName === GROUP);
  for (const [id, entry] of Object.entries(inputs.manifest)) {
    const missing = FIELDS.filter((field) => !entry[field]);
    if (missing.length) {
      problems.push(`${id}: missing ${missing.join(', ')}`);
      continue;
    }
    problems.push(
      ...checkInstalled(id, entry, inputs),
      ...checkKind(id, entry, inputs, expected),
      ...checkRouted(id, entry, rules)
    );
  }
  for (const file of inputs.patchFiles) {
    if (!expected.has(file)) {
      problems.push(`patches/${file} has no patch-package entry in patches.json`);
    }
  }
  return problems;
}

export function run(root) {
  const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const lock = json('package-lock.json');
  const sources = join(root, 'src/patches.ts');
  const problems = checkPatches({
    manifest: json('patches/patches.json'),
    installed: (name) => lock.packages?.[`node_modules/${name}`]?.version,
    renovate: json('renovate.json'),
    patchFiles: readdirSync(join(root, 'patches')).filter((file) => file.endsWith('.patch')),
    scripts: json('package.json').scripts ?? {},
    sources: existsSync(sources) ? readFileSync(sources, 'utf8') : '',
    read: (name, file) => {
      const path = join(root, 'node_modules', name, file);
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    },
  });
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = run(process.cwd());
  for (const problem of problems) console.error(`check-patches: ${problem}`);
  if (problems.length) process.exit(1);
  console.log('check-patches: ok');
}
