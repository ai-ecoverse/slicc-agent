import { copyFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist-test', { recursive: true, force: true });
await build({
  entryPoints: ['test/integration/page/agent-worker.js', 'test/integration/page/storage-worker.js'],
  outdir: 'dist-test',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
  logLevel: 'warning',
});
await copyFile('node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm', 'dist-test/sqlite3.wasm');
