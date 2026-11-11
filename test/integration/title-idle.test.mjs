import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.write = async (path, text) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    let handle = await navigator.storage.getDirectory();
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create: true });
    const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
};

test('a cone that goes quiet for 30 minutes after an untitled turn gets a fresh title, and a turn before then starts the wait over', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'spectrum', async () => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    globalThis.spectrum = { createDummyModel };
  });
  const seen = await staged(page, 'cone titles refresh after 30 idle minutes', async () => {
    const MINUTE = 60_000;
    await window.write(
      '/home/.pi/agent/settings.json',
      JSON.stringify({ memory: { extract: false } })
    );
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const answers = Array.from({ length: 6 }, (_, n) => ['answer', `Answer ${n + 1}.`]);
    const owner = await startTracked({
      worker: () =>
        new Worker(`/dist-test/clock-main-worker.js?${new URLSearchParams(answers)}`, {
          type: 'module',
        }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    await model.agent.ready();
    const panel = document.createElement('slicc-agents');
    panel.style.cssText = 'display:block;width:360px;height:600px';
    panel.model = { ...globalThis.spectrum.createDummyModel({ storage: localStorage }), ...model };
    document.body.append(panel);
    await customElements.whenDefined('slicc-agents');
    const shown = () =>
      panel.shadowRoot?.querySelector('li[data-id="cone"] .title')?.textContent.trim() ?? '';
    const off = model.monitor.on('snapshot', () => {});
    const until = (check, what = 'the state') =>
      when([changed, every(100), connection.monitor], check, what);
    const row = () => model.agent.list().find((agent) => agent.id === 'cone');
    const coneTitle = () => row()?.title ?? '';
    const ask = async (text) => {
      await connection.prompt(text);
      await until(() => row()?.status === 'idle', 'idle');
    };
    const sleeping = () =>
      (connection.monitor.value?.tasks ?? []).filter(
        (task) => task.kind === 'slicc.title-idle' && task.status === 'sleeping'
      );
    const clock = new BroadcastChannel('slicc-test-clock');
    let now = Date.now();
    const pass = (minutes) => {
      now += minutes * MINUTE;
      clock.postMessage({ now });
    };

    await ask('Please fix the build carefully now');
    await until(() => /^Title \d+$/.test(coneTitle()), 'title after turn 1');
    const first = coneTitle();
    const quietAfterFirst = sleeping().length;

    await ask('Please also tidy the release notes');
    await until(() => sleeping().length === 1, 'the idle watch after turn 2');
    pass(20);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const at20 = coneTitle();

    await ask('Please check the changelog once more');
    await until(
      () => /^Title \d+$/.test(coneTitle()) && coneTitle() !== first,
      'title after turn 3'
    );
    const third = coneTitle();

    await ask('Please draft the announcement email too');
    await until(() => sleeping().length === 1, 'the idle watch after turn 4');
    const watches = sleeping().length;
    pass(20);
    await ask('Please shorten the announcement a bit');
    await until(() => sleeping().length === 1, 'one idle watch after turn 5');
    pass(20);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const twentyAfterFifth = coneTitle();
    pass(11);
    await until(() => coneTitle() !== third, 'title after 30 idle minutes');
    const idle = coneTitle();
    await until(() => shown() === idle, 'the idle title in the Agents panel');
    const rendered = shown();
    await until(() => sleeping().length === 0, 'the idle watch ends');

    off();
    await owner.release();
    return { first, quietAfterFirst, at20, third, watches, twentyAfterFifth, idle, rendered };
  });
  assert.match(seen.first, /^Title \d+$/);
  assert.equal(seen.quietAfterFirst, 0);
  assert.equal(seen.at20, seen.first);
  assert.notEqual(seen.third, seen.first);
  assert.equal(seen.watches, 1);
  assert.equal(seen.twentyAfterFifth, seen.third);
  assert.match(seen.idle, /^Title \d+$/);
  assert.notEqual(seen.idle, seen.third);
  assert.equal(seen.rendered, seen.idle);
});
