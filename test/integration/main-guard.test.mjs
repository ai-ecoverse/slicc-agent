import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const scripts = resolve(import.meta.dirname, '../../scripts');
const scratch = mkdtempSync(join(tmpdir(), 'main-guard-'));
const linked = join(scratch, 'linked');
symlinkSync(scripts, linked, 'dir');
after(() => rmSync(scratch, { recursive: true, force: true }));

const fixture = (name, files) => {
  const dir = join(scratch, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
};

const viaLink = (script, cwd, env = {}) =>
  spawnSync(process.execPath, [join(linked, script)], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('lint:chord run through a symlinked checkout still checks the lockfile and fails on a second Chord', () => {
  const cwd = fixture('chord', {
    'package-lock.json': {
      packages: {
        'node_modules/@earendil-works/chord': { version: '1.0.0' },
        'node_modules/x/node_modules/@earendil-works/chord': { version: '0.9.0' },
      },
    },
  });
  const result = viaLink('check-chord.mjs', cwd);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /second Chord/);
  assert.match(result.stdout, /^check-chord: FAIL 1 problem$/m);
});

test('lint:patches run through a symlinked checkout still checks patches.json and fails on a broken entry', () => {
  const cwd = fixture('patches', {
    'package-lock.json': { packages: {} },
    'package.json': { scripts: {} },
    'renovate.json': {},
    'patches/patches.json': { broken: {} },
  });
  const result = viaLink('check-patches.mjs', cwd);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /broken: missing kind/);
  assert.match(result.stdout, /^check-patches: FAIL 1 problem$/m);
});
