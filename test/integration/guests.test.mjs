import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

async function boot(page, query) {
  await page.goto('/');
  await page.evaluate(async (query) => {
    await import('/dist-test/page.js');
    const url = `/dist-test/agent-worker.js?${query}`;
    let worker;
    const owner = await startAgent({
      worker: () => {
        worker = new Worker(url, { type: 'module' });
        return worker;
      },
    });
    const ask = (message, key) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ ...message, [key]: channel.port2 }, [channel.port2]);
      });
    const record = (seat) => ask({ seat }, 'reply');
    const seen = () => ask({}, 'seen');
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
          await new Promise((resolve) => channel.addEventListener('open', resolve, { once: true }));
      return { owner: ours, guest: other };
    };
    const join = async (options, connect = connectGuest) => {
      const rtc = await loopback();
      const port = await owner.port(options);
      pump(rtc.owner, bridgePort(port, sink(rtc.owner)));
      const endpoint = linkEndpoint(sink(rtc.guest));
      pump(rtc.guest, endpoint);
      return connect(endpoint);
    };
    const until = async (check, what) => {
      for (let i = 0; i < 400; i++) {
        const value = await check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const minted = [];
    const revoked = [];
    const hub = {
      async mint(request) {
        minted.push(request);
        const id = `seat-${minted.length}`;
        return { id, url: `https://hub.test/join/${id}-token` };
      },
      async revoke(id) {
        revoked.push(id);
      },
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
    globalThis.seats = { owner, join, until, hub, minted, revoked, said, record, seen };
  }, query);
}

const hour = 60 * 60 * 1000;

test('an owner invites a guest through the hub, the guest watches the cone and its message reaches the agent marked as a guest, and revoking ends the seat everywhere', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Watched.&answer=Thanks%2C%20Anna.');
  const result = await page.evaluate(async (hour) => {
    const { owner, join, until, hub, minted, revoked, said, record, seen } = globalThis.seats;
    const local = await owner.connect();
    const model = createAgentModel(local, { guests: hub });
    const out = { unavailable: model.guests.unavailable() };
    const expiresAt = Date.now() + hour;
    const invited = await model.guests.mint('cone', {
      label: 'Anna',
      expiresAt,
      gates: { messages: 'off', tools: 'user' },
    });
    out.url = invited.url;
    out.minted = minted;
    out.listed = model.guests.list().map(({ id, label, agentId, connected, gates }) => ({
      id,
      label,
      agentId,
      connected,
      gates,
    }));
    await local.prompt('Owner speaking.');
    const guest = await join({ guest: { id: invited.seat.id, label: 'Anna' } });
    const second = await join({ guest: { id: invited.seat.id, label: 'Anna' } });
    out.guest = guest.guest;
    const guestModel = createAgentModel(guest);
    await guestModel.agent.ready();
    out.seat = guestModel.seat;
    out.ownerSeat = 'seat' in model;
    await until(() => said(guestModel).includes('agent: Watched.'), 'the guest to watch');
    await until(() => model.guests.list()[0]?.connected, 'the seat to show connected');
    out.guestSees = said(guestModel);
    await guestModel.agent.send('cone', 'Could you summarise?');
    await until(
      () => said(model).includes('agent: Thanks, Anna.'),
      'the guest message to be answered'
    );
    out.ownerSees = said(model);
    await until(
      () => said(guestModel).includes('agent: Thanks, Anna.'),
      'the guest to see the answer'
    );
    out.guestSeesAfter = said(guestModel);
    out.modelSaw = (await seen()).at(-1);
    out.before = await record(invited.seat.id);
    await model.guests.revoke(invited.seat.id);
    await Promise.all([guest.closed, second.closed]);
    out.after = await record(invited.seat.id);
    out.revoked = revoked;
    out.listedAfter = model.guests.list();
    out.rejoin = await join({ guest: { id: invited.seat.id, label: 'Anna' } }).then(
      () => 'joined',
      (error) => `${error.code}: ${error.message}`
    );
    const sent = await guestModel.agent.send('cone', 'Still here?').then(
      () => 'sent',
      () => 'refused'
    );
    out.late = sent;
    out.ownerSeesAfter = said(model);
    return out;
  }, hour);
  assert.equal(result.unavailable, null);
  assert.match(result.url, /^https:\/\/hub\.test\/join\/seat-1-token$/);
  assert.equal(result.minted.length, 1);
  assert.deepEqual(result.minted[0].gates, { messages: 'off', tools: 'user' });
  assert.equal(result.minted[0].agentId, 'cone');
  assert.deepEqual(result.listed, [
    {
      id: 'seat-1',
      label: 'Anna',
      agentId: 'cone',
      connected: false,
      gates: { messages: 'off', tools: 'user' },
    },
  ]);
  assert.equal(result.guest.name, 'sliccy');
  assert.deepEqual(Object.keys(result.seat).sort(), [
    'agentId',
    'expiresAt',
    'gates',
    'id',
    'label',
  ]);
  assert.deepEqual(
    [result.seat.id, result.seat.label, result.seat.agentId],
    ['seat-1', 'Anna', 'cone']
  );
  assert.deepEqual(result.seat.gates, { messages: 'off', tools: 'user' });
  assert.equal(typeof result.seat.expiresAt, 'number');
  assert.equal(result.ownerSeat, false);
  assert.deepEqual(result.guestSees, ['owner: Owner speaking.', 'agent: Watched.']);
  assert.deepEqual(result.ownerSees, [
    'owner: Owner speaking.',
    'agent: Watched.',
    'guest(Anna): Could you summarise?',
    'agent: Thanks, Anna.',
  ]);
  assert.deepEqual(result.guestSeesAfter, result.ownerSees);
  assert.match(
    result.modelSaw,
    /A guest message from \\"Anna\\".*NOT from the cone's owner.*Could you summarise\?/
  );
  assert.equal(result.before.epoch, 1);
  assert.equal(result.before.revoked, null);
  assert.equal(result.after.epoch, 2, 'revoking bumps the seat epoch');
  assert.equal(typeof result.after.revoked, 'number');
  assert.deepEqual(result.revoked, ['seat-1']);
  assert.deepEqual(result.listedAfter, []);
  assert.equal(result.rejoin, "EACCES: This guest link isn't valid any more.");
  assert.equal(result.late, 'refused');
  assert.deepEqual(result.ownerSeesAfter, result.ownerSees);
});

test('a guest advertises nothing it can use: asking for Control and Panels still gets only its own seat, and the follower client is forbidden', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Hello.');
  const result = await page.evaluate(async () => {
    const { owner, join, hub } = globalThis.seats;
    const local = await owner.connect();
    const model = createAgentModel(local, { guests: hub });
    const { seat } = await model.guests.mint('cone', {
      label: 'Mallory',
      expiresAt: null,
      gates: { messages: 'user', tools: 'user' },
    });
    const unreviewed = [];
    for (const tools of ['off', 'cone'])
      unreviewed.push(
        await model.guests
          .mint('cone', { label: 'Eve', expiresAt: null, gates: { messages: 'off', tools } })
          .then(
            () => 'minted',
            (error) => error.message
          ),
        (
          await local.control.guestOpen(
            {
              id: `direct-${tools}`,
              label: 'Eve',
              agentId: 'cone',
              expiresAt: null,
              gates: { messages: 'off', tools },
            },
            BACKGROUND_CONTEXT
          )
        ).error
      );
    const listedAfterUnreviewed = model.guests.list().map((listed) => listed.label);
    const asks = { guest: { id: seat.id, label: 'Mallory' }, readOnly: false, pages: true };
    const asFollower = await join(asks, connectAgent).then(
      () => 'connected',
      (error) => error.code
    );
    const guest = await join(asks);
    const refused = async (run) =>
      run().then(
        () => 'allowed',
        (error) => error.code
      );
    const guestModel = createAgentModel(guest);
    const out = {
      asFollower,
      abort: await refused(() => guest.control.abort(BACKGROUND_CONTEXT)),
      lick: await refused(() => guest.control.resolveLick('l1', 'confirmed', BACKGROUND_CONTEXT)),
      configure: await refused(() =>
        guest.control.configure({ model: null, thinkingLevel: 'high' }, BACKGROUND_CONTEXT)
      ),
      mint: await refused(() =>
        guest.control.guestOpen(
          {
            id: 'x',
            label: 'x',
            agentId: 'cone',
            expiresAt: null,
            gates: { messages: 'off', tools: 'user' },
          },
          BACKGROUND_CONTEXT
        )
      ),
      settings: await refused(() => guest.settings.disconnect('faux', BACKGROUND_CONTEXT)),
      invite: guestModel.guests.unavailable(),
      gated: await guestModel.agent.send('cone', 'Let me in').then(
        () => 'sent',
        (error) => error.message
      ),
      pages: guest.pages ?? null,
      remote: guest.remote ?? null,
      views: guest.views ?? null,
      unreviewed,
      listedAfterUnreviewed,
      hubRevoked: globalThis.seats.revoked,
    };
    await guest.close();
    return out;
  });
  assert.equal(result.asFollower, 'forbidden');
  for (const key of ['abort', 'lick', 'configure', 'mint', 'settings'])
    assert.equal(result[key], 'EACCES', key);
  assert.equal(result.invite, 'Only a tab with Control can invite guests.');
  assert.equal(
    result.gated,
    "Messages from guests need a review, and this agent can't review them yet."
  );
  assert.equal(result.pages, null);
  assert.equal(result.remote, null);
  assert.equal(result.views, null);
  const review = "A guest's tool calls need a review: by a person, the judge or a scoop.";
  assert.deepEqual(
    result.unreviewed,
    [review, review, review, review],
    'tools off and cone are refused at mint, through the port and directly'
  );
  assert.deepEqual(result.listedAfterUnreviewed, ['Mallory']);
  assert.deepEqual(
    result.hubRevoked,
    ['seat-2', 'seat-3'],
    'the hub seats minted for a refused draft are revoked again'
  );
});

test('seats survive a worker restart: a revoked seat stays refused with its epoch bumped, a live one admits again, and an expiring one closes its guest and leaves the list', async (t) => {
  const page = await chrome.page(t);
  await boot(page, `directory=/.slicc/guests-${Date.now()}&answer=Hi.`);
  const result = await page.evaluate(async () => {
    const { owner, join, until, hub, record } = globalThis.seats;
    const local = await owner.connect();
    const model = createAgentModel(local, { guests: hub });
    const gates = { messages: 'off', tools: 'user' };
    const kept = await model.guests.mint('cone', { label: 'Kept', expiresAt: null, gates });
    const gone = await model.guests.mint('cone', { label: 'Gone', expiresAt: null, gates });
    await model.guests.revoke(gone.seat.id);
    await local.close();
    await owner.restart();
    const again = await owner.connect();
    const reloaded = createAgentModel(again, { guests: hub });
    await until(() => reloaded.guests.list().length === 1, 'the seats after the restart');
    const out = {
      listed: reloaded.guests.list().map((seat) => seat.label),
      gone: await record(gone.seat.id),
    };
    out.refused = await join({ guest: { id: gone.seat.id, label: 'Gone' } }).then(
      () => 'joined',
      (error) => error.code
    );
    const guest = await join({ guest: { id: kept.seat.id, label: 'Kept' } });
    out.kept = guest.guest.label;
    const brief = await reloaded.guests.mint('cone', {
      label: 'Brief',
      expiresAt: Date.now() + 1500,
      gates,
    });
    const short = await join({ guest: { id: brief.seat.id, label: 'Brief' } });
    out.briefListed = reloaded.guests.list().map((seat) => seat.label);
    await short.closed;
    await until(() => reloaded.guests.list().length === 1, 'the brief seat to leave the list');
    out.afterExpiry = reloaded.guests.list().map((seat) => seat.label);
    out.expiredJoin = await join({ guest: { id: brief.seat.id, label: 'Brief' } }).then(
      () => 'joined',
      (error) => error.code
    );
    await guest.close();
    await again.close();
    return out;
  });
  assert.deepEqual(result.listed, ['Kept']);
  assert.equal(result.gone.epoch, 2);
  assert.equal(result.refused, 'EACCES');
  assert.equal(result.kept, 'Kept');
  assert.deepEqual(result.briefListed, ['Kept', 'Brief']);
  assert.deepEqual(result.afterExpiry, ['Kept']);
  assert.equal(result.expiredJoin, 'EACCES');
});

test('the Network panel invites a guest through the agent adapter, shows the link once, lists the seat as connected once the guest joins, and revokes it', async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: Number(env.GUESTS_WIDTH ?? 1280),
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await boot(page, 'answer=Hi.');
  await page.evaluate(async () => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    const { owner, hub } = globalThis.seats;
    const local = await owner.connect();
    const model = createAgentModel(local, { storage: localStorage, guests: hub });
    const app = document.createElement('slicc-app');
    app.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.style.margin = '0';
    document.body.append(app);
    app.model = { ...createDummyModel({ storage: localStorage }), ...model };
    await customElements.whenDefined('slicc-app');
    await model.agent.ready();
    const all = (root, selector, found = []) => {
      found.push(...root.querySelectorAll(selector));
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) all(node.shadowRoot, selector, found);
      return found;
    };
    globalThis.ui = { model, local, find: (selector) => all(document, selector)[0] ?? null, all };
  });
  await page.until(() => Boolean(globalThis.ui.find('[data-network]')));
  await page.evaluate(() => globalThis.ui.find('[data-network]').click());
  await page.until(() => Boolean(globalThis.ui.find('section[data-guests] [data-guests-empty]')));
  await page.evaluate(() => globalThis.ui.find('[data-action="invite-guest"]').click());
  await page.until(() => Boolean(globalThis.ui.find('#guest-name')));
  await page.evaluate(() => globalThis.ui.find('#guest-name').focus());
  await page.insert('Anna');
  await page.evaluate(() => globalThis.ui.find('[data-action="create-guest-link"]').click());
  await page.until(() => Boolean(globalThis.ui.find('[data-guest-invite="link"]')));
  const link = await page.evaluate(() => {
    const field = globalThis.ui.find('[data-copy="guest-url"]');
    return { url: field?.value ?? '', minted: globalThis.seats.minted };
  });
  assert.equal(link.url, 'https://hub.test/join/seat-1-token');
  assert.equal(link.minted.length, 1);
  assert.equal(link.minted[0].label, 'Anna');
  assert.equal(link.minted[0].agentId, 'cone');
  assert.deepEqual(link.minted[0].gates, { messages: 'user', tools: 'user' });
  if (env.GUESTS_LINK_SHOT) await page.screenshot(env.GUESTS_LINK_SHOT);
  await page.evaluate(() => globalThis.ui.find('[data-action="done-guest"]').click());
  await page.until(() =>
    Boolean(globalThis.ui.find('li[data-seat="seat-1"][data-connected="false"]'))
  );
  await page.evaluate(async () => {
    globalThis.guest = await globalThis.seats.join({ guest: { id: 'seat-1', label: 'Anna' } });
  });
  await page.until(() =>
    Boolean(globalThis.ui.find('li[data-seat="seat-1"][data-connected="true"]'))
  );
  const row = await page.evaluate(() => globalThis.ui.find('li[data-seat="seat-1"]').innerText);
  assert.match(row, /Anna/);
  assert.match(row, /sliccy/);
  assert.match(row, /Expires in 7 days/);
  if (env.GUESTS_SHOT) await page.screenshot(env.GUESTS_SHOT);
  await page.evaluate(() => globalThis.ui.find('[data-action="revoke-guest"]').click());
  await page.until(() => Boolean(globalThis.ui.find('slicc-confirm')));
  await page.evaluate(() =>
    globalThis.ui.all(globalThis.ui.find('slicc-confirm').shadowRoot, '[data-action]')[0].click()
  );
  await page.until(() => Boolean(globalThis.ui.find('section[data-guests] [data-guests-empty]')));
  const after = await page.evaluate(async () => {
    await globalThis.guest.closed;
    return { revoked: globalThis.seats.revoked, seats: globalThis.ui.model.guests.list() };
  });
  assert.deepEqual(after.revoked, ['seat-1']);
  assert.deepEqual(after.seats, []);
});
