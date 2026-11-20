import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const MIB = 1024 * 1024;

async function boot(page, steps) {
  await page.goto('/');
  await staged(
    page,
    'the owner',
    async (steps) => {
      await import('/dist-test/page.js');
      stage('the kernel');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      stage('the agent');
      const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const MIB = 1024 * 1024;
      const sink = (channel) => {
        const queue = [];
        let closing = false;
        const pump = () => {
          while (queue.length && channel.readyState === 'open' && channel.bufferedAmount < MIB)
            channel.send(queue.shift());
          if (!queue.length && closing && channel.readyState === 'open') channel.close();
        };
        channel.bufferedAmountLowThreshold = 256 * 1024;
        channel.onbufferedamountlow = pump;
        return {
          write(bytes) {
            for (let at = 0; at < bytes.length; at += 64 * 1024)
              queue.push(bytes.slice(at, at + 64 * 1024));
            pump();
          },
          close() {
            closing = true;
            pump();
          },
        };
      };
      const pump = (channel, end) => {
        channel.binaryType = 'arraybuffer';
        channel.onmessage = ({ data }) => end.receive(new Uint8Array(data));
        channel.onclose = () => end.end();
      };
      const loopback = async () => {
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
            await new Promise((resolve) =>
              channel.addEventListener('open', resolve, { once: true })
            );
        return { owner: ours, follower: other, peers: [a, b] };
      };
      const follow = async (readOnly) => {
        const rtc = await loopback();
        const port = await owner.port({ readOnly, pages: false });
        pump(rtc.owner, bridgePort(port, sink(rtc.owner)));
        const endpoint = linkEndpoint(sink(rtc.follower));
        pump(rtc.follower, endpoint);
        const connection = await connectAgent(endpoint);
        return { connection, rtc };
      };
      const until = (check, what, connections) =>
        when(
          connections.flatMap((connection) => agentSources(connection)),
          check,
          what
        );
      const said = (connection) =>
        (connection.transcript.value?.entries ?? []).flatMap((entry) =>
          entry.kind === 'pi.assistant'
            ? (entry.model?.[0]?.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
            : []
        );
      const busy = (connection) => Boolean(connection.transcript.value?.docs['pi.live']?.run);
      globalThis.follow = { owner, follow, until, said, busy };
    },
    steps
  );
}

test('a follower over loopback WebRTC watches, sends a max-size message, steers and aborts; one without Control is refused', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [
    { answer: 'Watched.' },
    { answer: 'Got the files.' },
    { tool: { name: 'bash', args: { command: 'sleep 3' } } },
    { answer: 'Steered.' },
    { tool: { name: 'bash', args: { command: 'sleep 120' } } },
  ]);
  await staged(page, 'the follower and the viewer', async () => {
    const { owner, follow: join, until, said } = globalThis.follow;
    stage('the follower');
    const { connection: follower } = await join(false);
    stage('the viewer');
    const { connection: viewer } = await join(true);
    const local = await owner.connect();
    stage('the owner answer');
    await local.prompt('Owner speaking.');
    await until(() => said(follower).includes('Watched.'), 'the follower to watch', [follower]);
    await until(() => said(viewer).includes('Watched.'), 'the viewer to watch', [viewer]);
    globalThis.joined = { follower, viewer, local };
  });
  const sent = await staged(page, 'a max-size message', async () => {
    const { follower } = globalThis.joined;
    stage('the attachments');
    const random = (size) => {
      const bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += 65536)
        crypto.getRandomValues(bytes.subarray(at, Math.min(at + 65536, size)));
      let text = '';
      for (let at = 0; at < size; at += 32768)
        text += String.fromCharCode(...bytes.subarray(at, at + 32768));
      return btoa(text);
    };
    const attachments = ['one.bin', 'two.bin'].map((name) => ({
      name,
      mimeType: 'application/octet-stream',
      kind: 'file',
      data: random(5 * 1024 * 1024),
    }));
    stage('the send');
    const big = await follower.control.send(
      { text: 'Two files.', whenBusy: 'followUp', requestId: null, attachments },
      BACKGROUND_CONTEXT
    );
    globalThis.joined.big = big.submissionId;
    return {
      accepted: big.accepted,
      sentBytes: attachments.reduce((sum, item) => sum + item.data.length, 0),
    };
  });
  const files = await staged(page, 'the answer to the files', async () => {
    const { follower, big } = globalThis.joined;
    return follower.control.wait(big, BACKGROUND_CONTEXT);
  });
  const steering = await staged(page, 'the steer', async () => {
    const { until, busy } = globalThis.follow;
    const { follower } = globalThis.joined;
    const ctx = BACKGROUND_CONTEXT;
    const slow = await follower.control.send(
      { text: 'Take your time.', whenBusy: 'followUp', requestId: null },
      ctx
    );
    await until(() => busy(follower), 'the slow run', [follower]);
    const steer = await follower.control.send(
      { text: 'Steer here.', whenBusy: 'steer', requestId: null },
      ctx
    );
    stage('the steered answer');
    const steered = await follower.control.wait(slow.submissionId, ctx);
    await until(() => Object.values(follower.deliveries.value).includes('steer'), 'the steer', [
      follower,
    ]);
    return { steer: steer.accepted, steered };
  });
  const ending = await staged(page, 'the abort', async () => {
    const { owner, until, busy } = globalThis.follow;
    const { follower, viewer, local } = globalThis.joined;
    const ctx = BACKGROUND_CONTEXT;
    const long = await follower.control.send(
      { text: 'Never mind.', whenBusy: 'followUp', requestId: null },
      ctx
    );
    await until(() => busy(follower), 'the long run', [follower]);
    stage('the refusals');
    const refusals = {
      send: await viewer.control.send(
        { text: 'Let me in.', whenBusy: 'followUp', requestId: null },
        ctx
      ),
      abort: await viewer.control.abort(ctx).then(
        () => 'ran',
        (error) => [error.code, error.message]
      ),
    };
    const stillBusy = busy(local);
    await follower.control.abort(ctx);
    await until(() => !busy(follower), 'the abort', [follower]);
    stage('the aborted run');
    const aborted = await follower.control.wait(long.submissionId, ctx);
    const users = local.transcript.value.entries
      .filter((entry) => entry.kind === 'pi.user')
      .map((entry) => JSON.stringify(entry.model[0].content));
    await viewer.close();
    await follower.close();
    await local.close();
    await owner.release();
    return { aborted: aborted.status, refusals, stillBusy, users };
  });
  const seen = { files, ...sent, ...steering, ...ending };
  assert.equal(seen.accepted, true);
  assert.ok(seen.sentBytes > 13 * MIB);
  assert.deepEqual(seen.files, { status: 'done', text: 'Got the files.', reason: null });
  assert.ok(
    seen.users.some(
      (text) => text.includes('Two files.') && text.includes('one.bin') && text.includes('two.bin')
    )
  );
  assert.equal(seen.steer, true);
  assert.equal(seen.steered.text, 'Steered.');
  assert.ok(seen.users.some((text) => text.includes('Steer here.')));
  assert.notEqual(seen.aborted, 'done');
  assert.equal(seen.refusals.send.accepted, false);
  assert.equal(seen.refusals.send.error.code, 'EACCES');
  assert.equal(seen.refusals.abort[0], 'EACCES');
  assert.equal(seen.stillBusy, true);
});

const SENTENCE =
  "That SLICC runs another version of the agent, so this tab can't follow it. Update both SLICCs, then reload this page.";

test('a follower or guest of an owner on another wire or Chord version, or of a 7.x owner, is refused once with EVERSION, and both ends close', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    await import('/dist-test/page.js');
    const owner = (hello) => {
      const { port1, port2 } = new MessageChannel();
      const heard = [];
      port1.onmessage = ({ data }) =>
        heard.push(data instanceof Uint8Array ? { bytes: data.length } : data);
      port1.postMessage(hello);
      return { port: port2, heard };
    };
    const ours = { wire: 2, chord: 1, contracts: 'x', server: 'other' };
    const hellos = {
      wire: { hello: { ...ours, wire: 3 } },
      chord: { hello: { ...ours, chord: 2 } },
      seven: { hello: 'a-7.x-server-id' },
      refusing: { close: true, reason: 'version' },
    };
    const refused = async (connect, hello) => {
      const { port, heard } = owner(hello);
      const started = performance.now();
      const outcome = await connect(port).then(
        () => ({ connected: true }),
        (error) => ({ code: error.code, message: error.message })
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ...outcome, ms: performance.now() - started, heard };
    };
    const result = {};
    for (const [name, hello] of Object.entries(hellos)) {
      result[name] = {
        follower: await refused(connectAgent, hello),
        guest: await refused(connectGuest, hello),
      };
    }
    return result;
  });
  for (const [name, { follower, guest }] of Object.entries(seen))
    for (const outcome of [follower, guest]) {
      assert.equal(outcome.code, 'EVERSION', `${name}: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.message, SENTENCE);
      assert.ok(outcome.ms < 2000, `${outcome.ms}`);
      assert.deepEqual(
        outcome.heard,
        name === 'refusing' ? [] : [{ close: true, reason: 'version' }],
        `${name}: the client answers only with its close, no hello and nothing of Chord`
      );
    }
});

test('an owner refuses a peer that speaks Chord before its hello or says another version, and keeps serving its own links', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    await import('/dist-test/page.js');
    const owner = await startAgent({
      worker: () =>
        new Worker('/dist-test/agent-worker.js?answer=Still%20here.', { type: 'module' }),
    });
    const local = await owner.connect();
    const peer = async (first) => {
      const port = await owner.port({ pages: false });
      const heard = [];
      port.onmessage = ({ data }) =>
        heard.push(data instanceof Uint8Array ? { bytes: data.length } : data);
      port.postMessage(first);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return heard;
    };
    const old = new TextEncoder().encode(
      JSON.stringify({ t: 'hello', name: 'old', kind: 'client' })
    );
    const sevenClient = await peer(old);
    const otherWire = await peer({
      hello: { wire: 1, chord: 1, contracts: local.serverId },
    });
    const still = await local.prompt('Are you there?');
    await local.close();
    await owner.release();
    return { sevenClient, otherWire, still, serverId: local.serverId };
  });
  for (const heard of [seen.sevenClient, seen.otherWire]) {
    assert.equal(heard[0].hello.server, seen.serverId);
    assert.equal(heard[0].hello.wire, 2);
    assert.deepEqual(heard.slice(1), [{ close: true, reason: 'version' }], JSON.stringify(heard));
  }
  assert.equal(seen.still, 'Still here.');
});
