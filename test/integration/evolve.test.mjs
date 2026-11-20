import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const EMPTY = { models: [], accounts: [] };

const settingsSentence =
  "That SLICC runs another version of the agent's settings service, so this tab can't use it. Update both SLICCs, then reload this page.";

test('a follower with older contracts than the owner connects and uses what it knows, members the owner added are absent for it, and a service whose history the owner restarted fails at once with EVERSION naming it', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'an older follower', async () => {
    await import('/dist-test/page.js');
    const owner = await startAgent({
      worker: () =>
        new Worker('/dist-test/next-agent-worker.js?answer=Newer%20here.', { type: 'module' }),
    });
    const failed = (error) => ({ code: error.code ?? null, message: error.message });
    const timed = async (work) => {
      const started = performance.now();
      const value = await work().catch(failed);
      return { value, ms: performance.now() - started };
    };
    stage('the follower connects');
    const connecting = await timed(() =>
      owner.port({ pages: false }).then((port) => connectAgent(port))
    );
    const follower = connecting.value;
    stage('the follower prompts');
    const answer = await follower.prompt('Are you there?');
    const users = JSON.stringify(follower.transcript.value).includes('Are you there?');
    const settings = await timed(() =>
      follower.settings.connect('anthropic', 'key', null, BACKGROUND_CONTEXT)
    );
    const settingsState = follower.settings.state.value;
    stage('a raw link holds');
    const raw = await openRawLink(await owner.port({ pages: false }));
    const control = await raw.hold('control');
    const transcript = await raw.hold('transcript');
    const rawSettings = await raw.hold('settings');
    const aborted = await control.call('abort');
    raw.close();
    stage('a guest joins');
    const local = await owner.connect();
    const opened = await local.control.guestOpen(
      {
        id: 'older',
        label: 'Anna',
        agentId: 'cone',
        expiresAt: null,
        gates: { messages: 'off', tools: 'user' },
      },
      BACKGROUND_CONTEXT
    );
    const guest = await connectGuest(
      await owner.port({ guest: { id: 'older', label: 'Anna' } })
    ).catch(failed);
    const joined = guest.guest?.label ?? guest;
    await guest.close?.();
    await follower.close();
    await local.close();
    await owner.release();
    return {
      connectMs: connecting.ms,
      answer,
      users,
      settings,
      settingsState,
      hello: raw.hello.contracts,
      control: [control.variant, control.methods, control.error],
      transcript: [transcript.variant, transcript.error],
      rawSettings: [rawSettings.variant, rawSettings.error],
      aborted,
      opened: opened.error,
      joined,
    };
  });
  assert.ok(seen.connectMs < 2000, `${seen.connectMs}`);
  assert.match(seen.hello, /slicc\.agent\.extra@/, 'the owner says other contracts in its hello');
  assert.equal(seen.answer, 'Newer here.');
  assert.equal(seen.users, true, 'the transcript it follows has the prompt');
  assert.equal(seen.control[0], 'control');
  assert.ok(seen.control[1].includes('send'));
  assert.ok(!seen.control[1].includes('echo'), 'a method the owner added is absent for v1');
  assert.equal(seen.control[2], null);
  assert.deepEqual(seen.transcript, ['transcript', null]);
  assert.equal(seen.rawSettings[0], null);
  assert.equal(seen.rawSettings[1].code, 'contract_mismatch');
  assert.equal(seen.settings.value.code, 'EVERSION');
  assert.equal(seen.settings.value.message, settingsSentence);
  assert.ok(seen.settings.ms < 1000, `${seen.settings.ms}`);
  assert.deepEqual(seen.settingsState, EMPTY);
  assert.deepEqual(seen.aborted, { value: null });
  assert.equal(seen.opened, null);
  assert.equal(seen.joined, 'Anna');
});

test('a follower with newer contracts than the owner binds the older versions they share, members it added fail at once with EVERSION, and a service the owner lacks or does not know fails only its own hold', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'a newer follower', async () => {
    await import('/dist-test/next-page.js');
    const owner = await startAgent({
      worker: () =>
        new Worker('/dist-test/agent-worker.js?answer=Older%20here.', { type: 'module' }),
    });
    const failed = (error) => ({ code: error.code ?? null, message: error.message });
    const timed = async (work) => {
      const started = performance.now();
      const value = await work().catch(failed);
      return { value, ms: performance.now() - started };
    };
    stage('the follower connects');
    const connecting = await timed(() =>
      owner.port({ pages: false }).then((port) => connectAgent(port))
    );
    const follower = connecting.value;
    stage('the follower prompts');
    const answer = await follower.prompt('Are you there?');
    const echo = await timed(() => follower.control.echo(BACKGROUND_CONTEXT));
    const settings = await timed(() => follower.settings.signIn('anthropic', BACKGROUND_CONTEXT));
    stage('a raw link holds');
    const raw = await openRawLink(await owner.port({ pages: false }));
    const newer = await raw.hold('control');
    const older = await raw.hold('control', { version: 1 });
    const extra = await raw.hold('extra');
    const aborted = await older.call('abort');
    raw.close();
    await follower.close();
    await owner.release();
    return {
      connectMs: connecting.ms,
      answer,
      history: follower.history,
      echo,
      settings,
      newer: [newer.variant, newer.error],
      older: [older.variant, older.methods.includes('echo'), older.error],
      extra: [extra.variant, extra.error],
      aborted,
    };
  });
  assert.ok(seen.connectMs < 2000, `${seen.connectMs}`);
  assert.equal(seen.answer, 'Older here.');
  assert.equal(seen.history, true);
  assert.equal(seen.echo.value.code, 'EVERSION');
  assert.match(seen.echo.value.message, /another version of the agent's control service/);
  assert.ok(seen.echo.ms < 1000, `${seen.echo.ms}`);
  assert.equal(seen.settings.value.code, 'EVERSION');
  assert.equal(seen.settings.value.message, settingsSentence);
  assert.ok(seen.settings.ms < 1000, `${seen.settings.ms}`);
  assert.equal(seen.newer[0], null);
  assert.equal(seen.newer[1].code, 'contract_mismatch');
  assert.deepEqual(seen.older, ['control', false, null]);
  assert.equal(seen.extra[0], null);
  assert.equal(seen.extra[1].code, 'unavailable');
  assert.deepEqual(seen.aborted, { value: null });
});

test('a hello is matched on wire and Chord only: other or absent contracts are accepted, another wire or Chord is still refused with version, and contracts or a server that is not a string of at most 4096 characters is refused with version', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'hellos', async () => {
    await import('/dist-test/page.js');
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/agent-worker.js?answer=Hello.', { type: 'module' }),
    });
    const hellos = {
      other: { contracts: 'slicc.agent.control@0000000000000000' },
      absent: { contracts: undefined },
      longest: { contracts: 'x'.repeat(4096), server: 's'.repeat(4096) },
      extra: { padding: 'x'.repeat(100000) },
      wire: { wire: 3 },
      chord: { chord: 2 },
      oversize: { contracts: 'x'.repeat(4097) },
      huge: { contracts: 'x'.repeat(1000000) },
      number: { contracts: 1 },
      object: { contracts: { 'slicc.agent.control': 'x' } },
      array: { contracts: Array.from({ length: 100000 }, () => 'x') },
      empty: { contracts: null },
      server: { server: 's'.repeat(4097) },
      named: { server: 7 },
    };
    const result = {};
    for (const [name, hello] of Object.entries(hellos)) {
      result[name] = await openRawLink(await owner.port({ pages: false }), { hello }).then(
        async (link) => {
          const control = await link.hold('control');
          link.close();
          return control.variant;
        },
        (error) => error.reason
      );
    }
    await owner.release();
    return result;
  });
  assert.deepEqual(seen, {
    other: 'control',
    absent: 'control',
    longest: 'control',
    extra: 'control',
    wire: 'version',
    chord: 'version',
    oversize: 'version',
    huge: 'version',
    number: 'version',
    object: 'version',
    array: 'version',
    empty: 'version',
    server: 'version',
    named: 'version',
  });
});
