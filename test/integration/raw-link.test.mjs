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
