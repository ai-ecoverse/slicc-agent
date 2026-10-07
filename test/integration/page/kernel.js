const packages = {
  'node_modules/@ai-ecoverse/wasm-bash/': ['package.json', 'bin/bash', 'bin/bash.wasm'],
  'node_modules/@ai-ecoverse/wasm-coreutils/': [
    'package.json',
    'bin/coreutils',
    'bin/coreutils.wasm',
  ],
};

async function walk(path) {
  let dir = await navigator.storage.getDirectory();
  for (const part of path.split('/').filter(Boolean))
    dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
}

export async function bootKernel() {
  for (const [dir, names] of Object.entries(packages)) {
    for (const name of names) {
      const bytes = new Uint8Array(await (await fetch(`/${dir}${name}`)).arrayBuffer());
      const parts = `${dir}${name}`.split('/');
      const file = parts.pop();
      const handle = await (await walk(parts.join('/'))).getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    }
  }
  const { createKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
  return createKernel({ root: await navigator.storage.getDirectory() });
}
