import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const fixture = await readFile('test/integration/fixtures/gelatiere/suggestions.json', 'utf8');

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

test('the suggestions sprinkle shows the gelatiere store, a dismiss stays in the store, and a try reaches the cone', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async (stored) => {
    await window.write('/home/.gelatiere/suggestions.json', stored);
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const answers = Array.from({ length: 4 }, () => 'answer=Noted.').join('&');
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    await model.agent.ready();
    const until = async (check) => {
      for (let n = 0; n < 200 && !(await check()); n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return check();
    };
    await until(() => model.sprinkles.list().some((item) => item.id === 'suggestions'));
    const listed = model.sprinkles
      .list()
      .map((item) => [item.id, item.title, item.icon, Boolean(item.inline)]);
    const card = await model.sprinkles.call('suggestions', 'readFile', [
      '/shared/.gelatiere/suggestions.json',
    ]);
    model.sprinkles.send('suggestions', { action: 'gelatiere-dismiss', data: { id: 'tip-utc' } });
    await until(
      async () =>
        JSON.parse(await window.read('/home/.gelatiere/suggestions.json')).find(
          (item) => item.id === 'tip-utc'
        ).dismissedAt
    );
    model.sprinkles.send('suggestions', {
      action: 'gelatiere-try',
      data: { id: 'use-case-release-notes', prompt: 'ignored', title: 'Draft notes' },
    });
    const licks = () => model.agent.messages().filter((message) => message.role === 'lick');
    await until(() => licks().length > 0);
    const store = JSON.parse(await window.read('/home/.gelatiere/suggestions.json'));
    await owner.release();
    return {
      listed,
      card: JSON.parse(card).length,
      licks: licks().map((lick) => [lick.channel, lick.text]),
      dismissed: Boolean(store.find((item) => item.id === 'tip-utc').dismissedAt),
      taken: Boolean(store.find((item) => item.id === 'use-case-release-notes').takenAt),
    };
  }, fixture);
  assert.deepEqual(seen.listed, [
    ['suggestions', 'Suggestions', seen.listed[0][2], false],
    ['welcome', 'Welcome', 'sparkles', true],
  ]);
  assert.equal(seen.card, 7);
  assert.deepEqual(seen.licks, [['sprinkle', 'gelatiere-try']]);
  assert.equal(seen.dismissed, true);
  assert.equal(seen.taken, true);
});
