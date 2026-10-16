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
    const approve = (draft) => ask({ approve: draft }, 'reply');
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
    globalThis.seats = { owner, join, until, hub, minted, revoked, said, record, seen, approve };
  }, query);
}

const hour = 60 * 60 * 1000;

test('an owner invites a guest through the hub, the guest watches the cone and its message reaches the agent marked as a guest, and revoking ends the seat everywhere', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Watched.&answer=Thanks%2C%20Anna.');
  const result = await page.evaluate(async (hour) => {
    const { owner, join, until, hub, minted, revoked, said, record, seen, approve } =
      globalThis.seats;
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
    const review = await approve({
      kind: 'guest-message',
      seat: invited.seat.id,
      agentId: 'cone',
      requester: { kind: 'guest', name: 'Anna', seat: invited.seat.id },
      tier: 'user',
      detail: { text: 'One more thing?', attachments: [] },
    });
    await until(() => model.guests.list()[0]?.pending === 1, 'the pending review to count');
    out.pending = model.guests.list()[0].pending;
    out.before = await record(invited.seat.id);
    await model.guests.revoke(invited.seat.id);
    await Promise.all([guest.closed, second.closed]);
    out.after = await record(invited.seat.id);
    await until(
      () => local.approvals.value.find((item) => item.id === review.item.id)?.state === 'withdrawn',
      'the review to be withdrawn'
    );
    const ended = local.approvals.value.find((item) => item.id === review.item.id);
    out.review = { state: ended.state, reason: ended.reason };
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
  assert.equal(result.pending, 1);
  assert.deepEqual(
    result.review,
    { state: 'withdrawn', reason: 'revoked' },
    'a review that outlives its seat is discarded'
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
      waiting: guestModel.agent.queue('cone').map((message) => `${message.from}: ${message.text}`),
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
  for (const key of ['abort', 'lick', 'configure', 'settings'])
    assert.equal(result[key], 'EACCES', key);
  assert.equal(result.mint, 'forbidden', 'the guest policy refuses a guest managing guests');
  assert.equal(result.invite, "Only the owner's devices can invite guests.");
  assert.equal(result.gated, 'sent');
  assert.deepEqual(result.waiting, ['Mallory: Let me in']);
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

test('every owner device manages guests: a follower with Control and one without mint, list and revoke through the Guests port like the owner', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Hello.');
  const result = await page.evaluate(async () => {
    const { owner, join, hub, until, revoked } = globalThis.seats;
    const local = await owner.connect();
    const follower = await join({ pages: false }, connectAgent);
    const viewer = await join({ pages: false, readOnly: true }, connectAgent);
    const gates = { messages: 'user', tools: 'agent' };
    const ports = [local, follower, viewer].map(
      (connection) => createAgentModel(connection, { guests: hub }).guests
    );
    const unavailable = ports.map((port) => port.unavailable());
    const fromFollower = await ports[1].mint('cone', { label: 'Ada', expiresAt: null, gates });
    const fromViewer = await ports[2].mint('cone', { label: 'Bea', expiresAt: null, gates });
    await until(
      () => ports.every((port) => port.list().length === 2),
      'every device to list both seats'
    );
    const listed = ports.map((port) => port.list().map((seat) => seat.label));
    await ports[2].revoke(fromFollower.seat.id);
    await ports[1].revoke(fromViewer.seat.id);
    await until(() => ports.every((port) => port.list().length === 0), 'both seats to leave');
    const viewDrives = await viewer.control.abort(BACKGROUND_CONTEXT).then(
      () => 'ran',
      (error) => error.code
    );
    for (const connection of [viewer, follower, local]) await connection.close();
    return {
      unavailable,
      urls: [fromFollower.url, fromViewer.url],
      listed,
      revoked: [...revoked],
      viewDrives,
      viewOnly: viewer.viewOnly,
    };
  });
  assert.deepEqual(result.unavailable, [null, null, null]);
  assert.deepEqual(result.urls, [
    'https://hub.test/join/seat-1-token',
    'https://hub.test/join/seat-2-token',
  ]);
  assert.deepEqual(result.listed, [
    ['Ada', 'Bea'],
    ['Ada', 'Bea'],
    ['Ada', 'Bea'],
  ]);
  assert.deepEqual(result.revoked, ['seat-1', 'seat-2']);
  assert.equal(result.viewOnly, true);
  assert.equal(result.viewDrives, 'EACCES', 'Control still gates driving');
});

test('the approval policy: by default a guest seat with tools off is refused, an owner device allows it, and a guest can never change the policy or manage seats', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'answer=Hello.');
  const result = await page.evaluate(async () => {
    const { owner, join, hub, until } = globalThis.seats;
    const local = await owner.connect();
    const viewer = await join({ pages: false, readOnly: true }, connectAgent);
    const ownerPort = createAgentModel(local, { guests: hub }).guests;
    const viewerPort = createAgentModel(viewer, { guests: hub }).guests;
    const unreviewed = { messages: 'user', tools: 'off' };
    const failed = (promise) =>
      promise.then(
        () => 'resolved',
        (error) => `${error.code ?? ''}${error.code ? ' ' : ''}${error.message}`
      );
    const before = await failed(
      ownerPort.mint('cone', { label: 'Eve', expiresAt: null, gates: unreviewed })
    );
    const offered = ownerPort.gates();
    const set = await viewer.control.approvalPolicySet(
      { guests: { allowedToolGates: ['user', 'agent', 'scoop', 'off'] } },
      BACKGROUND_CONTEXT
    );
    const refusedChange = await viewer.control.approvalPolicySet(
      { guests: { manageGuests: 'user' } },
      BACKGROUND_CONTEXT
    );
    await until(
      () => local.approvalPolicy.value.guests.allowedToolGates.includes('off'),
      'the owner tab to see the policy'
    );
    const { seat } = await ownerPort.mint('cone', {
      label: 'Eve',
      expiresAt: null,
      gates: unreviewed,
    });
    await local.control.approvalPolicySet(
      { guests: { allowedToolGates: ['user', 'agent', 'scoop'] } },
      BACKGROUND_CONTEXT
    );
    await until(
      () => !viewer.approvalPolicy.value.guests.allowedToolGates.includes('off'),
      'the follower to see it closed again'
    );
    const after = await failed(
      viewerPort.mint('cone', { label: 'Mal', expiresAt: null, gates: unreviewed })
    );
    const guest = await join({ guest: { id: seat.id, label: 'Eve' } });
    const draft = {
      id: 'by-guest',
      label: 'Friend',
      agentId: 'cone',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    };
    const asGuest = {
      mint: await failed(guest.control.guestOpen(draft, BACKGROUND_CONTEXT)),
      revoke: await failed(guest.control.guestRevoke(seat.id, BACKGROUND_CONTEXT)),
      policy: await failed(
        guest.control.approvalPolicySet(
          { guests: { allowedToolGates: ['off'] }, sudo: { approver: 'agent' } },
          BACKGROUND_CONTEXT
        )
      ),
    };
    const seats = ownerPort.list().map((listed) => [listed.label, listed.gates.tools]);
    const policy = local.approvalPolicy.value;
    await guest.close();
    await viewer.close();
    await local.close();
    return { before, offered, set, refusedChange, after, asGuest, seats, policy };
  });
  const review = "A guest's tool calls need a review: by a person, the judge or a scoop.";
  assert.equal(result.before, review);
  assert.deepEqual(result.offered.tools, ['user', 'agent', 'scoop:*']);
  assert.deepEqual(result.set.policy.guests.allowedToolGates, ['user', 'agent', 'scoop', 'off']);
  assert.equal(
    result.refusedChange.error,
    "manageGuests can only be deny: guests can't manage guests yet."
  );
  assert.equal(result.after, review);
  assert.deepEqual(result.seats, [['Eve', 'off']]);
  assert.equal(
    result.asGuest.mint,
    "forbidden The owner's guest policy doesn't let guests manage guests."
  );
  assert.equal(
    result.asGuest.revoke,
    "forbidden The owner's guest policy doesn't let guests manage guests."
  );
  assert.match(result.asGuest.policy, /^EACCES /);
  assert.equal(result.policy.guests.manageGuests, 'deny');
  assert.deepEqual(result.policy.guests.allowedToolGates, ['user', 'agent', 'scoop']);
  assert.deepEqual(result.policy.sudo, { approver: 'user' });
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

test('a gated guest message waits visibly: the guest sees it pending, an approval delivers it once, and one nobody answers ends as not approved in time', async (t) => {
  const page = await chrome.page(t);
  await boot(page, 'ttl=2500&answer=Welcome%2C%20Anna.');
  const result = await page.evaluate(async () => {
    const { owner, join, until, hub, said } = globalThis.seats;
    const local = await owner.connect();
    const model = createAgentModel(local, { guests: hub });
    const { seat } = await model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates: { messages: 'user', tools: 'user' },
    });
    const guest = await join({ guest: { id: seat.id, label: 'Anna' } });
    const guestModel = createAgentModel(guest);
    await guestModel.agent.ready();
    const queue = () =>
      guestModel.agent
        .queue('cone')
        .map((message) => `${message.origin}(${message.from}): ${message.text}`);
    await guestModel.agent.send('cone', 'Can I join in?');
    await until(() => queue().length === 1, 'the guest to see its message waiting');
    const out = { waiting: queue() };
    await until(() => model.approvals.list().length === 1, 'the owner to be asked');
    const asked = model.approvals.list()[0];
    out.asked = { kind: asked.kind, text: asked.text, always: asked.always };
    await until(() => model.guests.list()[0]?.pending === 1, 'the seat to count it');
    await model.approvals.decide(asked.id, 'once');
    await until(
      () => said(model).includes('agent: Welcome, Anna.'),
      'the approved message to be answered'
    );
    out.ownerSees = said(model);
    await until(() => queue().length === 0, 'the guest queue to empty');
    await until(
      () => said(guestModel).includes('agent: Welcome, Anna.'),
      'the guest to see the answer'
    );
    await guestModel.agent.send('cone', 'Anyone there?');
    await until(() => queue().length === 1, 'the second message to wait');
    const notice = () =>
      guestModel.agent
        .messages('cone')
        .find((message) => message.role === 'system' && message.text === 'Anyone there?');
    await until(notice, 'the unanswered notice');
    out.notice = { title: notice().title, kind: notice().kind };
    out.queueAfter = queue();
    out.ownerAfter = said(model);
    out.pendingAfter = model.guests.list()[0].pending;
    await guest.close();
    return out;
  });
  assert.deepEqual(result.waiting, ['guest(Anna): Can I join in?']);
  assert.deepEqual(result.asked, { kind: 'guest-message', text: 'Can I join in?', always: false });
  assert.deepEqual(result.ownerSees, ['guest(Anna): Can I join in?', 'agent: Welcome, Anna.']);
  assert.deepEqual(result.notice, { title: 'Nobody approved this in time.', kind: 'notice' });
  assert.deepEqual(result.queueAfter, []);
  assert.deepEqual(
    result.ownerAfter,
    result.ownerSees,
    'an unanswered message never reaches the agent'
  );
  assert.equal(result.pendingAfter, 0);
});

test('a guest-started run gets every tool call refused, top-level and in codemode, and none of them runs, while the owner’s own runs in the same cone still use tools', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const steps = [
    { tool: { name: 'bash', args: { command: 'echo owner-ran' } } },
    { answer: 'Owner done.' },
    { tool: { name: 'bash', args: { command: 'touch /tmp/guest-bash' } } },
    { answer: 'That was refused.' },
    {
      tool: {
        name: 'codemode',
        args: { code: "await tools.bash({ command: 'touch /tmp/guest-code' }); return 'done';" },
      },
    },
    { answer: 'Refused again.' },
    {
      tool: {
        name: 'bash',
        args: {
          command:
            'for f in /tmp/guest-bash /tmp/guest-code; do test -e $f && echo "$f ran" || echo "$f never"; done',
        },
      },
    },
    { answer: 'Checked.' },
  ];
  const result = await page.evaluate(async (steps) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const until = async (check, what) => {
      for (let i = 0; i < 800; i++) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const local = await owner.connect();
    const said = () =>
      local.transcript.value.entries.flatMap((entry) =>
        entry.kind === 'pi.assistant'
          ? (entry.model?.[0]?.content ?? [])
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
          : []
      );
    const results = () =>
      local.transcript.value.entries
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) =>
          (entry.model?.[0]?.content ?? [])
            .map((block) => block.text ?? '')
            .join('')
            .trim()
        );
    const hub = {
      mint: async () => ({ id: 'seat-1', url: 'https://hub.test/join/t' }),
      revoke: async () => {},
    };
    const model = createAgentModel(local, { guests: hub });
    await model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    await local.prompt('Run something.');
    const guest = await connectGuest(await owner.port({ guest: { id: 'seat-1', label: 'Anna' } }));
    await guest.control.send(
      { text: 'Make a file.', whenBusy: 'steer', requestId: null },
      BACKGROUND_CONTEXT
    );
    await until(() => said().includes('That was refused.'), 'the first guest run');
    await guest.control.send(
      { text: 'Try a script.', whenBusy: 'steer', requestId: null },
      BACKGROUND_CONTEXT
    );
    await until(() => said().includes('Refused again.'), 'the second guest run');
    await local.prompt('Check the files.');
    await until(() => said().includes('Checked.'), 'the owner check');
    const out = { said: said(), results: results() };
    await guest.close();
    await local.close();
    await owner.release();
    return out;
  }, steps);
  const blocked =
    "Tool calls in a run a guest started need a review, which this agent can't do yet.";
  assert.deepEqual(result.said, ['Owner done.', 'That was refused.', 'Refused again.', 'Checked.']);
  assert.equal(result.results.length, 4);
  assert.equal(result.results[0], 'owner-ran');
  assert.ok(result.results[1].includes(blocked), result.results[1]);
  assert.ok(result.results[2].includes(blocked), result.results[2]);
  assert.match(result.results[3], /\/tmp\/guest-bash never/);
  assert.match(result.results[3], /\/tmp\/guest-code never/);
});
