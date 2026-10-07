import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist-test', { recursive: true, force: true });
await build({
  entryPoints: ['test/integration/page/agent-worker.js'],
  outdir: 'dist-test',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
  logLevel: 'warning',
});
