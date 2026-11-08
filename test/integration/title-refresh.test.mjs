import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('cone titles refresh every five user turns after the early ones', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'cone titles refresh every', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const answers = Array.from({ length: 20 }, (_, n) => `answer=Answer ${n + 1}.`).join('&');
    const owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    await model.agent.ready();
    const until = (check, what = 'the state') => when([changed, every(100)], check, what);
    const row = () => model.agent.list().find((agent) => agent.id === 'cone');
    const coneTitle = () => row()?.title;
    const idle = () => until(() => row()?.status === 'idle', 'idle');
    const ask = async (text) => {
      await connection.prompt(text);
      await idle();
    };
    const waitTitle = (check, what) => until(() => check(coneTitle() ?? ''), what);

    await ask('Please fix the build carefully now');
    await waitTitle((title) => /^Title \d+$/.test(title), 'title after turn 1');
    const after1 = coneTitle();

    await ask('Please continue the build carefully');
    await idle();
    const after2 = coneTitle();

    await ask('Please finish the third request carefully');
    await waitTitle((title) => /^Title \d+$/.test(title) && title !== after1, 'title after turn 3');
    const after3 = coneTitle();

    for (let n = 4; n <= 7; n++) await ask(`Please handle follow-up ${n} carefully now`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after7 = coneTitle();

    await ask('Please handle follow-up 8 carefully now');
    await waitTitle((title) => /^Title \d+$/.test(title) && title !== after3, 'title after turn 8');
    const after8 = coneTitle();

    for (let n = 9; n <= 12; n++) await ask(`Please handle follow-up ${n} carefully now`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after12 = coneTitle();

    await ask('Please handle follow-up 13 carefully now');
    await waitTitle(
      (title) => /^Title \d+$/.test(title) && title !== after8,
      'title after turn 13'
    );
    const after13 = coneTitle();

    await owner.release();
    return { after1, after2, after3, after7, after8, after12, after13 };
  });
  assert.match(seen.after1, /^Title \d+$/);
  assert.equal(seen.after2, seen.after1);
  assert.match(seen.after3, /^Title \d+$/);
  assert.notEqual(seen.after3, seen.after1);
  assert.equal(seen.after7, seen.after3);
  assert.match(seen.after8, /^Title \d+$/);
  assert.notEqual(seen.after8, seen.after3);
  assert.equal(seen.after12, seen.after8);
  assert.match(seen.after13, /^Title \d+$/);
  assert.notEqual(seen.after13, seen.after8);
});
