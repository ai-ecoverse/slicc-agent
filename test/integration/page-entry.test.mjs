import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('the page and spectrum entries load neither the agent runtime nor model providers', async () => {
  const { metafile } = await build({
    entryPoints: ['page.js', 'spectrum/index.js'].map((file) =>
      fileURLToPath(new URL(`../../dist/${file}`, import.meta.url))
    ),
    outdir: 'unused',
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:*'],
    logLevel: 'silent',
  });
  const inputs = Object.keys(metafile.inputs);
  const heavy = inputs.filter((path) =>
    /@earendil-works\/pi-(ai|durable|server)\/|@sqlite\.org|@aws-sdk|openai|@anthropic-ai|@google/.test(
      path
    )
  );
  assert.deepEqual(heavy, []);
  assert.ok(inputs.some((path) => path.includes('@earendil-works/pi-client/')));
});
