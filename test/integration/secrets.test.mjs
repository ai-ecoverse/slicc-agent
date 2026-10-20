import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { compile } from '@ai-ecoverse/slicc-scrub';
import vectors from '@ai-ecoverse/slicc-scrub/vectors.json' with { type: 'json' };
import { launch } from './chrome.mjs';
import { seeded } from './fixtures/seeds.mjs';

const seeds = seeded(vectors);
const scrubber = compile(seeds.values);
const leaks = (text) => scrubber.text(text).hits;
const [alpha, beta, gamma] = seeds.values.map((item) => item.value);
const split = (value) => (value.match(/.{1,10}/gu) ?? []).map((part) => `'${part}'`).join('');

const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.json': 'application/json' };
const scrubPackage = new URL('../../node_modules/@ai-ecoverse/slicc-scrub/', import.meta.url);
const served = {
  'vault.html': new URL('./fixtures/vault.html', import.meta.url),
  'fake-vault.mjs': new URL('./fixtures/fake-vault.mjs', import.meta.url),
  'seeds.mjs': new URL('./fixtures/seeds.mjs', import.meta.url),
  'slicc-scrub.mjs': new URL('dist/index.js', scrubPackage),
  'vectors.json': new URL('vectors.json', scrubPackage),
};
const vaultServer = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://vault').pathname.slice(1);
  const file = Object.hasOwn(served, name) ? served[name] : undefined;
  const read = file ? await readFile(file, 'utf8').catch(() => null) : null;
  const body = read?.replace("'@ai-ecoverse/slicc-scrub'", "'./slicc-scrub.mjs'");
  if (!body) return response.writeHead(404).end();
  response
    .writeHead(200, {
      'content-type': types[extname(name)],
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    })
    .end(body);
});
await new Promise((resolve) => vaultServer.listen(0, '127.0.0.1', resolve));
const vaultOrigin = `http://localhost:${vaultServer.address().port}`;

const chrome = await launch();
after(async () => {
  await chrome.close();
  await new Promise((resolve) => vaultServer.close(resolve));
});

const captured = [];
afterEach(() => {
  assert.ok(captured.length > 0);
  for (const { what, text } of captured) assert.deepEqual(leaks(text), [], what);
});

const helpers = () => {
  window.write = async (path, text) => {
    let handle = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) handle = await handle.getDirectoryHandle(part, { create: true });
    const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.read = async (path) => {
    let handle = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) handle = await handle.getDirectoryHandle(part);
    return (await (await handle.getFileHandle(name)).getFile()).text();
  };
  window.withVault = async (origin, steps) => {
    const frame = document.createElement('iframe');
    frame.src = `${origin}/vault.html`;
    const loaded = new Promise((resolve) => {
      addEventListener('message', function onLoaded({ data }) {
        if (!data?.loaded) return;
        removeEventListener('message', onLoaded);
        resolve();
      });
    });
    document.body.append(frame);
    await loaded;
    const { port1, port2 } = new MessageChannel();
    const ready = new Promise((resolve) => {
      addEventListener('message', function onReady({ data }) {
        if (!data?.ready) return;
        removeEventListener('message', onReady);
        resolve(data.pair);
      });
    });
    frame.contentWindow.postMessage({ role: 'agent' }, origin, [port2]);
    const pair = await ready;
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
    let worker;
    const owner = await startAgent({
      worker: () => {
        worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' });
        worker.postMessage({ vault: port1, scrub: pair }, [port1]);
        return worker;
      },
      kernel: { connect: () => kernel.connect() },
    });
    const requests = async () => {
      const channel = new MessageChannel();
      const answer = new Promise((resolve) => {
        channel.port1.onmessage = ({ data }) => resolve(data);
      });
      worker.postMessage({ requests: channel.port2 }, [channel.port2]);
      return answer;
    };
    return { owner, connection: await owner.connect(), requests };
  };
};

test('secrets: bash, read, codemode, a user send, memory, a lick and compaction all reach the model scrubbed', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seeded = `${alpha}\n${beta}\n${gamma}\n`;
  const command = `cat /home/seeded.txt; base64 /home/seeded.txt; xxd -p /home/seeded.txt; printf '%s' ${split(beta)} | basenc --base16 -w 0; echo; printf '%s' ${split(alpha)}`;
  const steps = [
    { tool: { name: 'bash', args: { command } } },
    { tool: { name: 'read', args: { path: '/home/seeded.txt' } } },
    {
      tool: {
        name: 'codemode',
        args: {
          code: 'const out = await tools.bash({ command: "cat /home/seeded.txt" });\ntext(out.output);',
        },
      },
    },
    { answer: 'Done.' },
    { answer: 'Lick seen.' },
    { answer: 'Summary.' },
    { answer: 'Spare.' },
    { answer: 'Spare.' },
  ];
  const seen = await page.evaluate(
    async ({ origin, steps, seeded, alpha, beta }) => {
      await window.write('/home/seeded.txt', seeded);
      await window.write('/home/.slicc/webhooks/build.json', '{"message":"The build finished"}');
      const { owner, connection, requests } = await window.withVault(origin, steps);
      const answer = await connection.prompt(`Look at the seeded file; my key is ${alpha}.`);
      await connection.control.memorySave(
        {
          id: null,
          scope: 'cone',
          section: 'Keys',
          title: 'beta',
          body: `remember ${beta}`,
          tag: 'project',
        },
        BACKGROUND_CONTEXT
      );
      await connection.control.webhook(
        'build',
        { id: 'w1', headers: { 'x-event': 'done' }, body: JSON.stringify({ token: alpha }) },
        BACKGROUND_CONTEXT
      );
      const until = async (check) => {
        for (let n = 0; n < 300 && !check(); n++)
          await new Promise((resolve) => setTimeout(resolve, 50));
        return check();
      };
      await until(
        () =>
          connection.transcript.value.entries.filter((entry) => entry.kind === 'pi.assistant')
            .length >= 5
      );
      await connection.control.compact(null, BACKGROUND_CONTEXT);
      await until(() =>
        connection.transcript.value.entries.some((entry) => entry.kind === 'pi.compaction')
      );
      const memory = await window.read('/home/.pi/agent/memory/cone/MEMORY.md');
      const result = {
        answer,
        vault: connection.vault.value,
        entries: JSON.stringify(connection.transcript.value.entries),
        docs: JSON.stringify(connection.transcript.value.docs),
        memory,
        requests: await requests(),
      };
      await owner.release();
      return result;
    },
    { origin: vaultOrigin, steps, seeded, alpha, beta }
  );
  captured.push(
    ...seen.requests.map((text, at) => ({ what: `request ${at}`, text })),
    { what: 'entries', text: seen.entries },
    { what: 'live slots and documents', text: seen.docs },
    { what: 'memory', text: seen.memory }
  );
  assert.equal(seen.answer, 'Done.');
  assert.deepEqual(seen.vault, { port: 'ready', needed: true, version: 1, locked: 'no', held: 0 });
  for (const shown of [
    'fnox_proxy_000000000000000000000001',
    'fnox_proxy_000000000000000000000004',
    '[redacted:UNI_KEY]',
    '[redacted:GH_TOKEN]',
  ])
    assert.ok(seen.entries.includes(shown), shown);
  assert.ok(seen.memory.includes('remember fnox_proxy_000000000000000000000004'));
  assert.ok(seen.requests.length >= 5);
});

test('secrets: with no vault the agent is unchanged, and /secrets answers locally', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const params = new URLSearchParams([['answer', 'Plain.']]);
    let worker;
    const owner = await startAgent({
      worker: () =>
        (worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const answer = await connection.prompt('Say something.');
    await connection.control.send(
      { text: '/secrets', whenBusy: 'steer', requestId: null },
      BACKGROUND_CONTEXT
    );
    for (
      let n = 0;
      n < 100 &&
      !connection.transcript.value.entries.some((entry) => entry.kind === 'slicc.secrets');
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = connection.transcript.value.entries.find(
      (entry) => entry.kind === 'slicc.secrets'
    );
    const channel = new MessageChannel();
    const requests = new Promise((resolve) => {
      channel.port1.onmessage = ({ data }) => resolve(data);
    });
    worker.postMessage({ requests: channel.port2 }, [channel.port2]);
    const result = {
      answer,
      vault: connection.vault.value,
      listed: listed?.model[0].content,
      requests: await requests,
    };
    await owner.release();
    return result;
  });
  captured.push(...seen.requests.map((text, at) => ({ what: `plain request ${at}`, text })));
  assert.equal(seen.answer, 'Plain.');
  assert.deepEqual(seen.vault, { port: 'none', needed: false, version: 0, locked: 'no', held: 0 });
  assert.match(
    seen.listed,
    /^Secrets are unavailable: fnox isn't installed; the vault refused to list secrets \(ENOTCONN\)\.$/
  );
});

test('secrets: a model call goes out prepared by the vault, with the key filled in and the body scrubbed', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const key = 'e2e-model-key-0001';
  const record = {
    kind: 'model',
    name: 'ADOBE_IMS_TOKEN',
    provider: 'adobe',
    placeholder: 'fnox_proxy_adobe',
    value: key,
  };
  const query = [
    'relay=mcp.test',
    'e2e',
    'vault',
    'scrub',
    `record=${encodeURIComponent(JSON.stringify(record))}`,
  ].join('&');
  const seen = await page.evaluate(
    async ({ query, alpha }) => {
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      let worker;
      const owner = await startAgent({
        worker: () =>
          (worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
        kernel: { connect: () => kernel.connect() },
      });
      const { agent, settings } = createAgentModel(await owner.connect(), {
        storage: localStorage,
      });
      await agent.ready();
      const until = async (check, tries = 500) => {
        for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
        return check();
      };
      await until(() => settings.models().some((model) => model.id === 'adobe/e2e-1'));
      agent.setModel(agent.active(), 'adobe/e2e-1');
      await until(
        () => agent.list().find((row) => row.id === agent.active())?.model === 'adobe/e2e-1'
      );
      await agent.send(agent.active(), `My key is ${alpha}.`);
      await until(() =>
        agent
          .messages()
          .some(
            (m) =>
              m.role === 'assistant' && m.parts?.some((part) => part.text === 'From the model.')
          )
      );
      const channel = new MessageChannel();
      const answer = new Promise((resolve) => {
        channel.port1.onmessage = ({ data }) => resolve(data);
      });
      worker.postMessage({ upstream: channel.port2 }, [channel.port2]);
      const result = { ...(await answer), messages: JSON.stringify(agent.messages()) };
      await owner.release();
      return result;
    },
    { query, alpha }
  );
  captured.push(
    ...seen.upstream.map((request, at) => ({ what: `upstream ${at}`, text: request.body })),
    { what: 'messages', text: seen.messages }
  );
  const turns = seen.upstream.filter((request) => !request.body.includes('Give this chat a title'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].authorization, `Bearer ${key}`);
  assert.match(turns[0].body, /My key is fnox_proxy_000000000000000000000001\./);
  for (const request of seen.upstream) assert.ok(!request.body.includes(alpha));
  assert.ok(seen.vault.some((message) => message.op === 'model' && message.provider === 'adobe'));
  assert.ok(seen.vault.some((message) => message.op === 'endpoints'));
  assert.ok(!seen.messages.includes(key));
});

test('secrets: a guest tool call asks with its arguments scrubbed, a secret shown as its placeholder, and once approved runs with the real value', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const steps = [
    {
      tool: {
        name: 'bash',
        args: { command: `printf '%s' ${alpha} > /home/guest-ran.txt`, timeout: 5 },
      },
    },
    { answer: 'Ran.' },
  ];
  const seen = await page.evaluate(
    async ({ origin, steps }) => {
      const { owner, connection } = await window.withVault(origin, steps);
      const hub = {
        mint: async () => ({ id: 'seat-1', url: 'https://hub.test/join/seat-1' }),
        revoke: async () => {},
      };
      const model = createAgentModel(connection, { guests: hub });
      await model.agent.ready();
      const minted = await model.guests.mint('cone', {
        label: 'Anna',
        expiresAt: null,
        gates: { messages: 'off', tools: 'user' },
      });
      const guest = await connectGuest(
        await owner.port({ guest: { id: minted.seat.id, label: 'Anna' } })
      );
      await guest.control.send(
        { text: 'Echo it.', whenBusy: 'followUp', requestId: null },
        BACKGROUND_CONTEXT
      );
      const asked = () =>
        model.approvals.list().filter((approval) => approval.kind === 'guest-tool');
      for (let n = 0; n < 300 && !asked().length; n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const [first] = asked();
      const result = {
        approval: JSON.stringify(first ?? null),
        args: first?.args,
        summary: first?.summary,
        items: JSON.stringify(connection.approvals.value),
      };
      if (first) await model.approvals.decide(first.id, 'once');
      const ran = () =>
        connection.transcript.value.entries.some(
          (entry) =>
            entry.kind === 'pi.assistant' &&
            entry.model?.[0]?.content?.some((block) => block.text === 'Ran.')
        );
      for (let n = 0; n < 300 && !ran(); n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      result.written = await window.read('/home/guest-ran.txt').catch(() => null);
      await guest.close();
      await owner.release();
      return result;
    },
    { origin: vaultOrigin, steps }
  );
  captured.push(
    { what: 'the approval shown', text: seen.approval },
    { what: 'the approval records', text: seen.items }
  );
  const placeholder = seeds.values[0].placeholder;
  const shown = `printf '%s' ${placeholder} > /home/guest-ran.txt`;
  assert.equal(seen.args, JSON.stringify({ command: shown, timeout: 5 }, null, 2));
  assert.equal(seen.summary, JSON.stringify({ command: shown, timeout: 5 }));
  assert.equal(seen.written, alpha);
});

test('secrets: an Always rule keeps no secret from its call, on the seat or in the guests state, and the same call still matches it', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const command = `printf '%s' ${alpha} >> /home/always.txt`;
  const steps = [
    { tool: { name: 'bash', args: { command } } },
    { answer: 'One.' },
    { tool: { name: 'bash', args: { command } } },
    { answer: 'Two.' },
  ];
  const seen = await page.evaluate(
    async ({ origin, steps }) => {
      const { owner, connection } = await window.withVault(origin, steps);
      const ctx = BACKGROUND_CONTEXT;
      const hub = {
        mint: async () => ({ id: 'seat-1', url: 'https://hub.test/join/seat-1' }),
        revoke: async () => {},
      };
      const model = createAgentModel(connection, { guests: hub });
      await model.agent.ready();
      await connection.control.approvalPolicySet({ guests: { always: { tools: true } } }, ctx);
      const minted = await model.guests.mint('cone', {
        label: 'Anna',
        expiresAt: null,
        gates: { messages: 'off', tools: 'user' },
      });
      const guest = await connectGuest(
        await owner.port({ guest: { id: minted.seat.id, label: 'Anna' } })
      );
      const until = async (check) => {
        for (let n = 0; n < 300 && !check(); n++)
          await new Promise((resolve) => setTimeout(resolve, 50));
        return check();
      };
      const said = (text) =>
        connection.transcript.value.entries.some(
          (entry) =>
            entry.kind === 'pi.assistant' &&
            entry.model?.[0]?.content?.some((block) => block.text === text)
        );
      const asked = () =>
        model.approvals.list().filter((approval) => approval.kind === 'guest-tool');
      const send = (text) =>
        guest.control.send({ text, whenBusy: 'followUp', requestId: null }, ctx);
      await send('First.');
      const [first] = await until(() => asked().length && asked());
      const decided = await connection.control.decide(first.id, 'always', null, ctx);
      await until(() => said('One.'));
      const rules = () =>
        connection.guests.value.find((entry) => entry.id === minted.seat.id)?.alwaysTools ?? [];
      await until(() => rules().length);
      let shown = 0;
      await send('Second.');
      await until(() => {
        shown = Math.max(shown, asked().length);
        return said('Two.');
      });
      const result = {
        decided: decided.state,
        rules: rules().map(({ tool, arguments: args, argumentsHash }) => ({
          tool,
          args,
          hashed: /^[0-9a-f]{64}$/.test(argumentsHash),
        })),
        guests: JSON.stringify(connection.guests.value),
        docs: JSON.stringify(connection.transcript.value.docs),
        shown,
        written: await window.read('/home/always.txt').catch(() => null),
      };
      await guest.close();
      await owner.release();
      return result;
    },
    { origin: vaultOrigin, steps }
  );
  captured.push(
    { what: 'the guests state', text: seen.guests },
    { what: 'live slots and documents', text: seen.docs }
  );
  const placeholder = seeds.values[0].placeholder;
  assert.equal(seen.decided, 'approved');
  assert.deepEqual(seen.rules, [
    {
      tool: 'bash',
      args: JSON.stringify({ command: `printf '%s' ${placeholder} >> /home/always.txt` }),
      hashed: true,
    },
  ]);
  assert.equal(seen.shown, 0);
  assert.equal(seen.written, `${alpha}${alpha}`);
});
