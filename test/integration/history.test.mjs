import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const TURNS = 60;
const answers = Array.from({ length: TURNS + 1 }, (_, n) => `answer=A${n + 1}`).join('&');
const questions = (count) => Array.from({ length: count }, (_, n) => `Q${n + 1}`);
const pairs = (count) => questions(count).flatMap((q, n) => [q, `A${n + 1}`]);

test('a background cone longer than the view window pages back to its first entry, in the chat and through remote history, with nothing lost or doubled at any boundary', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const seen = await staged(
    page,
    'a cone longer than the window pages back',
    async (turns, answers) => {
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/agent-worker.js?${answers}`, { type: 'module' }),
      });
      const connection = await owner.connect();
      const created = await connection.control.createCone('long', BACKGROUND_CONTEXT);
      const cone = created.id;
      const ask = async (text) => {
        const sent = await connection.control.send(
          { text, whenBusy: 'followUp', requestId: null, agentId: cone },
          BACKGROUND_CONTEXT
        );
        const settled = await connection.control.wait(sent.submissionId, BACKGROUND_CONTEXT);
        if (settled.status !== 'done') throw new Error(`${text}: ${settled.status}`);
      };
      for (let n = 1; n <= turns; n++) await ask(`Q${n}`);
      const model = createAgentModel(connection);
      const { agent } = model;
      await agent.ready();
      const texts = () =>
        agent
          .messages(cone)
          .map((message) => message.text ?? message.parts?.find((p) => p.type === 'text')?.text);
      await when([changed, every(100)], () => texts().at(-1) === `A${turns}`, 'the last answer');
      const windowed = texts().length;
      const window = connection.views.value[cone].entries.length;
      const olderBefore = agent.hasOlder(cone);
      const unread = () => agent.list().find((row) => row.id === cone)?.unread;
      const unreadBefore = unread();
      const pages = [];
      for (let guard = 0; guard < 20; guard++) {
        const first = agent.messages(cone)[0].id;
        const got = await agent.older(cone, first);
        pages.push(got.length);
        if (!got.length) break;
        const ids = agent.messages(cone).map((message) => message.id);
        if (got.at(-1).id !== ids[ids.indexOf(first) - 1])
          throw new Error('a page is not contiguous');
      }
      const paged = texts();
      const unreadPaged = unread();
      const ids = agent.messages(cone).map((message) => message.id);
      const remote = remoteControl(connection, { agent: () => cone });
      const watched = await remote.watch();
      const history = [];
      let before = watched.history;
      const cursors = [];
      while (before !== null) {
        const got = await remote.history({ before, limit: 7 });
        history.unshift(...got.events);
        cursors.push(got.before);
        before = got.more ? got.before : null;
      }
      await ask(`Q${turns + 1}`);
      const live = [];
      const iterator = watched.events[Symbol.asyncIterator]();
      while (!live.some((event) => event.t === 'text' && event.delta === `A${turns + 1}`))
        live.push((await iterator.next()).value);
      await iterator.return();
      await when(
        [changed, every(100)],
        () => texts().at(-1) === `A${turns + 1}`,
        'the answer after paging'
      );
      const final = texts();
      await owner.release();
      return {
        window,
        windowed,
        olderBefore,
        olderAfter: agent.hasOlder(cone),
        unreadBefore,
        unreadPaged,
        pages,
        paged,
        unique: new Set(ids).size === ids.length,
        history: history.map((event) => [event.t, event.text ?? event.delta, event.delivered]),
        historyIds: history
          .map((event) => event.id)
          .filter((id, at, all) => all.indexOf(id) !== at),
        cursors: cursors.length,
        shared: live.filter((event) => history.some((old) => old.id && old.id === event.id)).length,
        live: live
          .map((event) => [event.t, event.text ?? event.delta])
          .filter(([t]) => t !== 'run'),
        final,
      };
    },
    TURNS,
    answers
  );
  assert.ok(seen.window <= 100, `window ${seen.window}`);
  assert.ok(seen.windowed < TURNS * 2, `the window shows ${seen.windowed} messages`);
  assert.equal(seen.olderBefore, true);
  assert.equal(seen.olderAfter, false);
  assert.equal(seen.unreadPaged, seen.unreadBefore);
  assert.equal(seen.pages.at(-1), 0);
  assert.ok(seen.pages.length >= 2, `pages ${seen.pages}`);
  assert.deepEqual(seen.paged, pairs(TURNS));
  assert.equal(seen.unique, true);
  assert.deepEqual(
    seen.history,
    questions(TURNS).flatMap((q, n) => [
      ['user', q, 'run'],
      ['text', `A${n + 1}`, null],
    ])
  );
  assert.deepEqual(seen.historyIds, []);
  assert.equal(seen.shared, 0);
  assert.ok(seen.cursors >= Math.floor((TURNS * 2) / 7), `cursors ${seen.cursors}`);
  assert.deepEqual(seen.live, [
    ['user', `Q${TURNS + 1}`],
    ['text', `A${TURNS + 1}`],
  ]);
  assert.deepEqual(seen.final, pairs(TURNS + 1));
  assert.deepEqual(page.errors, []);
});

test('remote history refuses a malformed cursor and reports the start of a short conversation', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const seen = await staged(page, 'remote history edges', async () => {
    const owner = await startTracked({
      worker: () => new Worker('/dist-test/agent-worker.js?answer=Only.', { type: 'module' }),
    });
    const connection = await owner.connect();
    const remote = remoteControl(connection);
    const empty = await remote.watch();
    const none = await remote.history({ before: null });
    await connection.prompt('Just one');
    const all = await remote.history({ before: null, limit: 500 });
    const bad = await remote.history({ before: 'e12' }).then(
      () => null,
      (error) => error.code
    );
    const iterator = empty.events[Symbol.asyncIterator]();
    await iterator.return();
    await owner.release();
    return {
      emptyHistory: empty.history,
      none,
      all: all.events.map((event) => event.t),
      more: all.more,
      before: all.before,
      bad,
    };
  });
  assert.equal(seen.emptyHistory, null);
  assert.deepEqual(seen.none, { events: [], before: null, more: false });
  assert.deepEqual(seen.all, ['user', 'text']);
  assert.equal(seen.more, false);
  assert.equal(seen.before, null);
  assert.equal(seen.bad, 'EINVAL');
});

test('a watch opened while an answer streams starts with the answer so far, whole, then sends only the rest', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const long = Array.from({ length: 80 }, (_, n) => `word${n}`).join(' ');
  const seen = await staged(
    page,
    'a watch opened mid-answer',
    async (long) => {
      const owner = await startTracked({
        worker: () =>
          new Worker(`/dist-test/agent-worker.js?tps=40&answer=${encodeURIComponent(long)}`, {
            type: 'module',
          }),
      });
      const connection = await owner.connect();
      await connection.control.send(
        { text: 'Talk', whenBusy: 'followUp', requestId: null },
        BACKGROUND_CONTEXT
      );
      const partial = () =>
        connection.transcript.value?.docs['pi.live']?.generation?.message?.content?.find(
          (block) => block.type === 'text'
        )?.text ?? '';
      await when([changed, every(20)], () => partial().length > 40, 'a partial answer');
      const before = partial().length;
      const watched = await remoteControl(connection).watch();
      const events = [];
      const iterator = watched.events[Symbol.asyncIterator]();
      while (!events.some((event) => event.t === 'run' && event.state === 'end'))
        events.push((await iterator.next()).value);
      await iterator.return();
      await owner.release();
      return { before, events };
    },
    long
  );
  const texts = seen.events.filter((event) => event.t === 'text');
  assert.equal(seen.events[0].t, 'text');
  assert.ok(seen.events[0].delta.length >= seen.before, `${seen.events[0].delta.length}`);
  assert.ok(long.startsWith(seen.events[0].delta));
  assert.ok(seen.events[0].delta.length < long.length);
  assert.deepEqual([...new Set(texts.map((event) => event.id))], [texts[0].id]);
  assert.equal(texts.map((event) => event.delta).join(''), long);
});

test('when the view jumps past what the chat holds, the chat fills the gap itself, without older()', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const seen = await staged(
    page,
    'the chat fills a gap',
    async (turns, answers) => {
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/agent-worker.js?${answers}`, { type: 'module' }),
      });
      const connection = await owner.connect();
      const real = connection.views;
      const heard = new Set();
      let frozen = null;
      real.subscribe(() => {
        if (!frozen) for (const listener of heard) listener(real.value);
      });
      const views = {
        get value() {
          return frozen ?? real.value;
        },
        subscribe(listener) {
          heard.add(listener);
          return () => heard.delete(listener);
        },
      };
      const { agent } = createAgentModel({ ...connection, views });
      await agent.ready();
      const cone = agent.active();
      const texts = () =>
        agent
          .messages(cone)
          .map((message) => message.text ?? message.parts?.find((p) => p.type === 'text')?.text);
      for (let n = 1; n <= 3; n++) await connection.prompt(`Q${n}`);
      await when([changed, every(50)], () => texts().at(-1) === 'A3', 'three turns');
      frozen = real.value;
      for (let n = 4; n <= turns; n++) await connection.prompt(`Q${n}`);
      const jumped = real.value[cone];
      frozen = null;
      for (const listener of heard) listener(real.value);
      await when([changed, every(50)], () => texts().length === turns * 2, 'the gap filled');
      const ids = agent.messages(cone).map((message) => message.id);
      await owner.release();
      return {
        before: jumped.before,
        window: jumped.entries.length,
        texts: texts(),
        unique: new Set(ids).size === ids.length,
        older: agent.hasOlder(cone),
      };
    },
    TURNS,
    answers
  );
  assert.ok(seen.before > 6, `the window starts after entry ${seen.before}`);
  assert.ok(seen.window < TURNS * 2);
  assert.deepEqual(seen.texts, pairs(TURNS));
  assert.equal(seen.unique, true);
  assert.equal(seen.older, false);
  assert.deepEqual(page.errors, []);
});

test('a view-only seat gets the full image of an entry only from a view or its own page of the current conversation', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const seen = await staged(
    page,
    'view-only images',
    async (turns, answers) => {
      const canvas = new OffscreenCanvas(256, 256);
      const draw = canvas.getContext('2d');
      const pixels = draw.createImageData(256, 256);
      let seed = 7;
      for (let at = 0; at < pixels.data.length; at++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        pixels.data[at] = at % 4 === 3 ? 255 : seed & 255;
      }
      draw.putImageData(pixels, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      const png = btoa(text);
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/agent-worker.js?${answers}`, { type: 'module' }),
      });
      const connection = await owner.connect();
      const viewer = await owner.connect({ readOnly: true });
      const other = await owner.connect({ readOnly: true });
      const ask = async (text, attach) => {
        const sent = await connection.control.send(
          {
            text,
            whenBusy: 'followUp',
            requestId: null,
            ...(attach
              ? {
                  attachments: [
                    { name: 'noise.png', mimeType: 'image/png', kind: 'image', data: png },
                  ],
                }
              : {}),
          },
          BACKGROUND_CONTEXT
        );
        await connection.control.wait(sent.submissionId, BACKGROUND_CONTEXT);
      };
      const newest = async (kind) =>
        (
          await connection.control.entries({ agentId: 'cone', limit: 5 }, BACKGROUND_CONTEXT)
        ).entries.find((entry) => entry.kind === kind);
      const refOf = (entry) => ({
        entry: entry.id,
        message: 0,
        part: entry.model[0].content.findIndex((block) => block.type === 'image'),
      });
      await ask('Q1', true);
      const first = refOf(await newest('pi.user'));
      const conversation = Number(connection.views.value.cone.conversation.id);
      for (let n = 2; n < turns; n++) await ask(`Q${n}`);
      await ask(`Q${turns}`, true);
      const last = refOf(await newest('pi.user'));
      const answer = await newest('pi.assistant');
      const full = async (seat, ref) => (await seat.control.image(ref, BACKGROUND_CONTEXT)).data;
      const read = async (seat, ref, at = conversation) =>
        (
          await seat.control.entries(
            {
              agentId: 'cone',
              conversation: at,
              maxEntryId: ref.entry,
              order: 'descending',
              limit: 1,
            },
            BACKGROUND_CONTEXT
          )
        ).entries.map((entry) => entry.id);
      await when(
        [changed, every(50)],
        () => !viewer.views.value.cone.entries.some((item) => item.id === first.entry),
        'the first image leaves the window'
      );
      const out = {
        png,
        first: first.entry,
        last: last.entry,
        unpaged: await full(viewer, first),
        inView: await full(viewer, last),
        paged: await read(viewer, first),
      };
      out.afterPage = await full(viewer, first);
      out.otherSeat = await full(other, first);
      out.pagedLast = await read(viewer, last);
      const rewound = await connection.control.rewindAgent(
        'cone',
        `e${answer.id}`,
        BACKGROUND_CONTEXT
      );
      out.rewound = rewound.done;
      await when(
        [changed, every(50)],
        () => Number(viewer.views.value.cone.conversation.id) !== conversation,
        'the fork'
      );
      const fork = Number(viewer.views.value.cone.conversation.id);
      out.leftLast = await full(viewer, last);
      out.staleFirst = await full(viewer, first);
      out.staleRead = await read(viewer, first);
      out.forkLast = await read(viewer, last, fork);
      out.forkFirst = await read(viewer, first, fork);
      out.again = await full(viewer, first);
      await owner.release();
      return out;
    },
    TURNS,
    answers
  );
  assert.ok(seen.png.length > 48 * 1024, `${seen.png.length}`);
  assert.equal(seen.unpaged, null);
  assert.equal(seen.inView, seen.png);
  assert.deepEqual(seen.paged, [seen.first]);
  assert.equal(seen.afterPage, seen.png);
  assert.equal(seen.otherSeat, null);
  assert.deepEqual(seen.pagedLast, [seen.last]);
  assert.equal(seen.rewound, true);
  assert.equal(seen.leftLast, null);
  assert.equal(seen.staleFirst, null);
  assert.deepEqual(seen.staleRead, []);
  assert.notDeepEqual(seen.forkLast, [seen.last]);
  assert.deepEqual(seen.forkFirst, [seen.first]);
  assert.equal(seen.again, seen.png);
});

async function jumpsTwice(t, first, second, holdAt = 0) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(() => import('/dist-test/page.js'));
  const total = first + second;
  const seen = await staged(
    page,
    'a second jump during a gap fill',
    async (first, total, holdAt) => {
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/agent-worker.js?echo=${total}`, { type: 'module' }),
      });
      const connection = await owner.connect();
      const real = connection.views;
      const heard = new Set();
      let frozen = null;
      const tell = () => {
        for (const listener of heard) listener(real.value);
      };
      real.subscribe(() => {
        if (!frozen) tell();
      });
      const views = {
        get value() {
          return frozen ?? real.value;
        },
        subscribe(listener) {
          heard.add(listener);
          return () => heard.delete(listener);
        },
      };
      let hold = null;
      let release = () => {};
      let held = 0;
      let fetched = 0;
      const control = new Proxy(connection.control, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== 'entries') return typeof value === 'function' ? value.bind(target) : value;
          return async (...args) => {
            const result = await value.apply(target, args);
            fetched += result.entries.length;
            if (hold && fetched >= holdAt) {
              held += 1;
              await hold;
            }
            return result;
          };
        },
      });
      const { agent } = createAgentModel({ ...connection, control, views });
      await agent.ready();
      const cone = agent.active();
      const texts = () =>
        agent
          .messages(cone)
          .map((message) => message.text ?? message.parts?.find((p) => p.type === 'text')?.text);
      for (let n = 1; n <= 3; n++) await connection.prompt(`Q${n}`);
      await when([changed, every(50)], () => texts().at(-1) === 'A3', 'three turns');
      frozen = real.value;
      for (let n = 4; n <= first; n++) {
        if (n % 100 === 0) stage(`turn ${n}`);
        await connection.prompt(`Q${n}`);
      }
      hold = new Promise((resolve) => {
        release = resolve;
      });
      frozen = null;
      tell();
      await when([changed, every(50)], () => held > 0, 'a gap fill held open');
      frozen = real.value;
      for (let n = first + 1; n <= total; n++) await connection.prompt(`Q${n}`);
      frozen = null;
      tell();
      hold = null;
      release();
      await when([changed, every(50)], () => texts().at(-1) === `A${total}`, 'the last answer');
      for (let last = -1; last !== fetched; ) {
        last = fetched;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const shown = texts();
      await owner.release();
      return { shown, older: agent.hasOlder(cone), fetched };
    },
    first,
    total,
    holdAt
  );
  return { ...seen, total, errors: page.errors };
}

test('a second jump while the chat fills a gap is filled too, and the conversation stays whole', async (t) => {
  const seen = await jumpsTwice(t, 60, 60);
  assert.deepEqual(seen.shown, pairs(seen.total));
  assert.equal(seen.older, false);
  assert.deepEqual(seen.errors, []);
});

test('a second jump while the chat fills a jump past its cap is filled too, under a contiguous tail older() continues', async (t) => {
  const seen = await jumpsTwice(t, 2060, 60, 4000);
  const kept = seen.shown.length / 2;
  assert.ok(kept >= 2000 && kept < seen.total, `${kept} turns kept`);
  assert.deepEqual(seen.shown, pairs(seen.total).slice(-seen.shown.length));
  assert.equal(seen.older, true);
  assert.ok(seen.fetched <= 4000 + 200, `${seen.fetched} entries fetched`);
  assert.deepEqual(seen.errors, []);
});
