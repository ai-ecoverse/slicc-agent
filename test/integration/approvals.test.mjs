import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

async function boot(page, directory) {
  await page.goto('/');
  await page.evaluate(async (directory) => {
    await import('/dist-test/page.js');
    let worker;
    const query = directory ? `?directory=${directory}` : '';
    const owner = await startAgent({
      worker: () => {
        worker = new Worker(`/dist-test/agent-worker.js${query}`, { type: 'module' });
        return worker;
      },
    });
    const ask = (draft) =>
      new Promise((resolve, reject) => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = ({ data }) =>
          data.error ? reject(new Error(data.error)) : resolve(data.item);
        worker.postMessage({ approve: draft, reply: port2 }, [port2]);
      });
    const MIB = 1024 * 1024;
    const sink = (channel) => {
      const queue = [];
      const pump = () => {
        while (queue.length && channel.readyState === 'open' && channel.bufferedAmount < MIB)
          channel.send(queue.shift());
      };
      channel.onbufferedamountlow = pump;
      return {
        write(bytes) {
          queue.push(bytes.slice());
          pump();
        },
        close() {
          if (channel.readyState === 'open') channel.close();
        },
      };
    };
    const pump = (channel, end) => {
      channel.binaryType = 'arraybuffer';
      channel.onmessage = ({ data }) => end.receive(new Uint8Array(data));
      channel.onclose = () => end.end();
    };
    const follow = async (readOnly) => {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate);
      b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate);
      const ours = a.createDataChannel('pi', { ordered: true });
      const theirs = new Promise((resolve) => {
        b.ondatachannel = ({ channel }) => resolve(channel);
      });
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription();
      await a.setRemoteDescription(b.localDescription);
      const other = await theirs;
      for (const channel of [ours, other])
        if (channel.readyState !== 'open')
          await new Promise((resolve) => channel.addEventListener('open', resolve, { once: true }));
      const port = await owner.port({ readOnly, pages: false });
      pump(ours, bridgePort(port, sink(ours)));
      const endpoint = linkEndpoint(sink(other));
      pump(other, endpoint);
      return connectAgent(endpoint);
    };
    const until = async (check, what) => {
      for (let i = 0; i < 400; i++) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const record = (connection, id) => connection.approvals.value.find((item) => item.id === id);
    const listed = (model, id) => model.approvals.list().some((approval) => approval.id === id);
    const ended = (model) => {
      const seen = [];
      model.approvals.on('ended', (detail) => seen.push(detail));
      return seen;
    };
    const failed = (promise) =>
      promise.then(
        () => 'resolved',
        (error) => error.message
      );
    const guest = { kind: 'guest', name: 'Pat', seat: 'seat-1' };
    const message = (extra = {}) => ({
      kind: 'guest-message',
      seat: 'seat-1',
      agentId: 'cone',
      requester: guest,
      tier: 'user',
      detail: { text: 'Can I help?', attachments: [] },
      ...extra,
    });
    globalThis.t = { owner, ask, follow, until, record, listed, ended, failed, guest, message };
  }, directory ?? null);
}

test('a follower with Control answers over the link, the first decision wins, and one without Control only watches', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { owner, ask, follow, until, record, listed, ended, failed, message } = globalThis.t;
    const local = await owner.connect();
    const follower = await follow(false);
    const viewer = await follow(true);
    const models = [local, follower, viewer].map((connection) => createAgentModel(connection));
    const [mine, theirs, watching] = models;
    const endedHere = ended(mine);
    const item = await ask(message());
    await until(() => models.every((model) => listed(model, item.id)), 'every tab to list it');
    const shown = mine.approvals.list()[0];
    const viewDecide = typeof watching.approvals.decide;
    const viewRefused = await viewer.control.decide(item.id, 'once', null, BACKGROUND_CONTEXT).then(
      () => 'ran',
      (error) => error.code
    );
    await theirs.approvals.decide(item.id, 'once');
    const late = await failed(mine.approvals.decide(item.id, 'deny'));
    await until(() => !listed(mine, item.id) && !listed(watching, item.id), 'the item to leave');
    await until(() => endedHere.length, 'the owner to hear it ended');
    const settled = record(viewer, item.id);
    for (const connection of [viewer, follower, local]) await connection.close();
    await owner.release();
    return { shown, viewDecide, viewRefused, late, endedHere, settled };
  });
  assert.deepEqual(seen.shown, {
    id: seen.settled.id,
    requester: { kind: 'guest', name: 'Pat' },
    createdAt: seen.settled.createdAt,
    expiresAt: seen.settled.expiresAt,
    agentId: 'cone',
    agentName: seen.shown.agentName,
    always: false,
    kind: 'guest-message',
    text: 'Can I help?',
  });
  assert.equal(seen.viewDecide, 'undefined');
  assert.equal(seen.viewRefused, 'EACCES');
  assert.equal(seen.late, 'Someone else already answered this.');
  assert.deepEqual(seen.endedHere, [{ id: seen.settled.id, reason: 'answered' }]);
  assert.equal(seen.settled.state, 'approved');
  assert.equal(seen.settled.answer, 'once');
  assert.equal(seen.settled.decidedBy, 'follower');
});

test('an unknown tier is a deny, and a person saying no stays apart from nobody answering', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { owner, ask, until, record, listed, ended, message } = globalThis.t;
    const local = await owner.connect();
    const model = createAgentModel(local);
    const endedHere = ended(model);
    const unknown = await ask(message({ tier: 'everyone' }));
    const said = await ask(message());
    const ignored = await ask(message({ expiresAt: Date.now() + 1500 }));
    await until(() => listed(model, said.id) && listed(model, ignored.id), 'both to be listed');
    const unknownListed = listed(model, unknown.id);
    await model.approvals.decide(said.id, 'deny');
    await until(() => record(local, ignored.id)?.state === 'unanswered', 'the timeout');
    await until(() => endedHere.length, 'the expiry to end it');
    const states = [unknown, said, ignored].map((item) => {
      const { state, reason, decidedBy } = record(local, item.id);
      return { state, reason: reason ?? null, decidedBy };
    });
    await local.close();
    await owner.release();
    return { unknownListed, states, endedHere, ids: [unknown.id, said.id, ignored.id] };
  });
  assert.equal(seen.unknownListed, false);
  assert.deepEqual(seen.states, [
    { state: 'unanswered', reason: 'unknown-tier', decidedBy: 'host' },
    { state: 'rejected', reason: null, decidedBy: 'owner' },
    { state: 'unanswered', reason: 'timeout', decidedBy: 'host' },
  ]);
  assert.deepEqual(seen.endedHere, [{ id: seen.ids[2], reason: 'expired' }]);
});

test('nothing a guest triggered can be allowed always, while sudo can', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { owner, ask, until, record, listed, failed, guest } = globalThis.t;
    const local = await owner.connect();
    const model = createAgentModel(local);
    const tool = await ask({
      kind: 'guest-tool',
      seat: 'seat-1',
      agentId: 'cone',
      requester: guest,
      tier: 'user',
      always: true,
      detail: { tool: 'bash', summary: 'git push' },
    });
    const sudo = await ask({
      kind: 'sudo',
      agentId: 'cone',
      requester: { kind: 'agent', name: 'cone', agentId: 'cone' },
      tier: 'user',
      always: true,
      detail: { command: 'ls /root', target: 'root' },
    });
    await until(() => listed(model, tool.id) && listed(model, sudo.id), 'both to be listed');
    const shown = model.approvals.list().map(({ id, kind, always }) => ({ id, kind, always }));
    const always = await failed(model.approvals.decide(tool.id, 'always'));
    const stillPending = record(local, tool.id).state;
    await model.approvals.decide(tool.id, 'once');
    await model.approvals.decide(sudo.id, 'always');
    await until(() => record(local, sudo.id)?.state === 'approved', 'the sudo answer');
    const answers = [tool, sudo].map((item) => record(local, item.id).answer);
    await local.close();
    await owner.release();
    return { shown, always, stillPending, answers, ids: [tool.id, sudo.id] };
  });
  assert.deepEqual(seen.shown, [
    { id: seen.ids[0], kind: 'guest-tool', always: false },
    { id: seen.ids[1], kind: 'sudo', always: true },
  ]);
  assert.equal(seen.always, "Always isn't offered for this request.");
  assert.equal(seen.stillPending, 'pending');
  assert.deepEqual(seen.answers, ['once', 'always']);
});

test('a pending approval survives a reload, and one answered before it stays answered', async (t) => {
  const page = await chrome.page(t);
  const directory = `/approvals-${Date.now()}`;
  await boot(page, directory);
  const seen = await page.evaluate(async () => {
    const { owner, ask, until, listed, failed, message } = globalThis.t;
    let local = await owner.connect();
    let model = createAgentModel(local);
    const waiting = await ask(message({ expiresAt: Date.now() + 120_000 }));
    const answered = await ask(message({ expiresAt: Date.now() + 120_000 }));
    await until(() => listed(model, answered.id), 'the second to be listed');
    await model.approvals.decide(answered.id, 'deny');
    await local.close();
    await owner.restart();
    local = await owner.connect();
    model = createAgentModel(local);
    await until(() => listed(model, waiting.id), 'the pending one after the reload');
    const listedAfter = model.approvals.list().map((approval) => approval.id);
    const late = await failed(model.approvals.decide(answered.id, 'once'));
    await model.approvals.decide(waiting.id, 'once');
    const states = Object.fromEntries(local.approvals.value.map((item) => [item.id, item.state]));
    await local.close();
    await owner.release();
    return { listedAfter, late, states, ids: [waiting.id, answered.id] };
  });
  assert.deepEqual(seen.listedAfter, [seen.ids[0]]);
  assert.equal(seen.late, 'Someone else already answered this.');
  assert.equal(seen.states[seen.ids[1]], 'rejected');
});
