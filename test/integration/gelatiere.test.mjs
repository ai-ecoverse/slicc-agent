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

test('the welcome profile ranks a fake www.sliccy.com catalog through the production worker, and the catalog is cached', async (t) => {
  const rows = [
    {
      name: 'github',
      displayName: 'GitHub',
      description: 'Work with GitHub',
      repo: 'ai-ecoverse/skills',
      path: 'skills/',
      skill: 'github',
      installAll: '',
      apps: 'github',
      tasks: 'build-websites',
      role: 'developer',
      purpose: 'work',
      boost: '',
    },
    {
      name: 'linkedin',
      displayName: 'LinkedIn',
      description: 'Post to LinkedIn',
      repo: 'ai-ecoverse/skills',
      path: '',
      skill: 'linkedin',
      installAll: '',
      apps: 'linkedin',
      tasks: 'write-content',
      role: 'marketer',
      purpose: 'school',
      boost: '',
    },
  ];
  const acme = [
    {
      name: 'acme-tools',
      displayName: 'Acme tools',
      description: 'Internal tools',
      repo: 'acme/skills',
      path: 'tools/',
      skill: '',
      installAll: 'true',
      apps: 'github',
      tasks: '',
      role: '',
      purpose: '',
      boost: '2',
    },
  ];
  const page = await chrome.page(t);
  chrome.overrides.set('/fake-catalog/catalog.json', JSON.stringify({ total: 2, data: rows }));
  chrome.overrides.set('/fake-catalog/acme-inc.json', JSON.stringify({ total: 1, data: acme }));
  await page.init(helpers);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const params = new URLSearchParams([
      ['catalog', '/fake-catalog/'],
      [
        'tool',
        JSON.stringify({
          name: 'bash',
          args: { command: 'gelatiere catalog --json > /home/catalog-out.json' },
        }),
      ],
      ['answer', 'Welcome!'],
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    await model.agent.ready();
    const until = async (check) => {
      for (let n = 0; n < 400; n++) {
        const value = await check().catch(() => undefined);
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return undefined;
    };
    await until(async () => model.sprinkles.list().some((item) => item.id === 'welcome'));
    const profile = {
      purpose: 'work',
      role: 'developer',
      tasks: ['build-websites'],
      name: 'Sam',
      company: 'Acme Inc.',
      apps: ['github'],
    };
    model.sprinkles.send('welcome', { action: 'onboarding-complete', data: profile });
    const out = await until(async () => JSON.parse(await window.read('/home/catalog-out.json')));
    const saved = JSON.parse(await window.read('/home/.welcome.json'));
    const cached = JSON.parse(await window.read('/home/.gelatiere/catalog/catalog.json'));
    const missing = JSON.parse(await window.read('/home/.gelatiere/catalog/use-cases.json'));
    await owner.release();
    return { out, saved, cached: cached.rows.length, missing: missing.rows.length };
  });
  assert.deepEqual(seen.saved.company, 'Acme Inc.');
  assert.equal(seen.out.profile, true);
  assert.deepEqual(
    seen.out.sources.map((line) => line.split(' (')[0]),
    ['skills: fresh', 'company acme-inc: fresh', 'use cases: missing']
  );
  assert.deepEqual(
    seen.out.candidates.map((item) => [item.id, item.score]),
    [
      ['catalog-github', 7],
      ['catalog-acme-tools', 6],
    ]
  );
  assert.deepEqual(seen.out.candidates[1], {
    id: 'catalog-acme-tools',
    kind: 'skill',
    title: 'Acme tools',
    body: 'Internal tools',
    evidence: 'www.sliccy.com catalog: apps(github)',
    score: 6,
    repo: 'acme/skills',
    path: 'tools/',
    all: true,
  });
  assert.equal(seen.cached, 2);
  assert.equal(seen.missing, 0);
  assert.ok(chrome.requests.includes('/fake-catalog/use-cases.json'));
});
