import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { FIXTURE, files, manifest, profile, zip } from './fixtures/slicc6-profile.mjs';

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
  window.imported = (path, flags = '') => window.sh(`freezer import ${flags} ${path}`);
  window.rows = () => window.connection.frozen.value.filter((row) => !row.live);
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
  const usage = await page.evaluate(() => window.imported('/tmp/profile.zip'));
  assert.equal(usage.status, 2);
});

const refusals = [
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

test('the fixture is what the generator makes', async () => {
  assert.deepEqual(await readFile(FIXTURE), profile());
  assert.equal(zip([]).length, 22);
});
