import { spawnSync } from 'node:child_process';

const [name, script, ...args] = process.argv.slice(2);
if (!name || !script) {
  console.error('usage: node scripts/verdict.mjs <gate> <script> [args...]');
  process.exit(2);
}
const result = spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'inherit'],
});
process.stdout.write(result.stdout ?? '');
const verdict = new RegExp(`^${name}: PASS\\b`, 'm');
if (result.status !== 0) process.exit(result.status ?? 1);
if (!verdict.test(result.stdout ?? '')) {
  console.error(`${name}: FAIL no "${name}: PASS" verdict line, so the gate did not run`);
  process.exit(1);
}
