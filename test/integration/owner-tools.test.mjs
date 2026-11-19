import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = (command) => ({ tool: { name: 'bash', args: { command } } });
const code = (source) => ({ tool: { name: 'codemode', args: { code: source } } });
const answer = (text) => ({ answer: text });
const refused = (reason) => `<harness>\n[error] Tool call blocked: ${reason}\n</harness>`;

async function boot(page, options = {}) {
  await page.goto('/');
  await staged(
    page,
    'the owner-tools agent',
    async ({ steps, judge = null, settings = null }) => {
      if (settings) {
        let dir = await navigator.storage.getDirectory();
        for (const part of ['home', '.pi', 'agent'])
          dir = await dir.getDirectoryHandle(part, { create: true });
        const file = await dir.getFileHandle('settings.json', { create: true });
        const writable = await file.createWritable();
        await writable.write(JSON.stringify(settings));
        await writable.close();
      }
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      let worker;
      const url = `/dist-test/main-worker.js?${new URLSearchParams([
        ...(judge
          ? [['judge', ''], ...judge.map((step) => ['judge-step', JSON.stringify(step)])]
          : []),
        ...steps.map((step) => ['step', JSON.stringify(step)]),
      ])}`;
      const owner = await startTracked({
        worker: () => {
          worker = new Worker(url, { type: 'module' });
          return worker;
        },
        kernel: { connect: () => kernel.connect() },
      });
      const until = (check, what) => when([changed, every(100)], check, what);
      const r = { owner, until, gate: (name) => worker.postMessage({ gate: name }) };
      r.stored = () =>
        new Promise((resolve) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = ({ data }) => resolve(data);
          worker.postMessage({ items: port2 }, [port2]);
        });
      r.open = async () => {
        r.local = await owner.connect();
        r.model = createAgentModel(r.local);
        await r.model.agent.ready();
        return r;
      };
      r.policy = (tools) =>
        r.local.control.approvalPolicySet({ owner: { tools } }, BACKGROUND_CONTEXT);
      r.prompt = (text) =>
        r.local.control.send(
          { text, whenBusy: 'followUp', requestId: null, agentId: 'cone' },
          BACKGROUND_CONTEXT
        );
      r.entries = () => r.local.views.value?.cone?.entries ?? [];
      r.said = () =>
        r
          .entries()
          .flatMap((entry) =>
            entry.kind === 'pi.assistant'
              ? (entry.model?.[0]?.content ?? [])
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
              : []
          );
      r.results = () =>
        r
          .entries()
          .filter((entry) => entry.kind === 'pi.tool-result')
          .map((entry) =>
            (entry.model?.[0]?.content ?? [])
              .map((block) => block.text ?? '')
              .join('')
              .trim()
          );
      r.items = () => (r.local.approvals.value ?? []).filter((item) => item.kind === 'owner-tool');
      r.asked = () => r.model.approvals.list().filter((approval) => approval.kind === 'guest-tool');
      r.decide = async (decision, reason) => {
        const [first] = await until(() => r.asked().length && r.asked(), 'a tool call to ask');
        await r.model.approvals.decide(first.id, decision, reason);
        await until(() => !r.asked().some((item) => item.id === first.id), 'the answer');
        return first;
      };
      globalThis.r = r;
    },
    options
  );
}

test("with owner.tools off the owner's tool calls file nothing; with user each waits for a person: once runs it, deny returns the denial to the model, and always lets that exact call through until it is forgotten", async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    steps: [
      bash('echo free'),
      answer('Free.'),
      bash('echo once-ran'),
      bash('touch /tmp/owner-denied'),
      bash('echo always'),
      answer('One.'),
      bash('echo always'),
      answer('Two.'),
    ],
  });
  const seen = await staged(page, 'owner tool calls wait', async () => {
    const { until, open, policy, prompt, said, results, items, asked, decide } = globalThis.r;
    const { local } = await open();
    const ctx = BACKGROUND_CONTEXT;
    const out = { policy: local.approvalPolicy.value.owner };
    await prompt('Run freely.');
    await until(() => said().includes('Free.'), 'the ungated run');
    out.offItems = items().length;
    out.bad = (await policy('sometimes')).error;
    out.set = (await policy('user')).policy.owner;
    await prompt('Run things.');
    const [first] = await until(() => asked().length && asked(), 'the first call');
    const { id, tool, summary, args, always, agentName, requester } = first;
    out.first = { tool, summary, args, always, agentName, requester };
    const item = items().find((entry) => entry.id === id);
    out.item = {
      requester: item.requester,
      tier: item.tier,
      detail: { tool: item.detail.tool, summary: item.detail.summary, args: item.detail.arguments },
    };
    out.waiting = results().length;
    await decide('once');
    await decide('deny', 'Not now.');
    await decide('always');
    await until(() => said().includes('One.'), 'the first run');
    let shown = 0;
    await prompt('Again.');
    await until(() => {
      shown = Math.max(shown, asked().length);
      return said().includes('Two.');
    }, 'the second run');
    out.shownAgain = shown;
    const rules = await local.control.ownerAlways(ctx);
    out.rules = rules.map((rule) => `${rule.tool} ${rule.arguments}`);
    out.forgot = await local.control.ownerAlwaysForget(rules[0].approval, ctx);
    out.after = (await local.control.ownerAlways(ctx)).length;
    out.results = results();
    out.states = items().map((entry) => `${entry.state}:${entry.decidedBy}:${entry.answer ?? ''}`);
    return out;
  });
  assert.deepEqual(seen.policy, { tools: 'off' });
  assert.equal(seen.offItems, 0);
  assert.equal(seen.bad, "The owner's tool calls are reviewed by off, user or agent.");
  assert.deepEqual(seen.set, { tools: 'user' });
  assert.deepEqual(seen.first, {
    tool: 'bash',
    summary: 'echo once-ran',
    args: '{\n  "command": "echo once-ran"\n}',
    always: true,
    agentName: 'sliccy',
    requester: { kind: 'agent', name: 'you', agentId: 'cone' },
  });
  assert.deepEqual(seen.item, {
    requester: { kind: 'agent', name: 'sliccy', agentId: 'cone' },
    tier: 'user',
    detail: { tool: 'bash', summary: 'echo once-ran', args: '{"command":"echo once-ran"}' },
  });
  assert.equal(seen.waiting, 1);
  assert.equal(seen.shownAgain, 0);
  assert.deepEqual(seen.rules, ['bash {"command":"echo always"}']);
  assert.deepEqual(seen.forgot, { removed: true });
  assert.equal(seen.after, 0);
  assert.deepEqual(seen.results, [
    'free',
    'once-ran',
    refused('The owner declined this tool call. Not now.'),
    'always',
    'always',
  ]);
  assert.deepEqual(seen.states, [
    'approved:owner:once',
    'rejected:owner:',
    'approved:owner:always',
  ]);
});

test('with owner.tools agent and nobody there, the judge allows a level 1 call that fits the owner’s intent and denies a level 3 one with its reason', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    judge: [
      { low: 0.97, aligned: 0.95 },
      { low: 0.03, aligned: 0.05 },
    ],
    settings: { approvals: { judgeModel: 'judge/j-1' } },
    steps: [
      { gate: 'go', ...bash('echo judged-ok') },
      bash('rm -rf /tmp/owner-work'),
      answer('Judged.'),
    ],
  });
  const seen = await staged(page, 'the judge answers owner calls', async () => {
    const { until, open, policy, prompt, said, results, items, stored, gate } = globalThis.r;
    await open();
    await policy('agent');
    await prompt('Echo something.');
    await globalThis.r.local.close();
    gate('go');
    await until(async () => {
      const tools = (await stored()).filter((item) => item.kind === 'owner-tool');
      return tools.length === 2 && tools.every((item) => item.state !== 'pending');
    }, 'both calls to be judged');
    await open();
    await until(() => said().includes('Judged.'), 'the judged run');
    return {
      results: results(),
      states: items().map((item) => `${item.state}:${item.decidedBy}:${item.verdict?.level}`),
    };
  });
  assert.deepEqual(seen.results, [
    'judged-ok',
    refused(
      'The automatic check declined this tool call: It could harm the system or the work in a way that is hard to undo.'
    ),
  ]);
  assert.deepEqual(seen.states, ['approved:judge:1', 'rejected:judge:3']);
});

test("with owner.tools user an approved codemode script's own calls run unasked while it runs, a later direct call is asked again, Always records only the codemode rule, a denied script runs nothing, and off files nothing", async (t) => {
  const page = await chrome.page(t);
  const two = (a, b) =>
    [
      `const a = await tools.bash({ command: "echo ${a}" });`,
      `const b = await tools.bash({ command: "echo ${b}" });`,
      'text(`${a.output.trim()} ${b.output.trim()}`);',
    ].join('\n');
  await boot(page, {
    steps: [
      code(two('off-one', 'off-two')),
      answer('Free.'),
      code(two('inner-one', 'inner-two')),
      bash('echo inner-one'),
      code(two('kept-one', 'kept-two')),
      code('await tools.bash({ command: "touch /tmp/owner-script-denied" });'),
      bash('test -e /tmp/owner-script-denied && echo ran || echo never'),
      answer('Scripted.'),
    ],
  });
  const seen = await staged(page, 'an approved codemode script covers its calls', async () => {
    const { until, open, policy, prompt, said, results, items, decide } = globalThis.r;
    const { local } = await open();
    const out = {};
    await prompt('Script freely.');
    await until(() => said().includes('Free.'), 'the ungated script');
    out.offItems = items().length;
    await policy('user');
    await prompt('Script things.');
    out.asked = [];
    for (const decision of ['once', 'once', 'always', 'deny', 'once']) {
      const asked = await decide(decision);
      out.asked.push(`${asked.tool}: ${asked.summary.split('\n')[0]}`);
    }
    await until(() => said().includes('Scripted.'), 'the scripted run');
    out.items = items().map((item) => `${item.detail.tool}:${item.state}`);
    out.rules = (await local.control.ownerAlways(BACKGROUND_CONTEXT)).map((rule) => rule.tool);
    out.results = results();
    return out;
  });
  assert.equal(seen.offItems, 0);
  assert.deepEqual(seen.asked, [
    'codemode: const a = await tools.bash({ command: "echo inner-one" });',
    'bash: echo inner-one',
    'codemode: const a = await tools.bash({ command: "echo kept-one" });',
    'codemode: await tools.bash({ command: "touch /tmp/owner-script-denied" });',
    'bash: test -e /tmp/owner-script-denied && echo ran || echo never',
  ]);
  assert.deepEqual(seen.items, [
    'codemode:approved',
    'bash:approved',
    'codemode:approved',
    'codemode:rejected',
    'bash:approved',
  ]);
  assert.deepEqual(seen.rules, ['codemode']);
  assert.equal(seen.results.length, 6);
  assert.match(seen.results[0], /off-one off-two/);
  assert.match(seen.results[1], /inner-one inner-two/);
  assert.equal(seen.results[2], 'inner-one');
  assert.match(seen.results[3], /kept-one kept-two/);
  assert.equal(seen.results[4], refused('The owner declined this tool call.'));
  assert.equal(seen.results[5], 'never');
});
