import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function newer(a, b) {
  const x = TAG.exec(`v${a}`).slice(1).map(Number);
  const y = TAG.exec(`v${b}`).slice(1).map(Number);
  for (let at = 0; at < 3; at++) if (x[at] !== y[at]) return x[at] > y[at];
  return false;
}

export function pending(tags, latest) {
  return tags
    .filter((tag) => TAG.test(tag))
    .map((tag) => tag.slice(1))
    .filter((version) => !latest || newer(version, latest))
    .sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
}

export function plan(run, name) {
  const latest = run('npm', ['view', name, 'dist-tags.latest', '--prefer-online']).trim();
  const tags = run('git', ['tag', '--merged', 'HEAD']).split('\n').filter(Boolean);
  return pending(tags, latest || undefined);
}

export function publish({ run, log, name }) {
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const versions = plan(run, name);
  if (!versions.length) log(`npm already has every version tagged up to ${head}`);
  for (const version of versions) {
    run('git', ['checkout', '-q', '--force', `v${version}`]);
    run('npm', ['ci']);
    run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
    run('npm', ['publish']);
    log(`published ${name}@${version}`);
  }
  run('git', ['checkout', '-q', '--force', head]);
  return versions;
}

function exec(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  process.stdout.write(cmd === 'npm' && args[0] !== 'view' ? result.stdout : '');
  return result.stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { name } = JSON.parse(readFileSync('package.json', 'utf8'));
  publish({ run: exec, log: console.log, name });
}
