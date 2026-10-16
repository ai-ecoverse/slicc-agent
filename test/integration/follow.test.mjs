import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const MIB = 1024 * 1024;

async function boot(page, steps) {
  await page.goto('/');
  await page.evaluate(async (steps) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
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
          await new Promise((resolve) => channel.addEventListener('open', resolve, { once: true }));
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
    const until = async (check, what) => {
      for (let i = 0; i < 600; i++) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
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
  }, steps);
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
  await page.evaluate(async () => {
    const { owner, follow: join, until, said } = globalThis.follow;
    const { connection: follower } = await join(false);
    const { connection: viewer } = await join(true);
    const local = await owner.connect();
    await local.prompt('Owner speaking.');
    await until(() => said(follower).includes('Watched.'), 'the follower to watch');
    await until(() => said(viewer).includes('Watched.'), 'the viewer to watch');
    globalThis.joined = { follower, viewer, local };
  });
  const sent = await page.evaluate(async () => {
    const { follower } = globalThis.joined;
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
  const files = await page.evaluate(async () => {
    const { follower, big } = globalThis.joined;
    return follower.control.wait(big, BACKGROUND_CONTEXT);
  });
  const steering = await page.evaluate(async () => {
    const { until, busy } = globalThis.follow;
    const { follower } = globalThis.joined;
    const ctx = BACKGROUND_CONTEXT;
    const slow = await follower.control.send(
      { text: 'Take your time.', whenBusy: 'followUp', requestId: null },
      ctx
    );
    await until(() => busy(follower), 'the slow run');
    const steer = await follower.control.send(
      { text: 'Steer here.', whenBusy: 'steer', requestId: null },
      ctx
    );
    const steered = await follower.control.wait(slow.submissionId, ctx);
    await until(() => Object.values(follower.deliveries.value).includes('steer'), 'the steer');
    return { steer: steer.accepted, steered };
  });
  const ending = await page.evaluate(async () => {
    const { owner, until, busy } = globalThis.follow;
    const { follower, viewer, local } = globalThis.joined;
    const ctx = BACKGROUND_CONTEXT;
    const long = await follower.control.send(
      { text: 'Never mind.', whenBusy: 'followUp', requestId: null },
      ctx
    );
    await until(() => busy(follower), 'the long run');
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
    await until(() => !busy(follower), 'the abort');
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
