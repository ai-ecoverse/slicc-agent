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
