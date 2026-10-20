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
      worker: () => (worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    const ask = (key) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ [key]: channel.port2 }, [channel.port2]);
      });
    window.until = (check, what = 'the state') => when([changed, every(100)], check, what);
    return { owner, connection: await owner.connect(), ask };
  };
};

const steps = (...list) => list.map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`);
const vault = (...records) => [
  'relay=mcp.test',
  'e2e',
  'vault',
  ...records.map((record) => `record=${encodeURIComponent(JSON.stringify(record))}`),
];
const ADOBE = {
  kind: 'model',
  name: 'ADOBE_IMS_TOKEN',
  provider: 'adobe',
  placeholder: 'fnox_proxy_adobe',
  value: 'e2e-model-key-0001',
};
const FAUX = {
  kind: 'model',
  name: 'FAUX_API_KEY',
  provider: 'faux',
  placeholder: 'fnox_proxy_faux',
  value: 'faux-model-key-0001',
};

test('a turn retries when the provider says the service is temporarily unavailable', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = steps(
    { error: 'The service is temporarily unavailable' },
    { answer: 'Recovered.' }
  ).join('&');
  const seen = await staged(
    page,
    'a turn retries when the',
    async (query) => {
      const { owner, connection } = await window.boot(query);
      const answer = await connection.prompt('Hello?').catch((error) => `failed: ${error.message}`);
      await owner.release();
      return { answer };
    },
    query
  );
  assert.equal(seen.answer, 'Recovered.');
});

test('after a compaction that keeps assistant messages, the system prompt still leads the model context', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = steps(
    { answer: 'One.' },
    { answer: 'Two.' },
    { answer: 'Summary.' },
    ...Array.from({ length: 6 }, () => ({ answer: 'Three.' }))
  ).join('&');
  const seen = await staged(
    page,
    'after a compaction that keeps',
    async (query) => {
      const { owner, connection, ask } = await window.boot(query);
      await connection.prompt('First question.');
      await connection.prompt(`Second question. ${'Long. '.repeat(16000)}`);
      await connection.control.compact(null, BACKGROUND_CONTEXT);
      const compacted = await window.until(() =>
        connection.transcript.value.entries.some((entry) => entry.kind === 'pi.compaction')
      );
      await connection.prompt('Third question.');
      const requests = await ask('requests');
      await owner.release();
      return { compacted, requests };
    },
    query
  );
  assert.equal(seen.compacted, true);
  const third = seen.requests
    .map((text) => JSON.parse(text))
    .filter((context) => JSON.stringify(context.messages).includes('Third question.'))
    .at(0);
  assert.ok(third);
  const text = JSON.stringify(third.messages);
  assert.ok(text.includes('Second question.'));
  assert.ok(text.includes('Two.'));
  assert.ok(!text.includes('First question.'));
  assert.equal(third.messages[0].role, 'system');
});

test("switching models drops the previous model's thinking from the next request", async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = [
    ...vault(ADOBE, FAUX),
    ...steps({ think: 'Private faux reasoning.', answer: 'First answer.' }),
  ].join('&');
  const seen = await staged(
    page,
    'switching models drops the previous',
    async (query) => {
      const { owner, connection, ask } = await window.boot(query);
      const { agent, settings } = createAgentModel(connection, { storage: localStorage });
      await agent.ready();
      await window.until(() => settings.accounts().length > 0);
      await settings.connect('faux');
      await window.until(
        () => settings.accounts().find((account) => account.id === 'faux')?.status === 'connected'
      );
      const first = await connection.prompt('Think first.');
      await window.until(() => settings.models().some((model) => model.id === 'adobe/e2e-1'));
      agent.setModel(agent.active(), 'adobe/e2e-1');
      await window.until(
        () => agent.list().find((row) => row.id === agent.active())?.model === 'adobe/e2e-1'
      );
      const second = await connection.prompt('Now you.');
      const { upstream } = await ask('upstream');
      await owner.release();
      return { first, second, upstream };
    },
    query
  );
  assert.equal(seen.first, 'First answer.');
  assert.equal(seen.second, 'From the model.');
  const turn = seen.upstream.find((request) => request.body.includes('Now you.'));
  assert.ok(turn);
  assert.ok(turn.body.includes('First answer.'));
  assert.ok(!turn.body.includes('Private faux reasoning.'));
});

test('a tool call with malformed JSON arguments is refused, not run on a partial parse', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const call = { name: 'bash', arguments: '{"command": "echo ran-on-a-partial-parse' };
  const query = [...vault(ADOBE), `e2e-call=${encodeURIComponent(JSON.stringify(call))}`].join('&');
  const seen = await staged(
    page,
    'a tool call with malformed',
    async (query) => {
      const { owner, connection } = await window.boot(query);
      const { agent, settings } = createAgentModel(connection, { storage: localStorage });
      await agent.ready();
      await window.until(() => settings.models().some((model) => model.id === 'adobe/e2e-1'));
      agent.setModel(agent.active(), 'adobe/e2e-1');
      await window.until(
        () => agent.list().find((row) => row.id === agent.active())?.model === 'adobe/e2e-1'
      );
      const answer = await connection.prompt('Run it.');
      const results = connection.transcript.value.entries
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) => ({
          error: entry.model[0].isError,
          text: entry.model[0].content.map((part) => part.text ?? '').join(''),
        }));
      await owner.release();
      return { answer, results };
    },
    query
  );
  assert.equal(seen.answer, 'From the model.');
  assert.equal(seen.results.length, 1);
  assert.equal(seen.results[0].error, true);
  assert.match(seen.results[0].text, /Invalid arguments for tool "bash"/);
  assert.doesNotMatch(seen.results[0].text, /^ran-on-a-partial-parse/m);
});
