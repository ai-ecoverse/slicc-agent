import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';
import {
  DIRECTORY,
  directory,
  EXPORT_ID,
  FIXTURE,
  files,
  manifest,
  profile,
  zip,
} from './fixtures/slicc6-profile.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.sh = async (command, options = {}) => window.kernel.run(['bash', '-c', command], options);
  window.put = async (path, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(bytes);
    await writable.close();
  };
  window.progress = () => window.connection?.importing.value ?? null;
  window.start = async (query = '') => {
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    window.kernel = await bootKernel();
    stage('the agent');
    const answers = Array.from({ length: 6 }, (_, n) => `answer=Answer ${n + 1}.`).join('&');
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}${query}`, { type: 'module' }),
      kernel: {
        connect: (options) =>
          window.kernel.connect(options?.user ? { user: options.user } : undefined),
        users: window.kernel.users,
      },
    });
    window.connection = await owner.connect();
    window.agent = createAgentModel(window.connection, { storage: localStorage }).agent;
    await window.agent.ready();
    await when(
      [files(window.kernel, ['/var/lib/slicc/agent/requests']), every(500)],
      async () => (await window.sh('freezer list')).status === 0,
      'the freezer command'
    );
  };
  window.listed = (count) =>
    when([window.connection.frozen], () => window.rows().length === count, `${count} rows`);
  window.bigZip = async (path, small, big) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const out = await (await dir.getFileHandle(name, { create: true })).createWritable();
    const centrals = [];
    let offset = 0;
    const header = (signature, size) => {
      const bytes = new Uint8Array(size);
      new DataView(bytes.buffer).setUint32(0, signature, true);
      return bytes;
    };
    const entry = async (entryName, size, write) => {
      const named = new TextEncoder().encode(entryName);
      const local = header(0x04034b50, 30);
      const view = new DataView(local.buffer);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint32(18, size, true);
      view.setUint32(22, size, true);
      view.setUint16(26, named.length, true);
      const central = header(0x02014b50, 46);
      const record = new DataView(central.buffer);
      record.setUint16(4, 20, true);
      record.setUint16(6, 20, true);
      record.setUint16(8, 0x0800, true);
      record.setUint32(20, size, true);
      record.setUint32(24, size, true);
      record.setUint16(28, named.length, true);
      record.setUint32(42, offset, true);
      centrals.push(central, named);
      await out.write(local);
      await out.write(named);
      await write();
      offset += 30 + named.length + size;
    };
    for (const [entryName, base64] of small) {
      const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      await entry(entryName, data.length, () => out.write(data));
    }
    const chunk = new Uint8Array(8 * 1024 * 1024);
    for (const { path: entryName, size } of big)
      await entry(entryName, size, async () => {
        for (let left = size; left > 0; left -= chunk.length)
          await out.write(left >= chunk.length ? chunk : chunk.subarray(0, left));
      });
    const length = centrals.reduce((sum, part) => sum + part.length, 0);
    for (const part of centrals) await out.write(part);
    const end = header(0x06054b50, 22);
    const view = new DataView(end.buffer);
    view.setUint16(8, centrals.length / 2, true);
    view.setUint16(10, centrals.length / 2, true);
    view.setUint32(12, length, true);
    view.setUint32(16, offset, true);
    await out.write(end);
    await out.close();
  };
  window.imported = (path, flags = '') => window.sh(`freezer import ${flags} ${path}`);
  window.rows = () =>
    window.connection.frozen.value
      .filter((row) => row.v6)
      .map(({ id, name, title, messages }) => ({ id, name, title, messages }))
      .sort((a, b) => a.id.localeCompare(b.id));
};

async function booted(t, query = '') {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'the v6 agent', (query) => window.start(query), query);
  return page;
}

const upload = (page, path, bytes) =>
  page.evaluate(
    ([path, data]) => window.put(path, data),
    [path, Buffer.from(bytes).toString('base64')]
  );

const today = () => new Date().toISOString().slice(0, 10);

test('freezer import --preview checks a SLICC 6 profile export and says what is in it', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const ran = await staged(page, 'the preview', () =>
    window.imported('/tmp/profile.zip', '--preview')
  );
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(
    ran.stdout,
    'SLICC 6 profile from www.sliccy.ai, exported 2026-07-12: 2 cones, 1 scoop, 1 frozen session, 0.2 KB of files, 1 skill (for every agent), 2 crons (imported off), 1 webhook (new URLs needed), 2 credential-like files to review. SLICC 7 has no accounts for Anthropic and OpenAI. Not imported: 1 mount.\n'
  );
  const usage = await staged(page, 'the usage', () =>
    window.imported('/tmp/profile.zip', '--bogus')
  );
  assert.equal(usage.status, 2);
});

const coneDoc = () => JSON.parse(files()['transcripts/cone.json']);
const plain = () => manifest(files());

const refusals = [
  [
    'an undeclared skill',
    () => profile({ contents: { ...files(), 'skills/rogue/SKILL.md': 'x' } }),
    /skills\/rogue\/SKILL\.md has no place in a SLICC 6 profile/,
  ],
  [
    'a missing memory file',
    () =>
      profile({
        overrides: { cones: [{ ...plain().cones[0], memory: 'memory/gone.md' }, plain().cones[1]] },
      }),
    /memory\/gone\.md is named in the manifest but not in the zip/,
  ],
  [
    'a conversation the transcript lacks',
    () =>
      profile({
        overrides: { cones: [plain().cones[0], { ...plain().cones[1], conversation: 'cone_9' }] },
      }),
    /transcripts\/research\.json has no conversation cone_9/,
  ],
  [
    'an attachment that does not match its file',
    () => {
      const doc = coneDoc();
      doc.attachments[0].byteLength = 1;
      return profile({ contents: { ...files(), 'transcripts/cone.json': JSON.stringify(doc) } });
    },
    /transcripts\/cone\.json: attachment a1 doesn't match attachments\//,
  ],
  ['not a zip', () => Buffer.from('hello'), /this is not a zip file/],
  [
    'manifest not first',
    () => profile({ edit: (entries) => [...entries.slice(1), entries[0]] }),
    /manifest\.json must be the first entry/,
  ],
  [
    'another format',
    () => profile({ overrides: { format: 'other' } }),
    /this is not a SLICC 6 profile export/,
  ],
  [
    'a newer version',
    () => profile({ overrides: { version: 3 } }),
    /This export is from a newer SLICC 6; update seven\./,
  ],
  [
    'the directory form in a zip',
    () => profile({ overrides: { version: 2 } }),
    /this is SLICC 6's directory form; import it with freezer import --in-place/,
  ],
  [
    'a .. path',
    () => profile({ edit: (entries) => [...entries, { name: 'files/../x', data: 'x' }] }),
    /refused the entry name "files\/\.\.\/x"/,
  ],
  [
    'an absolute path',
    () => profile({ edit: (entries) => [...entries, { name: '/etc/passwd', data: 'x' }] }),
    /refused the entry name/,
  ],
  [
    'a backslash',
    () => profile({ edit: (entries) => [...entries, { name: 'files\\x', data: 'x' }] }),
    /refused the entry name/,
  ],
  [
    'a drive letter',
    () => profile({ edit: (entries) => [...entries, { name: 'C:/x', data: 'x' }] }),
    /refused the entry name/,
  ],
  [
    'a symlink',
    () =>
      profile({
        edit: (entries) => [
          ...entries,
          { name: 'files/home-user/link', data: '/etc', mode: 0o120777 },
        ],
      }),
    /files\/home-user\/link is a symlink/,
  ],
  [
    'an unlisted entry',
    () =>
      profile({ edit: (entries) => [...entries, { name: 'files/home-user/extra', data: 'x' }] }),
    /files\/home-user\/extra is not listed in the manifest/,
  ],
  [
    'a listed file that is missing',
    () => profile({ edit: (entries) => entries.filter((entry) => entry.name !== 'licks.json') }),
    /licks\.json is in the manifest but not in the zip/,
  ],
  [
    'a wrong sha256',
    () =>
      profile({
        edit: (entries) =>
          entries.map((entry) =>
            entry.name === 'files/home-user/todo.txt'
              ? { ...entry, data: 'Water the plantz\n' }
              : entry
          ),
      }),
    /files\/home-user\/todo\.txt doesn't match its sha256/,
  ],
  [
    'a broken transcript',
    () =>
      profile({
        contents: { ...files(), 'transcripts/research.json': JSON.stringify({ schemaVersion: 1 }) },
      }),
    /transcripts\/research\.json: export is malformed/,
  ],
  [
    'a broken licks.json',
    () => profile({ contents: { ...files(), 'licks.json': '{"crontasks": 1}' } }),
    /crontasks must be an array/,
  ],
  [
    'a file over 256 MiB',
    () =>
      profile({
        edit: (entries) => [...entries.slice(0, -1), { ...entries.at(-1), size: 300 * 1024 ** 2 }],
      }),
    /git\/gitconfig is over 256 MiB/,
  ],
  [
    'a zip bomb',
    () =>
      profile({
        edit: (entries) => [...entries.slice(0, -1), { ...entries.at(-1), size: 8 * 1024 ** 2 }],
      }),
    /the zip expands over 200:1, like a zip bomb/,
  ],
  [
    'an entry bigger than it says',
    () =>
      profile({
        overrides: {
          files: manifest(files()).files.map((file) =>
            file.path === 'files/home-user/todo.txt' ? { ...file, size: 5 } : file
          ),
        },
        edit: (entries) =>
          entries.map((entry) =>
            entry.name === 'files/home-user/todo.txt' ? { ...entry, method: 8, size: 5 } : entry
          ),
      }),
    /files\/home-user\/todo\.txt is bigger than it says/,
  ],
  [
    'an encrypted entry',
    () =>
      profile({
        edit: (entries) =>
          entries.map((entry) => (entry.name === 'licks.json' ? { ...entry, flags: 1 } : entry)),
      }),
    /licks\.json is encrypted/,
  ],
  [
    'an entry with no place',
    () => profile({ contents: { ...files(), 'elsewhere/x': 'x' } }),
    /elsewhere\/x has no place in a SLICC 6 profile/,
  ],
];

test('freezer import refuses a damaged or unsafe profile and changes nothing', async (t) => {
  const page = await booted(t);
  for (const [what, make, error] of refusals) {
    await upload(page, '/tmp/bad.zip', make());
    const ran = await staged(page, what, () => window.imported('/tmp/bad.zip', '--preview'));
    assert.equal(ran.status, 1, `${what}: ${ran.stdout}`);
    assert.match(ran.stderr + ran.stdout, error, what);
  }
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const plain = await staged(page, 'an import as the cone', async () => ({
    cone: await window.sh('freezer import /tmp/profile.zip', { user: 'cone' }),
    rows: window.rows().length,
    users: (await window.kernel.users.list())
      .map((user) => user.name)
      .filter((name) => name.startsWith('cone-')),
  }));
  assert.equal(plain.cone.stderr, 'freezer: only root can import; run sudo freezer import\n');
  assert.equal(plain.cone.status, 1);
  assert.equal(plain.rows, 0);
  assert.deepEqual(plain.users, []);
});

test('freezer import turns a SLICC 6 profile into frozen cones, with files, memory, skills, crons off, webhooks off and a report; a thaw forks one', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const preview = await staged(
    page,
    'the control preview',
    async (data) => {
      const answer = await window.connection.control.importProfile(
        { upload: null, data, again: false, preview: true },
        BACKGROUND_CONTEXT
      );
      return { text: answer.preview.text, done: answer.done, rows: window.rows().length };
    },
    Buffer.from(await readFile(FIXTURE)).toString('base64')
  );
  assert.deepEqual(preview, {
    text: 'SLICC 6 profile from www.sliccy.ai, exported 12 Jul 2026. SLICC 7 has no accounts for Anthropic and OpenAI.',
    done: false,
    rows: 0,
  });
  const ran = await staged(page, 'the import', () => window.imported('/tmp/profile.zip'));
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(
    ran.stdout,
    /^Imported 3 frozen cones from https:\/\/www\.sliccy\.ai: frozen-1, frozen-2, frozen-3\.\nSLICC 7 has no accounts for Anthropic and OpenAI\.\nThe report is \/root\/v6-import-\d{4}-\d\d-\d\d\.md\.\n$/
  );
  const seen = await staged(page, 'the imported profile', async () => {
    await window.listed(3);
    stage('the imported files');
    const out = async (command) => (await window.sh(command)).stdout;
    return {
      rows: window.rows(),
      progress: window.connection.importing.value.phase,
      modes: await out(
        'stat -c "%U %a %n" /home/cone-2 /home/cone-2/workspace /home/cone-2/workspace/.env /home/cone-2/workspace/deploy.sh /home/cone-2/scoops/helper/out.txt /home/cone-3/workspace/certs/dev.pem /usr/share/skills/deploy-notes /usr/share/skills/deploy-notes/SKILL.md'
      ),
      env: await out('cat /home/cone-2/workspace/.env'),
      attachment: await out('ls /home/cone-2/v6-attachments'),
      homeUser: await out('cat /root/v6/home-user/todo.txt'),
      memory: await out('cat /root/.pi/agent/memory/MEMORY.md'),
      coneMemory: await out('cat /root/.pi/agent/memory/cone-2/MEMORY.md'),
      crontab: await out('crontab -u cone-2 -l'),
      webhooks: await out('ls /home/cone-2/.slicc/webhooks'),
      webhook: await out('cat /home/cone-2/.slicc/webhooks/github-push.json.v6'),
      sprinkle: await out('ls /home/cone-2/sprinkles/dashboard'),
      git: await out('cat /root/.gitconfig'),
      staging: await out('ls -A /var/lib/slicc/agent/imports'),
      report: await out('cat /root/v6-import-*.md'),
    };
  });
  assert.deepEqual(seen.rows, [
    { id: 'frozen-1', name: 'sliccy', title: 'Fix the deploy script', messages: 3 },
    { id: 'frozen-2', name: 'research', title: 'Research notes', messages: 2 },
    { id: 'frozen-3', name: 'Old planning chat', title: 'Old planning chat', messages: 2 },
  ]);
  assert.equal(seen.progress, 'done');
  assert.equal(
    seen.modes,
    [
      'cone-2 710 /home/cone-2',
      'cone-2 700 /home/cone-2/workspace',
      'cone-2 600 /home/cone-2/workspace/.env',
      'cone-2 600 /home/cone-2/workspace/deploy.sh',
      'cone-2 600 /home/cone-2/scoops/helper/out.txt',
      'cone-3 600 /home/cone-3/workspace/certs/dev.pem',
      'root 755 /usr/share/skills/deploy-notes',
      'root 644 /usr/share/skills/deploy-notes/SKILL.md',
      '',
    ].join('\n')
  );
  assert.equal(seen.env, 'API_KEY=sk-test-not-a-real-key\n');
  assert.match(seen.attachment, /^[0-9a-f]{12}-screenshot\.png\n$/);
  assert.equal(seen.homeUser, 'Water the plants\n');
  assert.equal(
    seen.memory,
    `## Imported from SLICC 6 (${today()})\n\n### Shared\n\nThe user prefers short answers.\n`
  );
  assert.equal(
    seen.coneMemory,
    `## Imported from SLICC 6 (${today()})\n\n### Project\n\nDeploys go through deploy.sh.\n`
  );
  assert.ok(
    seen.crontab
      .split('\n')
      .filter(Boolean)
      .every((line) => line.startsWith('#')),
    seen.crontab
  );
  assert.match(seen.crontab, /^# # name: standup\n# 0 9 \* \* 1-5 agent send cone --lick=cron$/m);
  assert.match(
    seen.crontab,
    /^# 30 8 \* \* \* agent send scoop:helper --lick=cron 'Summarize the build logs'$/m
  );
  assert.match(
    seen.crontab,
    /^# standup had a SLICC 6 filter, not imported: event => event\.day !== "sat"$/m
  );
  assert.equal(seen.webhooks, 'github-push.json.v6\n');
  assert.deepEqual(JSON.parse(seen.webhook), { target: 'scoop:helper' });
  assert.equal(seen.sprinkle, 'dashboard.shtml\n');
  assert.equal(seen.git, '[user]\n\tname = Pat Example\n\temail = pat@example.com\n');
  assert.equal(seen.staging, '');
  for (const part of [
    '- Fix the deploy script: frozen cone frozen-1, home /home/cone-2, with helper',
    '- the skill deploy-notes, for every agent, in /usr/share/skills/deploy-notes',
    '- crons, imported off: 2 in crontab -u cone-2',
    '- a webhook, imported off: /home/cone-2/.slicc/webhooks/github-push.json.v6',
    '- /mnt/photos: mount',
    "- a SLICC 6 task that cron can't express: interval 3600000: Check the build",
    '| /home/cone-2/workspace/.env | 31 B | environment file, often holds keys |',
    '| /home/cone-3/workspace/certs/dev.pem | 59 B | PEM file, may be a private key |',
    "Delete or move these if you don't need them here.",
    '- Anthropic: SLICC 7 has no such provider',
    'These never move: the GitHub token.',
    '- Mount these folders again: /mnt/photos.',
    '- Add these MCP servers again: docs (https://mcp.example.com/sse).',
    '- These sprinkles call SLICC APIs other than slicc.lick and may need edits: dashboard (slicc.readFile).',
  ])
    assert.ok(seen.report.includes(part), `the report lacks ${part}:\n${seen.report}`);
  const thawed = await staged(page, 'the thaw', async () => {
    const thaw = await window.connection.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    await window.agent.select(thaw.id);
    stage('the answer');
    const answer = await window.connection.prompt('Still there?');
    const messages = window.agent
      .messages(thaw.id)
      .map((message) => `${message.role}: ${message.text ?? ''}`);
    const kinds = window.connection.transcript.value.entries.map((entry) => entry.kind);
    return { id: thaw.id, answer, messages, kinds, rows: window.rows().map((row) => row.id) };
  });
  assert.equal(thawed.id, 'cone-2');
  assert.match(thawed.answer, /^Answer \d\.$/);
  assert.deepEqual(thawed.rows, ['frozen-2', 'frozen-3']);
  assert.ok(
    thawed.kinds.includes('slicc.v6') && thawed.kinds.includes('slicc.thawed'),
    thawed.kinds.join()
  );
  assert.ok(
    thawed.messages.some((line) => line.startsWith('user: Please fix the deploy script')),
    thawed.messages.join('\n')
  );
  const twice = await staged(page, 'the import again', async () => ({
    ran: await window.imported('/tmp/profile.zip'),
    rows: window.rows().length,
  }));
  assert.equal(twice.ran.status, 0);
  assert.match(
    twice.ran.stdout,
    /^Already imported on \d{4}-\d\d-\d\d; freezer import --again makes fresh copies\.\n$/
  );
  assert.equal(twice.rows, 2);
});

test('the spectrum adapter imports a picked zip: preview, progress, the v6 badge, and a zip too big to send as data refused', async (t) => {
  const page = await booted(t, '&anthropic&openai');
  const zip = Buffer.from(await readFile(FIXTURE)).toString('base64');
  const seen = await staged(
    page,
    'the spectrum import',
    async (zip) => {
      const blob = new Blob([Uint8Array.from(atob(zip), (char) => char.charCodeAt(0))]);
      const phases = [];
      window.agent.on('importing', (value) => phases.push(value.phase));
      const preview = await window.agent.importProfile(blob, { preview: true });
      const done = await window.agent.importProfile(blob, { preview: false });
      const listedAtOnce = window.agent
        .frozen()
        .filter((row) => row.v6 && done.cones.includes(row.id))
        .map((row) => row.id)
        .sort();
      const again = await window.agent.importProfile(blob, { preview: true });
      const badges = window.agent.frozen().filter((row) => row.v6).length;
      const models = [
        ...new Set(
          window.agent
            .frozen()
            .filter((row) => row.v6)
            .map((row) => row.model)
        ),
      ];
      const uploads = (await window.sh('ls -A /var/lib/slicc/agent/imports')).stdout;
      const refused = await window.agent
        .importProfile(new Blob(['not a zip']), { preview: true })
        .then(
          () => 'resolved',
          (error) => error.message
        );
      return {
        preview: preview.preview,
        done,
        models,
        listedAtOnce,
        already: again.preview.already,
        phases,
        badges,
        uploads,
        refused,
        progress: window.agent.importing().phase,
      };
    },
    zip
  );
  assert.equal(seen.preview.origin, 'https://www.sliccy.ai');
  assert.equal(seen.preview.createdAt, Date.parse('2026-07-12T10:00:00.000Z'));
  assert.equal(seen.preview.exportId, undefined);
  assert.deepEqual(seen.preview.providers, ['anthropic', 'openai']);
  assert.equal(seen.preview.text, 'SLICC 6 profile from www.sliccy.ai, exported 12 Jul 2026.');
  assert.equal(
    seen.done.text,
    'From www.sliccy.ai. Sign in to Anthropic and OpenAI again before you thaw them.'
  );
  assert.deepEqual(seen.preview.flagged, [
    'files/cones/cone/.env',
    'files/cones/research/certs/dev.pem',
  ]);
  assert.deepEqual(seen.done.cones, ['frozen-1', 'frozen-2', 'frozen-3']);
  assert.deepEqual(seen.listedAtOnce, ['frozen-1', 'frozen-2', 'frozen-3']);
  assert.match(seen.done.report, /^\/root\/v6-import-\d{4}-\d\d-\d\d\.md$/);
  assert.equal(typeof seen.already, 'number');
  assert.ok(
    seen.phases.includes('checking') &&
      seen.phases.includes('writing') &&
      seen.phases.includes('done'),
    seen.phases.join()
  );
  assert.equal(seen.badges, 3);
  assert.deepEqual(seen.models, ['Claude Sonnet 4.5 (latest)']);
  assert.equal(seen.uploads, '');
  assert.equal(seen.refused, 'This is not a zip file.');
  assert.equal(seen.progress, 'failed');
  const remote = await staged(page, 'a zip too big to send', async () => {
    const root = await navigator.storage.getDirectory();
    const agent = await (
      await (await root.getDirectoryHandle('var')).getDirectoryHandle('lib')
    ).getDirectoryHandle('slicc');
    await (await agent.getDirectoryHandle('agent')).removeEntry('imports', { recursive: true });
    return window.agent
      .importProfile(new Blob([new Uint8Array(17 * 1024 * 1024)]), { preview: true })
      .then(
        () => 'resolved',
        (error) => error.message
      );
  });
  assert.match(remote, /^This profile is too big to send from this device\./);
});

test('a failed freezer import leaves nothing behind, and the same zip imports once the problem is gone', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const failed = await staged(page, 'the failed import', async () => {
    const look = async () => {
      const out = async (command) => {
        const ran = await window.sh(command);
        return `${ran.status} ${ran.stdout}`;
      };
      return {
        rows: window.rows().length,
        homes: await out('ls -A /home'),
        skills: await out('ls -A /usr/share/skills'),
        memory: await out('ls -AR /root/.pi/agent/memory; cat /root/.pi/agent/memory/MEMORY.md'),
        root: await out('ls -A /root'),
        crontab: await out('crontab -u cone-2 -l; crontab -l'),
        users: (await window.kernel.users.list()).map((user) => user.name),
        staging: await out('ls -A /var/lib/slicc/agent/imports'),
      };
    };
    await window.sh('mkdir -p /var/lib/slicc/agent/imports && echo in-the-way > /root/v6');
    stage('the state before');
    const before = await look();
    stage('the import');
    const ran = await window.imported('/tmp/profile.zip');
    stage('the state after');
    return { ran, before, after: await look() };
  });
  assert.equal(failed.ran.status, 1);
  assert.match(failed.ran.stderr, /^freezer: couldn't write \/root\/v6\/home-user\/todo\.txt/);
  assert.deepEqual(failed.after, failed.before);
  const retried = await staged(page, 'the retried import', async () => {
    await window.sh('rm /root/v6');
    stage('the import');
    const ran = await window.imported('/tmp/profile.zip');
    if (ran.status === 0) await window.listed(3);
    return ran;
  });
  assert.equal(retried.status, 0, retried.stdout);
});

test('a newer export of the same profile adds only the conversations that grew, as "(updated)", and keeps seven-side edits', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/v1.zip', await readFile(FIXTURE));
  const changed = {
    ...files({ grown: true, readme: '# Deploy\n\nRun ./deploy.sh --dry-run first\n' }),
    'files/cones/research/notes.md': 'Vendor B is faster.\n',
  };
  await upload(
    page,
    '/tmp/v2.zip',
    profile({
      contents: changed,
      overrides: {
        exportId: EXPORT_ID.replace(/^6f/, '7a'),
        createdAt: '2026-07-20T10:00:00.000Z',
      },
    })
  );
  const seen = await staged(page, 'a newer export', async () => {
    const out = async (command) => (await window.sh(command)).stdout;
    stage('the first import');
    const first = await window.imported('/tmp/v1.zip');
    stage('the thaw and the edit');
    await window.connection.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    await window.sh('echo "my seven edit" >> /home/cone-2/workspace/README.md');
    stage('the second import');
    const second = await window.imported('/tmp/v2.zip');
    await when(
      [window.connection.frozen],
      () => window.rows().some((row) => row.title.endsWith('(updated)')),
      'the updated row'
    );
    stage('the files and the second thaw');
    return {
      first: first.status,
      second: second.stdout,
      rows: window.rows(),
      kept: await out('cat /home/cone-2/workspace/README.md'),
      beside: await out('cat /home/cone-2/workspace.v6-*/README.md'),
      notes: await out('cat /home/cone-3/workspace/notes.md'),
      thawed: (await window.connection.control.thaw('frozen-4', BACKGROUND_CONTEXT)).id,
    };
  });
  const after = await staged(page, 'the thawed update', () =>
    when(
      agentSources(window.connection),
      () => {
        const rows = window.connection.frozen.value.filter(
          (row) => !row.live && row.kind === 'cone'
        );
        const entries = window.connection.transcript.value.entries;
        const note = entries.findLast((entry) => entry.kind === 'slicc.thawed');
        return (
          !rows.some((row) => row.id === 'frozen-4') && {
            rows: rows.map(({ id, title, v6 }) => `${id} ${title}${v6 ? ' v6' : ''}`).sort(),
            active: window.connection.agents.value.active,
            note: note?.model[0].content,
            grown: entries.some((entry) =>
              JSON.stringify(entry.model ?? '').includes('Added --dry-run.')
            ),
          }
        );
      },
      'the thawed update'
    )
  );
  assert.equal(seen.first, 0);
  assert.match(seen.second, /^Imported 1 frozen cone from https:\/\/www\.sliccy\.ai: frozen-4\./);
  assert.deepEqual(seen.rows, [
    { id: 'frozen-2', name: 'research', title: 'Research notes', messages: 2 },
    { id: 'frozen-3', name: 'Old planning chat', title: 'Old planning chat', messages: 2 },
    { id: 'frozen-4', name: 'sliccy', title: 'Fix the deploy script (updated)', messages: 5 },
  ]);
  assert.equal(seen.kept, '# Deploy\n\nRun ./deploy.sh\nmy seven edit\n');
  assert.equal(seen.beside, '# Deploy\n\nRun ./deploy.sh --dry-run first\n');
  assert.equal(seen.notes, 'Vendor B is faster.\n');
  assert.equal(seen.thawed, 'cone-2');
  assert.equal(after.active, 'cone-2');
  assert.equal(after.grown, true);
  assert.match(
    after.note,
    /SLICC 6's \/workspace is now ~\/workspace\.v6-\d{4}-\d\d-\d\d \(\/home\/cone-2\/workspace\.v6-/
  );
  assert.deepEqual(after.rows, [
    'frozen-2 Research notes v6',
    'frozen-3 Old planning chat v6',
    'frozen-5 Fix the deploy script',
  ]);
});

test('a profile of a few hundred MB imports, read from the zip by ranges', async (t) => {
  const page = await booted(t);
  const size = 100 * 1024 ** 2;
  const hash = createHash('sha256');
  const block = Buffer.alloc(1024 ** 2);
  for (let n = 0; n < size / block.length; n++) hash.update(block);
  const sha256 = hash.digest('hex');
  const big = [0, 1, 2].map((n) => ({ path: `files/home-user/big-${n}.bin`, size, sha256 }));
  const contents = files();
  const head = manifest(contents, { files: [...manifest(contents).files, ...big] });
  const small = [
    ['manifest.json', Buffer.from(JSON.stringify(head)).toString('base64')],
    ...Object.entries(contents).map(([name, data]) => [name, Buffer.from(data).toString('base64')]),
  ];
  await staged(page, 'the big zip', ([small, big]) => window.bigZip('/tmp/big.zip', small, big), [
    small,
    big,
  ]);
  const seen = await staged(page, 'the big import', async () => {
    const ran = await window.imported('/tmp/big.zip');
    stage('the sizes');
    const sizes = await window.sh('stat -c "%s %n" /tmp/big.zip /root/v6/home-user/big-*.bin');
    return { ran, sizes: sizes.stdout, rows: window.rows().length };
  });
  assert.equal(seen.ran.status, 0, seen.ran.stderr);
  assert.match(seen.ran.stdout, /^Imported 3 frozen cones/);
  const lines = seen.sizes.trim().split('\n');
  assert.ok(Number(lines[0].split(' ')[0]) > 3 * size, lines[0]);
  assert.deepEqual(
    lines.slice(1),
    [0, 1, 2].map((n) => `${size} /root/v6/home-user/big-${n}.bin`)
  );
});

test('cancelling a large import while it writes rolls it back and leaves nothing behind', async (t) => {
  const page = await booted(t);
  const size = 100 * 1024 ** 2;
  const hash = createHash('sha256');
  const block = Buffer.alloc(1024 ** 2);
  for (let n = 0; n < size / block.length; n++) hash.update(block);
  const sha256 = hash.digest('hex');
  const big = [0, 1, 2].map((n) => ({ path: `files/home-user/big-${n}.bin`, size, sha256 }));
  const contents = files();
  const head = manifest(contents, { files: [...manifest(contents).files, ...big] });
  const small = [
    ['manifest.json', Buffer.from(JSON.stringify(head)).toString('base64')],
    ...Object.entries(contents).map(([name, data]) => [name, Buffer.from(data).toString('base64')]),
  ];
  await staged(page, 'the big zip', ([small, big]) => window.bigZip('/tmp/big.zip', small, big), [
    small,
    big,
  ]);
  const seen = await staged(page, 'the cancelled import', async () => {
    const look = async () => ({
      homes: (await window.sh('ls -A /home')).stdout,
      root: (await window.sh('ls -A /root')).stdout,
      skills: (await window.sh('ls -A /usr/share/skills')).stdout,
      imports: (await window.sh('ls -A /var/lib/slicc/agent/imports')).stdout,
      users: (await window.kernel.users.list()).map((user) => user.name),
      rows: window.rows().length,
    });
    stage('the state before');
    const before = await look();
    stage('the cancelled import');
    const root = await navigator.storage.getDirectory();
    const file = await (
      await (await root.getDirectoryHandle('tmp')).getFileHandle('big.zip')
    ).getFile();
    const phases = [];
    let cancelled = false;
    window.agent.on('importing', (value) => {
      phases.push(value.phase);
      if (value.phase === 'writing' && !cancelled) {
        cancelled = true;
        window.agent.importCancel();
      }
    });
    const refused = await window.agent.importProfile(file, { preview: false }).then(
      () => 'resolved',
      (error) => error.message
    );
    stage('the state after');
    return { before, after: await look(), refused, phases, cancelled };
  });
  assert.equal(seen.cancelled, true, seen.phases.join());
  assert.equal(seen.refused, 'The import was cancelled.');
  assert.deepEqual(seen.after, seen.before);
});

test('freezer import never writes memory through a symlink, and leaves its target and everything else alone', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const seen = await staged(page, 'an import into a memory symlink', async () => {
    await window.sh(
      'mkdir -p /root/.pi/agent/memory && echo keep > /etc/kept && ln -s /etc/kept /root/.pi/agent/memory/MEMORY.md'
    );
    stage('the import');
    const ran = await window.imported('/tmp/profile.zip');
    stage('the state after');
    return {
      ran,
      kept: (await window.sh('cat /etc/kept')).stdout,
      homes: (await window.sh('ls -A /home')).stdout,
      rows: window.rows().length,
    };
  });
  assert.equal(seen.ran.status, 1);
  assert.equal(
    seen.ran.stderr,
    "freezer: /root/.pi/agent/memory/MEMORY.md is a symlink, and the import won't write memory through it\n"
  );
  assert.equal(seen.kept, 'keep\n');
  assert.equal(seen.rows, 0);
  assert.doesNotMatch(seen.homes, /cone-/);
});

test('a newer export with changed crons replaces the earlier commented-out jobs by name and keeps their scoop target', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/v1.zip', await readFile(FIXTURE));
  const licks = JSON.parse(files()['licks.json']);
  licks.tasks[0].prompt = 'Summarize the logs again';
  await upload(
    page,
    '/tmp/v2.zip',
    profile({
      contents: { ...files(), 'licks.json': JSON.stringify(licks) },
      overrides: { exportId: EXPORT_ID.replace(/^6f/, '5d') },
    })
  );
  const table = await staged(page, 'two exports with crons', async () => {
    stage('the first import');
    await window.imported('/tmp/v1.zip');
    stage('the second import');
    await window.imported('/tmp/v2.zip');
    stage('the crontab');
    return (await window.sh('crontab -u cone-2 -l')).stdout;
  });
  assert.equal(table.match(/# # name: v6-task-1/g).length, 1, table);
  assert.match(
    table,
    /^# 30 8 \* \* \* agent send scoop:helper --lick=cron 'Summarize the logs again'$/m
  );
  assert.ok(
    table
      .split('\n')
      .filter(Boolean)
      .every((line) => line.startsWith('#')),
    table
  );
});

test('the fixture is what the generator makes', async () => {
  assert.deepEqual(await readFile(FIXTURE), profile());
  assert.equal(zip([]).length, 22);
});

const lay = async (page, form) => {
  for (const [path, data] of [...Object.entries(form.moved), ...Object.entries(form.written)])
    await upload(page, path, Buffer.from(data));
};

const moved = (form) => Object.keys(form.moved);

test("freezer import --in-place moves six's files out of /slicc-fs into seven, writes the rest, and deletes the export directory", async (t) => {
  const page = await booted(t);
  const form = directory();
  await lay(page, form);
  const preview = await staged(
    page,
    'the in-place preview',
    (dir) => window.imported(dir, '--in-place --preview'),
    DIRECTORY
  );
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(
    preview.stdout,
    /^SLICC 6 profile from www\.sliccy\.ai, exported 2026-07-12: 2 cones,/
  );
  const asked = await staged(
    page,
    'the in-place control preview',
    async (dir) => {
      const answer = await window.connection.control.importProfile(
        { upload: null, data: null, inPlace: dir, again: false, preview: true },
        BACKGROUND_CONTEXT
      );
      return { error: answer.error, done: answer.done, line: answer.line };
    },
    DIRECTORY
  );
  assert.equal(asked.error, null);
  assert.equal(asked.done, false);
  assert.equal(asked.line, preview.stdout);
  const progress = await staged(
    page,
    'the in-place import',
    async (dir) => {
      const seen = [];
      const off = window.connection.importing.subscribe(() =>
        seen.push(window.connection.importing.value.text)
      );
      const ran = await window.imported(dir, '--in-place');
      off?.();
      return { ran, seen };
    },
    DIRECTORY
  );
  assert.equal(progress.ran.status, 0, progress.ran.stdout + progress.ran.stderr);
  assert.match(
    progress.ran.stdout,
    /^Imported 3 frozen cones from https:\/\/www\.sliccy\.ai: frozen-1, frozen-2, frozen-3\./
  );
  const seen = await staged(
    page,
    'the moved files',
    async (sources) => {
      await window.listed(3);
      stage('the moved files');
      const out = async (command) => (await window.sh(command)).stdout;
      const left = [];
      for (const source of sources)
        if ((await window.sh(`test -e ${source}`)).status === 0) left.push(source);
      return {
        left,
        directory: (await window.sh('test -e /slicc-v6-upgrade/*')).status,
        readme: await out('cat /home/cone-2/workspace/README.md'),
        modes: await out(
          'stat -c "%U %a %n" /home/cone-2/workspace/README.md /home/cone-2/workspace/.env /home/cone-2/scoops/helper/out.txt /home/cone-3/workspace/certs/dev.pem /usr/share/skills/deploy-notes /usr/share/skills/deploy-notes/SKILL.md /root/v6/home-user/todo.txt /home/cone-2/sprinkles/dashboard/dashboard.shtml'
        ),
        attachment: await out('ls /home/cone-2/v6-attachments'),
        memory: await out('cat /root/.pi/agent/memory/cone-2/MEMORY.md'),
        git: await out('cat /root/.gitconfig'),
      };
    },
    moved(form)
  );
  assert.deepEqual(seen.left, []);
  assert.equal(seen.directory, 1);
  assert.equal(seen.readme, files()['files/cones/cone/README.md']);
  assert.equal(
    seen.modes,
    [
      'cone-2 600 /home/cone-2/workspace/README.md',
      'cone-2 600 /home/cone-2/workspace/.env',
      'cone-2 600 /home/cone-2/scoops/helper/out.txt',
      'cone-3 600 /home/cone-3/workspace/certs/dev.pem',
      'root 755 /usr/share/skills/deploy-notes',
      'root 644 /usr/share/skills/deploy-notes/SKILL.md',
      'root 644 /root/v6/home-user/todo.txt',
      'cone-2 600 /home/cone-2/sprinkles/dashboard/dashboard.shtml',
      '',
    ].join('\n')
  );
  assert.match(seen.attachment, /^[0-9a-f]{12}-screenshot\.png\n$/);
  assert.match(seen.memory, /Deploys go through deploy\.sh\./);
  assert.match(seen.git, /name = Pat Example/);
  assert.ok(
    progress.seen.some((line) => line.startsWith('Moving')),
    progress.seen.join('|')
  );
  assert.ok(!progress.seen.some((line) => line.startsWith('Importing')), progress.seen.join('|'));
});

test('freezer import --in-place takes a directory form whose manifest leaves out providers, secrets, mcp and the optional cone fields', async (t) => {
  const page = await booted(t);
  const form = directory({
    contents: { 'files/home-user/notes.txt': 'Feed the cat\n' },
    overrides: {
      cones: [{ key: '/workspace::cone_1', folder: 'cone', name: 'sliccy', scoops: [] }],
      frozen: [],
      skills: [],
      sprinkles: [],
      licks: undefined,
      gitconfig: undefined,
      skipped: [],
      flagged: [],
      providers: undefined,
      mcp: undefined,
      secrets: undefined,
    },
  });
  await lay(page, form);
  const preview = await staged(
    page,
    'the bare preview',
    (dir) => window.imported(dir, '--in-place --preview'),
    DIRECTORY
  );
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(
    preview.stdout,
    /^SLICC 6 profile from www\.sliccy\.ai, exported 2026-07-12: 1 cone,/
  );
  const ran = await staged(
    page,
    'the bare import',
    async (dir) => {
      const ran = await window.imported(dir, '--in-place');
      const notes = (await window.sh('cat /root/v6/home-user/notes.txt')).stdout;
      const report = (await window.sh('cat /root/v6-import-*.md')).stdout;
      return { ran, notes, report };
    },
    DIRECTORY
  );
  assert.equal(ran.ran.status, 0, ran.ran.stdout + ran.ran.stderr);
  assert.match(
    ran.ran.stdout,
    /^Imported 1 frozen cone from https:\/\/www\.sliccy\.ai: frozen-1\./
  );
  assert.equal(ran.notes, 'Feed the cat\n');
  assert.match(ran.report, /## Re-enter in Settings\n\n- no providers\n/);
});

test('a failed in-place import moves every file back to /slicc-fs and keeps the directory for the next try', async (t) => {
  const page = await booted(t);
  const form = directory();
  await lay(page, form);
  const stat = (sources) =>
    page.evaluate(
      async (list) => (await window.sh(`stat -c '%U:%G %a %n' ${list.join(' ')}`)).stdout,
      sources
    );
  await page.evaluate(
    (list) => window.sh(`chown nobody:nogroup ${list.join(' ')} && chmod 640 ${list.join(' ')}`),
    moved(form)
  );
  const before = await stat(moved(form));
  const failed = await staged(
    page,
    'the failed in-place import',
    async (dir) => {
      await window.sh(
        'mkdir -p /tmp/elsewhere /root && rm -rf /root/v6 && ln -s /tmp/elsewhere /root/v6'
      );
      stage('the import');
      return window.imported(dir, '--in-place');
    },
    DIRECTORY
  );
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stdout + failed.stderr, /leads through a symlink/);
  const after = await staged(
    page,
    'the files moved back',
    async (sources) => {
      const missing = [];
      for (const source of sources)
        if ((await window.sh(`test -f ${source}`)).status !== 0) missing.push(source);
      return {
        missing,
        readme: (await window.sh('cat /slicc-fs/workspace/README.md')).stdout,
        homes: (await window.sh('ls -d /home/cone-* 2>/dev/null')).stdout,
        skills: (await window.sh('ls /usr/share/skills 2>/dev/null')).stdout,
        directory: (await window.sh(`test -f ${'/slicc-v6-upgrade'}/*/manifest.json`)).status,
        rows: window.rows().length,
      };
    },
    moved(form)
  );
  assert.deepEqual(after.missing, []);
  assert.equal(await stat(moved(form)), before);
  assert.equal(after.readme, files()['files/cones/cone/README.md']);
  assert.equal(after.homes, '');
  assert.equal(after.skills, '');
  assert.equal(after.directory, 0);
  assert.equal(after.rows, 0);
  const again = await staged(
    page,
    'the in-place import again',
    async (dir) => {
      await window.sh('rm /root/v6');
      stage('the import');
      const ran = await window.imported(dir, '--in-place');
      if (ran.status === 0) await window.listed(3);
      return ran;
    },
    DIRECTORY
  );
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

const formRefusals = [
  [
    'a changed file left in place',
    (form) => {
      form.moved['/slicc-fs/home/user/todo.txt'] = 'Water the plantz\n';
    },
    /files\/home-user\/todo\.txt doesn't match its sha256/,
  ],
  [
    'a missing file left in place',
    (form) => {
      delete form.moved['/slicc-fs/home/user/todo.txt'];
    },
    /\/slicc-fs\/home\/user\/todo\.txt is missing/,
  ],
  [
    'a source outside /slicc-fs',
    (form) => {
      const file = form.manifest.files.find((item) => item.path === 'files/home-user/todo.txt');
      file.source = '/etc/passwd';
    },
    /source must be a path under \/slicc-fs\//,
  ],
  [
    'a source on a transcript',
    (form) => {
      const file = form.manifest.files.find((item) => item.path === 'licks.json');
      file.source = '/slicc-fs/licks.json';
    },
    /can't stay in place/,
  ],
  [
    'a file that is both written and left in place',
    (form) => {
      form.written[`${DIRECTORY}/files/home-user/todo.txt`] = 'Water the plants\n';
    },
    /files\/home-user\/todo\.txt is both in/,
  ],
  [
    'an unlisted file in the directory',
    (form) => {
      form.written[`${DIRECTORY}/files/home-user/extra`] = 'x';
    },
    /files\/home-user\/extra is not listed in the manifest/,
  ],
  [
    'a written file that is missing',
    (form) => {
      delete form.written[`${DIRECTORY}/licks.json`];
    },
    /licks\.json is in the manifest but not in/,
  ],
  [
    'a zip manifest',
    (form) => {
      form.manifest.version = 1;
      for (const file of form.manifest.files) delete file.source;
    },
    /the export version must be 2/,
  ],
  [
    'parts',
    (form) => {
      form.manifest.part = { index: 1, of: 2 };
    },
    /never split into parts/,
  ],
  [
    'a name that climbs out of its cone',
    (form) => {
      form.manifest.files.push({
        path: 'files/cones/cone/../.pi/agent/settings.json',
        size: 3,
        sha256: 'a'.repeat(64),
        source: '/slicc-fs/x.json',
      });
    },
    /refused the entry name "files\/cones\/cone\/\.\.\/\.pi\/agent\/settings\.json"/,
  ],
  [
    'files that add up to over 4 GiB',
    (form) => {
      form.manifest.files = form.manifest.files.map((file) => ({ ...file, size: 256 * 1024 ** 2 }));
    },
    /the files add up to over 4 GiB/,
  ],
  [
    'another export id',
    (form) => {
      form.manifest.exportId = '00000000-0000-4000-8000-000000000000';
    },
    /holds the export 00000000/,
  ],
];

test('freezer import --in-place checks the directory form before anything moves', async (t) => {
  const page = await booted(t);
  for (const [what, edit, error] of formRefusals) {
    await page.evaluate(() => window.sh('rm -rf /slicc-fs /slicc-v6-upgrade'));
    const form = directory();
    edit(form);
    form.written[`${DIRECTORY}/manifest.json`] = `${JSON.stringify(form.manifest, null, 2)}\n`;
    await lay(page, form);
    const ran = await staged(page, what, (dir) => window.imported(dir, '--in-place'), DIRECTORY);
    assert.equal(ran.status, 1, `${what}: ${ran.stdout}`);
    assert.match(ran.stderr + ran.stdout, error, what);
    const homes = await page.evaluate(
      async () => (await window.sh('ls -d /home/cone-* 2>/dev/null')).stdout
    );
    assert.equal(homes, '', what);
  }
  const outside = await staged(page, 'an import outside the upgrade directory', () =>
    window.imported('/tmp', '--in-place')
  );
  assert.equal(outside.status, 1);
  assert.match(
    outside.stdout + outside.stderr,
    /\/tmp isn't a SLICC 6 upgrade in \/slicc-v6-upgrade/
  );
});
