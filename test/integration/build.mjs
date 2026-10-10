import { copyFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist-test', { recursive: true, force: true });
await build({
  entryPoints: [
    'test/integration/page/agent-worker.js',
    'test/integration/page/storage-worker.js',
    'test/integration/page/page.js',
    'test/integration/page/main-worker.js',
    'test/integration/page/codemode-worker.js',
  ],
  outdir: 'dist-test',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
  alias: {
    'node:crypto': './test/integration/shims/node-crypto.js',
    'node:worker_threads': './test/integration/shims/node-worker-threads.js',
    'node:fs/promises': './test/integration/shims/node-only.js',
    'node:module': './test/integration/shims/node-only.js',
    'node:child_process': './test/integration/shims/node-only.js',
    'node:process': './test/integration/shims/node-only.js',
    'cross-spawn': './test/integration/shims/node-only.js',
  },
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
await build({
  entryPoints: ['test/integration/page/bedrock-worker.js'],
  outdir: 'dist-test',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2024',
  sourcemap: 'linked',
  logLevel: 'warning',
  alias: {
    'node:crypto': './test/integration/shims/node-crypto.js',
    'node:worker_threads': './test/integration/shims/node-worker-threads.js',
    'node:fs/promises': './test/integration/shims/node-only.js',
    'node:module': './test/integration/shims/node-only.js',
    'node:child_process': './test/integration/shims/node-only.js',
    'node:process': './test/integration/shims/node-only.js',
    'cross-spawn': './test/integration/shims/node-only.js',
    '@smithy/node-http-handler': './test/integration/shims/node-only.js',
    'http-proxy-agent': './test/integration/shims/node-only.js',
    'https-proxy-agent': './test/integration/shims/node-only.js',
  },
});
await copyFile('node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm', 'dist-test/sqlite3.wasm');
