import assert from 'node:assert/strict';
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

const bash = (command) => ({ tool: { name: 'bash', args: { command } } });
const code = (source) => ({ tool: { name: 'codemode', args: { code: source } } });
const answer = (text) => ({ answer: text });
const refused = (reason) => `<harness>\n[error] Tool call blocked: ${reason}\n</harness>`;

async function boot(page, options = {}) {
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate(
    async ({ steps, later = [], judge = null, persist = null, files = {}, seed = null }) => {
      for (const [path, text] of Object.entries(files)) await window.write(path, text);
      if (seed) {
        const seeded = await new Promise((resolve) => {
          const worker = new Worker(`/dist-test/legacy-worker.js?${seed}`, { type: 'module' });
          worker.onmessage = ({ data }) => {
            worker.terminate();
            resolve(data);
          };
        });
        if (seeded.error) throw new Error(seeded.error);
      }
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      let lives = 0;
      let worker;
      const url = (list) =>
        `/dist-test/main-worker.js?${new URLSearchParams([
          ...(judge
            ? [['judge', ''], ...judge.map((step) => ['judge-step', JSON.stringify(step)])]
            : []),
          ...(persist ? [['persist', persist]] : []),
          ...list.map((step) => ['step', JSON.stringify(step)]),
        ])}`;
      const owner = await startAgent({
        worker: () => {
          lives += 1;
          worker = new Worker(url(lives === 1 ? steps : later), { type: 'module' });
          return worker;
        },
        kernel: { connect: () => kernel.connect() },
      });
      const until = async (check, what) => {
        for (let i = 0; i < 800; i++) {
          const value = await check();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`timed out waiting for ${what}`);
      };
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const hub = {
        minted: 0,
        async mint() {
          this.minted += 1;
          return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
        },
        async revoke() {},
      };
      const r = { owner, until, pause, hub };
      r.open = async () => {
        r.local = await owner.connect();
        r.model = createAgentModel(r.local, { guests: hub });
        await r.model.agent.ready();
        return r;
      };
      r.mint = async (tools, messages = 'off') => {
        const minted = await r.model.guests.mint('cone', {
          label: 'Anna',
          expiresAt: null,
          gates: { messages, tools },
        });
        return minted.seat.id;
      };
      r.join = (seat) => owner.port({ guest: { id: seat, label: 'Anna' } }).then(connectGuest);
      r.send = (guest, text, whenBusy = 'followUp') =>
        guest.control.send({ text, whenBusy, requestId: null }, BACKGROUND_CONTEXT);
      r.prompt = (text, whenBusy = 'followUp', agentId = 'cone') =>
        r.local.control.send({ text, whenBusy, requestId: null, agentId }, BACKGROUND_CONTEXT);
      r.entries = (agentId = 'cone') => r.local.views.value?.[agentId]?.entries ?? [];
      r.said = (agentId) =>
        r
          .entries(agentId)
          .flatMap((entry) =>
            entry.kind === 'pi.assistant'
              ? (entry.model?.[0]?.content ?? [])
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
              : []
          );
      r.results = (agentId) =>
        r
          .entries(agentId)
          .filter((entry) => entry.kind === 'pi.tool-result')
          .map((entry) =>
            (entry.model?.[0]?.content ?? [])
              .map((block) => block.text ?? '')
              .join('')
              .trim()
          );
      r.items = () => (r.local.approvals.value ?? []).filter((item) => item.kind === 'guest-tool');
      r.asked = () =>
        r.model.approvals
          .list()
          .filter((approval) => approval.kind === 'guest-tool')
          .map(({ id, tool, summary }) => ({ id, tool, summary }));
      r.decide = async (decision, reason) => {
        const [first] = await until(() => r.asked().length && r.asked(), 'a tool call to ask');
        await r.model.approvals.decide(first.id, decision, reason);
        await until(() => !r.asked().some((item) => item.id === first.id), 'the answer');
        return first;
      };
      r.when = (check, what, quietMs = 60_000) =>
        new Promise((resolve, reject) => {
          r.waiting = what;
          const offs = [];
          let done = false;
          let timer;
          const stop = (settle, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            for (const off of offs.splice(0)) off();
            settle(value);
          };
          const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              stop(
                reject,
                new Error(`no progress for ${Math.round(quietMs / 1000)} s waiting for ${what}`)
              );
            }, quietMs);
          };
          const look = () => {
            if (done || !offs.length) return;
            arm();
            const value = check();
            if (value) stop(resolve, value);
          };
          offs.push(
            r.local.views.subscribe(look),
            r.local.approvals.subscribe(look),
            r.model.approvals.on('approvals', look)
          );
          look();
          if (!done) arm();
        });
      r.ran = (agentId, path) =>
        until(() => r.results(agentId).at(-1)?.includes(path) && r.results(agentId).at(-1), path);
      globalThis.r = r;
    },
    options
  );
}

test('a guest run waits for the owner: an approved bash runs, a denied one never does and the model is told why, while the owner’s own run in the same cone is ungated', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    steps: [
      bash('echo owner-ran'),
      answer('Owner done.'),
      bash('echo guest-approved'),
      answer('Approved ran.'),
      bash('touch /tmp/guest-denied'),
      answer('Denied.'),
      bash('test -e /tmp/guest-denied && echo ran || echo never'),
      answer('Checked.'),
    ],
  });
  const seen = await page.evaluate(async () => {
    const { until, pause, open, mint, join, send, prompt, said, results, items, asked, decide } =
      globalThis.r;
    await open();
    const seat = await mint('user');
    await prompt('Run something.');
    await until(() => said().includes('Owner done.'), 'the owner run');
    const out = { ownerItems: items().length };
    const guest = await join(seat);
    await send(guest, 'Make a file.');
    await until(() => asked().length === 1, 'the first guest call to be asked');
    await pause(300);
    out.waiting = { asked: asked().map(({ tool, summary }) => ({ tool, summary })) };
    out.waiting.results = results().length;
    await decide('once');
    await until(() => said().includes('Approved ran.'), 'the approved run');
    await send(guest, 'Make another.');
    await decide('deny', 'Not now.');
    await until(() => said().includes('Denied.'), 'the denied run');
    await prompt('Check the file.');
    await until(() => said().includes('Checked.'), 'the owner check');
    out.said = said();
    out.results = results();
    out.states = items().map((item) => `${item.state}:${item.decidedBy}`);
    await guest.close();
    return out;
  });
  assert.equal(seen.ownerItems, 0);
  assert.deepEqual(seen.waiting, {
    asked: [{ tool: 'bash', summary: 'echo guest-approved' }],
    results: 1,
  });
  assert.deepEqual(seen.said, ['Owner done.', 'Approved ran.', 'Denied.', 'Checked.']);
  assert.equal(seen.results[0], 'owner-ran');
  assert.equal(seen.results[1], 'guest-approved');
  assert.equal(
    seen.results[2],
    refused('The owner declined this tool call in a run a guest started. Not now.')
  );
  assert.equal(seen.results[3], 'never');
  assert.deepEqual(seen.states, ['approved:owner', 'rejected:owner']);
});

test('a guest tool call shows its arguments in full as pretty JSON, and arguments over 64 KiB as a prefix marked truncated', async (t) => {
  const page = await chrome.page(t);
  const script = [
    'try {',
    "  await tools.bash({ command: 'x'.repeat(70000) });",
    '} catch (error) {',
    "  text('denied');",
    '}',
  ].join('\n');
  await boot(page, {
    steps: [bash(''), answer('Empty.'), code(script), answer('Long.')],
  });
  const seen = await page.evaluate(async () => {
    const { until, open, mint, join, send, said, decide } = globalThis.r;
    await open();
    const guest = await join(await mint('user'));
    const shown = () =>
      globalThis.r.model.approvals.list().filter((approval) => approval.kind === 'guest-tool');
    const look = () => {
      const [first] = shown();
      return {
        tool: first.tool,
        summary: first.summary,
        args: first.args,
        ...(first.argsTruncated ? { argsTruncated: true } : {}),
      };
    };
    await send(guest, 'Run nothing.');
    await until(() => shown().length === 1, 'the empty call to be asked');
    const empty = look();
    await decide('deny');
    await until(() => said().includes('Empty.'), 'the empty run');
    await send(guest, 'Run a long one.');
    await decide('once');
    await until(() => shown()[0]?.tool === 'bash', 'the long call to be asked');
    const long = look();
    await decide('deny');
    await until(() => said().includes('Long.'), 'the long run');
    await guest.close();
    return { empty, long };
  });
  assert.deepEqual(seen.empty, { tool: 'bash', summary: '', args: '{\n  "command": ""\n}' });
  const whole = JSON.stringify({ command: 'x'.repeat(70_000) }, null, 2);
  assert.equal(seen.long.args, whole.slice(0, 65_536));
  assert.equal(seen.long.argsTruncated, true);
  assert.equal(seen.long.summary.length, 2000);
});

test("a guest run's codemode script hits the same gate for each nested bash: one approved runs, one denied comes back blocked", async (t) => {
  const page = await chrome.page(t);
  const script = [
    'const ok = await tools.bash({ command: "echo nested-ok" });',
    'let denied;',
    'try {',
    '  denied = (await tools.bash({ command: "touch /tmp/nested-denied" })).output;',
    '} catch (error) {',
    '  denied = String(error.message ?? error);',
    '}',
    'text(ok.output.trim());',
    'text(denied);',
  ].join('\n');
  await boot(page, {
    steps: [
      code(script),
      answer('Scripted.'),
      bash('test -e /tmp/nested-denied && echo ran || echo never'),
      answer('Checked.'),
    ],
  });
  const seen = await page.evaluate(async () => {
    const { until, open, mint, join, send, prompt, said, results, decide } = globalThis.r;
    await open();
    const guest = await join(await mint('user'));
    await send(guest, 'Try a script.');
    const out = { asked: [] };
    for (const decision of ['once', 'once', 'deny']) {
      const asked = await decide(decision);
      out.asked.push(`${asked.tool}: ${asked.summary.split('\n')[0]}`);
    }
    await until(() => said().includes('Scripted.'), 'the script run');
    await prompt('Check the file.');
    await until(() => said().includes('Checked.'), 'the owner check');
    out.results = results();
    await guest.close();
    return out;
  });
  assert.deepEqual(seen.asked, [
    'codemode: const ok = await tools.bash({ command: "echo nested-ok" });',
    'bash: echo nested-ok',
    'bash: touch /tmp/nested-denied',
  ]);
  assert.match(seen.results[0], /nested-ok/);
  assert.match(
    seen.results[0],
    /Tool call blocked: The owner declined this tool call in a run a guest started\./
  );
  assert.equal(seen.results[1], 'never');
});

test('an owner steer into a guest run still leaves the run gated', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    steps: [bash('echo first'), bash('echo after-steer'), answer('Mixed.')],
  });
  const seen = await page.evaluate(async () => {
    const { until, pause, open, mint, join, send, prompt, said, results, asked, decide } =
      globalThis.r;
    const { local } = await open();
    const guest = await join(await mint('user'));
    await send(guest, 'Start something.');
    await until(() => asked().length === 1, 'the first guest call');
    await prompt('Then run another.', 'steer');
    await decide('once');
    await until(() => asked().length === 1, 'the call after the owner steer');
    await pause(300);
    const out = { waiting: results().length, asked: asked().map(({ summary }) => summary) };
    await decide('once');
    await until(() => said().includes('Mixed.'), 'the mixed run');
    out.results = results();
    await guest.close();
    return out;
  });
  assert.deepEqual(seen.asked, ['echo after-steer']);
  assert.equal(seen.waiting, 1);
  assert.deepEqual(seen.results, ['first', 'after-steer']);
});

test('a reload while a guest tool call waits rejoins the same review: it is asked once, and runs once approved', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    persist: `/.slicc/guest-tools-${Date.now()}`,
    steps: [bash('echo after-reload')],
    later: [answer('Reloaded.')],
  });
  const seen = await page.run(
    { label: 'a reload while a guest tool call waits', marker: () => globalThis.r.waiting ?? null },
    async () => {
      const r = globalThis.r;
      const { owner, when, pause, open, mint, join, send, said, results, items, asked } = r;
      r.waiting = 'the guest';
      await open();
      const guest = await join(await mint('user'));
      await send(guest, 'Run it.');
      await when(() => asked().length === 1, 'the call to be asked');
      const before = asked()[0].id;
      r.waiting = 'the reload';
      await r.local.close();
      await owner.restart();
      await open();
      await when(() => asked().length === 1, 'the call after the reload');
      r.waiting = 'a second ask';
      await pause(500);
      const [again] = asked();
      const out = { same: again.id === before, asked: asked().length, items: items().length };
      r.waiting = 'the decision';
      await r.model.approvals.decide(again.id, 'once');
      await when(() => said().includes('Reloaded.'), 'the run after the reload');
      out.results = results();
      out.after = items().map((item) => item.state);
      return out;
    }
  );
  assert.deepEqual(seen, {
    same: true,
    asked: 1,
    items: 1,
    results: ['after-reload'],
    after: ['approved'],
  });
});

test('aborting the conversation withdraws its waiting guest tool call, which never runs', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    steps: [
      bash('touch /tmp/guest-aborted'),
      bash('test -e /tmp/guest-aborted && echo ran || echo never'),
      answer('Checked.'),
    ],
  });
  const seen = await page.evaluate(async () => {
    const { until, open, mint, join, send, prompt, said, results, items, asked } = globalThis.r;
    const { local } = await open();
    const guest = await join(await mint('user'));
    await send(guest, 'Make a file.');
    await until(() => asked().length === 1, 'the call to be asked');
    await local.control.abort(BACKGROUND_CONTEXT);
    await until(() => items()[0]?.state !== 'pending', 'the item to end');
    const out = { item: `${items()[0].state}:${items()[0].reason}`, asked: asked().length };
    await prompt('Check the file.');
    await until(() => said().includes('Checked.'), 'the owner check');
    out.last = results().at(-1);
    await guest.close();
    return out;
  });
  assert.deepEqual(seen, { item: 'withdrawn:aborted', asked: 0, last: 'never' });
});

test('with the judge as the tools gate, the judge allows a call that fits the owner’s intent and declines a risky one, without asking the owner', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    judge: [
      { low: 0.97, aligned: 0.95 },
      { low: 0.03, aligned: 0.05 },
    ],
    steps: [
      answer('Noted.'),
      bash('echo judged-ok'),
      bash('touch /tmp/judged-denied'),
      answer('Judged.'),
    ],
    files: {
      '/home/.pi/agent/settings.json': JSON.stringify({ approvals: { judgeModel: 'judge/j-1' } }),
    },
  });
  const seen = await page.evaluate(async () => {
    const { until, open, mint, join, send, prompt, said, results, items } = globalThis.r;
    const { model } = await open();
    const seat = await mint('agent');
    await prompt('Only run echo commands today.');
    await until(() => said().includes('Noted.'), 'the owner turn');
    const guest = await join(seat);
    await send(guest, 'Run things.');
    let shown = 0;
    await until(() => {
      shown = Math.max(shown, model.approvals.list().length);
      return said().includes('Judged.');
    }, 'the judged run');
    const out = {
      shown,
      results: results(),
      states: items().map((item) => `${item.state}:${item.decidedBy}`),
    };
    await guest.close();
    return out;
  });
  assert.equal(seen.shown, 0);
  assert.equal(seen.results[0], 'judged-ok');
  assert.equal(
    seen.results[1],
    refused(
      'The automatic check declined this tool call in a run a guest started: it looks high-risk.'
    )
  );
  assert.deepEqual(seen.states, ['approved:judge', 'rejected:judge']);
});

test('a seat whose tools gate this agent does not know gets every tool call in its runs denied, without asking anyone', async (t) => {
  const page = await chrome.page(t);
  const directory = `/.slicc/guest-unknown-${Date.now()}`;
  const seat = {
    id: 'seat-old',
    label: 'Anna',
    agentId: 'cone',
    expiresAt: null,
    gates: { messages: 'off', tools: 'council' },
    createdAt: Date.now(),
    epoch: 1,
    revoked: null,
  };
  await boot(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['seat', JSON.stringify(seat)],
    ]).toString(),
    steps: [
      bash('touch /tmp/guest-unknown'),
      bash('test -e /tmp/guest-unknown && echo ran || echo never'),
      answer('Checked.'),
    ],
  });
  const seen = await page.evaluate(async () => {
    const { until, open, join, send, said, results, items } = globalThis.r;
    await open();
    const guest = await join('seat-old');
    await send(guest, 'Make a file.');
    await until(() => said().includes('Checked.'), 'the guest run');
    const out = { results: results(), items: items().length };
    await guest.close();
    return out;
  });
  assert.deepEqual(seen.results, [
    refused(
      'A guest started this run, and its seat names no review for tool calls that this agent knows.'
    ),
    refused(
      'A guest started this run, and its seat names no review for tool calls that this agent knows.'
    ),
  ]);
  assert.equal(seen.items, 0);
});

test('a guest seat with tools off is refused until the owner allows it, then its runs use tools unasked, and taking off back denies them again', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    steps: [bash('echo guest-free'), answer('Free.'), bash('echo guest-again'), answer('Again.')],
  });
  const seen = await page.evaluate(async () => {
    const { until, open, mint, join, send, said, results, items } = globalThis.r;
    const { local } = await open();
    const out = {};
    out.refused = await mint('off').then(
      () => 'minted',
      (error) => error.message
    );
    const set = (allowedToolGates) =>
      local.control.approvalPolicySet({ guests: { allowedToolGates } }, BACKGROUND_CONTEXT);
    await set(['user', 'agent', 'scoop', 'off']);
    const guest = await join(await mint('off'));
    await send(guest, 'Run freely.');
    await until(() => said().includes('Free.'), 'the free run');
    await set(['user', 'agent', 'scoop']);
    await send(guest, 'Run again.');
    await until(() => said().includes('Again.'), 'the second run');
    out.results = results();
    out.items = items().length;
    await guest.close();
    return out;
  });
  assert.equal(
    seen.refused,
    "A guest's tool calls need a review: by a person, the judge or a scoop."
  );
  assert.deepEqual(seen.results, [
    'guest-free',
    refused("A guest's tool calls need a review: by a person, the judge or a scoop."),
  ]);
  assert.equal(seen.items, 0);
});

test('Always on a guest tool call, once the policy offers it, lets only that exact call from that seat through unasked, until the owner forgets it', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    steps: [
      bash('echo always'),
      answer('One.'),
      bash('echo always'),
      bash('echo other'),
      answer('Two.'),
      bash('echo always'),
      answer('Three.'),
      bash('echo always'),
      answer('Four.'),
    ],
  });
  const seen = await page.evaluate(async () => {
    const { until, open, mint, join, send, said, results, asked } = globalThis.r;
    const { local, model } = await open();
    const ctx = BACKGROUND_CONTEXT;
    const out = {};
    const seat = await mint('user');
    const guest = await join(seat);
    const first = async (what) => (await until(() => asked().length && asked(), what))[0];
    await send(guest, 'First.');
    const offered = await first('the first call');
    out.notOffered = (await local.control.decide(offered.id, 'always', null, ctx)).error;
    await local.control.approvalPolicySet({ guests: { always: { tools: true } } }, ctx);
    await local.control.decide(offered.id, 'deny', null, ctx);
    await until(() => said().includes('One.'), 'the first run');
    await send(guest, 'Second.');
    const always = await first('the always call');
    out.always = (await local.control.decide(always.id, 'always', null, ctx)).state;
    const other = await until(
      () => asked().find((item) => item.id !== always.id),
      'the other call'
    );
    out.other = other.summary;
    await model.approvals.decide(other.id, 'once');
    await until(() => said().includes('Two.'), 'the second run');
    const rules = () => local.guests.value.find((entry) => entry.id === seat).alwaysTools;
    out.rules = rules().map(({ tool, arguments: args }) => `${tool} ${args}`);
    let shown = 0;
    await send(guest, 'Third.');
    await until(() => {
      shown = Math.max(shown, asked().length);
      return said().includes('Three.');
    }, 'the third run');
    out.shownThird = shown;
    out.forgot = await local.control.guestAlwaysForget(seat, rules()[0].approval, ctx);
    await until(() => rules().length === 0, 'the rule to go');
    await send(guest, 'Fourth.');
    const again = await first('the call after forgetting');
    out.again = again.summary;
    await model.approvals.decide(again.id, 'once');
    await until(() => said().includes('Four.'), 'the fourth run');
    out.results = results();
    await guest.close();
    return out;
  });
  assert.equal(seen.notOffered, "Always isn't offered for this request.");
  assert.equal(seen.always, 'approved');
  assert.equal(seen.other, 'echo other');
  assert.deepEqual(seen.rules, ['bash {"command":"echo always"}']);
  assert.equal(seen.shownThird, 0);
  assert.deepEqual(seen.forgot, { removed: true });
  assert.equal(seen.again, 'echo always');
  assert.deepEqual(seen.results, [
    refused('The owner declined this tool call in a run a guest started.'),
    'always',
    'other',
    'always',
    'always',
  ]);
});

test('the guest tool call dialog offers Always allow only while the policy does, and Always there records that exact call on the seat', async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await boot(page, {
    steps: [bash('echo always'), answer('One.'), bash('echo always'), answer('Two.')],
  });
  const seen = await page.evaluate(async () => {
    const { until, pause, open, mint, join, send, said, results } = globalThis.r;
    const { local, model } = await open();
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    const app = document.createElement('slicc-app');
    app.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.style.margin = '0';
    document.body.append(app);
    const dummy = createDummyModel({ storage: localStorage });
    delete dummy.notices;
    delete dummy.tabs;
    delete dummy.approvals;
    app.model = { ...dummy, ...model };
    await customElements.whenDefined('slicc-app');
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          const inner = find(node.shadowRoot, selector);
          if (inner) return inner;
        }
      return null;
    };
    const dialog = () => find(document, 'dialog[data-approval][data-kind="guest-tool"]');
    const click = async (action) => {
      await pause(600);
      dialog().querySelector(`[data-action="${action}"]`).click();
      await until(() => !dialog(), 'the dialog to close');
    };
    const shown = async () => {
      await until(() => dialog()?.querySelector('[data-action="once"]'), 'the whole request seen');
      return {
        always: Boolean(dialog().querySelector('[data-action="always"]')),
        text: dialog().textContent.replace(/\s+/g, ' '),
      };
    };
    const seat = await mint('user');
    const guest = await join(seat);
    await send(guest, 'First.');
    await until(dialog, 'the first dialog');
    const off = await shown();
    await click('deny');
    await until(() => said().includes('One.'), 'the first run');
    await local.control.approvalPolicySet(
      { guests: { always: { tools: true } } },
      BACKGROUND_CONTEXT
    );
    await send(guest, 'Second.');
    await until(dialog, 'the second dialog');
    const on = await shown();
    await click('always');
    await until(() => said().includes('Two.'), 'the second run');
    const record = local.guests.value.find((entry) => entry.id === seat);
    const rules = record.alwaysTools.map(({ tool, arguments: args }) => `${tool} ${args}`);
    const answers = local.approvals.value
      .filter((item) => item.kind === 'guest-tool')
      .map((item) => [item.always, item.state, item.answer ?? null]);
    const out = { off, on, rules, answers, results: results() };
    await guest.close();
    return out;
  });
  assert.equal(seen.off.always, false, 'no Always while the policy is off');
  assert.equal(seen.on.always, true, 'Always once the policy offers it');
  assert.match(seen.on.text, /run exactly this bash call for Anna without asking again/);
  assert.deepEqual(seen.rules, ['bash {"command":"echo always"}']);
  assert.deepEqual(seen.answers, [
    [false, 'rejected', null],
    [true, 'approved', 'always'],
  ]);
  assert.deepEqual(seen.results, [
    refused('The owner declined this tool call in a run a guest started.'),
    'always',
  ]);
});

test('the gate reaches a conversation stored before it existed, also forked and frozen then thawed', async (t) => {
  const page = await chrome.page(t);
  const directory = `/.slicc/guest-old-${Date.now()}`;
  await boot(page, {
    persist: directory,
    seed: new URLSearchParams([
      ['directory', directory],
      ['without', 'slicc-guest-guard'],
    ]).toString(),
    steps: [
      bash('echo old'),
      answer('Old.'),
      bash('echo forked'),
      answer('Forked.'),
      bash('echo thawed'),
      answer('Thawed.'),
    ],
  });
  const seen = await page.evaluate(async () => {
    const { until, open, mint, join, send, said, decide, entries } = globalThis.r;
    const { local } = await open();
    const ctx = BACKGROUND_CONTEXT;
    await until(() => entries().length, 'the old cone');
    const guest = await join(await mint('user'));
    const out = { asked: [] };
    const gated = async (text, answer) => {
      await send(guest, text);
      out.asked.push((await decide('once')).summary);
      await until(() => said().includes(answer), answer);
    };
    await gated('Old one.', 'Old.');
    const answers = entries().filter((entry) => entry.kind === 'pi.assistant');
    await local.control.rewindAgent('cone', `e${answers[1].id}`, ctx);
    await until(() => entries().some((entry) => entry.kind === 'slicc.rewound'), 'the fork');
    await gated('Forked one.', 'Forked.');
    const frozen = await local.control.freeze('cone', ctx);
    await until(() => !local.views.value?.cone, 'the frozen cone');
    await local.control.thaw(frozen.id, ctx);
    await until(() => local.views.value?.cone, 'the thawed cone');
    await gated('Thawed one.', 'Thawed.');
    await guest.close();
    return out;
  });
  assert.deepEqual(seen.asked, ['echo old', 'echo forked', 'echo thawed']);
});
