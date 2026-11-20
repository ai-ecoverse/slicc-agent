import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const SERVICES = ['control', 'transcript', 'settings', 'remote', 'pages', 'inventory', 'sudo'];

async function boot(page, query) {
  await page.goto('/');
  await staged(
    page,
    'the raw link agent',
    async (query) => {
      await import('/dist-test/page.js');
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/agent-worker.js?${query}`, { type: 'module' }),
      });
      const local = await owner.connect();
      const seat = async (id) => {
        const opened = await local.control.guestOpen(
          {
            id,
            label: 'Anna',
            agentId: 'cone',
            expiresAt: null,
            gates: { messages: 'off', tools: 'user' },
          },
          BACKGROUND_CONTEXT
        );
        if (opened.error) throw new Error(opened.error);
        return { id, label: 'Anna' };
      };
      globalThis.raw = { owner, local, seat };
    },
    query
  );
}

test('a raw link test client on a guest seat is refused every owner-only service, also when its holds claim the owner principal, and a call outside its variant ends only its link', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Still%20here.');
  const seen = await staged(
    page,
    'guest refusal tests',
    async (services) => {
      const { owner, local, seat } = globalThis.raw;
      const guest = await seat('raw-guest');
      const link = await openRawLink(await owner.port({ guest }));
      const holds = {};
      for (const service of services)
        for (const principal of [undefined, { kind: 'owner' }, { kind: 'host' }]) {
          const held = await link.hold(service, principal ? { principal } : {});
          holds[`${service}:${principal?.kind ?? 'none'}`] = [held.variant, held.error];
        }
      const mine = await link.hold('guest', { principal: { kind: 'owner' } });
      const manage = await mine.call('guestOpen', [
        {
          id: 'x',
          label: 'x',
          agentId: 'cone',
          expiresAt: null,
          gates: { messages: 'off', tools: 'off' },
        },
      ]);
      const outside = await mine.callAt(mine.methods.length).then(
        () => 'answered',
        (error) => error.reason
      );
      const closed = await link.closed;
      const still = await local.prompt('Are you there?');
      await local.close();
      await owner.release();
      return {
        holds,
        variant: mine.variant,
        methods: mine.methods,
        manage,
        outside,
        closed,
        still,
      };
    },
    SERVICES
  );
  for (const [name, [variant, error]] of Object.entries(seen.holds)) {
    assert.equal(variant, null, name);
    assert.equal(error.code, 'forbidden', name);
    assert.equal(error.message, 'a guest seat has only its transcript and propose', name);
  }
  assert.equal(Object.keys(seen.holds).length, SERVICES.length * 3);
  assert.equal(seen.variant, 'guest');
  assert.deepEqual(seen.methods, ['guestOpen', 'guestRevoke', 'propose']);
  assert.equal(seen.manage.error.code, 'forbidden');
  assert.equal(seen.outside, null);
  assert.deepEqual(seen.closed, { reason: null });
  assert.equal(seen.still, 'Still here.');
});

test('a raw link test client on view and control seats binds only their variants, whatever principal its holds claim', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Hello.');
  const seen = await staged(
    page,
    'seat variants',
    async (services) => {
      const { owner, local } = globalThis.raw;
      const variants = async (options) => {
        const link = await openRawLink(await owner.port(options));
        const found = {};
        for (const service of [...services, 'guest']) {
          const held = await link.hold(service, { principal: { kind: 'owner' } });
          found[service] = held.variant;
        }
        const control = await link.hold('control', { principal: { kind: 'owner' } });
        const methods = control.methods;
        link.close();
        return { found, methods };
      };
      const view = await variants({ readOnly: true });
      const control = await variants({ pages: false });
      const mine = await variants({});
      await local.close();
      await owner.release();
      return { view, control, mine };
    },
    SERVICES
  );
  assert.deepEqual(seen.view.found, {
    control: 'view',
    transcript: 'transcript',
    settings: 'view',
    remote: 'watch',
    pages: 'none',
    inventory: 'none',
    sudo: 'none',
    guest: 'none',
  });
  assert.ok(!seen.view.methods.includes('send'));
  assert.ok(!seen.view.methods.includes('abort'));
  assert.ok(seen.view.methods.includes('entries'));
  assert.deepEqual(seen.control.found, {
    control: 'control',
    transcript: 'transcript',
    settings: 'settings',
    remote: 'remote',
    pages: 'none',
    inventory: 'none',
    sudo: 'none',
    guest: 'none',
  });
  assert.deepEqual(seen.mine.found, {
    control: 'control',
    transcript: 'transcript',
    settings: 'owner',
    remote: 'remote',
    pages: 'pages',
    inventory: 'owner',
    sudo: 'sudo',
    guest: 'none',
  });
  assert.ok(seen.control.methods.includes('send'));
});

test('an invalid guest seat is refused before any hello: the raw link test client sees reason seat and connectGuest rejects with SEAT_REFUSED and EACCES', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Hello.');
  const seen = await staged(page, 'seat refusal', async () => {
    const { owner, local, seat } = globalThis.raw;
    const guest = await seat('raw-revoked');
    const unknown = { id: 'nobody', label: 'Anna' };
    const heard = [];
    const port = await owner.port({ guest: unknown });
    port.onmessage = ({ data }) => heard.push(data);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const raw = await openRawLink(await owner.port({ guest: unknown })).then(
      () => 'opened',
      (error) => error.reason
    );
    const refused = await connectGuest(await owner.port({ guest: unknown })).then(
      () => 'joined',
      (error) => [error.code, error.message]
    );
    await local.control.guestRevoke(guest.id, BACKGROUND_CONTEXT);
    const revoked = await connectGuest(await owner.port({ guest })).then(
      () => 'joined',
      (error) => [error.code, error.message]
    );
    await local.close();
    await owner.release();
    return { heard, raw, refused, revoked, sentence: SEAT_REFUSED };
  });
  assert.deepEqual(seen.heard, [{ close: true, reason: 'seat' }]);
  assert.equal(seen.raw, 'seat');
  assert.deepEqual(seen.refused, ['EACCES', seen.sentence]);
  assert.deepEqual(seen.revoked, ['EACCES', seen.sentence]);
});

test('a slow follower holds acks: the owner keeps at most two state messages unacknowledged, coalesces the rest, and the next one after an ack carries the newest state', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=First.&answer=Second.&answer=Third.&answer=Fourth.');
  const seen = await staged(page, 'slow follower', async () => {
    const { owner, local } = globalThis.raw;
    const link = await openRawLink(await owner.port({ pages: false }), { acks: false });
    const states = () => link.received.filter((message) => message.kind === 'state');
    const bound = () => link.received.filter((message) => message.kind === 'bound');
    await link.hold('transcript');
    const said = [];
    for (const text of ['one', 'two', 'three', 'four']) said.push(await local.prompt(text));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const held = states().length;
    const text = (message) =>
      message.holds.flatMap((hold) => hold.members.map((member) => partText(member.ops))).join('');
    const before = states().map(text).join('').includes('Fourth.');
    link.ack();
    link.ack();
    await link.next((message) => message.kind === 'state' && text(message).includes('Fourth.'));
    const after = states().length;
    const control = await link.hold('control');
    const reply = await control.call('abort', []);
    link.close();
    await local.close();
    await owner.release();
    return { said, bound: bound().length, held, before, after, reply };
  });
  assert.deepEqual(seen.said, ['First.', 'Second.', 'Third.', 'Fourth.']);
  assert.equal(seen.bound, 2);
  assert.equal(seen.held, 1, 'the bound and one state fill the window of two');
  assert.equal(seen.before, false);
  assert.ok(seen.after <= 3, `${seen.after} state messages after the acks`);
  assert.deepEqual(seen.reply, { value: null });
});

test('the raw link test client speaks over a byte stream and is refused cleanly when its hello names another wire', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Hello.');
  const seen = await staged(page, 'byte stream', async () => {
    const { owner, local } = globalThis.raw;
    const port = await owner.port({ pages: false });
    let near;
    const far = bridgePort(port, {
      write: (chunk) => queueMicrotask(() => near.receive(chunk)),
      close: () => queueMicrotask(() => near.end()),
    });
    near = linkEndpoint({
      write: (chunk) => queueMicrotask(() => far.receive(chunk)),
      close: () => queueMicrotask(() => far.end()),
    });
    const link = await openRawLink(near);
    const control = await link.hold('control');
    const settings = await link.hold('settings');
    const refusals = settings.methods.includes('refusals');
    const aborted = await control.call('abort', []);
    link.close();
    const other = await openRawLink(await owner.port({ pages: false }), {
      hello: { wire: 1 },
    }).then(
      () => 'opened',
      (error) => error.reason
    );
    await local.close();
    await owner.release();
    return {
      server: link.hello.server,
      mine: local.serverId,
      variant: control.variant,
      refusals,
      aborted,
      other,
    };
  });
  assert.equal(seen.server, seen.mine);
  assert.equal(seen.variant, 'control');
  assert.equal(seen.refusals, false);
  assert.deepEqual(seen.aborted, { value: null });
  assert.equal(seen.other, 'version');
});

test('on a byte stream that loses what is sent before its first message arrives, as a data channel announced by the other side can in Chrome, a follower and a guest still connect, and a raw client whose hello is lost is refused', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Hello.');
  const seen = await staged(page, 'lossy first send', async () => {
    const { owner, local, seat } = globalThis.raw;
    const lost = [];
    const announced = async (options) => {
      const port = await owner.port(options);
      let heard = false;
      let near;
      const far = bridgePort(port, {
        write: (chunk) => setTimeout(() => near.receive(chunk)),
        close: () => setTimeout(() => near.end()),
      });
      const end = linkEndpoint({
        write: (chunk) => {
          if (heard) setTimeout(() => far.receive(chunk));
          else lost.push(chunk.length);
        },
        close: () => setTimeout(() => far.end()),
      });
      near = {
        ...end,
        receive(chunk) {
          heard = true;
          end.receive(chunk);
        },
      };
      return near;
    };
    const failed = (error) => [error.code ?? null, error.message];
    const follower = await connectAgent(await announced({ pages: false })).catch(failed);
    const followed = Array.isArray(follower) ? follower : await follower.prompt('Over the stream?');
    const guest = await connectGuest(await announced({ guest: await seat('lossy') })).catch(failed);
    const joined = Array.isArray(guest) ? guest : guest.guest.label;
    const before = lost.length;
    const raw = await openRawLink(await announced({ pages: false }))
      .then((link) => link.hold('control'))
      .then(
        () => 'held',
        (error) => error.reason
      );
    if (!Array.isArray(follower)) await follower.close();
    if (!Array.isArray(guest)) await guest.close();
    await local.close();
    await owner.release();
    return { followed, joined, before, after: lost.length, raw };
  });
  assert.equal(seen.followed, 'Hello.');
  assert.equal(seen.joined, 'Anna');
  assert.equal(
    seen.before,
    0,
    'connectAgent and connectGuest send nothing before the agent speaks'
  );
  assert.equal(seen.after, 1, 'the raw client sends its hello first');
  assert.equal(seen.raw, 'version', 'a link whose hello never arrives is still refused');
});

test('the four-call guest limit belongs to the link: holds of the guest service on one link share four calls in flight, the fifth is answered as unavailable and the link stays open, and another link of the same seat has its own four', async (t) => {
  const page = await chrome.page(t);
  await boot(page, `answer=Hello.&directory=/raw-calls-${Date.now()}&crash=before`);
  const seen = await staged(page, 'link call budget', async () => {
    const { owner, local, seat } = globalThis.raw;
    const guest = await seat('raw-busy');
    const first = await openRawLink(await owner.port({ guest }));
    const second = await openRawLink(await owner.port({ guest }));
    const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve('pending'), ms));
    const answered = (call) =>
      Promise.race([
        call.then(
          (reply) => ('error' in reply ? [reply.error.code, reply.error.message] : 'answered'),
          () => 'ended'
        ),
        wait(300),
      ]);
    let n = 0;
    const propose = (hold) => {
      n += 1;
      return hold.call('propose', [{ text: `Message ${n}`, requestId: `raw-call-${n}` }]);
    };
    const one = await first.hold('guest');
    const two = await first.hold('guest');
    const flying = [propose(one), propose(two), propose(one), propose(two)];
    const inFlight = await answered(Promise.any(flying));
    const over = [await answered(propose(one)), await answered(propose(two))];
    const three = await first.hold('guest');
    const later = await answered(three.call('guestOpen', [{}]));
    const other = await second.hold('guest');
    const fresh = await answered(other.call('guestOpen', [{}]));
    const own = [propose(other), propose(other), propose(other), propose(other)];
    const ownInFlight = await answered(Promise.any(own));
    const ownOver = await answered(propose(other));
    const open = await Promise.race([first.closed.then(() => 'closed'), wait(300)]);
    const variants = [one.variant, two.variant, three.variant, other.variant];
    first.close();
    second.close();
    await local.close();
    await owner.release();
    return { variants, inFlight, over, later, fresh, ownInFlight, ownOver, open };
  });
  const busy = ['unavailable', 'Too many calls in progress on this connection (4)'];
  assert.deepEqual(seen.variants, ['guest', 'guest', 'guest', 'guest']);
  assert.equal(seen.inFlight, 'pending', 'four calls across two holds are still in flight');
  assert.deepEqual(seen.over, [busy, busy]);
  assert.deepEqual(seen.later, busy, 'a hold made later on the same link shares its four');
  assert.equal(seen.fresh[0], 'forbidden', 'another link of the seat is not busy');
  assert.equal(seen.ownInFlight, 'pending');
  assert.deepEqual(seen.ownOver, busy);
  assert.equal(seen.open, 'pending', 'the busy link stays open');
});

test('a guest link that releases its hold with four calls still running and holds the guest service again keeps those four calls in its budget: the next call is answered as unavailable and the link stays open', async (t) => {
  const page = await chrome.page(t);
  await boot(page, `answer=Hello.&directory=/raw-rehold-${Date.now()}&crash=before`);
  const seen = await staged(page, 'a held again guest service', async () => {
    const { owner, local, seat } = globalThis.raw;
    const guest = await seat('raw-rehold');
    const link = await openRawLink(await owner.port({ guest }), { ms: 90_000 });
    const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve('pending'), ms));
    const answered = (call) =>
      Promise.race([
        call.then(
          (reply) => ('error' in reply ? [reply.error.code, reply.error.message] : 'answered'),
          () => 'ended'
        ),
        wait(300),
      ]);
    let n = 0;
    const propose = (hold) => {
      n += 1;
      return hold.call('propose', [{ text: `Message ${n}`, requestId: `raw-rehold-${n}` }]);
    };
    const first = await link.hold('guest');
    const flying = [propose(first), propose(first), propose(first), propose(first)];
    const inFlight = await answered(Promise.any(flying));
    first.release();
    const again = await link.hold('guest');
    const over = await answered(propose(again));
    const open = await Promise.race([link.closed.then(() => 'closed'), wait(300)]);
    link.close();
    await local.close();
    await owner.release();
    return { variants: [first.variant, again.variant], inFlight, over, open };
  });
  const busy = ['unavailable', 'Too many calls in progress on this connection (4)'];
  assert.deepEqual(seen.variants, ['guest', 'guest']);
  assert.equal(seen.inFlight, 'pending', 'four calls are still running');
  assert.deepEqual(seen.over, busy, 'the guest service held again shares the four');
  assert.equal(seen.open, 'pending', 'the busy link stays open');
});
