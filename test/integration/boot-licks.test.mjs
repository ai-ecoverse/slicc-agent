import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const ADOBE = {
  kind: 'model',
  name: 'ADOBE_IMS_TOKEN',
  provider: 'adobe',
  placeholder: 'fnox_proxy_adobe',
  value: 'e2e-model-key-0001',
};
const bash = (command) => ({ name: 'bash', arguments: JSON.stringify({ command }) });
const ANSWER = 'said:From the model.';

async function boot(page, lives) {
  await page.goto('/');
  await staged(
    page,
    'the boot-licks agent',
    async ({ lives, record }) => {
      await import('/dist-test/page.js');
      stage('the kernel');
      const { bootKernel } = await import('/kernel.js');
      const directory = `/.slicc/boot-licks-${Date.now()}`;
      const r = { kernel: await bootKernel(), life: 0 };
      const url = ({ version, calls = [], adobe = true }) =>
        `/dist-test/main-worker.js?${new URLSearchParams([
          ['persist', directory],
          ['version', version],
          ['relay', 'mcp.test'],
          ['vault', ''],
          ...(adobe
            ? [
                ['e2e', ''],
                ['record', JSON.stringify(record)],
              ]
            : []),
          ...calls.map((call) => ['e2e-call', JSON.stringify(call)]),
        ])}`;
      r.owner = await startAgent({
        worker: () => new Worker(url(lives[r.life++]), { type: 'module' }),
        kernel: { connect: () => r.kernel.connect() },
      });
      r.pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      r.entries = () => r.local?.views.value?.cone?.entries ?? [];
      r.text = (entry) => {
        const content = entry.model?.[0]?.content;
        if (typeof content === 'string') return content;
        return (content ?? []).map((block) => block.text ?? '').join('');
      };
      r.shape = () =>
        r.entries().flatMap((entry) => {
          if (entry.kind === 'pi.user') {
            const lick = /^<lick [^>]*channel="([^"]+)"[^>]*count="(\d+)"/.exec(r.text(entry));
            return [lick ? `lick:${lick[1]}:${lick[2]}` : `user:${r.text(entry)}`];
          }
          if (entry.kind === 'pi.assistant') {
            const said = r.text(entry);
            return [said ? `said:${said}` : 'tool'];
          }
          return [];
        });
      r.until = (check, what) => when(agentSources(r.local, r.model), check, what);
      r.idle = () => !r.local.views.value?.cone?.docs?.['pi.live']?.run;
      r.listed = () => r.model.settings.models().some((model) => model.id === 'adobe/e2e-1');
      r.open = async () => {
        stage('the connection');
        r.local = await r.owner.connect();
        r.model = createAgentModel(r.local, { storage: localStorage });
        await r.model.agent.ready();
        await r.until(() => r.local.views.value?.cone, 'the cone');
      };
      r.adobe = async () => {
        const { agent } = r.model;
        await r.until(r.listed, 'the Adobe model');
        agent.setModel(agent.active(), 'adobe/e2e-1');
        await r.until(
          () => agent.list().find((row) => row.id === agent.active())?.model === 'adobe/e2e-1',
          'the cone on the Adobe model'
        );
      };
      r.prompt = (text) => {
        stage(`the answer to ${text}`);
        return r.local.prompt(text);
      };
      r.restart = async (kernel = false) => {
        stage('the restart');
        await r.local.close();
        if (kernel) {
          r.kernel.terminate();
          await r.pause(1100);
          stage('the kernel after a restart');
          r.kernel = await bootKernel();
        }
        stage('the worker after a restart');
        await r.owner.restart();
        await r.open();
      };
      r.settle = async (what) => {
        await r.until(r.listed, 'the Adobe model');
        stage('a quiet window');
        await r.pause(2500);
        await r.until(r.idle, what);
        return r.shape();
      };
      globalThis.r = r;
      await r.open();
      await r.adobe();
    },
    { lives, record: ADOBE }
  );
}

test('an upgrade lick starts a turn on its own that the model answers', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [{ version: '6.5.0' }, { version: '6.6.0' }]);
  const seen = await staged(page, 'the upgrade lick', async () => {
    const { until, prompt, restart, shape, settle } = globalThis.r;
    await prompt('Hi.');
    await restart();
    await until(() => shape().length === 4, 'the answer to the upgrade');
    return settle('the upgrade turn');
  });
  assert.deepEqual(seen, ['user:Hi.', 'said:From the model.', 'lick:upgrade:1', ANSWER]);
});

test('a session-reload lick starts a turn on its own that the model answers', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [{ version: '6.6.0', calls: [bash('echo one')] }, { version: '6.6.0' }]);
  const seen = await staged(page, 'the session-reload lick', async () => {
    const { until, prompt, restart, shape, settle } = globalThis.r;
    await prompt('Start it.');
    await restart(true);
    await until(() => shape().length === 5, 'the answer to the reload');
    return settle('the reload turn');
  });
  assert.deepEqual(seen, ['user:Start it.', 'tool', ANSWER, 'lick:session-reload:1', ANSWER]);
});

test('two reloads in quick succession give one reload lick and one turn', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [
    { version: '6.6.0', calls: [bash('echo one')] },
    { version: '6.6.0', adobe: false },
    { version: '6.6.0' },
  ]);
  const seen = await staged(page, 'two reloads', async () => {
    const { prompt, restart, settle } = globalThis.r;
    await prompt('Start it.');
    await restart(true);
    await restart(true);
    return settle('the reload turns');
  });
  assert.deepEqual(seen, ['user:Start it.', 'tool', ANSWER, 'lick:session-reload:1', ANSWER]);
});

test('a reload caused by the turn a reload lick started does not wake the agent again', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [
    { version: '6.6.0', calls: [bash('echo one')] },
    { version: '6.6.0', calls: [bash('echo two')] },
    { version: '6.6.0' },
  ]);
  const seen = await staged(page, 'a reload from a reload turn', async () => {
    const { until, prompt, restart, shape, settle } = globalThis.r;
    await prompt('Start it.');
    await restart(true);
    await until(() => shape().length === 6, 'the turn the reload lick started');
    await restart(true);
    return settle('after the second reload');
  });
  assert.deepEqual(seen, [
    'user:Start it.',
    'tool',
    ANSWER,
    'lick:session-reload:1',
    'tool',
    ANSWER,
  ]);
});

test('a run a reload interrupts on a discovered model is resumed and answered', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [{ version: '6.6.0', calls: [bash('sleep 30')] }, { version: '6.6.0' }]);
  const seen = await staged(page, 'a resumed run', async () => {
    const { local, until, restart, shape, settle } = globalThis.r;
    const sent = await local.control.send(
      { text: 'Wait.', whenBusy: 'followUp', requestId: null },
      BACKGROUND_CONTEXT
    );
    await until(
      () => local.views.value?.cone?.docs?.['pi.live']?.tools?.length,
      'the running tool call'
    );
    await restart();
    await until(() => shape().length === 3, 'the answer after the reload');
    return { shape: await settle('the resumed run'), sent: Boolean(sent.submissionId) };
  });
  assert.equal(seen.sent, true);
  assert.deepEqual(seen.shape, ['user:Wait.', 'tool', ANSWER]);
});
