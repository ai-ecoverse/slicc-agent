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
const callers = [
  ['lint:chord', 'check-chord', scripts['lint:chord']],
  ['lint:patches', 'check-patches', scripts['lint:patches']],
  [
    'release.yml publish',
    'publish',
    /^\s*- run: (node .*scripts\/publish\.mjs.*)$/m.exec(release)?.[1],
  ],
];
const callerOf = (gate) => callers.find(([, name]) => name === gate)[2];

const stubbed = (gate, body) => {
  const dir = mkdtempSync(join(scratch, `${gate}-`));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(root, 'scripts/verdict.mjs'), join(dir, 'scripts/verdict.mjs'));
  writeFileSync(join(dir, `scripts/${gate}.mjs`), body);
  return spawnSync('sh', ['-c', callerOf(gate)], { cwd: dir, encoding: 'utf8' });
};

for (const [caller, gate, command] of callers) {
  test(`${caller} fails when ${gate} exits 0 without its PASS verdict line`, () => {
    assert.ok(command, `${caller} is defined`);
    const silent = stubbed(gate, '');
    assert.notEqual(silent.status, 0, silent.stdout + silent.stderr);
    assert.match(silent.stderr, new RegExp(`${gate}: FAIL no "${gate}: PASS" verdict line`));
    const chatty = stubbed(gate, `console.log('${gate}: ok');`);
    assert.notEqual(chatty.status, 0, chatty.stdout + chatty.stderr);
  });

  test(`${caller} passes when ${gate} prints its PASS verdict line, and fails when it exits non-zero`, () => {
    const pass = stubbed(gate, `console.log('${gate}: PASS stub');`);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.match(pass.stdout, new RegExp(`^${gate}: PASS stub$`, 'm'));
    const failed = stubbed(gate, `console.log('${gate}: PASS stub'); process.exit(3);`);
    assert.equal(failed.status, 3, failed.stdout + failed.stderr);
  });
}
