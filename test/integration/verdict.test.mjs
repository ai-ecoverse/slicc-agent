import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'verdict-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const step =
  /\n {8}run: \|\n((?: {10}.*\n)*? {10}node scripts\/publish\.mjs .*\n(?: {10}.*\n)+)/.exec(
    release
  )?.[1];

const callers = [
  ['lint:chord', 'check-chord', scripts['lint:chord']],
  ['lint:patches', 'check-patches', scripts['lint:patches']],
  ['lint:vault-pi', 'check-vault-pi', scripts['lint:vault-pi']],
  ['the release.yml publish step', 'publish', step?.replace(/^ {10}/gm, '')],
];

const stubbed = (command, gate, body) => {
  const dir = mkdtempSync(join(scratch, `${gate}-`));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(root, 'scripts/verdict.mjs'), join(dir, 'scripts/verdict.mjs'));
  writeFileSync(join(dir, `scripts/${gate}.mjs`), body);
  return spawnSync('bash', ['-c', command], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RUNNER_TEMP: dir },
  });
};

for (const [caller, gate, command] of callers) {
  test(`${caller} fails when ${gate} exits 0 without its PASS verdict line, so its silence never reads as a pass`, () => {
    assert.ok(command, `${caller} runs ${gate}`);
    const silent = stubbed(command, gate, '');
    assert.notEqual(silent.status, 0, silent.stdout + silent.stderr);
    assert.match(
      silent.stdout + silent.stderr,
      new RegExp(`no "?${gate}: PASS"? verdict|no PASS verdict from ${gate}`)
    );
    const other = stubbed(command, gate, `console.log('${gate}: ok');`);
    assert.notEqual(other.status, 0, other.stdout + other.stderr);
  });

  test(`${caller} passes when ${gate} prints its PASS verdict line, and fails when ${gate} exits non-zero`, () => {
    assert.ok(command, `${caller} runs ${gate}`);
    const pass = stubbed(command, gate, `console.log('${gate}: PASS stub');`);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, new RegExp(`^${gate}: PASS stub$`, 'm'));
    const failed = stubbed(command, gate, `console.log('${gate}: FAIL stub'); process.exit(3);`);
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  });
}
