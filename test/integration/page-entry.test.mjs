import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const dist = fileURLToPath(new URL('../../dist', import.meta.url));

const walkJs = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
};

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
    /@earendil-works\/pi-(ai|durable)\/|@sqlite\.org|@aws-sdk|openai|@anthropic-ai|@google/.test(
      path
    )
  );
  assert.deepEqual(heavy, []);
  assert.ok(inputs.some((path) => path.includes('@earendil-works/chord/')));
  assert.equal(inputs.filter((path) => path.includes('@ai-ecoverse/slicc-vault')).length, 0);
});

test('no published dist .js mentions slicc-vault', () => {
  const hits = walkJs(dist).filter((path) =>
    readFileSync(path, 'utf8').includes('@ai-ecoverse/slicc-vault')
  );
  assert.deepEqual(
    hits.map((path) => path.slice(dist.length + 1)),
    []
  );
});
