import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the freezer in the production worker: freeze a cone with its scoop, list it, thaw it and go on, delete another', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'the freezer in the production', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const answers = Array.from({ length: 8 }, (_, n) => `answer=Answer ${n + 1}.`).join('&');
    const owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    await model.agent.ready();
    const frozenRows = () => model.agent.frozen().filter((row) => row.id.startsWith('frozen-'));
    const until = (check, what = 'the state') => when([changed, every(100)], check, what);
    await connection.prompt('Please fix the build');
    const coneTitle = () => model.agent.list().find((agent) => agent.id === 'cone')?.title;
    await until(() => /^Title \d$/.test(coneTitle() ?? ''));
    const liveTitle = coneTitle();
    const scoop = await connection.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    const other = await connection.control.createCone('other', BACKGROUND_CONTEXT);
    const frozen = await connection.control.freeze('cone', BACKGROUND_CONTEXT);
    await until(() => frozenRows().length === 1);
    const listed = frozenRows().map(({ id, name, title, messages }) => ({
      id,
      name,
      title,
      messages,
    }));
    const agentsWhileFrozen = connection.agents.value.agents.map((agent) => agent.id);
    const kinds = model.agent.frozen().map(({ id, kind, live }) => `${id}:${kind}:${live}`);
    const thawed = model.agent.thaw(frozen.id);
    model.agent.select(thawed.id);
    await until(
      () =>
        connection.agents.value.agents.some((agent) => agent.id === 'cone') &&
        frozenRows().length === 0
    );
    const answer = await connection.prompt('Still there?');
    const agentsAfterThaw = connection.agents.value.agents.map((agent) => agent.id);
    const second = await connection.control.freeze(other.id, BACKGROUND_CONTEXT);
    await until(() => frozenRows().length === 1);
    model.agent.discard(second.id);
    await until(() => frozenRows().length === 0);
    await owner.release();
    return {
      scoop: scoop.id,
      frozen: frozen.id,
      listed,
      agentsWhileFrozen,
      agentsAfterThaw,
      answer,
      kinds,
      liveTitle,
    };
  });
  assert.equal(seen.frozen, 'frozen-1');
  assert.match(seen.liveTitle, /^Title \d$/);
  assert.deepEqual(
    seen.listed.map(({ id, name, messages }) => ({ id, name, messages })),
    [{ id: 'frozen-1', name: 'sliccy', messages: 2 }]
  );
  assert.match(seen.listed[0].title, /^(Please fix the build|Title \d)$/);
  assert.deepEqual(seen.agentsWhileFrozen, ['cone-2']);
  assert.deepEqual(seen.agentsAfterThaw.sort(), ['cone', 'cone-2', seen.scoop].sort());
  assert.match(seen.answer, /^Answer \d\.$/);
  assert.deepEqual(
    seen.kinds.sort(),
    ['cone-2:cone:true', 'frozen-1:cone:false', `${seen.scoop}:scoop:false`].sort()
  );
});

const GONE = 'The cone this seat shares is gone.';

async function restartable(page, { persist, seed = null }) {
  await page.goto('/');
  await staged(
    page,
    'the restartable freezer agent',
    async ({ persist, seed }) => {
      if (seed) {
        const seeded = await new Promise((resolve) => {
          const worker = new Worker(`/dist-test/legacy-worker.js?${seed}`, { type: 'module' });
          worker.onmessage = ({ data }) => {
            worker.terminate();
            resolve(data);
          };
        });
        if (seeded.error) throw new Error(seeded.error);
      }
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const answers = Array.from({ length: 6 }, (_, n) => ['answer', `Answer ${n + 1}.`]);
      const owner = await startTracked({
        worker: () =>
          new Worker(
            `/dist-test/main-worker.js?${new URLSearchParams([['persist', persist], ...answers])}`,
            { type: 'module' }
          ),
        kernel: { connect: () => kernel.connect() },
      });
      const hub = {
        minted: 0,
        async mint() {
          this.minted += 1;
          return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
        },
        async revoke() {},
      };
      const until = (check, what) => when([changed, every(100)], check, what);
      const f = { owner, until, hub };
      f.open = async () => {
        f.local = await owner.connect();
        f.model = createAgentModel(f.local, { guests: hub });
        await f.model.agent.ready();
        return f.local;
      };
      f.restart = async () => {
        await f.local.close();
        await owner.restart();
        return f.open();
      };
      f.cones = () =>
        f.local.agents.value.agents
          .filter((agent) => agent.kind === 'cone')
          .map((agent) => agent.id)
          .sort();
      f.texts = (agentId) =>
        (f.local.views.value?.[agentId]?.entries ?? []).flatMap((entry) =>
          (entry.model ?? []).flatMap((message) =>
            typeof message.content === 'string'
              ? [message.content]
              : (message.content ?? [])
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
          )
        );
      f.holding = (text) =>
        until(() => {
          const views = f.local.views.value ?? {};
          const cones = f.cones();
          return (
            cones.every((id) => views[id]) &&
            cones.filter((id) => f.texts(id).some((line) => line.includes(text)))
          );
        }, `the cones' views to load`);
      f.rows = async () => {
        await until(() => f.local.frozen?.value, 'the freezer rows');
        return f.local.frozen.value
          .map(({ id, kind, live, name, messages }) => `${id}:${kind}:${live}:${name}:${messages}`)
          .sort();
      };
      f.sh = async (command) => {
        await until(
          async () => (await kernel.run(['bash', '-c', 'freezer list'])).status === 0,
          'the freezer command'
        );
        const ran = await kernel.run(['bash', '-c', command]);
        return { status: ran.status, out: `${ran.stdout}${ran.stderr}` };
      };
      f.problems = async () => {
        const off = f.model.monitor.on('snapshot', () => {});
        const found = await until(() => {
          const listed = (f.local.monitor.value?.problems ?? [])
            .filter((problem) => problem.report?.source === 'slicc.agents')
            .map(({ agentId, message }) => `${agentId}: ${message}`);
          return listed.length && listed;
        }, 'the repair report');
        off();
        return found;
      };
      f.join = (seat) =>
        owner
          .port({ guest: { id: seat, label: 'Anna' } })
          .then(connectGuest)
          .then(track);
      f.guestSays = async (seat, text) => {
        const guest = await f.join(seat);
        const sent = await guest.control.send(
          { text, whenBusy: 'followUp', requestId: null },
          BACKGROUND_CONTEXT
        );
        await guest.close();
        return sent.accepted ? 'accepted' : sent.error.message;
      };
      globalThis.f = f;
    },
    { persist, seed }
  );
}

test('a frozen first cone stays frozen across a worker restart, a guest seat on it stays refused, and thawing it brings back the same cone on its conversation', async (t) => {
  const page = await chrome.page(t);
  await restartable(page, { persist: `/.slicc/freezer-first-${Date.now()}` });
  const seen = await staged(page, 'a frozen first cone stays frozen', async () => {
    const { until, open, restart, cones, holding, rows, guestSays } = globalThis.f;
    const local = await open();
    await local.prompt('Remember the blue door.');
    const gates = { messages: 'off', tools: 'user' };
    const minted = await globalThis.f.model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates,
    });
    const seat = minted.seat.id;
    const out = { before: cones() };
    out.frozen = await local.control.freeze('cone', BACKGROUND_CONTEXT);
    out.whileFrozen = await guestSays(seat, 'Are you there?');
    await restart();
    await until(() => cones().length, 'the cones after the restart');
    out.afterRestart = cones();
    out.holdingAfterRestart = await holding('blue door');
    out.rowsAfterRestart = await rows();
    out.guestAfterRestart = await guestSays(seat, 'Still there?');
    out.thawed = await globalThis.f.local.control.thaw(out.frozen.id, BACKGROUND_CONTEXT);
    await until(() => cones().includes('cone'), 'the thawed cone');
    out.afterThaw = cones();
    out.holdingAfterThaw = await holding('blue door');
    out.guestAfterThaw = await guestSays(seat, 'Back now?');
    await restart();
    await until(() => cones().length, 'the cones after the second restart');
    out.afterSecondRestart = cones();
    out.holdingAfterSecondRestart = await holding('blue door');
    out.rowsAfterSecondRestart = await rows();
    return out;
  });
  assert.deepEqual(seen.before, ['cone']);
  assert.deepEqual(seen.frozen, { id: 'frozen-1', error: null });
  assert.equal(seen.whileFrozen, GONE);
  assert.deepEqual(seen.afterRestart, ['cone-2']);
  assert.deepEqual(seen.holdingAfterRestart, []);
  assert.deepEqual(seen.rowsAfterRestart, [
    'cone-2:cone:true:sliccy:0',
    'frozen-1:cone:false:sliccy:2',
  ]);
  assert.equal(seen.guestAfterRestart, GONE);
  assert.deepEqual(seen.thawed, { id: 'cone', error: null });
  assert.deepEqual(seen.afterThaw, ['cone', 'cone-2']);
  assert.deepEqual(seen.holdingAfterThaw, ['cone']);
  assert.equal(seen.guestAfterThaw, 'accepted');
  assert.deepEqual(seen.afterSecondRestart, ['cone', 'cone-2']);
  assert.deepEqual(seen.holdingAfterSecondRestart, ['cone']);
  assert.deepEqual(
    seen.rowsAfterSecondRestart.map((row) => row.split(':').slice(0, 3).join(':')),
    ['cone-2:cone:true', 'cone:cone:true']
  );
});

test('a session whose first cone came back live on its frozen conversation freezes it again at startup, says so in the monitor, starts a fresh cone, and thaws it as the same cone', async (t) => {
  const page = await chrome.page(t);
  const directory = `/.slicc/freezer-refrozen-${Date.now()}`;
  await restartable(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['bug', 'refrozen'],
    ]).toString(),
  });
  const seen = await staged(page, 'a session whose first cone came back', async () => {
    const { until, open, cones, holding, rows, problems } = globalThis.f;
    stage('the agent');
    const local = await open();
    stage('the cones');
    await until(() => cones().length, 'the cones');
    stage('the views');
    const out = { cones: cones(), holding: await holding('First.') };
    stage('the rows');
    out.rows = await rows();
    stage('the report');
    out.problems = await problems();
    stage('the thaw');
    out.thawed = await local.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    await until(() => cones().includes('cone'), 'the thawed cone');
    out.afterThaw = cones();
    out.holdingAfterThaw = await holding('First.');
    return out;
  });
  assert.deepEqual(seen.cones, ['cone-3']);
  assert.deepEqual(seen.holding, []);
  assert.deepEqual(seen.rows, ['cone-3:cone:true:sliccy:0', 'frozen-1:cone:false:sliccy:4']);
  assert.deepEqual(seen.problems, [
    'null: sliccy (cone) was live again on the conversation it was frozen with as frozen-1, so it is frozen again; thaw frozen-1 to continue it.',
  ]);
  assert.deepEqual(seen.thawed, { id: 'cone', error: null });
  assert.deepEqual(seen.afterThaw, ['cone', 'cone-3']);
  assert.deepEqual(seen.holdingAfterThaw, ['cone']);
});

test('a session with two live cones on one conversation keeps the first one live, moves the other to the Freezer with a monitor report, and refuses to thaw it onto that conversation', async (t) => {
  const page = await chrome.page(t);
  const directory = `/.slicc/freezer-twin-${Date.now()}`;
  await restartable(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['bug', 'twin'],
    ]).toString(),
  });
  const seen = await staged(page, 'a session with two live cones', async () => {
    const { until, open, restart, cones, holding, rows, problems, sh } = globalThis.f;
    const local = await open();
    await until(() => cones().length, 'the cones');
    stage('the views');
    const out = { cones: cones(), holding: await holding('First.') };
    stage('the rows');
    out.rows = await rows();
    stage('the report');
    out.problems = await problems();
    stage('the thaw');
    out.control = await local.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    out.command = await sh('freezer thaw frozen-1');
    const again = await restart();
    await until(() => globalThis.f.cones().length, 'the cones after the restart');
    out.afterRestart = globalThis.f.cones();
    out.rowsAfterRestart = await globalThis.f.rows();
    out.reportedAgain = (again.monitor.value?.problems ?? []).filter(
      (problem) => problem.report?.source === 'slicc.agents'
    ).length;
    return out;
  });
  const refusal =
    'sliccy (cone) already has this conversation live, so twin can’t have it too; open cone instead.';
  assert.deepEqual(seen.cones, ['cone', 'cone-2']);
  assert.deepEqual(seen.holding, ['cone']);
  assert.deepEqual(seen.rows, [
    'cone-2:cone:true:kept:0',
    'cone:cone:true:sliccy:4',
    'frozen-1:cone:false:twin:4',
  ]);
  assert.deepEqual(seen.problems, [
    'cone: twin (cone-3) shared its conversation with sliccy (cone), so it moved to the Freezer as frozen-1; the conversation stays live in cone.',
  ]);
  assert.deepEqual(seen.control, { id: null, error: refusal });
  assert.deepEqual(seen.command, { status: 1, out: `freezer: ${refusal}\n` });
  assert.deepEqual(seen.afterRestart, ['cone', 'cone-2']);
  assert.deepEqual(seen.rowsAfterRestart, seen.rows);
  assert.equal(seen.reportedAgain, 0);
});
