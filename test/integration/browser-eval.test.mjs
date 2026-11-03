import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('bash accepts ordinary CGI eval code and refuses protected URLs inside eval', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'ordinary CGI eval code', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const client = await attachKernel(await kernel.connect());
    let pnpm = '';
    const probe = await client.spawn(['bash', '-c', 'printf %s "$PNPM_HOME"'], {
      cwd: '/',
      onStdout: (bytes) => {
        pnpm += new TextDecoder().decode(bytes);
      },
    });
    await probe.exited;
    const executable = `${pnpm || '/home/.local/share/pnpm'}/bin/playwright-cli`;
    await client.fs.mkdir(executable.slice(0, executable.lastIndexOf('/')), { recursive: true });
    await client.fs.writeFile(executable, '#!/bin/bash\necho ordinary-eval-reached\n');
    const chmod = await client.spawn(['chmod', '+x', executable], { cwd: '/' });
    await chmod.exited;
    const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
    const reproductions = [
      '[location.href,location.origin,document.referrer]',
      '[location.href, location.origin, document.referrer]',
      '() => [location.href, location.origin, document.referrer]',
      '() => [...document.querySelectorAll("a")].map(a => a.href)',
      '() => { // sliccy\nreturn location.href; }',
      '() => { // slicc.ai\nreturn location.href; }',
    ];
    const ordinary = [
      'location.href',
      'location.origin',
      'document.referrer',
      'window.opener',
      'document.domain',
      "fetch('/cgi-bin/x')",
      "fetch('http://127.0.0.1:8765/cgi-bin/x')",
      "location.href.includes('sliccy')",
      "location.href.includes('slicc.ai')",
      '() => { /* sliccy */ return location.href; }',
    ];
    const allowed = [
      ...reproductions.flatMap((expression) =>
        ['', '-t t1', '--tab 3D7EC13F2E96795FF2641D6D88F1EA13'].map(
          (tab) => `playwright-cli eval ${tab} ${quote(expression)}`
        )
      ),
      ...ordinary.map((expression) => `playwright-cli eval --tab t1 ${quote(expression)}`),
    ];
    const protectedExpressions = [
      'location = "https://www.sliccy.ai/os/"',
      'window.open("https://www.sliccy.ai/os/")',
      'fetch("https://www.sliccy.ai/os/")',
      '[www.sliccy.ai]',
      '//www.sliccy.ai/x',
      '[www%2Esliccy%2Eai]',
      '[www\u3002sliccy\uff0eai]',
      '[www%E3%80%82sliccy%EF%BD%A1ai]',
      '() => { // https://www.sliccy.ai/os/\nreturn location.href; }',
    ];
    const blocked = protectedExpressions.map(
      (expression) => `playwright-cli eval ${quote(expression)}`
    );
    const params = new URLSearchParams([
      ...[...allowed, ...blocked].map((command) => [
        'tool',
        JSON.stringify({ name: 'bash', args: { command } }),
      ]),
      ['answer', 'Checked eval text.'],
    ]);
    const owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const collected = new Map();
    const collect = (view) => {
      for (const entry of view.entries)
        if (entry.kind === 'pi.tool-result')
          collected.set(entry.id, entry.model[0].content.map((part) => part.text ?? '').join(''));
    };
    const unsubscribe = connection.transcript.subscribe(collect);
    await connection.prompt('Check CGI eval text.');
    collect(connection.transcript.value);
    unsubscribe();
    await owner.release();
    return { allowed, blocked, results: [...collected.values()] };
  });
  assert.equal(seen.results.length, seen.allowed.length + seen.blocked.length);
  const refusedOrdinary = seen.allowed.filter(
    (_, index) => !seen.results[index].includes('ordinary-eval-reached')
  );
  assert.deepEqual(refusedOrdinary, []);
  for (const [index, command] of seen.blocked.entries()) {
    assert.match(
      seen.results[seen.allowed.length + index],
      /Rule: (protected domain sliccy.ai|unparseable protected URL)/,
      command
    );
    assert.doesNotMatch(
      seen.results[seen.allowed.length + index],
      /ordinary-eval-reached/,
      command
    );
  }
});
