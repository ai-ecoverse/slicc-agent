import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.boot = async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let worker;
    const owner = await startTracked({
      worker: () =>
        (worker = new Worker(`/dist-test/bedrock-agent-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    const ask = (key) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ [key]: channel.port2 }, [channel.port2]);
      });
    const until = (check, what = 'the state') => when([changed, every(100)], check, what);
    return { owner, connection: await owner.connect(), ask, until };
  };
};

const BEDROCK = {
  kind: 'model',
  name: 'AWS_BEARER_TOKEN_BEDROCK',
  provider: 'amazon-bedrock',
  placeholder: 'fnox_proxy_bedrock',
  value: 'dummy-bedrock-key-0000',
};
const query = [
  'relay=mcp.test',
  'bedrock',
  'hold-model',
  'vault',
  `record=${encodeURIComponent(JSON.stringify(BEDROCK))}`,
].join('&');

for (const how of ['agent.stop()', 'the remote abort']) {
  test(`${how} during a held model request settles within a few seconds, and the held request is cancelled`, async (t) => {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    const seen = await staged(
      page,
      'how during a held model',
      async ({ query, how }) => {
        const { owner, connection, ask, until } = await window.boot(query);
        const { agent, settings } = createAgentModel(connection, { storage: localStorage });
        await agent.ready();
        const bedrock = await until(
          () =>
            settings
              .models()
              .find((model) => model.id.startsWith('amazon-bedrock/') && model.default)?.id,
          'a Bedrock model'
        );
        agent.setModel(agent.active(), bedrock);
        await until(
          () => agent.list().find((row) => row.id === agent.active())?.model === bedrock,
          'the model switch'
        );
        const held = async () =>
          (await ask('upstream')).upstream
            .filter((request) => request.held)
            .map((request) => request.held);
        await agent.send(agent.active(), 'Hold on');
        await until(async () => (await held()).length === 1, 'the held request');
        const started = Date.now();
        const stopping = how === 'agent.stop()' ? agent.stop() : remoteControl(connection).abort();
        const settled = await until(() => !agent.busy(), 'the turn to stop').then(
          () => Date.now() - started,
          (error) => error.message
        );
        const late = new Promise((resolve) => setTimeout(() => resolve('pending'), 1000));
        const aborted = await Promise.race([stopping, late]);
        const result = { settled, held: await held(), aborted };
        await owner.release();
        return result;
      },
      { query, how }
    );
    assert.deepEqual(seen.held, ['aborted']);
    assert.deepEqual(seen.aborted, how === 'agent.stop()' ? undefined : { aborted: true });
    assert.ok(seen.settled < 5000, `settled: ${seen.settled}`);
  });
}
