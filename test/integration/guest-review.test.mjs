import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  const dir = async (parts, create) => {
    let handle = await navigator.storage.getDirectory();
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create });
    return handle;
  };
  window.write = async (path, text) => {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    const writable = await (
      await (await dir(parts, true)).getFileHandle(name, { create: true })
    ).createWritable();
    await writable.write(text);
    await writable.close();
  };
};

async function boot(page, { query = '', crash = null, judge = false, files = {} } = {}) {
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate(
    async ({ query, crash, judge, files }) => {
      for (const [path, text] of Object.entries(files)) await window.write(path, text);
      await import('/dist-test/page.js');
      let kernel;
      if (judge) {
        const { bootKernel } = await import('/kernel.js');
        kernel = await bootKernel();
      }
      let worker;
      let lives = 0;
      let crashed;
      const crashing = new Promise((resolve) => {
        crashed = resolve;
      });
      const base = judge ? '/dist-test/main-worker.js?judge&' : '/dist-test/agent-worker.js?';
      const owner = await startAgent({
        worker: () => {
          lives += 1;
          const extra = crash && lives === 1 ? `&crash=${crash}` : '';
          worker = new Worker(`${base}${query}${extra}`, { type: 'module' });
          worker.addEventListener('message', ({ data }) => data?.crashed && crashed(data.crashed));
          return worker;
        },
        ...(kernel ? { kernel: { connect: () => kernel.connect() } } : {}),
      });
      const ask = (message, key) =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => resolve(data);
          worker.postMessage({ ...message, [key]: channel.port2 }, [channel.port2]);
        });
      const sink = (channel) => ({
        write: (bytes) => channel.readyState === 'open' && channel.send(bytes),
        close: () => channel.readyState === 'open' && channel.close(),
      });
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
        return { owner: ours, guest: other };
      };
      const join = async (seat, label = 'Anna') => {
        const rtc = await loopback();
        const port = await owner.port({ guest: { id: seat, label } });
        pump(rtc.owner, bridgePort(port, sink(rtc.owner)));
        const endpoint = linkEndpoint(sink(rtc.guest));
        pump(rtc.guest, endpoint);
        const connection = await connectGuest(endpoint);
        const model = createAgentModel(connection);
        await model.agent.ready();
        return { connection, model };
      };
      const until = async (check, what) => {
        for (let i = 0; i < 600; i++) {
          const value = await check();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`timed out waiting for ${what}`);
      };
      const heard = (models, check) =>
        Promise.all(
          models.map(
            (model) =>
              new Promise((resolve) => {
                const look = () => {
                  if (!check(model)) return;
                  off();
                  resolve();
                };
                const off = model.agent.on('messages', look);
                look();
              })
          )
        );
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const hub = {
        minted: 0,
        async mint() {
          this.minted += 1;
          return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
        },
        async revoke() {},
      };
      const said = (model) =>
        model.agent
          .messages('cone')
          .map((message) =>
            message.role === 'user'
              ? `${message.origin ?? 'owner'}${message.from ? `(${message.from})` : ''}: ${message.text}`
              : message.role === 'assistant'
                ? `agent: ${message.parts
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('')}`
                : null
          )
          .filter(Boolean);
      const asked = (model) =>
        model.agent
          .messages('cone')
          .filter((message) => message.role === 'system' && / asked “/.test(message.text))
          .map((message) => message.text);
      const queue = (guest) => guest.model.agent.queue('cone').map((message) => message.text);
      const notices = (guest) =>
        guest.model.agent
          .messages('cone')
          .filter((message) => message.role === 'system' && message.title)
          .map((message) => `${message.title} ${message.text}`);
      const listed = (model) => model.approvals.list().map((item) => item.text);
      const open = async (gates = { messages: 'user', tools: 'user' }) => {
        const local = await owner.connect();
        const model = createAgentModel(local, { guests: hub });
        await model.agent.ready();
        const minted = hub.minted
          ? null
          : await model.guests.mint('cone', { label: 'Anna', expiresAt: null, gates });
        return { local, model, seat: minted?.seat.id ?? `seat-${hub.minted}` };
      };
      globalThis.r = {
        owner,
        join,
        until,
        heard,
        pause,
        said,
        asked,
        queue,
        notices,
        listed,
        open,
        crashing,
        record: (seat) => ask({ seat }, 'reply'),
        judged: () => ask({}, 'judged'),
        table: (judgeTable) => worker.postMessage({ judgeTable }),
      };
    },
    { query, crash, judge, files }
  );
}

test('three tabs of one seat share one queue: the owner is asked one message at a time, in order, and each is delivered once', async (t) => {
  const page = await chrome.page(t);
  await boot(page, { query: 'answer=One.&answer=Two.&answer=Three.' });
  const seen = await page.evaluate(async () => {
    const { join, until, heard, said, asked, queue, listed, open } = globalThis.r;
    const { model, seat } = await open();
    const tabs = [await join(seat), await join(seat), await join(seat)];
    for (const [index, tab] of tabs.entries())
      await tab.model.agent.send('cone', `Message ${index + 1}`);
    await until(() => asked(model).length === 3, 'three awaiting lines');
    await until(() => tabs.every((tab) => queue(tab).length === 3), 'every tab to see the queue');
    const out = { asked: asked(model), queues: tabs.map(queue), shown: [] };
    for (const answer of ['One.', 'Two.', 'Three.']) {
      await until(() => listed(model).length === 1, 'one message to be asked');
      out.shown.push(listed(model));
      await model.approvals.decide(model.approvals.list()[0].id, 'once');
      await heard([model, ...tabs.map((tab) => tab.model)], (seer) =>
        said(seer).includes(`agent: ${answer}`)
      );
    }
    await until(() => tabs.every((tab) => queue(tab).length === 0), 'the queues to empty');
    out.ownerSees = said(model);
    out.guestSees = said(tabs[2].model);
    return out;
  });
  assert.deepEqual(seen.asked, [
    'Anna asked “Message 1”, awaiting approval',
    'Anna asked “Message 2”, awaiting approval',
    'Anna asked “Message 3”, awaiting approval',
  ]);
  for (const shown of seen.queues) assert.deepEqual(shown, ['Message 1', 'Message 2', 'Message 3']);
  assert.deepEqual(seen.shown, [['Message 1'], ['Message 2'], ['Message 3']]);
  assert.deepEqual(seen.ownerSees, [
    'guest(Anna): Message 1',
    'agent: One.',
    'guest(Anna): Message 2',
    'agent: Two.',
    'guest(Anna): Message 3',
    'agent: Three.',
  ]);
  assert.deepEqual(seen.guestSees, seen.ownerSees);
});

test('a seat queues at most eight messages behind the one in review, and the next one is unanswered, never sent', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { join, until, asked, queue, listed, open } = globalThis.r;
    const { model, seat } = await open();
    const guest = await join(seat);
    const results = [];
    for (let i = 1; i <= 10; i++)
      results.push(
        await guest.model.agent.send('cone', `Ask ${i}`).then(
          () => 'queued',
          (error) => error.message
        )
      );
    await until(() => asked(model).length === 9, 'nine awaiting lines');
    await until(() => model.guests.list()[0]?.pending === 9, 'the seat to count nine');
    return {
      results,
      queue: queue(guest),
      listed: listed(model),
      pending: model.guests.list()[0].pending,
      asked: asked(model).length,
    };
  });
  assert.deepEqual(seen.results.slice(0, 9), Array(9).fill('queued'));
  assert.equal(
    seen.results[9],
    'Too many of your messages are waiting for approval. Try again once one is answered.'
  );
  assert.deepEqual(
    seen.queue,
    Array.from({ length: 9 }, (_, i) => `Ask ${i + 1}`)
  );
  assert.deepEqual(seen.listed, ['Ask 1']);
  assert.equal(seen.pending, 9);
  assert.equal(seen.asked, 9);
});

test('a review survives a reload: the message in review is still asked once, and the one behind it follows after', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    query: `directory=/.slicc/review-${Date.now()}&answer=First.&answer=Second.`,
  });
  const seen = await page.evaluate(async () => {
    const { owner, join, until, said, asked, queue, listed, open } = globalThis.r;
    const first = await open();
    const guest = await join(first.seat);
    await guest.model.agent.send('cone', 'Before the reload');
    await guest.model.agent.send('cone', 'Behind it');
    await until(() => listed(first.model).length === 1, 'the first to be asked');
    await first.local.close();
    await owner.restart();
    const { model, seat } = await open();
    const back = await join(seat);
    await until(() => listed(model).length === 1, 'the review after the reload');
    const out = { listed: listed(model), queue: queue(back) };
    await model.approvals.decide(model.approvals.list()[0].id, 'once');
    await until(() => said(model).includes('agent: First.'), 'the first answer');
    await until(() => listed(model).length === 1, 'the second to be asked');
    out.next = listed(model);
    await model.approvals.decide(model.approvals.list()[0].id, 'once');
    await until(() => said(model).includes('agent: Second.'), 'the second answer');
    out.ownerSees = said(model);
    out.asked = asked(model).length;
    return out;
  });
  assert.deepEqual(seen.listed, ['Before the reload']);
  assert.deepEqual(seen.queue, ['Before the reload', 'Behind it']);
  assert.deepEqual(seen.next, ['Behind it']);
  assert.deepEqual(seen.ownerSees, [
    'guest(Anna): Before the reload',
    'agent: First.',
    'guest(Anna): Behind it',
    'agent: Second.',
  ]);
  assert.equal(seen.asked, 2);
});

for (const crash of ['before', 'after'])
  test(`a crash ${crash} the approved message is submitted delivers it exactly once after the reload, and records it against the seat`, async (t) => {
    const page = await chrome.page(t);
    await boot(page, {
      query: `directory=/.slicc/crash-${crash}-${Date.now()}&answer=Delivered.&answer=Again.`,
      crash,
    });
    const seen = await page.evaluate(async () => {
      const { owner, join, until, pause, said, listed, open, crashing, record } = globalThis.r;
      const first = await open();
      const guest = await join(first.seat);
      await guest.model.agent.send('cone', 'Deliver me once');
      await until(() => listed(first.model).length === 1, 'the owner to be asked');
      await first.model.approvals.decide(first.model.approvals.list()[0].id, 'once');
      const crashed = await crashing;
      await owner.restart();
      const { model, seat } = await open();
      await until(() => said(model).includes('agent: Delivered.'), 'the delivery after the crash');
      await pause(1000);
      const kept = await record(seat);
      return {
        crashed,
        ownerSees: said(model),
        submissions: kept.submissions.map(({ approval, tools }) => ({
          approval: Boolean(approval),
          tools,
        })),
      };
    });
    assert.equal(seen.crashed, crash);
    assert.deepEqual(seen.ownerSees, ['guest(Anna): Deliver me once', 'agent: Delivered.']);
    assert.deepEqual(seen.submissions, [{ approval: true, tools: 'user' }]);
  });

test('a review nobody answers expires as unanswered, and the next message in the queue is asked then', async (t) => {
  const page = await chrome.page(t);
  await boot(page, { query: 'ttl=1500&answer=Got the second.' });
  const seen = await page.evaluate(async () => {
    const { join, until, said, notices, listed, open } = globalThis.r;
    const { model, seat } = await open();
    const guest = await join(seat);
    await guest.model.agent.send('cone', 'Nobody looks at this');
    await guest.model.agent.send('cone', 'But this one');
    await until(() => listed(model).length === 1, 'the first to be asked');
    const out = { first: listed(model) };
    await until(() => listed(model)[0] === 'But this one', 'the second after the expiry');
    out.notices = notices(guest);
    await model.approvals.decide(model.approvals.list()[0].id, 'once');
    await until(() => said(model).includes('agent: Got the second.'), 'the second answer');
    out.ownerSees = said(model);
    return out;
  });
  assert.deepEqual(seen.first, ['Nobody looks at this']);
  assert.deepEqual(seen.notices, ['Nobody approved this in time. Nobody looks at this']);
  assert.deepEqual(seen.ownerSees, ['guest(Anna): But this one', 'agent: Got the second.']);
});

test('the guest is told each outcome: approved, declined, or that nobody approved it in time', async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: Number(env.REVIEW_WIDTH ?? 1280),
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await boot(page, { query: 'ttl=2500&answer=Sure.' });
  const seen = await page.evaluate(async () => {
    const { join, until, said, asked, notices, listed, open } = globalThis.r;
    const { model, seat } = await open();
    const guest = await join(seat);
    await guest.model.agent.send('cone', 'Please add a test');
    await guest.model.agent.send('cone', 'Delete the repo');
    await guest.model.agent.send('cone', 'Anyone there?');
    await until(() => listed(model)[0] === 'Please add a test', 'the first');
    await model.approvals.decide(model.approvals.list()[0].id, 'once');
    await until(() => said(model).includes('agent: Sure.'), 'the answer');
    await until(() => listed(model)[0] === 'Delete the repo', 'the second');
    await model.approvals.decide(model.approvals.list()[0].id, 'deny');
    await until(() => notices(guest).length === 3, 'three notices');
    await until(
      () => asked(model).every((line) => !line.endsWith('awaiting approval')),
      'the owner lines to end'
    );
    globalThis.shown = { model, guest };
    return {
      notices: notices(guest),
      asked: asked(model),
      guestSees: said(guest.model),
      ownerSees: said(model),
    };
  });
  assert.deepEqual(seen.notices, [
    'It was approved. Please add a test',
    'It was declined. Delete the repo',
    'Nobody approved this in time. Anyone there?',
  ]);
  assert.deepEqual(seen.asked, [
    'Anna asked “Please add a test”: approved',
    'Anna asked “Delete the repo”: declined',
    'Anna asked “Anyone there?”: nobody approved it in time',
  ]);
  for (const line of seen.asked) assert.match(line, /^Anna asked \u201c[^"\u201c\u201d]+\u201d: /);
  assert.deepEqual(seen.guestSees, ['guest(Anna): Please add a test', 'agent: Sure.']);
  assert.deepEqual(seen.ownerSees, seen.guestSees);
  if (env.REVIEW_GUEST_SHOT || env.REVIEW_OWNER_SHOT) {
    await page.evaluate(async () => {
      const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
      await import(`${spectrum}/slicc-ui.js`);
      const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
      document.body.style.margin = '0';
      globalThis.mount = async (model) => {
        document.body.replaceChildren();
        const app = document.createElement('slicc-app');
        app.style.cssText = 'display:block;width:100vw;height:100vh';
        document.body.append(app);
        app.model = { ...createDummyModel({ storage: localStorage }), ...model };
        await customElements.whenDefined('slicc-app');
      };
    });
    for (const [shot, who] of [
      [env.REVIEW_GUEST_SHOT, 'guest'],
      [env.REVIEW_OWNER_SHOT, 'owner'],
    ]) {
      if (!shot) continue;
      await page.evaluate(async (who) => {
        const { model, guest } = globalThis.shown;
        await globalThis.mount(who === 'guest' ? guest.model : model);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }, who);
      await page.screenshot(shot);
    }
  }
});

test('with the judge as the gate, one message is judged at a time: a low-risk one is delivered, a risky one declined, and an unsure one goes to the owner', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    judge: true,
    query: 'answer=Noted.&answer=Fixed.&answer=Tidied.',
    files: {
      '/home/.pi/agent/settings.json': JSON.stringify({ approvals: { judgeModel: 'judge/j-1' } }),
    },
  });
  const seen = await page.evaluate(async () => {
    const { join, until, pause, said, notices, listed, open, judged, table } = globalThis.r;
    const { local, model, seat } = await open({ messages: 'agent', tools: 'user' });
    await local.prompt('Only fix small things in the docs today.');
    await until(() => said(model).includes('agent: Noted.'), 'the owner turn');
    table({
      'Fix the footer link.': { low: 0.97, aligned: 0.95, delay: 800 },
      'Push to production now.': { low: 0.03, aligned: 0.05 },
      'Maybe tidy things?': { low: 0.6, aligned: 0.5 },
    });
    const guest = await join(seat);
    await guest.model.agent.send('cone', 'Fix the footer link.');
    await guest.model.agent.send('cone', 'Push to production now.');
    await guest.model.agent.send('cone', 'Maybe tidy things?');
    await until(async () => (await judged()).length === 1, 'the first to be judged');
    await pause(300);
    const out = { judgedWhileFirst: (await judged()).length };
    await until(
      () => listed(model)[0] === 'Maybe tidy things?',
      'the unsure one to reach the owner'
    );
    out.judged = (await judged()).length;
    await model.approvals.decide(model.approvals.list()[0].id, 'once');
    await until(() => said(model).includes('agent: Tidied.'), 'the tidy answer');
    await until(() => notices(guest).length === 3, 'three notices');
    out.notices = notices(guest);
    out.ownerSees = said(model).slice(said(model).findIndex((line) => line.startsWith('guest')));
    out.decidedBy = local.approvals.value
      .filter((item) => item.kind === 'guest-message')
      .map((item) => `${item.state}:${item.decidedBy}`);
    return out;
  });
  assert.equal(seen.judgedWhileFirst, 1);
  assert.equal(seen.judged, 3);
  assert.deepEqual(seen.notices, [
    'It was approved. Fix the footer link.',
    'It was declined. Push to production now.',
    'It was approved. Maybe tidy things?',
  ]);
  assert.deepEqual(seen.decidedBy, ['approved:judge', 'rejected:judge', 'approved:owner']);
  assert.deepEqual(seen.ownerSees, [
    'guest(Anna): Fix the footer link.',
    'agent: Fixed.',
    'guest(Anna): Maybe tidy things?',
    'agent: Tidied.',
  ]);
});

test('an Always answer on a guest message lets that seat send without asking again, while another seat still waits', async (t) => {
  const page = await chrome.page(t);
  await boot(page, { query: 'native&answer=First.&answer=Second.' });
  const seen = await page.evaluate(async () => {
    const { join, until, said, asked, listed, open } = globalThis.r;
    const { local, model, seat } = await open();
    const set = await local.control.approvalPolicySet(
      { guests: { always: { messages: true } } },
      BACKGROUND_CONTEXT
    );
    const gates = { messages: 'user', tools: 'user' };
    const other = await model.guests.mint('cone', { label: 'Ben', expiresAt: null, gates });
    const anna = await join(seat);
    const ben = await join(other.seat.id, 'Ben');
    await anna.model.agent.send('cone', 'May I always?');
    await until(() => listed(model).length === 1, 'the first message to be asked');
    const out = {
      setError: set.error,
      offered: local.approvals.value.find((item) => item.id === model.approvals.list()[0].id)
        .always,
    };
    await model.approvals.decide(model.approvals.list()[0].id, 'always');
    await until(() => said(model).includes('agent: First.'), 'the first answer');
    await until(
      () => model.guests.list().find((row) => row.id === seat)?.gates.messages === 'off',
      'the gate to open'
    );
    out.gates = model.guests.list().map((row) => [row.label, row.gates.messages, row.gates.tools]);
    await anna.model.agent.send('cone', 'And again');
    await until(() => said(model).includes('agent: Second.'), 'the second answer without a review');
    await ben.model.agent.send('cone', 'Me too?');
    await until(() => listed(model).length === 1, 'the other seat to be asked');
    out.listed = listed(model);
    out.asked = asked(model);
    out.ownerSees = said(model);
    return out;
  });
  assert.equal(seen.setError, null);
  assert.equal(seen.offered, true);
  assert.deepEqual(seen.gates, [
    ['Anna', 'off', 'user'],
    ['Ben', 'user', 'user'],
  ]);
  assert.deepEqual(seen.listed, ['Me too?']);
  assert.deepEqual(seen.asked, [
    'Anna asked “May I always?”: approved',
    'Ben asked “Me too?”, awaiting approval',
  ]);
  assert.deepEqual(seen.ownerSees, [
    'guest(Anna): May I always?',
    'agent: First.',
    'guest(Anna): And again',
    'agent: Second.',
  ]);
});
