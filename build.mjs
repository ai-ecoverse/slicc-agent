import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

const relativeTs = /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g;

async function sources(dir) {
  const names = await readdir(dir, { recursive: true });
  return names.filter((name) => name.endsWith('.ts')).map((name) => join(dir, name));
}

async function rewrite(file) {
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(relativeTs, '$1$2$3.js$2'));
}

await rm('dist', { recursive: true, force: true });
const result = await build({
  entryPoints: await sources('src'),
  outdir: 'dist',
  outbase: 'src',
  bundle: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2024',
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'warning',
});
await Promise.all(
  Object.keys(result.metafile.outputs)
    .filter((file) => file.endsWith('.js'))
    .map(rewrite)
);
