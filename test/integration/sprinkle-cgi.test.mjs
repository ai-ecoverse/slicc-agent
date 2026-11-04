import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const JSH = [
  'package.json',
  'dist/jsh.mjs',
  'dist/vendor/readable-stream.cjs',
  'dist/vendor/string_decoder.cjs',
  'dist/vendor/node-lib.cjs',
];

const SCRIPTS = {
  'notes.shtml': '<!doctype html><html><head><title>Notes</title></head><body></body></html>',
  'store.json': '[]',
  'cgi-bin/list': [
    '#!/bin/sh',
    "printf 'Content-Type: application/json\\r\\nX-Notes: 2\\r\\n\\r\\n'",
    'cat store.json',
  ].join('\n'),
  'cgi-bin/add': [
    '#!/usr/bin/env jsh',
    "const fs = require('fs');",
    "const body = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "const list = JSON.parse(fs.readFileSync('store.json', 'utf8'));",
    'const { REQUEST_METHOD, PATH_INFO, QUERY_STRING, CONTENT_TYPE, HTTP_X_ASKED, REMOTE_USER, SLICC_SPRINKLE, SLICC_OWNER, SLICC_TAB, GATEWAY_INTERFACE } = process.env;',
    'list.push({ text: body.text, REQUEST_METHOD, PATH_INFO, QUERY_STRING, CONTENT_TYPE, HTTP_X_ASKED, REMOTE_USER, SLICC_SPRINKLE, SLICC_OWNER, SLICC_TAB, GATEWAY_INTERFACE });',
    "fs.writeFileSync('store.json', JSON.stringify(list));",
    "const sent = require('child_process').spawnSync('agent', ['send', SLICC_OWNER, '--lick=sprinkle', '--source', 'notes', '-'], { input: 'added ' + body.text, encoding: 'utf8' });",
    "process.stderr.write('agent ' + sent.status + ' ' + sent.stderr + '\\n');",
    "process.stdout.write('Status: 201 Created\\nContent-Type: application/json\\n\\n' + JSON.stringify({ ok: true, count: list.length }));",
  ].join('\n'),
  'cgi-bin/fail': ['#!/bin/sh', 'echo broken >&2', 'exit 3'].join('\n'),
  'cgi-bin/early': ['#!/bin/sh', "printf 'Status: 103 Early Hints\\n\\n'"].join('\n'),
  'cgi-bin/open': ['#!/bin/sh', 'echo planted'].join('\n'),
  'cgi-bin/slow': ['#!/bin/sh', 'sleep 2', 'echo slow'].join('\n'),
};

const helpers = () => {
  window.boot = async (jsh) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel(
      { 'node_modules/@ai-ecoverse/slicc-jsh/': jsh },
      { users: 'enforce' }
    );
    window.sh = (command, user, stdin) =>
      kernel.run(['bash', '-c', command], {
        ...(user ? { user } : {}),
        ...(stdin ? { stdin } : {}),
      });
    const answers = Array.from({ length: 4 }, () => 'answer=Noted.').join('&');
    window.owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: {
        connect: (options) => kernel.connect(options?.user ? { user: options.user } : undefined),
        users: kernel.users,
      },
    });
    window.connection = await window.owner.connect();
    window.model = createAgentModel(window.connection, {
      storage: localStorage,
      page: { tab: 'tab-1', run: () => ({ stdout: '', stderr: '', code: 0 }) },
    });
    window.agent = window.model.agent;
    await window.agent.ready();
  };
  window.licks = () =>
    window.agent
      .messages()
      .filter((message) => message.role === 'lick')
      .map(({ channel, title, text }) => ({ channel, title, text }));
  window.cgi = async (request) => {
    const body = request.body === undefined ? null : btoa(request.body);
    const reply = await window.model.sprinkles.call('cone/notes', 'cgi', [
      { method: 'GET', query: '', headers: [], ...request, body },
    ]);
    let bytes = atob(reply.body);
    let { done, stream } = reply;
    while (!done) {
      const chunk = await window.model.sprinkles.call('cone/notes', 'cgiRead', [stream]);
      bytes += atob(chunk.body);
      done = chunk.done;
    }
    const type = reply.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    return {
      status: reply.status,
      statusText: reply.statusText,
      headers: Object.fromEntries(
        reply.headers.map(([name, value]) => [name.toLowerCase(), value])
      ),
      body: bytes && type?.startsWith('application/json') ? JSON.parse(bytes) : bytes,
    };
  };
};

test('a sprinkle runs its own cgi-bin scripts as its owner: sh and jsh, CGI/1.1 headers, the store change, a sprinkle lick, errors and refusals', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'the agent', (jsh) => window.boot(jsh), JSH);
  await staged(
    page,
    'the sprinkle',
    async (files) => {
      const folder = '/home/cone/sprinkles/notes';
      for (const [name, text] of Object.entries(files)) {
        const made = await window.sh(
          `mkdir -p "$(dirname ${folder}/${name})" && cat > ${folder}/${name}`,
          'cone',
          text
        );
        if (made.status) throw new Error(made.stderr);
      }
      await window.sh(`chmod 666 ${folder}/cgi-bin/open`, 'cone');
      await when(
        [heard(window.model.sprinkles, 'sprinkles'), every(200)],
        () => window.model.sprinkles.list().some((item) => item.id === 'cone/notes'),
        'the notes sprinkle'
      );
    },
    SCRIPTS
  );
  const seen = await staged(page, 'the cgi-bin calls', async () => {
    const list = await window.cgi({ path: 'list' });
    const add = await window.cgi({
      method: 'post',
      path: 'add/extra%20bit',
      query: 'x=1',
      headers: [
        ['Content-Type', 'application/json'],
        ['X-Asked', 'yes'],
      ],
      body: JSON.stringify({ text: 'hello' }),
    });
    if (add.status !== 201)
      throw new Error(`add answered ${add.status}: ${JSON.stringify(add.body)}`);
    const again = await window.cgi({ path: 'list' });
    await when(
      [heard(window.agent, 'messages')],
      () => window.licks().length > 0,
      'the sprinkle lick'
    );
    const fail = await window.cgi({ path: 'fail' });
    const early = await window.cgi({ path: 'early' });
    const head = await window.cgi({ method: 'HEAD', path: 'list' });
    const open = await window.cgi({ path: 'open' });
    const dots = await window.cgi({ path: '..%2Fnotes.shtml' });
    const hidden = await window.cgi({ path: '.list' });
    const missing = await window.cgi({ path: 'nothing' });
    const crowd = await Promise.all(Array.from({ length: 8 }, () => window.cgi({ path: 'slow' })));
    const outsider = await window.sh(
      'agent send cone --lick=sprinkle --source notes "not from the sprinkle"',
      'cone'
    );
    const log = await window.sh('cat /home/cone/sprinkles/notes/error.log', 'cone');
    return {
      list,
      add,
      again,
      fail,
      early: early.status,
      head: { status: head.status, notes: head.headers['x-notes'], body: head.body },
      open,
      crowd: crowd.map((reply) => reply.status).sort(),
      retry: crowd.find((reply) => reply.status === 503)?.headers['retry-after'],
      dots: dots.status,
      hidden: hidden.status,
      missing: missing.status,
      outsider: { status: outsider.status, stderr: outsider.stderr },
      licks: window.licks(),
      log: log.stdout,
    };
  });
  assert.equal(seen.list.status, 200);
  assert.equal(seen.list.headers['x-notes'], '2');
  assert.equal(seen.list.headers['content-type'], 'application/json');
  assert.deepEqual(seen.list.body, []);
  assert.equal(seen.add.status, 201);
  assert.equal(seen.add.statusText, 'Created');
  assert.deepEqual(seen.add.body, { ok: true, count: 1 });
  assert.deepEqual(seen.again.body, [
    {
      text: 'hello',
      REQUEST_METHOD: 'POST',
      PATH_INFO: '/extra bit',
      QUERY_STRING: 'x=1',
      CONTENT_TYPE: 'application/json',
      HTTP_X_ASKED: 'yes',
      REMOTE_USER: 'cone',
      SLICC_SPRINKLE: 'cone/notes',
      SLICC_OWNER: 'cone',
      SLICC_TAB: 'tab-1',
      GATEWAY_INTERFACE: 'CGI/1.1',
    },
  ]);
  assert.deepEqual(seen.licks, [{ channel: 'sprinkle', title: 'Notes', text: 'added hello' }]);
  assert.equal(seen.fail.status, 500);
  assert.equal(seen.fail.body, 'broken\n');
  assert.equal(seen.early, 502);
  assert.deepEqual(seen.head, { status: 200, notes: '2', body: '' });
  assert.equal(seen.open.status, 403);
  assert.match(seen.open.body, /cgi-bin\/open is refused: its group or others can write it/);
  assert.deepEqual([seen.dots, seen.hidden, seen.missing], [404, 404, 404]);
  assert.deepEqual(seen.crowd, [200, 200, 200, 200, 503, 503, 503, 503]);
  assert.equal(seen.retry, '1');
  assert.deepEqual(seen.outsider, {
    status: 2,
    stderr:
      "agent: --lick=sprinkle is the agent's own channel; a process may send --lick=cron or --lick=webhook\n",
  });
  assert.match(seen.log, /\] add: agent 0 \n/);
  assert.match(seen.log, /\] fail: broken\n.*\] fail: exited 3\n/s);
  assert.match(seen.log, /\] open: .* is refused/);
});
