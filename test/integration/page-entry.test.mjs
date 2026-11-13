import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, 'dist');
const vault = '@ai-ecoverse/slicc-vault';

const walk = (dir, suffix) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, suffix));
    else if (entry.name.endsWith(suffix)) out.push(path);
  }
  return out;
};

test('the page and spectrum entries load neither the agent runtime nor model providers', async () => {
  const { metafile } = await build({
    entryPoints: ['page.js', 'spectrum/index.js'].map((file) => join(dist, file)),
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
  assert.equal(inputs.filter((path) => path.includes(vault)).length, 0);
});

test('the published package never depends on slicc-vault, and no dist file names it', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies?.[vault], undefined);
  assert.equal(pkg.peerDependencies?.[vault], undefined);
  assert.equal(pkg.peerDependenciesMeta?.[vault], undefined);
  assert.equal(typeof pkg.devDependencies?.[vault], 'string');
  const hits = [...walk(dist, '.js'), ...walk(join(dist, 'types'), '.d.ts')].filter((path) =>
    readFileSync(path, 'utf8').includes(vault)
  );
  assert.deepEqual(
    hits.map((path) => path.slice(dist.length + 1)),
    []
  );
});
