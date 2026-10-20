import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

export const FIXTURE = fileURLToPath(new URL('./slicc6-profile-v1.zip', import.meta.url));
export const EXPORT_ID = '6f1c2b0e-8d4a-4c3e-9b7a-2f5d1e0c9a11';
export const ORIGIN = 'https://www.sliccy.ai';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const stored = entry.method === 8 ? deflateRawSync(data) : data;
    const size = entry.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800 | (entry.flags ?? 0), 6);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.mode === undefined ? 20 : 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800 | (entry.flags ?? 0), 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const sha = (data) => createHash('sha256').update(data).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const at = (minute) => `2026-07-12T09:${String(minute).padStart(2, '0')}:00.000Z`;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const usage = {
  input: 120,
  output: 40,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 160,
  cost: { input: 0.0004, output: 0.0006, cacheRead: 0, cacheWrite: 0, total: 0.001 },
};
const model = { provider: 'anthropic', id: 'claude-sonnet-4-5', api: 'anthropic-messages' };

function message(id, sequence, role, content, extra = {}) {
  return { id, sequence, role, timestamp: at(sequence), content, ...extra };
}

function transcript({ id, title, state = 'active', conversations, attachments = [], frozenAt }) {
  return {
    schemaVersion: 1,
    export: {
      id: `${id}-export`,
      generatedAt: at(50),
      producer: { application: 'slicc', version: '6.42.0' },
      format: 'slicc-transcript',
    },
    session: {
      id,
      title,
      state,
      createdAt: at(0),
      updatedAt: at(30),
      ...(frozenAt ? { frozenAt } : {}),
      completeness: { status: 'complete', missing: [] },
    },
    privacy: {
      reasoningExcluded: true,
      excludedReasoningBlocks: 1,
      binaryAttachments: 'included-unchanged',
      redactionCounts: { 'known-secret': 1 },
      redactions: [
        {
          id: 'r1',
          category: 'known-secret',
          detector: 'known-secret',
          target: { kind: 'json', pointer: '/conversations/0/messages/1/content/0/text' },
        },
      ],
    },
    conversations,
    delegations: [],
    attachments,
  };
}

function coneTranscript(more = []) {
  const cone = [
    message('m1', 1, 'user', [
      { type: 'text', text: 'Please fix the deploy script' },
      { type: 'attachment-ref', attachmentId: 'a1' },
    ]),
    message(
      'm2',
      2,
      'assistant',
      [
        { type: 'text', text: 'Reading it now. The token is ⟦REDACTED:known-secret⟧.' },
        {
          type: 'tool-call',
          id: 'call_1',
          name: 'read_file',
          input: { path: '/workspace/deploy.sh' },
        },
      ],
      { model, usage, stopReason: 'toolUse' }
    ),
    message('m3', 3, 'tool-result', [{ type: 'text', text: '#!/bin/sh\necho deploy' }], {
      toolCallId: 'call_1',
    }),
    message(
      'm4',
      4,
      'assistant',
      [{ type: 'text', text: 'Fixed: the script now exits on errors.' }],
      {
        model,
        usage,
        stopReason: 'stop',
      }
    ),
    ...more,
  ];
  return transcript({
    id: 'cone_1',
    title: 'Fix the deploy script',
    conversations: [
      { id: 'cone_1', kind: 'cone', name: 'sliccy', folder: 'cone', messages: cone },
      {
        id: 'scoop_helper',
        kind: 'scoop',
        name: 'helper',
        folder: 'helper',
        parentConversationId: 'cone_1',
        messages: [
          message('h1', 1, 'user', [{ type: 'text', text: 'Collect the build logs' }]),
          message('h2', 2, 'assistant', [{ type: 'text', text: 'The logs are in out.txt.' }], {
            model,
            usage,
          }),
        ],
      },
    ],
    attachments: [
      {
        id: 'a1',
        path: `attachments/${sha(PNG)}`,
        originalName: 'screenshot.png',
        mimeType: 'image/png',
        byteLength: PNG.length,
        sha256: sha(PNG),
        sourceConversationId: 'cone_1',
        sourceMessageId: 'm1',
        handling: 'binary-unchanged',
        present: true,
      },
    ],
  });
}

const researchTranscript = () =>
  transcript({
    id: 'cone_2',
    title: 'Research notes',
    conversations: [
      {
        id: 'cone_2',
        kind: 'cone',
        name: 'research',
        folder: 'research',
        messages: [
          message('r1', 1, 'user', [{ type: 'text', text: 'Compare the two vendors' }]),
          message('r2', 2, 'assistant', [{ type: 'text', text: 'Vendor A is cheaper.' }], {
            model,
            usage,
          }),
        ],
      },
    ],
  });

const frozenTranscript = () =>
  transcript({
    id: 'session-1',
    title: 'Old planning chat',
    state: 'frozen',
    frozenAt: at(20),
    conversations: [
      {
        id: 'session-1',
        kind: 'cone',
        name: 'sliccy',
        messages: [
          message('s1', 1, 'user', [{ type: 'text', text: 'Plan the launch' }]),
          message('s2', 2, 'assistant', [{ type: 'text', text: 'Launch on Monday.' }], {
            model,
            usage,
          }),
        ],
      },
    ],
  });

const SPRINKLE = `<!doctype html>
<title>Dashboard</title>
<script>
  slicc.lick({ action: 'refresh' });
  slicc.readFile('/workspace/status.json');
</script>
`;

const licks = {
  crontasks: [
    {
      id: 'ct1',
      name: 'Standup',
      cron: '0 9 * * 1-5',
      filter: 'event => event.day !== "sat"',
      nextRun: null,
      lastRun: null,
      status: 'active',
      createdAt: at(1),
      targetFolder: null,
    },
  ],
  tasks: [
    {
      id: 't1',
      groupFolder: 'helper',
      prompt: 'Summarize the build logs',
      scheduleType: 'cron',
      scheduleValue: '30 8 * * *',
      status: 'active',
      nextRun: null,
      lastRun: null,
      createdAt: at(2),
    },
    {
      id: 't2',
      groupFolder: 'cone',
      prompt: 'Check the build',
      scheduleType: 'interval',
      scheduleValue: '3600000',
      status: 'active',
      nextRun: null,
      lastRun: null,
      createdAt: at(3),
    },
  ],
  webhooks: [
    { id: 'w1', name: 'GitHub Push', createdAt: at(4), scoop: 'helper', targetFolder: 'helper' },
  ],
};

export function files({ grown = false, readme = '# Deploy\n\nRun ./deploy.sh\n' } = {}) {
  return {
    'transcripts/cone.json': json(
      coneTranscript(
        grown
          ? [
              message('m5', 5, 'user', [{ type: 'text', text: 'Now add a dry run' }]),
              message('m6', 6, 'assistant', [{ type: 'text', text: 'Added --dry-run.' }], {
                model,
                usage,
              }),
            ]
          : []
      )
    ),
    'transcripts/research.json': json(researchTranscript()),
    'frozen/session-1.json': json(frozenTranscript()),
    [`attachments/${sha(PNG)}`]: PNG,
    'files/cones/cone/README.md': readme,
    'files/cones/cone/deploy.sh': '#!/bin/sh\nset -e\necho deploy\n',
    'files/cones/cone/.env': 'API_KEY=sk-test-not-a-real-key\n',
    'files/cones/research/notes.md': 'Vendor A is cheaper.\n',
    'files/cones/research/certs/dev.pem':
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    'files/scoops/helper/out.txt': 'build ok\n',
    'files/home-user/todo.txt': 'Water the plants\n',
    'memory/global.md': '# Shared\n\nThe user prefers short answers.\n',
    'memory/cone.md': '## Project\n\nDeploys go through deploy.sh.\n',
    'skills/deploy-notes/SKILL.md':
      '---\nname: deploy-notes\ndescription: How this project deploys.\n---\n\nRun ./deploy.sh from the workspace.\n',
    'sprinkles/dashboard/dashboard.shtml': SPRINKLE,
    'licks.json': json(licks),
    'git/gitconfig': '[user]\n\tname = Pat Example\n\temail = pat@example.com\n',
  };
}

function totals(contents) {
  const names = Object.keys(contents);
  const under = (...tops) =>
    names.filter((name) => tops.some((top) => name.startsWith(`${top}/`))).length;
  const listed = licks;
  return {
    cones: 2,
    scoops: 1,
    frozen: 1,
    files: under('files'),
    bytes: Object.values(contents).reduce((sum, data) => sum + Buffer.byteLength(data), 0),
    entries: names.length + 1,
    attachments: under('attachments'),
    skills: 1,
    sprinkles: 1,
    crontasks: listed.crontasks.length,
    tasks: listed.tasks.length,
    webhooks: listed.webhooks.length,
    flagged: 2,
  };
}

export function manifest(contents, overrides = {}) {
  return {
    format: 'slicc-profile',
    version: 1,
    exportId: EXPORT_ID,
    producer: { slicc: '6.42.0', origin: ORIGIN },
    createdAt: '2026-07-12T10:00:00.000Z',
    cones: [
      {
        key: '/workspace::cone_1',
        folder: 'cone',
        name: 'sliccy',
        conversation: 'cone_1',
        transcript: 'transcripts/cone.json',
        files: 'files/cones/cone/',
        memory: 'memory/cone.md',
        scoops: [
          {
            key: '/scoops/helper/workspace::scoop_helper',
            folder: 'helper',
            name: 'helper',
            conversation: 'scoop_helper',
            files: 'files/scoops/helper/',
          },
        ],
      },
      {
        key: '/cones/research/workspace::cone_2',
        folder: 'research',
        name: 'research',
        conversation: 'cone_2',
        transcript: 'transcripts/research.json',
        files: 'files/cones/research/',
        memory: null,
        scoops: [],
      },
    ],
    frozen: [
      {
        id: 'session-1',
        title: 'Old planning chat',
        frozenAt: at(20),
        transcript: 'frozen/session-1.json',
      },
    ],
    skills: [{ name: 'deploy-notes', path: 'skills/deploy-notes/' }],
    sprinkles: [{ name: 'dashboard', path: 'sprinkles/dashboard/' }],
    licks: 'licks.json',
    gitconfig: 'git/gitconfig',
    files: Object.entries(contents).map(([path, data]) => ({
      path,
      size: Buffer.byteLength(data),
      sha256: sha(data),
    })),
    skipped: [
      { path: '/mnt/photos', reason: 'mount' },
      { path: '/workspace/node_modules', reason: 'cache' },
      { path: '/workspace/.git/hooks', reason: 'cache' },
    ],
    flagged: [
      { path: 'files/cones/cone/.env', rule: 'env' },
      { path: 'files/cones/research/certs/dev.pem', rule: 'pem' },
    ].map((item) => ({ ...item, size: Buffer.byteLength(contents[item.path] ?? '') })),
    providers: ['anthropic', 'openai'],
    mcp: [{ name: 'docs', url: 'https://mcp.example.com/sse' }],
    secrets: ['github-token'],
    redactionCounts: { 'known-secret': 1 },
    totals: totals(contents),
    ...overrides,
  };
}

export function profile({ contents = files(), overrides = {}, edit = (entries) => entries } = {}) {
  const head = { name: 'manifest.json', data: json(manifest(contents, overrides)) };
  const rest = Object.entries(contents).map(([name, data]) => ({ name, data }));
  return zip(edit([head, ...rest]));
}

export const DIRECTORY = `/slicc-v6-upgrade/${EXPORT_ID}`;

const PLACES = [
  ['files/cones/cone/', '/slicc-fs/workspace/'],
  ['files/cones/research/', '/slicc-fs/cones/research/workspace/'],
  ['files/scoops/helper/', '/slicc-fs/scoops/helper/workspace/'],
  ['files/home-user/', '/slicc-fs/home/user/'],
  ['skills/', '/slicc-fs/workspace/skills/'],
  ['sprinkles/', '/slicc-fs/shared/sprinkles/'],
];

export function sourceOf(path) {
  const found = PLACES.find(([prefix]) => path.startsWith(prefix));
  return found ? `${found[1]}${path.slice(found[0].length)}` : undefined;
}

export function directory({ contents = files(), overrides = {}, keep = () => false } = {}) {
  const plain = manifest(contents, { version: 2, ...overrides });
  const moved = {};
  const written = {};
  plain.files = plain.files.map((file) => {
    const source = keep(file.path) ? undefined : sourceOf(file.path);
    if (source) moved[source] = contents[file.path];
    else written[`${DIRECTORY}/${file.path}`] = contents[file.path];
    return source ? { ...file, source } : file;
  });
  written[`${DIRECTORY}/manifest.json`] = json(plain);
  return { manifest: plain, moved, written };
}

if (argv[1] === fileURLToPath(import.meta.url)) await writeFile(FIXTURE, profile());
