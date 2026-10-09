import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the freezer in the production worker: freeze a cone with its scoop, list it, thaw it and go on, delete another', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const answers = Array.from({ length: 8 }, (_, n) => `answer=Answer ${n + 1}.`).join('&');
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
    await connection.prompt('Fix the build');
    const scoop = await connection.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    const other = await connection.control.createCone('other', BACKGROUND_CONTEXT);
    const frozen = await connection.control.freeze('cone', BACKGROUND_CONTEXT);
    await until(() => model.agent.frozen().length === 1);
    const listed = model.agent
      .frozen()
      .map(({ id, name, title, messages }) => ({ id, name, title, messages }));
    const agentsWhileFrozen = connection.agents.value.agents.map((agent) => agent.id);
    const thawed = model.agent.thaw(frozen.id);
    model.agent.select(thawed.id);
    await until(
      () =>
        connection.agents.value.agents.some((agent) => agent.id === 'cone') &&
        model.agent.frozen().length === 0
    );
    const answer = await connection.prompt('Still there?');
    const agentsAfterThaw = connection.agents.value.agents.map((agent) => agent.id);
    const second = await connection.control.freeze(other.id, BACKGROUND_CONTEXT);
    await until(() => model.agent.frozen().length === 1);
    model.agent.discard(second.id);
    await until(() => model.agent.frozen().length === 0);
    await owner.release();
    return {
      scoop: scoop.id,
      frozen: frozen.id,
      listed,
      agentsWhileFrozen,
      agentsAfterThaw,
      answer,
    };
  });
  assert.equal(seen.frozen, 'frozen-1');
  assert.deepEqual(
    seen.listed.map(({ id, name, messages }) => ({ id, name, messages })),
    [{ id: 'frozen-1', name: 'sliccy', messages: 2 }]
  );
  assert.match(seen.listed[0].title, /^(Fix the build|Answer \d)$/);
  assert.deepEqual(seen.agentsWhileFrozen, ['cone-2']);
  assert.deepEqual(seen.agentsAfterThaw.sort(), ['cone', 'cone-2', seen.scoop].sort());
  assert.match(seen.answer, /^Answer \d\.$/);
});
