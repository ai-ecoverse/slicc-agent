import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const server = (name) =>
  JSON.stringify({ mcpServers: { [name]: { url: 'https://mcp.test/mcp' } } });

const helpers = () => {
  window.boot = async (query, worker) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel(
      {},
      { users: 'enforce', ...(worker ? { worker: new URL(worker, location.href) } : {}) }
    );
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

const booted = async (t, query = 'relay=mcp.test&answer=Ready.', worker = '') => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'the agent', ([q, w]) => window.boot(q, w), [query, worker]);
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

test('only the owner can add or remove a server or read why one was refused: a view-only seat and a control seat are told so, and a model on them offers none of it', async (t) => {
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
        refusals: await attempt(() => connection.settings.refusals()),
        offered: [
          typeof model.settings.addServer,
          typeof model.settings.removeServer,
          typeof model.settings.refusals,
        ],
      };
    };
    return {
      view: await seat({ readOnly: true, pages: false }),
      control: await seat({ pages: false }),
      owner: [typeof window.model.settings.addServer, typeof window.model.settings.refusals],
      file: (await window.sh(`ls ${file}`)).status,
    };
  }, FILE);
  for (const seat of [seen.view, seen.control]) {
    for (const edit of [seat.add, seat.remove]) {
      assert.equal(edit.value.ok, false);
      assert.equal(edit.value.code, 'not-owner');
      assert.match(edit.value.reason, /Only the owner/);
    }
    assert.equal(seat.refusals.code, 'EACCES');
    assert.match(seat.refusals.message, /Only the owner/);
    assert.deepEqual(seat.offered, ['undefined', 'undefined', 'undefined']);
  }
  assert.deepEqual(seen.owner, ['function', 'function']);
  assert.notEqual(seen.file, 0);
});

const NO_LEAK = /abc123|hunter2|:\/\/|mcp\.test/;
const URL_OK = 'https://mcp.test/mcp';

const REFUSED = [
  ['bad name!', { url: URL_OK }, 'bad-name'],
  ['my-docs', { url: URL_OK }, 'duplicate'],
  ['my_docs', { url: URL_OK }, 'duplicate'],
  ['plain', URL_OK, 'not-object'],
  ['tok', { url: URL_OK, token: 'abc123' }, 'bad-token'],
  [
    'tok',
    { url: URL_OK, token: true, headers: { Authorization: 'Bearer ${A}' } },
    'token-conflict',
  ],
  ['tok', { url: URL_OK, token: true, oauth: { clientId: 'abc123' } }, 'token-conflict'],
  ['pass', { url: 'https://user:hunter2@mcp.test/mcp' }, 'url-secret'],
  ['key', { url: 'https://mcp.test/mcp?api_key=abc123' }, 'url-secret'],
  ['head', { url: URL_OK, headers: { 'X-Api-Key': 'abc123' } }, 'header-secret'],
  ['local', { command: 'npx', args: ['abc123'] }, 'stdio'],
  ['old', { type: 'sse', url: URL_OK }, 'sse'],
  ['nourl', {}, 'bad-url'],
  ['broken', { url: 'abc123 is no url' }, 'bad-url'],
  ['ftp', { url: 'ftp://mcp.test/mcp' }, 'bad-url'],
  ['meta', { url: URL_OK, oauth: { authServerMetadataUrl: 'abc123' } }, 'bad-url'],
  ['meta', { url: URL_OK, oauth: { authServerMetadataUrl: 'http://mcp.test/m' } }, 'insecure-url'],
  ['slow', { url: URL_OK, timeout: -1 }, 'invalid'],
  ['auth', { url: URL_OK, auth: 'abc123' }, 'invalid'],
];

const refusedWith = (edit, code, label) => {
  assert.equal(edit.ok, false, label);
  assert.equal(edit.code, code, label);
  assert.ok(edit.reason, label);
  assert.doesNotMatch(JSON.stringify(edit), NO_LEAK, label);
};

test('every refused edit carries a stable code beside its reason, and no reply holds a URL, a host or a secret', async (t) => {
  const page = await booted(t);
  const seen = await page.evaluate(
    async ({ file, entries, url }) => {
      const { settings } = window.model;
      const write = (text) => window.sh(`printf '%s' '${text}' > ${file}`);
      const added = await settings.addServer('my-docs', { url });
      const refused = [];
      for (const [name, entry] of entries) refused.push(await settings.addServer(name, entry));
      const missing = await settings.removeServer('mcp:ghost');
      const model = await settings.removeServer('faux');
      await write('{ "mcpServers": { oops');
      const unparsed = await settings.addServer('later', { url });
      const unparsedRemove = await settings.removeServer('mcp:my-docs');
      await write('{"mcpServers":[]}');
      const shape = await settings.addServer('later', { url });
      await window.sh(`rm -f ${file} && mkdir ${file}`);
      const unreadable = await settings.addServer('later', { url });
      const unreadableRemove = await settings.removeServer('mcp:later');
      return {
        added,
        refused,
        missing,
        model,
        unparsed,
        unparsedRemove,
        shape,
        unreadable,
        unreadableRemove,
      };
    },
    { file: FILE, entries: REFUSED, url: URL_OK }
  );
  assert.deepEqual(seen.added, { ok: true });
  REFUSED.forEach(([name, , code], index) => {
    refusedWith(seen.refused[index], code, `${name} ${code}`);
  });
  refusedWith(seen.missing, 'not-found', 'missing');
  refusedWith(seen.model, 'not-found', 'a model account');
  refusedWith(seen.unparsed, 'file-invalid', 'broken JSON');
  refusedWith(seen.unparsedRemove, 'file-invalid', 'broken JSON, remove');
  refusedWith(seen.shape, 'file-invalid', 'the wrong shape');
  refusedWith(seen.unreadable, 'file-unreadable', 'a directory');
  refusedWith(seen.unreadableRemove, 'file-unreadable', 'a directory, remove');
});

test('a write that fails answers file-unwritable and leaves the file as it was', async (t) => {
  const page = await booted(t, undefined, '/fail-mcp-write-kernel-worker.js');
  const seen = await page.evaluate(async (file) => {
    const { settings } = window.model;
    await window.sh(`printf '{"mcpServers":{}}' > ${file}`);
    const edit = await settings.addServer('docs', { url: 'https://mcp.test/mcp' });
    return { edit, text: (await window.sh(`cat ${file}`)).stdout };
  }, FILE);
  refusedWith(seen.edit, 'file-unwritable', 'the write');
  assert.equal(seen.text, '{"mcpServers":{}}');
});

test('refusals gives the owner the code and the warn lick sentence of each refused entry, with no URL or secret, and forgets an entry once it is gone', async (t) => {
  const page = await booted(t);
  await page.evaluate(({ file, text }) => window.sh(`printf '%s' '${text}' > ${file}`), {
    file: FILE,
    text: JSON.stringify({
      mcpServers: {
        open: { url: URL_OK },
        local: { command: 'npx', args: ['abc123'] },
        leaky: { url: 'https://mcp.test/leak-path/mcp?token=abc123' },
        pass: { url: 'https://user:hunter2@mcp.test/mcp' },
        head: { url: URL_OK, headers: { Authorization: 'Bearer abc123' } },
        old: { type: 'sse', url: URL_OK },
        'my-twin': { url: URL_OK },
        my_twin: { url: 'https://mcp.test/abc123' },
      },
    }),
  });
  await page.within(60000, () =>
    window.model.settings
      .accounts()
      .some(({ id, state }) => id === 'mcp:open' && state === 'connected')
  );
  await page.within(60000, () =>
    window.licks().some((title) => title.startsWith('MCP config problem'))
  );
  const seen = await page.evaluate(async () => ({
    refusals: await window.model.settings.refusals(),
    licks: window.agent
      .messages()
      .filter((message) => message.role === 'lick')
      .map(({ title, text }) => ({ title, text })),
  }));
  assert.deepEqual(
    Object.fromEntries(Object.entries(seen.refusals).map(([name, { code }]) => [name, code])),
    {
      local: 'stdio',
      leaky: 'url-secret',
      pass: 'url-secret',
      head: 'header-secret',
      old: 'sse',
      my_twin: 'duplicate',
    }
  );
  const warned = seen.licks.filter(({ title }) => title.startsWith('MCP config problem'));
  assert.ok(warned.length);
  for (const { title, text } of warned) {
    const name = /server "([^"]+)"/.exec(title)[1];
    assert.equal(seen.refusals[name].reason, text, name);
  }
  assert.doesNotMatch(JSON.stringify(seen.refusals), NO_LEAK);
  const removed = await page.evaluate(() => window.model.settings.removeServer('mcp:leaky'));
  assert.deepEqual(removed, { ok: true });
  await page.within(60000, async () => !('leaky' in (await window.model.settings.refusals())));
  const left = await page.evaluate(() => window.model.settings.refusals());
  assert.deepEqual(Object.keys(left).sort(), ['head', 'local', 'my_twin', 'old', 'pass']);
});
