import assert from 'node:assert/strict';
import { env } from 'node:process';
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

test('a follower of a SLICC on an older agent shows a banner to update that stays, watches only, and nothing else happens', async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.goto('/');
  const shown = await page.evaluate(async () => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    await import('/dist-test/page.js');
    const { port1, port2 } = new MessageChannel();
    const heard = [];
    port1.onmessage = ({ data }) => heard.push(data);
    port1.postMessage({ hello: crypto.randomUUID() });
    port1.postMessage(new Uint8Array([0xa2, 0x01, 0x02]));
    const connection = await connectAgent(port2);
    const model = createAgentModel(connection, { storage: localStorage });
    const app = document.createElement('slicc-app');
    app.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.style.margin = '0';
    document.body.append(app);
    app.model = { ...createDummyModel({ storage: localStorage }), ...model };
    await customElements.whenDefined('slicc-app');
    await model.agent.ready();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const notices = model.agent.messages('cone').filter((message) => message.kind === 'notice');
    return {
      mismatch: connection.mismatch,
      notices: notices.map((message) => message.text),
      banners: model.notices.list(),
      readOnly: model.agent.readOnly(),
      heard: heard.map((frame) =>
        frame instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(frame)) : frame
      ),
      rendered: document.body.innerText,
    };
  });
  assert.match(shown.mismatch, /older version of the agent/);
  assert.deepEqual(shown.notices, []);
  assert.deepEqual(
    shown.banners.map((notice) => [notice.id, notice.body, notice.dismissible]),
    [['agent-mismatch', shown.mismatch, false]]
  );
  assert.equal(shown.readOnly, 'Watch only.');
  assert.deepEqual(shown.heard, [{ t: 'bye', reason: 'link protocol mismatch' }, { close: true }]);
  if (env.FOLLOW_SHOT) await page.screenshot(env.FOLLOW_SHOT);
});

test('a 4.x follower of a 5.x owner shows the notice to update at once and leaves the link', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const refused = await page.evaluate(async () => {
    await import('/dist-test/page.js');
    await import('/dist-test/old-follower.js');
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/agent-worker.js?answer=Hi.', { type: 'module' }),
    });
    const port = await owner.port({ pages: false });
    const { port1, port2 } = new MessageChannel();
    const told = [];
    port.onmessage = ({ data }) => port1.postMessage(data);
    port1.onmessage = ({ data }) => {
      told.push(data);
      port.postMessage(data);
    };
    const started = performance.now();
    const outcome = await Promise.race([
      oldConnectAgent(port2).then(
        (connection) => ({ mismatch: connection.mismatch }),
        (error) => ({ error: error.message })
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 5000)),
    ]);
    const ms = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await owner.release();
    return { outcome, ms, told };
  });
  assert.deepEqual(refused.outcome, {
    mismatch:
      "That SLICC runs a newer version of the agent than this one, so this tab can't follow it. Update this SLICC, then reload this page.",
  });
  assert.deepEqual(refused.told, [{ close: true }]);
  assert.ok(refused.ms < 2000, `${refused.ms}`);
});
