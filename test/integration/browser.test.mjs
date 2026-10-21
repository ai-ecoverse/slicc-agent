import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a playwright-cli screenshot read back shows on the tool card, through the production worker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(
    page,
    'a playwright-cli screenshot read back',
    async (png) => {
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const { attachKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      const client = await attachKernel(await kernel.connect());
      const pnpm = await (async () => {
        let out = '';
        const probe = await client.spawn(['bash', '-c', 'printf %s "$PNPM_HOME"'], {
          cwd: '/',
          onStdout: (bytes) => {
            out += new TextDecoder().decode(bytes);
          },
        });
        await probe.exited;
        return out || '/home/.local/share/pnpm';
      })();
      const script = [
        '#!/bin/bash',
        'for arg in "$@"; do',
        `  if [ "$previous" = --filename ]; then echo '${png}' | base64 -d > "$arg"; fi`,
        '  previous="$arg"',
        'done',
        'echo "Screenshot saved"',
      ].join('\n');
      await client.fs.mkdir(`${pnpm}/bin`, { recursive: true });
      await client.fs.writeFile(`${pnpm}/bin/playwright-cli`, `${script}\n`);
      const params = new URLSearchParams([
        [
          'tool',
          JSON.stringify({
            name: 'bash',
            args: {
              command: `chmod +x ${pnpm}/bin/playwright-cli && playwright-cli screenshot --tab t1 --max-width 1600 --filename /tmp/shot.png`,
            },
          }),
        ],
        ['tool', JSON.stringify({ name: 'read', args: { path: '/tmp/shot.png' } })],
        ['answer', 'It is a single pixel.'],
      ]);
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      const answer = await connection.prompt('Take a screenshot.');
      await model.agent.ready();
      const tools = model.agent
        .messages(model.agent.active())
        .flatMap((message) => message.parts ?? [])
        .filter((part) => part.type === 'tool')
        .map((part) => ({
          name: part.tool.name,
          output: part.tool.output,
          image: part.tool.image ?? null,
        }));
      await owner.release();
      return { answer, tools };
    },
    PNG
  );
  assert.equal(seen.answer, 'It is a single pixel.');
  assert.equal(seen.tools[0].name, 'bash');
  assert.match(seen.tools[0].output, /Screenshot saved/);
  assert.equal(seen.tools[1].name, 'read');
  assert.match(seen.tools[1].image, /^data:image\/png;base64,iVBORw0KGgo/);
});

test("bash refuses to point playwright-cli at SLICC's own pages, through the production worker", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'bash refuses to point playwright-cli', async () => {
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
    const bin = `${pnpm || '/home/.local/share/pnpm'}/bin`;
    await client.fs.mkdir(bin, { recursive: true });
    await client.fs.writeFile(`${bin}/playwright-cli`, '#!/bin/bash\necho "opened $*"\n');
    const bash = (command) => ['tool', JSON.stringify({ name: 'bash', args: { command } })];
    const code = [
      'try { await tools.bash({ command: "playwright-cli open https://SEVEN.sliccy.ai./x" }); }',
      'catch (error) { text(error.message); }',
    ].join('\n');
    const params = new URLSearchParams([
      ['code', code],
      bash(
        `chmod +x ${bin}/playwright-cli && playwright-cli open https://seven.sliccy.ai/home/x.html`
      ),
      bash(`playwright-cli open ${location.origin}/home/x.html`),
      bash(`chmod +x ${bin}/playwright-cli && playwright-cli open https://example.com/`),
      bash('playwright-cli open exa%20mple.sliccy.ai/home'),
      bash('playwright-cli fill e1 "hello world [draft]"'),
      bash('playwright-cli open exa%20mple%2Esliccy%2Eai/home'),
      bash('playwright-cli open exa%20mple\u3002sliccy\uff0eai/home'),
      bash('playwright-cli open exa%20mple%E3%80%82sliccy%EF%BD%A1ai/home'),
      ['answer', 'Refused.'],
    ]);
    const owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const answer = await connection.prompt('Open seven.');
    const results = connection.transcript.value.entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => entry.model[0].content.map((part) => part.text ?? '').join(''));
    await owner.release();
    return { answer, results };
  });
  const refusal = /SLICC's own pages can't be opened or driven from the browser tools\./;
  assert.equal(seen.answer, 'Refused.');
  assert.equal(seen.results.length, 9);
  assert.match(seen.results[0], refusal);
  assert.match(seen.results[1], refusal);
  assert.doesNotMatch(seen.results[1], /opened open/);
  assert.match(seen.results[2], refusal);
  assert.match(seen.results[3], /opened open https:\/\/example\.com\//);
  assert.match(seen.results[4], refusal);
  assert.doesNotMatch(seen.results[4], /opened open/);
  assert.match(seen.results[5], /opened fill e1 hello world \[draft\]/);
  assert.match(seen.results[6], refusal);
  assert.match(seen.results[7], refusal);
  assert.match(seen.results[8], refusal);
});

test("with SLICC_CDP_URL set and no browser attached, the browser skill's check reports not connected", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'with SLICC_CDP_URL set and no', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const skill = await (await fetch('/packages/vfs-root/skills/browser/SKILL.md')).text();
    const check = /## Before you start[\s\S]*?```bash\n([\s\S]*?)\n```/.exec(skill)[1];
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const client = await attachKernel(await kernel.connect());
    let out = '';
    const probe = await client.spawn(
      ['bash', '-c', 'printf "%s\\n%s" "$PNPM_HOME" "$SLICC_CDP_URL"'],
      {
        cwd: '/',
        onStdout: (bytes) => {
          out += new TextDecoder().decode(bytes);
        },
      }
    );
    await probe.exited;
    const [pnpm, cdp] = out.split('\n');
    const bin = `${pnpm || '/home/.local/share/pnpm'}/bin`;
    await client.fs.mkdir(bin, { recursive: true });
    await client.fs.writeFile(
      `${bin}/playwright-cli`,
      '#!/bin/bash\necho "Error: HTTP 502: no browser to drive: install slicc-extension, or run npx @ai-ecoverse/slicc-node" >&2\nexit 1\n'
    );
    const chmod = await client.spawn(['chmod', '+x', `${bin}/playwright-cli`], { cwd: '/' });
    await chmod.exited;
    const params = new URLSearchParams([
      ['tool', JSON.stringify({ name: 'bash', args: { command: check } })],
      ['answer', 'Not connected.'],
    ]);
    let worker;
    const owner = await startTracked({
      worker: () => {
        worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' });
        return worker;
      },
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const answer = await connection.prompt('Is the browser connected?');
    const result = connection.transcript.value.entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => entry.model[0].content.map((part) => part.text ?? '').join(''))[0];
    const channel = new MessageChannel();
    const requests = new Promise((resolve) => {
      channel.port1.onmessage = ({ data }) => resolve(data);
    });
    worker.postMessage({ requests: channel.port2 }, [channel.port2]);
    const [request] = await requests;
    await owner.release();
    return { answer, cdp, check, result, request };
  });
  assert.equal(seen.answer, 'Not connected.');
  assert.match(seen.cdp, /^ws:\/\//);
  assert.match(seen.check, /playwright-cli tab-list/);
  assert.match(seen.result, /no browser to drive/);
  assert.match(seen.result, /exit 1/);
  assert.match(
    seen.request,
    /Browser: one may be available \(SLICC_CDP_URL is set\), but nothing has checked/
  );
  assert.doesNotMatch(seen.request, /a browser or CDP tool/);
});
