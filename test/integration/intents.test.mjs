import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const INTENT_DESCRIPTION =
  'What this call does, as 2–6 words starting with a present participle, in the user\'s language, such as "Backing up the dataset\'s access list". No credentials, secrets or command output.';

const bash = (args) => ({ tool: { name: 'bash', args } });
const code = (args) => ({ tool: { name: 'codemode', args } });
const answer = (text) => ({ answer: text });

const helpers = () => {
  window.write = async (path, text) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.boot = async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startTracked({
      worker: () =>
        (window.worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    window.local = await owner.connect();
    const hub = {
      minted: 0,
      async mint() {
        this.minted += 1;
        return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
      },
      async revoke() {},
    };
    window.model = createAgentModel(window.local, { guests: hub });
    window.agent = window.model.agent;
    await window.agent.ready();
    window.seen = new Map();
    const look = () => {
      for (const message of window.agent.messages('cone'))
        for (const part of message.parts ?? [])
          if (part.type === 'tool') {
            const titles = window.seen.get(part.tool.id) ?? [];
            if (titles.at(-1) !== part.tool.title) titles.push(part.tool.title);
            window.seen.set(part.tool.id, titles);
          }
    };
    window.agent.on('messages', look);
    window.agent.on('message', look);
    window.owner = owner;
  };
  window.tools = (agentId = 'cone') =>
    window.agent
      .messages(agentId)
      .filter((message) => message.role === 'assistant' && message.id !== 'live')
      .flatMap((message) => message.parts.filter((part) => part.type === 'tool'))
      .map((part) => part.tool);
  window.results = () =>
    (window.local.views.value?.cone?.entries ?? [])
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) =>
        (entry.model?.[0]?.content ?? [])
          .map((block) => block.text ?? '')
          .join('')
          .trim()
      );
  window.said = (agentId = 'cone') =>
    (window.local.views.value?.[agentId]?.entries ?? []).flatMap((entry) =>
      entry.kind === 'pi.assistant'
        ? (entry.model?.[0]?.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
        : []
    );
  window.until = (check, what) => when([changed, every(100)], check, what);
  window.guest = async () => {
    const minted = await window.model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    return window.owner
      .port({ guest: { id: minted.seat.id, label: 'Anna' } })
      .then(connectGuest)
      .then(track);
  };
  window.asked = () =>
    window.model.approvals.list().filter((approval) => approval.kind === 'guest-tool');
  window.decide = async (decision) => {
    const [first] = await window.until(
      () => window.asked().length && window.asked(),
      'a guest call to be asked'
    );
    const shown = { tool: first.tool, summary: first.summary, args: first.args };
    await window.model.approvals.decide(first.id, decision, null);
    await window.until(() => !window.asked().some((item) => item.id === first.id), 'the answer');
    return shown;
  };
  window.requests = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => resolve(data.map((text) => JSON.parse(text)));
      window.worker.postMessage({ requests: channel.port2 }, [channel.port2]);
    });
};

function queryOf(steps, extra = []) {
  const params = new URLSearchParams(extra);
  for (const step of steps) params.append('step', JSON.stringify(step));
  return params.toString();
}

async function boot(page, steps, { settings, extra } = {}) {
  await page.init(helpers);
  await page.goto('/');
  if (settings)
    await page.evaluate(
      (text) => window.write('/home/.pi/agent/settings.json', text),
      JSON.stringify(settings)
    );
  await staged(page, 'the intents agent', (query) => window.boot(query), queryOf(steps, extra));
}

const schemaOf = async (page) => {
  await page.evaluate(() => window.agent.send(window.agent.active(), 'Go.'));
  await page.within(60000, () => window.said().includes('Done.'));
  return page.evaluate(async () => {
    const [first] = await window.requests();
    const added = first.messages.flatMap((message) => message.toolsAdded ?? []);
    const pick = (name) => added.find((tool) => tool.name === name)?.parameters;
    return { bash: pick('bash'), codemode: pick('codemode') };
  });
};

test('bash and codemode offer an optional intent as their first property', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [answer('Done.')]);
  const on = await schemaOf(page);
  assert.deepEqual(Object.keys(on.bash.properties), ['intent', 'command', 'timeout']);
  assert.deepEqual(Object.keys(on.codemode.properties), ['intent', 'code']);
  for (const schema of [on.bash, on.codemode]) {
    assert.deepEqual(schema.properties.intent, {
      type: 'string',
      maxLength: 120,
      description: INTENT_DESCRIPTION,
    });
    assert.equal(schema.required.includes('intent'), false);
  }
});

test('"toolIntents": false in settings.json takes intent off the bash and codemode schemas', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [answer('Done.')], { settings: { toolIntents: false } });
  const off = await schemaOf(page);
  assert.deepEqual(Object.keys(off.bash.properties), ['command', 'timeout']);
  assert.deepEqual(Object.keys(off.codemode.properties), ['code']);
});

test("a trusted bash runs its command unchanged with SLICC_INTENT set and its title follows the intent as it streams, a codemode's nested bash inherits its intent unless it sets one, and a call with an intent makes no step label call", async (t) => {
  const page = await chrome.page(t);
  const long = `echo "[$SLICC_INTENT]" | cat # ${'x'.repeat(400)}`;
  const script = [
    'const inherited = await tools.bash({ command: \'echo "[$SLICC_INTENT]"\' });',
    'const own = await tools.bash({ intent: "Using its own", command: \'echo "[$SLICC_INTENT]"\' });',
    'return inherited.output.trim() + " " + own.output.trim();',
  ].join('\n');
  await boot(
    page,
    [
      bash({ intent: 'Printing the intent', command: long }),
      bash({ command: 'echo "[$SLICC_INTENT]" | cat' }),
      code({ intent: 'Checking the environment', code: script }),
      code({ code: 'return (await tools.bash({ command: \'echo "[$SLICC_INTENT]"\' })).output;' }),
      answer('Done.'),
    ],
    { extra: [['tps', '60']] }
  );
  const seen = await staged(page, 'a trusted bash runs its command', async () => {
    await window.agent.send(window.agent.active(), 'Go.');
    await when([changed, every(100)], () => window.said().includes('Done.'), 'the answer');
    const tools = window.tools();
    const labels = [];
    for (const tool of tools.slice(0, 3))
      labels.push(await window.agent.stepLabel('cone', tool.id));
    return {
      results: window.results(),
      titles: tools.map((tool) => tool.title),
      inputs: tools.map((tool) => tool.input),
      streamed: window.seen.get(tools[0].id),
      labels,
    };
  });
  assert.equal(seen.results[0], '[Printing the intent]');
  assert.equal(seen.results[1], '[]');
  assert.match(seen.results[2], /\n\[Checking the environment\] \[Using its own\]$/);
  assert.match(seen.results[3], /\n\[\]$/);
  assert.equal(seen.inputs[0], long);
  assert.deepEqual(seen.titles, [
    'Printing the intent',
    'Running echo and cat',
    'Checking the environment',
    'Running code',
  ]);
  const intent = 'Printing the intent';
  assert.equal(seen.streamed.at(-1), intent, JSON.stringify(seen.streamed));
  assert.ok(
    seen.streamed.some((title) => title !== intent && intent.startsWith(title)),
    JSON.stringify(seen.streamed)
  );
  assert.equal(
    seen.streamed.some((title) => title.startsWith('Running')),
    seen.streamed[0] === 'Running a command',
    JSON.stringify(seen.streamed)
  );
  assert.deepEqual(seen.labels, [null, 'Run echo "[$SLICC_INTENT]" | cat', null]);
});

test("a guest run's intent never shows: its title is the parsed one while it streams and after, its approval shows only the command, and it runs without SLICC_INTENT", async (t) => {
  const page = await chrome.page(t);
  const command = `echo "[$SLICC_INTENT]" # ${'x'.repeat(400)}`;
  await boot(
    page,
    [
      bash({ intent: 'Printing the owner intent', command }),
      answer('Owner done.'),
      bash({ intent: 'Reading the harmless docs', command }),
      answer('Guest done.'),
      code({ intent: 'Checking the guest script', code: 'return 1;' }),
      answer('Script done.'),
    ],
    { extra: [['tps', '60']] }
  );
  const seen = await staged(page, "a guest run's intent never shows", async () => {
    const until = (check, what) => when([changed, every(100)], check, what);
    await window.agent.send(window.agent.active(), 'Mine.');
    await until(() => window.said().includes('Owner done.'), 'the owner run');
    const minted = await window.model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    const guest = await window.owner
      .port({ guest: { id: minted.seat.id, label: 'Anna' } })
      .then(connectGuest)
      .then(track);
    const send = (text) =>
      guest.control.send({ text, whenBusy: 'followUp', requestId: null }, BACKGROUND_CONTEXT);
    const asked = () =>
      window.model.approvals.list().filter((approval) => approval.kind === 'guest-tool');
    const decide = async () => {
      const [first] = await until(() => asked().length && asked(), 'a guest call to be asked');
      const shown = { tool: first.tool, summary: first.summary, args: first.args };
      await window.model.approvals.decide(first.id, 'once', null);
      await until(() => !asked().some((item) => item.id === first.id), 'the answer');
      return shown;
    };
    await send('Read the docs.');
    const first = await decide();
    await until(() => window.said().includes('Guest done.'), 'the guest bash');
    await send('Run a script.');
    const second = await decide();
    await until(() => window.said().includes('Script done.'), 'the guest script');
    const tools = window.tools();
    const exposed = JSON.stringify(guest.transcript.value).includes('"intent"');
    await guest.close();
    return {
      exposed,
      asked: [first, second],
      results: window.results(),
      titles: tools.map((tool) => tool.title),
      streamed: tools.map((tool) => window.seen.get(tool.id)),
      inputs: tools.map((tool) => tool.input),
    };
  });
  assert.equal(seen.exposed, false);
  assert.deepEqual(seen.asked, [
    { tool: 'bash', summary: command, args: JSON.stringify({ command }, null, 2) },
    {
      tool: 'codemode',
      summary: 'return 1;',
      args: JSON.stringify({ code: 'return 1;' }, null, 2),
    },
  ]);
  assert.deepEqual(seen.results.slice(0, 2), ['[Printing the owner intent]', '[]']);
  assert.deepEqual(seen.titles, ['Printing the owner intent', 'Running echo', 'Running code']);
  assert.equal(seen.streamed[1].at(-1), 'Running echo', JSON.stringify(seen.streamed[1]));
  assert.ok(
    seen.streamed[1].every((title) => title.startsWith('Running')),
    JSON.stringify(seen.streamed[1])
  );
  assert.deepEqual(seen.streamed[2], ['Running code']);
  assert.equal(seen.inputs[2], JSON.stringify({ code: 'return 1;' }, null, 2));
});

test('"toolIntents": false still strips a call\'s intent: its title is the parsed one, it runs without SLICC_INTENT, and it gets a step label', async (t) => {
  const page = await chrome.page(t);
  await boot(
    page,
    [bash({ intent: 'Printing the intent', command: 'echo "[$SLICC_INTENT]"' }), answer('Done.')],
    { settings: { toolIntents: false } }
  );
  const seen = await staged(page, '"toolIntents": false still strips', async () => {
    await window.agent.send(window.agent.active(), 'Go.');
    await window.until(() => window.said().includes('Done.'), 'the answer');
    const [tool] = window.tools();
    return {
      results: window.results(),
      title: tool.title,
      label: await window.agent.stepLabel('cone', tool.id),
    };
  });
  assert.deepEqual(seen, {
    results: ['[]'],
    title: 'Running echo',
    label: 'Run echo "[$SLICC_INTENT]',
  });
});

test("a clean scoop's streamed call that a guest's taint gates before it runs shows the parsed title, also after a reload", async (t) => {
  const page = await chrome.page(t);
  const scoopCall = { intent: 'Reading notes', command: 'echo scoop-ran' };
  await boot(
    page,
    [
      bash({ command: "agent --async --name helper --prompt 'work'" }),
      answer('Started.'),
      bash({ command: 'agent rename $(agent list | cut -f1 | head -n1) Renamed' }),
      answer('Renamed.'),
    ],
    {
      extra: [
        ['scoop-step', JSON.stringify({ gate: 'scoop', tool: { name: 'bash', args: scoopCall } })],
        ['scoop-step', JSON.stringify({ answer: 'Scoop done.' })],
      ],
    }
  );
  const seen = await staged(page, "a clean scoop's streamed call", async () => {
    const scoop = 'scoop:helper';
    await window.agent.send(window.agent.active(), 'Start a helper.');
    await window.until(() => window.said().includes('Started.'), 'the helper');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const guest = await window.guest();
    await guest.control.send(
      { text: 'Rename it.', whenBusy: 'followUp', requestId: null },
      BACKGROUND_CONTEXT
    );
    const renamed = await window.decide('once');
    await window.until(() => window.said().includes('Renamed.'), 'the rename');
    await guest.close();
    window.worker.postMessage({ gate: 'scoop' });
    const asked = await window.decide('deny');
    await window.until(() => window.said(scoop).includes('Scoop done.'), 'the scoop answer');
    const title = window.tools(scoop).map((tool) => tool.title);
    const again = createAgentModel(await window.owner.connect()).agent;
    await again.ready();
    await window.until(
      () => again.messages(scoop).some((message) => message.role === 'assistant'),
      'the reloaded scoop'
    );
    const reloaded = again
      .messages(scoop)
      .flatMap((message) => (message.parts ?? []).filter((part) => part.type === 'tool'))
      .map((part) => part.tool.title);
    return { renamed: renamed.summary, asked: asked.summary, title, reloaded };
  });
  assert.equal(seen.renamed, 'agent rename $(agent list | cut -f1 | head -n1) Renamed');
  assert.equal(seen.asked, 'echo scoop-ran');
  assert.deepEqual(seen.title, ['Running echo']);
  assert.deepEqual(seen.reloaded, ['Running echo']);
});
