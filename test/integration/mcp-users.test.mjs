import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const server = (name) =>
  JSON.stringify({ mcpServers: { [name]: { url: 'https://mcp.test/mcp' } } });

const helpers = () => {
  window.boot = async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel({}, { users: 'enforce' });
    window.sh = (command, user) => kernel.run(['bash', '-c', command], user ? { user } : {});
    window.owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
      kernel: {
        connect: (options) => kernel.connect(options?.user ? { user: options.user } : undefined),
        users: kernel.users,
      },
    });
    window.model = createAgentModel(await window.owner.connect(), { storage: localStorage });
    window.agent = window.model.agent;
    await window.agent.ready();
  };
  window.tools = () =>
    window.agent
      .messages()
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool);
  window.licks = () =>
    window.agent
      .messages()
      .filter((message) => message.role === 'lick')
      .map(({ title }) => title);
};

test('with kernel users a server in /etc/slicc/agent/mcp.json connects, and one only in a ~/.pi/agent/mcp.json does not', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const script =
    'const found = await searchTools("echo text"); const echoed = await tools.mcp__wanted__echo({ text: "etc" }); return { found: found.map((item) => item.name), echoed };';
  const query = ['relay=mcp.test', `code=${encodeURIComponent(script)}`, 'answer=Done.'].join('&');
  await staged(page, 'the agent', (q) => window.boot(q), query);
  await page.within(
    60000,
    async () => (await window.sh('test -d /var/lib/slicc/agent/requests/cone/in')).status === 0
  );
  const write = (path, text, user) =>
    page.evaluate(
      async ({ path, text, user }) => {
        const dir = path.slice(0, path.lastIndexOf('/'));
        const result = await window.sh(`mkdir -p ${dir} && printf '%s' '${text}' > ${path}`, user);
        return { status: result.status, stderr: result.stderr };
      },
      { path, text, user }
    );
  assert.equal((await write('/home/cone/.pi/agent/mcp.json', server('cone'), 'cone')).status, 0);
  assert.equal((await write('/root/.pi/agent/mcp.json', server('root'))).status, 0);
  assert.equal((await write('/home/.pi/agent/mcp.json', server('shared'))).status, 0);
  assert.equal((await write('/etc/slicc/agent/mcp.json', server('wanted'))).status, 0);
  await page.within(60000, () =>
    window.licks().some((title) => title === 'MCP server "wanted" connected')
  );
  await page.within(60000, () => !window.agent.busy(window.agent.active()));
  await page.evaluate(() => window.agent.send(window.agent.active(), 'Which servers are there?'));
  await page.within(60000, () =>
    window.tools().some((tool) => tool.status === 'done' || tool.status === 'error')
  );
  const seen = await page.evaluate(() => ({
    tools: window.tools().map(({ name, output, status }) => ({ name, output, status })),
    licks: window.licks(),
  }));
  assert.equal(seen.tools[0].name, 'codemode');
  assert.equal(seen.tools[0].status, 'done', seen.tools[0].output);
  assert.match(seen.tools[0].output, /echo: etc/);
  const found = /"found":(\[[^\]]*\])/.exec(seen.tools[0].output);
  assert.ok(found, seen.tools[0].output);
  assert.ok(
    JSON.parse(found[1]).every((name) => name.startsWith('mcp__wanted__')),
    found[1]
  );
  assert.deepEqual(
    seen.licks.filter((title) => /MCP server ".*" connected/.test(title)),
    ['MCP server "wanted" connected']
  );
});

const booted = async (t, query = 'relay=mcp.test&answer=Ready.') => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'the agent', (q) => window.boot(q), query);
  await page.within(
    60000,
    async () => (await window.sh('test -d /var/lib/slicc/agent/requests/cone/in')).status === 0
  );
  return page;
};

const FILE = '/etc/slicc/agent/mcp.json';

test('mcp.json from the settings methods is 0600 root:root and only root can read it, and a file made by hand stays as it is until the next write', async (t) => {
  const page = await booted(t);
  const seen = await page.evaluate(async (file) => {
    const mode = async () => (await window.sh(`stat -c "%a %U %G" ${file}`)).stdout.trim();
    const hand = await window.sh(`printf '{"mcpServers":{}}' > ${file}`);
    const byHand = await mode();
    const coneReadsHand = (await window.sh(`cat ${file}`, 'cone')).status;
    const added = await window.model.settings.addServer('docs', { url: 'https://mcp.test/mcp' });
    return {
      hand: hand.status,
      byHand,
      coneReadsHand,
      added,
      written: await mode(),
      read: await window.sh(`cat ${file}`, 'cone'),
      write: await window.sh(`printf '{}' > ${file}`, 'cone'),
      left: (await window.sh('ls -A /etc/slicc/agent')).stdout.trim(),
      root: await window.sh(`cat ${file}`),
    };
  }, FILE);
  assert.equal(seen.hand, 0);
  assert.equal(seen.byHand, '644 root root');
  assert.equal(seen.coneReadsHand, 0);
  assert.deepEqual(seen.added, { ok: true });
  assert.equal(seen.written, '600 root root');
  assert.notEqual(seen.read.status, 0);
  assert.equal(seen.read.stdout, '');
  assert.notEqual(seen.write.status, 0);
  assert.equal(seen.left, 'mcp.json');
  assert.deepEqual(JSON.parse(seen.root.stdout), {
    mcpServers: { docs: { url: 'https://mcp.test/mcp' } },
  });
});

test('a server added in Settings connects through the file watch, and removing it closes it and keeps the other servers and unknown fields', async (t) => {
  const page = await booted(t);
  const before = JSON.stringify({
    note: 'mine',
    mcpServers: { kept: { url: 'https://mcp.test/kept', custom: 1 } },
  });
  await page.evaluate(({ file, before }) => window.sh(`printf '%s' '${before}' > ${file}`), {
    file: FILE,
    before,
  });
  await page.within(60000, () =>
    window.model.settings.accounts().some(({ id }) => id === 'mcp:kept')
  );
  const added = await page.evaluate(() =>
    window.model.settings.addServer('docs', { url: 'https://mcp.test/mcp' })
  );
  assert.deepEqual(added, { ok: true });
  await page.within(60000, () =>
    window.model.settings
      .accounts()
      .some(({ id, state }) => id === 'mcp:docs' && state === 'connected')
  );
  const file = () =>
    page.evaluate((path) => window.sh(`cat ${path}`).then(({ stdout }) => stdout), FILE);
  assert.deepEqual(JSON.parse(await file()), {
    note: 'mine',
    mcpServers: {
      kept: { url: 'https://mcp.test/kept', custom: 1 },
      docs: { url: 'https://mcp.test/mcp' },
    },
  });
  const removed = await page.evaluate(() => window.model.settings.removeServer('mcp:docs'));
  assert.deepEqual(removed, { ok: true });
  await page.within(60000, () =>
    window.model.settings.accounts().every(({ id }) => id !== 'mcp:docs')
  );
  assert.deepEqual(JSON.parse(await file()), JSON.parse(before));
});

test('a server added with a token uses MCP_<NAME>_TOKEN and its row offers Connect; every refused entry says why and writes nothing, and a file that does not parse is never overwritten', async (t) => {
  const page = await booted(t);
  const seen = await page.evaluate(async (file) => {
    const { settings } = window.model;
    const until = (check) => when([every(100)], check, 'the row');
    const read = async () => (await window.sh(`cat ${file}`)).stdout;
    const added = await settings.addServer('my-docs', { url: 'https://mcp.test/mcp', token: true });
    const text = await read();
    await until(() => settings.accounts().find(({ id }) => id === 'mcp:my-docs'));
    const row = settings.accounts().find(({ id }) => id === 'mcp:my-docs');
    const entries = {
      stdio: { command: 'npx', args: ['server'] },
      sse: { type: 'sse', url: 'https://mcp.test/mcp' },
      header: { url: 'https://mcp.test/mcp', headers: { Authorization: 'Bearer abc123' } },
      password: { url: 'https://user:hunter2@mcp.test/mcp' },
      key: { url: 'https://mcp.test/mcp?api_key=abc123' },
    };
    const refused = {};
    for (const [name, entry] of Object.entries(entries))
      refused[name] = await settings.addServer(name, entry);
    refused.twin = await settings.addServer('my_docs', { url: 'https://mcp.test/mcp' });
    refused.taken = await settings.addServer('my-docs', { url: 'https://mcp.test/other' });
    const unchanged = (await read()) === text;
    await window.sh(`printf '{ "mcpServers": { oops' > ${file}`);
    const broken = await settings.addServer('later', { url: 'https://mcp.test/mcp' });
    const gone = await settings.removeServer('mcp:my-docs');
    return { added, row, text, refused, unchanged, broken, gone, after: await read() };
  }, FILE);
  assert.deepEqual(seen.added, { ok: true });
  assert.equal(seen.row.status, 'disconnected');
  assert.equal(seen.row.auth, 'api-key');
  assert.equal(seen.row.secret, 'token');
  assert.equal(seen.row.store, 'vault');
  assert.equal(seen.row.state, 'needs-secret');
  assert.deepEqual(JSON.parse(seen.text), {
    mcpServers: {
      'my-docs': {
        url: 'https://mcp.test/mcp',
        headers: { Authorization: 'Bearer ${MCP_MY_DOCS_TOKEN}' },
      },
    },
  });
  const reasons = {
    stdio: /stdio/,
    sse: /legacy SSE/,
    header: /literal secret/,
    password: /literal secret/,
    key: /literal secret/,
    twin: /differ only/,
    taken: /already has a server/,
  };
  for (const [name, reason] of Object.entries(reasons)) {
    assert.equal(seen.refused[name].ok, false, name);
    assert.match(seen.refused[name].reason, reason, name);
    assert.doesNotMatch(seen.refused[name].reason, /abc123|hunter2/, name);
  }
  assert.ok(seen.unchanged);
  assert.equal(seen.broken.ok, false);
  assert.match(seen.broken.reason, /isn't valid JSON/);
  assert.equal(seen.gone.ok, false);
  assert.equal(seen.after, '{ "mcpServers": { oops');
});

test('Settings lists no-auth, disabled and refused servers with their state and the host only', async (t) => {
  const page = await booted(t);
  await page.evaluate(({ file, text }) => window.sh(`printf '%s' '${text}' > ${file}`), {
    file: FILE,
    text: JSON.stringify({
      mcpServers: {
        open: { url: 'https://mcp.test/secret-path/mcp' },
        off: { url: 'https://mcp.test/other-path/mcp', enabled: false },
        local: { command: 'npx' },
        leaky: { url: 'https://mcp.test/leak-path/mcp?token=abc123' },
        token: {
          url: 'https://mcp.test/token-path/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN_TOKEN}' },
        },
      },
    }),
  });
  await page.within(60000, () =>
    window.model.settings
      .accounts()
      .some(({ id, state }) => id === 'mcp:open' && state === 'connected')
  );
  const seen = await page.evaluate(async () => {
    const rows = window.model.settings
      .accounts()
      .filter(({ group }) => group === 'mcp')
      .map(({ provider, identity, status, auth, state }) => ({
        provider,
        identity,
        status,
        auth,
        state,
      }));
    const viewer = await window.owner.connect({ readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { rows, replicated: JSON.stringify(viewer.settings.state.value.accounts) };
  });
  assert.deepEqual(seen.rows, [
    {
      provider: 'open',
      identity: 'mcp.test',
      status: 'connected',
      auth: 'local',
      state: 'connected',
    },
    {
      provider: 'off',
      identity: 'mcp.test',
      status: 'disconnected',
      auth: 'local',
      state: 'disabled',
    },
    {
      provider: 'token',
      identity: 'mcp.test',
      status: 'disconnected',
      auth: 'api-key',
      state: 'needs-secret',
    },
    { provider: 'local', identity: '', status: 'disconnected', auth: 'local', state: 'refused' },
    {
      provider: 'leaky',
      identity: 'mcp.test',
      status: 'disconnected',
      auth: 'local',
      state: 'refused',
    },
  ]);
  assert.match(seen.replicated, /mcp:open/);
  assert.doesNotMatch(seen.replicated, /path|abc123|https:/);
});

test('only the owner can add or remove a server: a view-only seat and a control seat are refused, and a model on them offers neither', async (t) => {
  const page = await booted(t);
  const seen = await page.evaluate(async (file) => {
    const attempt = (run) =>
      run().then(
        (value) => ({ value }),
        (error) => ({ code: error.code, message: error.message })
      );
    const seat = async (options) => {
      const connection = await window.owner.connect(options);
      const model = createAgentModel(connection, { storage: localStorage });
      return {
        add: await attempt(() =>
          connection.settings.addServer('sneaky', { url: 'https://mcp.test/mcp' })
        ),
        remove: await attempt(() => connection.settings.removeServer('mcp:sneaky')),
        offered: typeof model.settings.addServer,
      };
    };
    return {
      view: await seat({ readOnly: true, pages: false }),
      control: await seat({ pages: false }),
      owner: typeof window.model.settings.addServer,
      file: (await window.sh(`ls ${file}`)).status,
    };
  }, FILE);
  for (const seat of [seen.view, seen.control]) {
    assert.equal(seat.add.code, 'EACCES');
    assert.equal(seat.remove.code, 'EACCES');
    assert.match(seat.add.message, /Only the owner/);
    assert.equal(seat.offered, 'undefined');
  }
  assert.equal(seen.owner, 'function');
  assert.notEqual(seen.file, 0);
});
