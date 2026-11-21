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

async function restartable(
  page,
  { persist, seed = null, crash = null, extra = [], answers = null, worker = 'main-worker' }
) {
  await page.goto('/');
  await staged(
    page,
    'the restartable freezer agent',
    async ({ persist, seed, crash, extra, answers: said, worker }) => {
      const legacy = (query) =>
        new Promise((resolve) => {
          const worker = new Worker(`/dist-test/legacy-worker.js?${query}`, { type: 'module' });
          worker.onmessage = ({ data }) => {
            worker.terminate();
            resolve(data);
          };
        });
      if (seed) {
        const seeded = await legacy(seed);
        if (seeded.error) throw new Error(seeded.error);
      }
      const crashed = crash ? await legacy(crash) : null;
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const answers = (said ?? Array.from({ length: 6 }, (_, n) => `Answer ${n + 1}.`)).map(
        (answer) => ['answer', answer]
      );
      const f = {};
      const owner = await startTracked({
        worker: () => {
          f.worker = new Worker(
            `/dist-test/${worker}.js?${new URLSearchParams([['persist', persist], ...answers, ...extra])}`,
            { type: 'module' }
          );
          return f.worker;
        },
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
      Object.assign(f, { owner, until, hub, crashed });
      f.ask = (key) =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => resolve(data);
          f.worker.postMessage({ [key]: channel.port2 }, [channel.port2]);
        });
      f.tell = (message) => f.worker.postMessage(message);
      f.memory = (scope) =>
        Object.fromEntries(
          (f.local.memories.value ?? [])
            .filter((entry) => entry.id.startsWith(`${scope}/`))
            .map((entry) => [entry.id, `${entry.origin ?? null}: ${entry.body}`])
        );
      f.unattached = async () => {
        const { items, agents } = await f.ask('conversations');
        const used = new Set(
          [
            ...Object.values(agents.cones),
            ...Object.values(agents.frozen ?? {}),
            ...Object.values(agents.scoops),
          ].map((record) => record.conversation)
        );
        return items.map((item) => item.id).filter((id) => !used.has(id));
      };
      f.frozenRow = (id) => {
        const row = f.local.frozen?.value?.find((item) => item.id === id);
        return row && { model: row.model, messages: row.messages, frozenAt: row.frozenAt };
      };
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
    { persist, seed, crash, extra, answers, worker }
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
  const started = Date.now();
  await restartable(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['bug', 'refrozen'],
      ['said', 'remember colors / door: blue'],
    ]).toString(),
    extra: [['recall', '1']],
  });
  const seen = await staged(page, 'a session whose first cone came back', async () => {
    const { until, open, cones, holding, rows, problems, frozenRow, ask } = globalThis.f;
    stage('the agent');
    const local = await open();
    stage('the cones');
    await until(() => cones().length, 'the cones');
    stage('the views');
    const out = { cones: cones(), holding: await holding('First.') };
    stage('the repaired record');
    out.record = await until(
      () => frozenRow('frozen-1')?.model === 'faux/faux-1' && frozenRow('frozen-1'),
      'the repaired record'
    );
    stage('the extraction');
    out.extractions = await until(async () => {
      const found = await ask('extractions');
      return found.length && found.map((item) => item.conversation);
    }, 'the extraction');
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
  assert.equal(seen.record.messages, 6);
  assert.ok(seen.record.frozenAt >= started);
  assert.ok(seen.extractions.length > 0);
  assert.ok(seen.extractions.every((text) => /remember colors \/ door: blue/.test(text)));
  assert.deepEqual(seen.rows, ['cone-3:cone:true:sliccy:0', 'frozen-1:cone:false:sliccy:6']);
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
    stage('the keeper leaves');
    out.keeperFrozen = await again.control.freeze('cone', BACKGROUND_CONTEXT);
    await until(() => globalThis.f.frozenRow(out.keeperFrozen.id), 'the frozen keeper');
    out.leftRow = globalThis.f.frozenRow('frozen-1');
    out.thawedAfter = await again.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    await until(() => globalThis.f.cones().includes('cone-3'), 'the thawed twin');
    out.holdingAfter = await globalThis.f.holding('First.');
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
  assert.deepEqual(seen.keeperFrozen, { id: 'frozen-2', error: null });
  assert.equal(seen.leftRow.model, 'faux/faux-1');
  assert.equal(seen.leftRow.messages, 4);
  assert.deepEqual(seen.thawedAfter, { id: 'cone-3', error: null });
  assert.deepEqual(seen.holdingAfter, ['cone-3']);
});

test('a session with two live cones on one conversation keeps the active one live even when it has the higher id, and moves the other to the Freezer', async (t) => {
  const page = await chrome.page(t);
  const directory = `/.slicc/freezer-twin-active-${Date.now()}`;
  await restartable(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['bug', 'twin'],
      ['active', 'twin'],
    ]).toString(),
  });
  const seen = await staged(page, 'a session with two live cones, the active', async () => {
    const { until, open, cones, holding, rows, problems } = globalThis.f;
    const local = await open();
    await until(() => cones().length, 'the cones');
    const out = { cones: cones(), holding: await holding('First.') };
    out.rows = await rows();
    out.problems = await problems();
    out.thaw = await local.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    return out;
  });
  assert.deepEqual(seen.cones, ['cone-2', 'cone-3']);
  assert.deepEqual(seen.holding, ['cone-3']);
  assert.deepEqual(seen.rows, [
    'cone-2:cone:true:kept:0',
    'cone-3:cone:true:twin:4',
    'frozen-1:cone:false:sliccy:4',
  ]);
  assert.deepEqual(seen.problems, [
    'cone-3: sliccy (cone) shared its conversation with twin (cone-3), so it moved to the Freezer as frozen-1; the conversation stays live in cone-3.',
  ]);
  assert.deepEqual(seen.thaw, {
    id: null,
    error:
      'twin (cone-3) already has this conversation live, so sliccy can’t have it too; open cone-3 instead.',
  });
});

test('when every cone is frozen, a start that stops right after making the fresh conversation leaves no conversation without a cone, and the next start keeps exactly one fresh cone', async (t) => {
  const page = await chrome.page(t);
  const directory = `/.slicc/freezer-crash-${Date.now()}`;
  await restartable(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['bug', 'frozen'],
    ]).toString(),
    crash: new URLSearchParams([
      ['directory', directory],
      ['crash', 'fresh'],
    ]).toString(),
  });
  const seen = await staged(page, 'when every cone is frozen, a start', async () => {
    const { until, open, restart, cones, unattached, crashed } = globalThis.f;
    await open();
    await until(() => cones().length, 'the cones');
    const out = { crashed: crashed.crashed, cones: cones(), unattached: await unattached() };
    await restart();
    await until(() => globalThis.f.cones().length, 'the cones after the restart');
    out.afterRestart = globalThis.f.cones();
    out.unattachedAfter = await globalThis.f.unattached();
    out.rows = await globalThis.f.rows();
    return out;
  });
  assert.equal(seen.crashed, true);
  assert.deepEqual(seen.cones, ['cone-3']);
  assert.deepEqual(seen.unattached, []);
  assert.deepEqual(seen.afterRestart, ['cone-3']);
  assert.deepEqual(seen.unattachedAfter, []);
  assert.deepEqual(
    seen.rows.map((row) => row.split(':').slice(0, 4).join(':')),
    ['cone-3:cone:true:sliccy', 'frozen-1:cone:false:sliccy', 'frozen-2:cone:false:kept']
  );
});

test('a session left with no cone and no frozen record but with a guest seat starts a fresh cone on a new conversation, says so in the monitor once, and keeps the seat refused', async (t) => {
  const page = await chrome.page(t);
  const directory = `/.slicc/freezer-orphan-${Date.now()}`;
  const seat = {
    id: 'seat-old',
    label: 'Anna',
    agentId: 'cone',
    expiresAt: null,
    gates: { messages: 'off', tools: 'user' },
    createdAt: Date.now(),
    epoch: 1,
    revoked: null,
  };
  await restartable(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['bug', 'orphan'],
      ['seat', JSON.stringify(seat)],
    ]).toString(),
  });
  const seen = await staged(page, 'a session left with no cone', async () => {
    const { until, open, restart, cones, holding, problems, guestSays } = globalThis.f;
    await open();
    await until(() => cones().length, 'the cones');
    const out = { cones: cones(), holding: await holding('First.') };
    out.problems = await problems();
    out.guest = await guestSays('seat-old', 'Are you there?');
    const again = await restart();
    await until(() => globalThis.f.cones().length, 'the cones after the restart');
    out.afterRestart = globalThis.f.cones();
    out.reportedAgain = (again.monitor.value?.problems ?? []).filter(
      (problem) => problem.report?.source === 'slicc.agents'
    ).length;
    return out;
  });
  assert.deepEqual(seen.cones, ['cone-3']);
  assert.deepEqual(seen.holding, []);
  assert.deepEqual(seen.problems, [
    'cone-3: No cone was left but scoops or guest seats were, so sliccy (cone-3) started on a new conversation instead of the first cone’s.',
  ]);
  assert.equal(seen.guest, GONE);
  assert.deepEqual(seen.afterRestart, ['cone-3']);
  assert.equal(seen.reportedAgain, 0);
});

const SAID = ['remember pets / cat: Tom', 'remember drinks / tea: green', 'Fine.', 'Fine.'];

test('Delete cone and New conversation each extract the conversation’s memory in the background, the owner’s lines as owner and the rest as mixed, and neither waits for the extraction', async (t) => {
  const page = await chrome.page(t);
  await restartable(page, {
    persist: `/.slicc/freezer-extract-${Date.now()}`,
    answers: SAID,
    extra: [['recall', '1']],
  });
  const seen = await staged(page, 'Delete cone and New conversation extract', async () => {
    const { until, open, ask, tell, memory } = globalThis.f;
    const local = await open();
    await local.prompt('remember colors / door: blue');
    tell({ recallHold: true });
    stage('the freeze');
    const out = { frozen: await local.control.freeze('cone', BACKGROUND_CONTEXT) };
    stage('the held extraction');
    out.held = await until(async () => {
      const found = await ask('extractions');
      return found.length && found.map((item) => item.conversation);
    }, 'the held extraction');
    out.memoryWhileHeld = memory('cone');
    tell({ recallHold: false, recallRelease: true });
    stage('the frozen cone’s entries');
    out.cone = await until(() => {
      const found = memory('cone');
      return Object.keys(found).length === 2 && found;
    }, 'the frozen cone’s entries');
    stage('the new conversation');
    out.active = local.agents.value.active;
    await local.prompt('remember tools / editor: vim');
    tell({ recallHold: true });
    out.cleared = await local.control.newChat(out.active, BACKGROUND_CONTEXT);
    await until(async () => (await ask('extractions')).length > 2, 'the second held extraction');
    tell({ recallHold: false, recallRelease: true });
    stage('the new conversation’s entries');
    out.next = await until(() => {
      const found = memory(out.active);
      return Object.keys(found).length === 2 && found;
    }, 'the new conversation’s entries');
    out.extractions = (await ask('extractions')).map((item) => item.conversation);
    return out;
  });
  assert.deepEqual(seen.frozen, { id: 'frozen-1', error: null });
  assert.deepEqual(seen.held, ['User: remember colors / door: blue']);
  assert.deepEqual(seen.memoryWhileHeld, {});
  assert.deepEqual(seen.cone, {
    'cone/colors/door': 'owner: blue',
    'cone/pets/cat': 'mixed: Tom',
  });
  assert.equal(seen.active, 'cone-2');
  assert.deepEqual(seen.cleared, { id: 'frozen-2', error: null });
  assert.deepEqual(seen.next, {
    'cone-2/tools/editor': 'owner: vim',
    'cone-2/drinks/tea': 'mixed: green',
  });
  assert.deepEqual(seen.extractions, [
    'User: remember colors / door: blue',
    'User: remember colors / door: blue\n\nAgent: remember pets / cat: Tom',
    'User: remember tools / editor: vim',
    'User: remember tools / editor: vim\n\nAgent: remember drinks / tea: green',
  ]);
});

test('a restart while a freeze’s extraction is still running extracts the frozen conversation exactly once', async (t) => {
  const page = await chrome.page(t);
  await restartable(page, {
    persist: `/.slicc/freezer-extract-restart-${Date.now()}`,
    answers: SAID,
    extra: [['recall', '1']],
  });
  const seen = await staged(page, 'a restart while a freeze’s extraction', async () => {
    const { until, open, ask, tell } = globalThis.f;
    const local = await open();
    await local.prompt('remember colors / door: blue');
    tell({ recallHold: true });
    const out = { frozen: await local.control.freeze('cone', BACKGROUND_CONTEXT) };
    await until(async () => (await ask('extractions')).length, 'the held extraction');
    stage('the restart');
    await globalThis.f.restart();
    stage('the entries');
    out.cone = await until(() => {
      const found = globalThis.f.memory('cone');
      return Object.keys(found).length === 2 && found;
    }, 'the entries after the restart');
    out.afterRestart = (await globalThis.f.ask('extractions')).map((item) => item.conversation);
    stage('the second restart');
    const again = await globalThis.f.restart();
    await again.prompt('Anything new?');
    out.afterSecondRestart = (await globalThis.f.ask('extractions')).length;
    out.coneAfter = globalThis.f.memory('cone');
    return out;
  });
  assert.deepEqual(seen.frozen, { id: 'frozen-1', error: null });
  assert.deepEqual(seen.cone, {
    'cone/colors/door': 'owner: blue',
    'cone/pets/cat': 'mixed: Tom',
  });
  assert.deepEqual(seen.afterRestart, [
    'User: remember colors / door: blue',
    'User: remember colors / door: blue\n\nAgent: remember pets / cat: Tom',
  ]);
  assert.equal(seen.afterSecondRestart, 0);
  assert.deepEqual(seen.coneAfter, seen.cone);
});

test('a freeze’s extraction that gets a model error keeps its cursor and runs again at the next start, without duplicating the entries it saved', async (t) => {
  const page = await chrome.page(t);
  await restartable(page, {
    persist: `/.slicc/freezer-extract-retry-${Date.now()}`,
    answers: SAID,
    extra: [['recall', '1']],
  });
  const seen = await staged(page, 'a freeze’s extraction that gets a model error', async () => {
    const { until, open, ask, tell, memory } = globalThis.f;
    const local = await open();
    await local.prompt('remember colors / door: blue');
    tell({ recallFail: [2] });
    const out = { frozen: await local.control.freeze('cone', BACKGROUND_CONTEXT) };
    stage('the failed extraction');
    await until(async () => (await ask('extractions')).length === 2, 'the failed extraction');
    out.saved = await until(() => {
      const found = memory('cone');
      return Object.keys(found).length && found;
    }, 'the entry saved before the error');
    stage('the restart');
    await globalThis.f.restart();
    out.cone = await until(() => {
      const found = globalThis.f.memory('cone');
      return Object.keys(found).length === 2 && found;
    }, 'the entries after the retry');
    out.retried = (await globalThis.f.ask('extractions')).map((item) => item.memory);
    out.titles = (globalThis.f.local.memories.value ?? [])
      .filter((entry) => entry.scope === 'cone')
      .map((entry) => entry.title)
      .sort();
    return out;
  });
  assert.deepEqual(seen.frozen, { id: 'frozen-1', error: null });
  assert.deepEqual(seen.saved, { 'cone/colors/door': 'owner: blue' });
  assert.deepEqual(seen.cone, {
    'cone/colors/door': 'owner: blue',
    'cone/pets/cat': 'mixed: Tom',
  });
  assert.equal(seen.retried.length, 2);
  assert.ok(seen.retried.every((memory) => /### door\n[\s\S]*blue/.test(memory)));
  assert.deepEqual(seen.titles, ['cat', 'door']);
});

test('New conversation while an earlier extraction of the cone is still running also extracts the turns that came after it', async (t) => {
  const page = await chrome.page(t);
  await restartable(page, {
    persist: `/.slicc/freezer-extract-chain-${Date.now()}`,
    answers: SAID,
    extra: [['recall', '1']],
    worker: 'clock-main-worker',
  });
  const seen = await staged(page, 'New conversation while an earlier extraction', async () => {
    const MINUTE = 60_000;
    const { until, open, ask, tell, memory } = globalThis.f;
    const local = await open();
    const off = globalThis.f.model.monitor.on('snapshot', () => {});
    await until(
      () =>
        local.monitor.value?.tasks?.some(
          (row) => row.kind === 'slicc.memory-idle' && row.status === 'sleeping'
        ),
      'the idle watch'
    );
    off();
    const base = Date.now();
    const clock = new BroadcastChannel('slicc-test-clock');
    clock.postMessage({ now: base + 2 * MINUTE });
    await local.prompt('remember colors / door: blue');
    tell({ recallHold: true });
    stage('the idle extraction');
    clock.postMessage({ now: base + 33 * MINUTE });
    await until(async () => (await ask('extractions')).length, 'the idle extraction');
    await local.prompt('remember tools / editor: vim');
    stage('the new conversation');
    const out = { cleared: await local.control.newChat('cone', BACKGROUND_CONTEXT) };
    tell({ recallHold: false, recallRelease: true });
    stage('the entries');
    out.cone = await until(() => {
      const found = memory('cone');
      return Object.keys(found).length === 4 && found;
    }, 'the entries of both turns');
    out.extractions = (await ask('extractions')).map((item) => item.conversation);
    return out;
  });
  assert.deepEqual(seen.cleared, { id: 'frozen-1', error: null });
  assert.deepEqual(seen.cone, {
    'cone/colors/door': 'owner: blue',
    'cone/pets/cat': 'mixed: Tom',
    'cone/tools/editor': 'owner: vim',
    'cone/drinks/tea': 'mixed: green',
  });
  assert.deepEqual(seen.extractions, [
    'User: remember colors / door: blue',
    'User: remember colors / door: blue\n\nAgent: remember pets / cat: Tom',
    'User: remember tools / editor: vim',
    'User: remember tools / editor: vim\n\nAgent: remember drinks / tea: green',
  ]);
});
