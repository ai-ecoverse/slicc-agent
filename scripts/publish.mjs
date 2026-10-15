import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
export const BACKFILL = 'backfill';

export function newer(a, b) {
  const x = TAG.exec(a).slice(1).map(Number);
  const y = TAG.exec(b).slice(1).map(Number);
  for (let at = 0; at < 3; at++) if (x[at] !== y[at]) return x[at] > y[at];
  return false;
}

export function distTag(version, { latest, tags }) {
  const ahead = [latest, ...tags].filter((other) => other && TAG.test(other));
  return ahead.some((other) => newer(other, version)) ? BACKFILL : 'latest';
}

export function publish({ run, log, name, tag }) {
  const version = tag.replace(/^v/, '');
  if (run('npm', ['view', `${name}@${version}`, 'version', '--prefer-online']).trim() === version) {
    log(`${name}@${version} is already on npm`);
    return undefined;
  }
  const latest = run('npm', ['view', name, 'dist-tags.latest', '--prefer-online']).trim();
  const tags = run('git', ['ls-remote', '--tags', '--refs', 'origin', 'v*'])
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter(Boolean);
  const chosen = distTag(version, { latest, tags });
  run('npm', ['ci']);
  run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
  run('npm', ['publish', '--tag', chosen]);
  log(`published ${name}@${version} as ${chosen}`);
  return chosen;
}

function exec(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0 && !(cmd === 'npm' && args[0] === 'view'))
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  return result.status === 0 ? result.stdout : '';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { name } = JSON.parse(readFileSync('package.json', 'utf8'));
  publish({ run: exec, log: console.log, name, tag: process.env.TAG ?? '' });
}
