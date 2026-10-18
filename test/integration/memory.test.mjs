import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  const dir = async (parts, create) => {
    let handle = await navigator.storage.getDirectory();
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create });
    return handle;
  };
  window.write = async (path, text) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    const writable = await (
      await (await dir(parts, true)).getFileHandle(name, { create: true })
    ).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.read = async (path) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    return (await (await (await dir(parts, false)).getFileHandle(name)).getFile()).text();
  };
};

test('memory: context files and memory reach the prompt, memory_write redacts secrets, and the memory panel port edits the files', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    await window.write('/home/.pi/agent/AGENTS.md', 'Always answer in English.');
    await window.write(
      '/home/.pi/agent/memory/MEMORY.md',
      '## About the user\n\n### Name\ntag: user\n\nThe user is Sam.\n'
    );
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const params = new URLSearchParams([
      [
        'memory',
        JSON.stringify({
          section: 'Projects',
          title: 'harbor',
          body: 'Forecast API. Token sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE.',
          tag: 'project',
        }),
      ],
      ['answer', 'Saved.'],
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    const answer = await connection.prompt('Remember the harbor project.');
    const entries = connection.transcript.value.entries;
    const result = entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => entry.model[0].content.map((part) => part.text ?? '').join(''))[0];
    const until = async (check) => {
      for (let n = 0; n < 200 && !check(); n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return check();
    };
    await until(() => model.memory.list().some((item) => item.id === 'cone/projects/harbor'));
    const listed = model.memory.list().map((item) => [item.id, item.tag]);
    const scopes = model.memory.scopes().map((scope) => scope.id);
    const coneFile = await window.read('/home/.pi/agent/memory/cone/MEMORY.md');
    model.memory.save({
      scope: 'global',
      section: 'Preferences',
      title: 'Short',
      body: 'Keep replies short.',
      tag: 'feedback',
    });
    model.memory.remove('global/about-the-user/name');
    await until(
      () =>
        connection.memories.value.some((item) => item.id === 'global/preferences/short') &&
        !connection.memories.value.some((item) => item.id === 'global/about-the-user/name')
    );
    const globalFile = await window.read('/home/.pi/agent/memory/MEMORY.md');
    await owner.release();
    return {
      answer,
      result,
      listed,
      scopes,
      coneFile,
      globalFile,
      prompt: JSON.stringify(entries),
    };
  });
  assert.equal(seen.answer, 'Saved.');
  assert.match(
    seen.result,
    /^Saved "harbor" in Projects \(cone\/projects\/harbor\)\..*Redacted 1 thing that looked like a secret\.$/
  );
  assert.equal(
    seen.coneFile,
    '## Projects\n\n### harbor\ntag: project\n\nForecast API. Token [redacted].\n'
  );
  assert.deepEqual(seen.listed, [
    ['global/about-the-user/name', 'user'],
    ['cone/projects/harbor', 'project'],
  ]);
  assert.deepEqual(seen.scopes.slice(0, 2), ['global', 'cone']);
  assert.equal(
    seen.globalFile,
    '## Preferences\n\n### Short\ntag: feedback\n\nKeep replies short.\n'
  );
  assert.match(seen.prompt, /Always answer in English\./);
  assert.match(seen.prompt, /The user is Sam\./);
});

test('memory: a new cone gets its memory scope without a memory file changing', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const scoped = (label) =>
      new Promise((resolve) => {
        let off = () => undefined;
        const look = () => {
          const scope = connection.memoryScopes.value?.find((item) => item.label === label);
          if (!scope) return;
          off();
          resolve(scope);
        };
        off = connection.memoryScopes.subscribe(look);
        look();
      });
    const first = await scoped('sliccy');
    const created = await connection.control.createCone('second', BACKGROUND_CONTEXT);
    const scope = await scoped('second');
    await owner.release();
    return { first, created: created.id, scope };
  });
  assert.deepEqual(seen.first, { id: 'cone', label: 'sliccy', group: 'cones' });
  assert.deepEqual(seen.scope, { id: seen.created, label: 'second', group: 'cones' });
});

const held = () => {
  window.heldMemory = async (files) => {
    for (const [path, text] of Object.entries(files)) await window.write(path, text);
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel(
      {},
      { worker: new URL('/held-memory-kernel-worker.js', location.href) }
    );
    let worker;
    const owner = await startAgent({
      worker: () => {
        worker = new Worker('/dist-test/main-worker.js', { type: 'module' });
        return worker;
      },
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const hold = new BroadcastChannel('held-memory');
    const heard = (check) =>
      new Promise((resolve) => {
        const look = ({ data }) => {
          if (!check(data)) return;
          hold.removeEventListener('message', look);
          resolve(data);
        };
        hold.addEventListener('message', look);
      });
    const scoped = (label) =>
      new Promise((resolve) => {
        let off = () => undefined;
        const look = () => {
          const scope = connection.memoryScopes.value?.find((item) => item.label === label);
          if (!scope) return;
          off();
          resolve(scope);
        };
        off = connection.memoryScopes.subscribe(look);
        look();
      });
    await scoped('sliccy');
    const armed = heard((data) => data === 'armed');
    hold.postMessage('arm');
    await armed;
    return {
      owner,
      connection,
      scoped,
      holding: heard((data) => data === 'held'),
      release: () => hold.postMessage('release'),
      reads: async () => {
        const counted = heard((data) => typeof data?.reads === 'number');
        hold.postMessage('count');
        return (await counted).reads;
      },
      close: () =>
        new Promise((resolve) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = ({ data }) => resolve(data);
          worker.postMessage({ close: port2 }, [port2]);
        }),
    };
  };
};

const files = {
  '/home/.pi/agent/memory/MEMORY.md': '## Notes\n\n### One\n\nShared note.\n',
  '/home/.pi/agent/memory/cone/MEMORY.md': '## Notes\n\n### Two\n\nCone note.\n',
};

test('memory: a memory read that never settles does not keep a newer cone from its scope', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(held);
  await page.goto('/');
  const seen = await page.evaluate(async (files) => {
    const agent = await window.heldMemory(files);
    const { connection } = agent;
    await connection.control.createCone('first', BACKGROUND_CONTEXT);
    await agent.holding;
    const created = await connection.control.createCone('second', BACKGROUND_CONTEXT);
    const scope = await agent.scoped('second');
    const first = await agent.scoped('first');
    agent.release();
    await agent.owner.release();
    return { created: created.id, scope, first: first.label };
  }, files);
  assert.deepEqual(seen.scope, { id: seen.created, label: 'second', group: 'cones' });
  assert.equal(seen.first, 'first');
});

test('memory: after the agent host closes, no memory reload runs', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(held);
  await page.goto('/');
  const seen = await page.evaluate(async (files) => {
    const agent = await window.heldMemory(files);
    await agent.connection.control.createCone('first', BACKGROUND_CONTEXT);
    await agent.holding;
    const closed = await agent.close();
    const before = await agent.reads();
    agent.release();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await agent.reads();
    await agent.owner.release();
    return { closed, later: after - before };
  }, files);
  assert.equal(seen.closed, 'closed');
  assert.equal(seen.later, 0);
});
