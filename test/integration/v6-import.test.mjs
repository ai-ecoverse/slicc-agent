import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { EXPORT_ID, FIXTURE, files, manifest, profile, zip } from './fixtures/slicc6-profile.mjs';

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
  window.start = async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    window.kernel = await bootKernel();
    const answers = Array.from({ length: 6 }, (_, n) => `answer=Answer ${n + 1}.`).join('&');
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: {
        connect: (options) =>
          window.kernel.connect(options?.user ? { user: options.user } : undefined),
        users: window.kernel.users,
      },
    });
    window.connection = await owner.connect();
    window.agent = createAgentModel(window.connection, { storage: localStorage }).agent;
    await window.agent.ready();
    for (let n = 0; n < 400; n++) {
      if ((await window.sh('freezer list')).status === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
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

async function booted(t) {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate(() => window.start());
  return page;
}

const upload = (page, path, bytes) =>
  page.evaluate(
    ([path, data]) => window.put(path, data),
    [path, Buffer.from(bytes).toString('base64')]
  );

test('freezer import --preview checks a SLICC 6 profile export and says what is in it', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const ran = await page.evaluate(() => window.imported('/tmp/profile.zip', '--preview'));
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(
    ran.stdout,
    'SLICC 6 profile from www.sliccy.ai, exported 2026-07-12: 2 cones, 1 scoop, 1 frozen session, 0.2 KB of files, 1 skill (for every agent), 2 crons (imported off), 1 webhook (new URLs needed), 2 credential-like files to review. Re-enter in Settings: anthropic, openai. Not imported: 1 mount.\n'
  );
  const usage = await page.evaluate(() => window.imported('/tmp/profile.zip', '--bogus'));
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
    () => profile({ overrides: { version: 2 } }),
    /This export is from a newer SLICC 6; update seven\./,
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
    const ran = await page.evaluate(() => window.imported('/tmp/bad.zip', '--preview'));
    assert.equal(ran.status, 1, `${what}: ${ran.stdout}`);
    assert.match(ran.stderr + ran.stdout, error, what);
  }
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const plain = await page.evaluate(async () => ({
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

test('freezer import turns a SLICC 6 profile into frozen cones with their files at cone modes, and a thaw forks one', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const ran = await page.evaluate(() => window.imported('/tmp/profile.zip'));
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(
    ran.stdout,
    /^Imported 3 frozen cones from https:\/\/www\.sliccy\.ai: frozen-1, frozen-2, frozen-3\.\nRe-enter in Settings: anthropic, openai\.\n$/
  );
  await page.within(30000, () => window.rows().length === 3);
  const seen = await page.evaluate(async () => {
    const out = async (command) => (await window.sh(command)).stdout;
    return {
      rows: window.rows(),
      modes: await out(
        'stat -c "%U %a %n" /home/cone-2 /home/cone-2/workspace /home/cone-2/workspace/.env /home/cone-2/workspace/deploy.sh /home/cone-2/scoops/helper/out.txt /home/cone-3/workspace/certs/dev.pem'
      ),
      env: await out('cat /home/cone-2/workspace/.env'),
      attachment: await out('ls /home/cone-2/v6-attachments'),
      homeUser: await out('cat /root/v6/home-user/todo.txt'),
      staging: await out('ls -A /var/lib/slicc/agent/imports'),
    };
  });
  assert.deepEqual(seen.rows, [
    { id: 'frozen-1', name: 'sliccy', title: 'Fix the deploy script', messages: 3 },
    { id: 'frozen-2', name: 'research', title: 'Research notes', messages: 2 },
    { id: 'frozen-3', name: 'Old planning chat', title: 'Old planning chat', messages: 2 },
  ]);
  assert.equal(
    seen.modes,
    [
      'cone-2 710 /home/cone-2',
      'cone-2 700 /home/cone-2/workspace',
      'cone-2 600 /home/cone-2/workspace/.env',
      'cone-2 600 /home/cone-2/workspace/deploy.sh',
      'cone-2 600 /home/cone-2/scoops/helper/out.txt',
      'cone-3 600 /home/cone-3/workspace/certs/dev.pem',
      '',
    ].join('\n')
  );
  assert.equal(seen.env, 'API_KEY=sk-test-not-a-real-key\n');
  assert.match(seen.attachment, /^[0-9a-f]{12}-screenshot\.png\n$/);
  assert.equal(seen.homeUser, 'Water the plants\n');
  assert.equal(seen.staging, '');
  const thawed = await page.evaluate(async () => {
    const thaw = await window.connection.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    await window.agent.select(thaw.id);
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
  const twice = await page.evaluate(async () => ({
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

test('a failed freezer import leaves nothing behind, and the same zip imports once the problem is gone', async (t) => {
  const page = await booted(t);
  await upload(page, '/tmp/profile.zip', await readFile(FIXTURE));
  const failed = await page.evaluate(async () => {
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
    const before = await look();
    const ran = await window.imported('/tmp/profile.zip');
    return { ran, before, after: await look() };
  });
  assert.equal(failed.ran.status, 1);
  assert.match(failed.ran.stderr, /^freezer: couldn't write \/root\/v6\/home-user\/todo\.txt/);
  assert.deepEqual(failed.after, failed.before);
  const retried = await page.evaluate(async () => {
    await window.sh('rm /root/v6');
    return window.imported('/tmp/profile.zip');
  });
  assert.equal(retried.status, 0, retried.stdout);
  await page.within(30000, () => window.rows().length === 3);
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
  const seen = await page.evaluate(async () => {
    const out = async (command) => (await window.sh(command)).stdout;
    const first = await window.imported('/tmp/v1.zip');
    await window.connection.control.thaw('frozen-1', BACKGROUND_CONTEXT);
    await window.sh('echo "my seven edit" >> /home/cone-2/workspace/README.md');
    const second = await window.imported('/tmp/v2.zip');
    for (let n = 0; n < 200 && !window.rows().some((row) => row.title.endsWith('(updated)')); n++)
      await new Promise((resolve) => setTimeout(resolve, 50));
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
  const after = await page.within(30000, () => {
    const rows = window.connection.frozen.value.filter((row) => !row.live && row.kind === 'cone');
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
  });
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
  await page.evaluate(([small, big]) => window.bigZip('/tmp/big.zip', small, big), [small, big]);
  const seen = await page.evaluate(async () => {
    const ran = await window.imported('/tmp/big.zip');
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

test('the fixture is what the generator makes', async () => {
  assert.deepEqual(await readFile(FIXTURE), profile());
  assert.equal(zip([]).length, 22);
});
