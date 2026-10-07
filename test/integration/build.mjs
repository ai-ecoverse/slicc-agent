import { copyFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist-test', { recursive: true, force: true });
await build({
  entryPoints: [
    'test/integration/page/agent-worker.js',
    'test/integration/page/storage-worker.js',
    'test/integration/page/page.js',
    'test/integration/page/main-worker.js',
  ],
  outdir: 'dist-test',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
  alias: { 'node:crypto': './test/integration/shims/node-crypto.js' },
  plugins: [
    {
      name: 'lazy-bedrock',
      setup(build) {
        build.onResolve({ filter: /bedrock-converse-stream\.js$/ }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
  logLevel: 'warning',
});
await copyFile('node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm', 'dist-test/sqlite3.wasm');
