import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('watch: a missing target keeps its group native, is heard once it is created, and is not rescanned for seconds', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'watch a missing target', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const kernel = await bootKernel();
    const client = await attachKernel(await kernel.connect());
    await client.fs.mkdir('/home/w/here');
    const counts = { readdir: 0, stat: 0 };
    const fs = Object.create(client.fs);
    fs.readdir = (path) => {
      counts.readdir += 1;
      return client.fs.readdir(path);
    };
    fs.stat = (path) => {
      counts.stat += 1;
      return client.fs.stat(path);
    };
    const env = new SliccKernelEnv({ ...client, fs }, { cwd: '/' });
    const heard = [];
    let wake = () => {};
    const result = await env.watch(
      [
        { path: '/home/w/here', recursive: true },
        { path: '/home/w/missing', recursive: true },
        { path: '/home/w/later/deep/skills', recursive: true },
      ],
      (change) => {
        if (change.kind === 'paths') heard.push(...change.paths);
        wake();
      },
      BACKGROUND_CONTEXT
    );
    const until = (path) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no change at ${path}: ${heard}`)), 5000);
        wake = () => {
          if (!heard.includes(path)) return;
          clearTimeout(timer);
          resolve();
        };
        wake();
      });
    const idle = { ...counts };
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const scans = { readdir: counts.readdir - idle.readdir, stat: counts.stat - idle.stat };
    await client.fs.writeFile('/home/w/here/a.txt', 'a');
    await until('/home/w/here/a.txt');
    await client.fs.mkdir('/home/w/missing/sub');
    await until('/home/w/missing');
    await client.fs.writeFile('/home/w/missing/sub/b.txt', 'b');
    await until('/home/w/missing/sub/b.txt');
    await client.fs.mkdir('/home/w/later/deep/skills/demo');
    await until('/home/w/later/deep/skills/demo');
    await client.fs.writeFile('/home/w/later/deep/skills/demo/SKILL.md', 'demo');
    await until('/home/w/later/deep/skills/demo/SKILL.md');
    await result.value.stop(BACKGROUND_CONTEXT);
    return { ok: result.ok, mode: result.value.mode, scans };
  });
  assert.equal(seen.ok, true);
  assert.equal(seen.mode, 'native');
  assert.deepEqual(seen.scans, { readdir: 0, stat: 0 });
});

test('watch: polling a tree slower to scan than its interval never overlaps scans or piles them up', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'watch a slow tree', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const kernel = await bootKernel();
    const client = await attachKernel(await kernel.connect());
    for (let i = 0; i < 8; i++) {
      await client.fs.mkdir(`/home/slow/d${i}`);
      await client.fs.writeFile(`/home/slow/d${i}/f.txt`, 'x');
    }
    let inflight = 0;
    let peak = 0;
    let scans = 0;
    const slow = (name) => async (path) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      if (name === 'readdir' && path === '/home/slow') scans += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await client.fs[name](path);
      } finally {
        inflight -= 1;
      }
    };
    const fs = Object.create(client.fs);
    fs.readdir = slow('readdir');
    fs.stat = slow('stat');
    const env = new SliccKernelEnv(
      { ...client, fs },
      { cwd: '/', watch: { mode: 'polling', intervalMs: 20 } }
    );
    const heard = [];
    const result = await env.watch(
      [{ path: '/home/slow', recursive: true }],
      (change) => heard.push(...(change.paths ?? [])),
      BACKGROUND_CONTEXT
    );
    peak = 0;
    const before = scans;
    await client.fs.writeFile('/home/slow/d3/new.txt', 'n');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const during = scans - before;
    const stopping = Date.now();
    await result.value.stop(BACKGROUND_CONTEXT);
    const stopMs = Date.now() - stopping;
    const settled = scans;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      mode: result.value.mode,
      peak,
      during,
      stopMs,
      after: scans - settled,
      heard: heard.includes('/home/slow/d3/new.txt'),
    };
  });
  assert.equal(seen.mode, 'polling');
  assert.equal(seen.peak, 1);
  assert.ok(seen.during >= 1 && seen.during <= 4, `scans in 5 s: ${seen.during}`);
  assert.ok(seen.stopMs < 1000, `stop took ${seen.stopMs} ms`);
  assert.equal(seen.after, 0);
  assert.equal(seen.heard, true);
});

test('watch: a missing target under a symlinked directory hears a creation made through the real path', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'watch under a symlink', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const kernel = await bootKernel();
    const client = await attachKernel(await kernel.connect());
    await client.fs.mkdir('/home/s/real');
    await client.fs.symlink('/home/s/real', '/home/s/link');
    const env = new SliccKernelEnv(client, { cwd: '/' });
    const heard = [];
    let wake = () => {};
    const result = await env.watch(
      [{ path: '/home/s/link/cone/.slicc', recursive: true }],
      (change) => {
        if (change.kind === 'paths') heard.push(...change.paths);
        wake();
      },
      BACKGROUND_CONTEXT
    );
    const until = (path) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no change at ${path}: ${heard}`)), 5000);
        wake = () => {
          if (!heard.includes(path)) return;
          clearTimeout(timer);
          resolve();
        };
        wake();
      });
    await client.fs.mkdir('/home/s/real/cone/.slicc/watches');
    await until('/home/s/link/cone/.slicc/watches');
    await client.fs.writeFile('/home/s/real/cone/.slicc/watches/a.json', '{}');
    await until('/home/s/link/cone/.slicc/watches/a.json');
    await result.value.stop(BACKGROUND_CONTEXT);
    return { mode: result.value.mode };
  });
  assert.equal(seen.mode, 'native');
});

test('watch: on a kernel whose client watches hear other kernels, trees are not rescanned and another tab is heard', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'watch another kernel', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const kernel = await bootKernel();
    const client = await attachKernel(await kernel.connect());
    let probe = '';
    const cat = await client.spawn(['cat', '/proc/sys/kernel/slicc_meta_transactions'], {
      onStdout: (bytes) => {
        probe += new TextDecoder().decode(bytes);
      },
    });
    if ((await cat.exited) !== 0) probe = undefined;
    if (probe === undefined) return { skip: true };
    const other = await attachKernel(await (await bootKernel()).connect());
    for (let i = 0; i < 100; i++) {
      let shared = '';
      const read = await client.spawn(['cat', '/proc/sys/kernel/slicc_shared_root'], {
        onStdout: (bytes) => {
          shared += new TextDecoder().decode(bytes);
        },
      });
      await read.exited;
      if (shared.trim() === '1') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await client.fs.mkdir('/home/p/here');
    const counts = { readdir: 0 };
    const fs = Object.create(client.fs);
    fs.readdir = (path) => {
      counts.readdir += 1;
      return client.fs.readdir(path);
    };
    const env = new SliccKernelEnv({ ...client, fs }, { cwd: '/' });
    const heard = [];
    let wake = () => {};
    const result = await env.watch(
      [
        { path: '/home/p/here', recursive: true },
        { path: '/home/p/missing', recursive: true },
      ],
      (change) => {
        if (change.kind === 'paths') heard.push(...change.paths);
        wake();
      },
      BACKGROUND_CONTEXT
    );
    const until = (path) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no change at ${path}: ${heard}`)), 5000);
        wake = () => {
          if (!heard.includes(path)) return;
          clearTimeout(timer);
          resolve();
        };
        wake();
      });
    const idle = counts.readdir;
    await other.fs.mkdir('/home/p/missing/sub');
    await until('/home/p/missing/sub');
    await other.fs.writeFile('/home/p/here/b.txt', 'b');
    await until('/home/p/here/b.txt');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await result.value.stop(BACKGROUND_CONTEXT);
    return { mode: result.value.mode, rescans: counts.readdir - idle };
  });
  if (seen.skip) {
    t.skip('this kernel does not pass other kernels’ changes to client watches');
    return;
  }
  assert.equal(seen.mode, 'native');
  assert.equal(seen.rescans, 0);
});
