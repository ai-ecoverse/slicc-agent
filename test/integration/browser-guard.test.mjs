import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('bash scopes browser refusals to the invoked tool and reports its protected rule', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'bash scopes browser refusals', async () => {
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
    const script =
      '#!/bin/bash\nprintf "%s\\n" "$*" >> /tmp/browser-invocations\necho "tab x http://127.0.0.1:8765/"\n';
    for (const name of ['playwright-cli', 'curlwright']) {
      await client.fs.writeFile(`${bin}/${name}`, script);
      const chmod = await client.spawn(['chmod', '+x', `${bin}/${name}`], { cwd: '/' });
      await chmod.exited;
    }
    await client.fs.writeFile(`${bin}/gh`, '#!/bin/bash\ncat\necho issue-created\n');
    const chmod = await client.spawn(['chmod', '+x', `${bin}/gh`], { cwd: '/' });
    await chmod.exited;
    const allowed = [
      'playwright-cli eval --tab t1 "() => document.body.innerText"; echo https://seven.sliccy.ai',
      'playwright-cli tab-list | grep x; echo https://seven.sliccy.ai',
      `for f in /usr/bin/jsh /usr/bin/node /usr/bin/playwright-cli /usr/bin/curlwright; do printf '%s: ' $f; head -c 120 $f | tr -dc '[:print:]\\n' | head -c 100; echo; done; grep -rlE "findTab" /usr/lib /usr/local /opt /var/lib/slicc 2>/dev/null | grep -vE '\\.map$|/skills/|share/skills' | head -5`,
      'grep -r findTab /usr/bin/playwright-cli /usr/bin/curlwright; echo https://seven.sliccy.ai',
      "gh issue create --body-file /dev/stdin <<'EOF'\nplaywright-cli tab-list t1 attachToTarget own pages https://seven.sliccy.ai\nEOF",
      "gh issue create --body-file /dev/stdin <<'ONE'\nplaywright-cli https://seven.sliccy.ai\nONE\ngh issue create --body-file /dev/stdin <<'TWO'\ncurlwright t1 attachToTarget own pages https://vault.sliccy.ai\nTWO",
      'echo "playwright-cli open https://seven.sliccy.ai"',
      'echo "$(printf \'playwright-cli open https://seven.sliccy.ai\')"',
    ];
    allowed.push(
      `playwright-cli tab-select t1; echo ${location.origin}/`,
      `playwright-cli eval --tab t1 "() => document.title" | grep '${location.origin}/'`,
      `gh issue create --body-file /dev/stdin <<'ORIGIN'\nplaywright-cli t1 attachToTarget own pages ${location.origin}/\nORIGIN`
    );
    const blocked = [
      ['playwright-cli open https://seven.sliccy.ai/', 'protected domain sliccy.ai'],
      ['playwright-cli eval "fetch(\'https://seven.sliccy.ai/\')"', 'protected domain sliccy.ai'],
      ['playwright-cli tab-select https://seven.sliccy.ai/', 'protected domain sliccy.ai'],
      ['curlwright https://vault.sliccy.ai/', 'protected host vault.sliccy.ai'],
      ['playwright-cli open http://foreign.kernel.localhost/', 'foreign kernel host'],
      ['playwright-cli open http://9222.kernel.localhost/', 'foreign kernel host'],
      ['playwright-cli open https://seven%2Esliccy%2Eai/', 'protected domain sliccy.ai'],
      ['env X=1 playwright-cli open https://seven.sliccy.ai/', 'protected domain sliccy.ai'],
      ['/usr/bin/playwright-cli open https://seven.sliccy.ai/', 'protected domain sliccy.ai'],
      ['echo harmless; playwright-cli open https://seven.sliccy.ai/', 'protected domain sliccy.ai'],
      ["playwright-cli eval <<'EOF'\nhttps://seven.sliccy.ai/\nEOF", 'protected domain sliccy.ai'],
      [
        'playwright-cli eval "document.location=\'https://vault.sliccy.ai/\'"',
        'protected host vault.sliccy.ai',
      ],
      [`playwright-cli open ${location.origin}/`, 'worker origin'],
      ['playwright-cli eval <(echo script)', 'command too dynamic to check'],
      [
        'cat <<EOF\n$(playwright-cli open https://seven.sliccy.ai/)\nEOF',
        'protected domain sliccy.ai',
      ],
      ['echo "$(playwright-cli open https://seven.sliccy.ai/)"', 'protected domain sliccy.ai'],
      ['echo `curlwright https://vault.sliccy.ai/`', 'protected host vault.sliccy.ai'],
      ['cat <(env X=1 playwright-cli open https://seven.sliccy.ai/)', 'protected domain sliccy.ai'],
      [
        "eval 'command exec nohup playwright-cli open https://seven.sliccy.ai/'",
        'protected domain sliccy.ai',
      ],
      ['sh -c "playwright-cli open https://seven.sliccy.ai/"', 'protected domain sliccy.ai'],
      ['xargs -n 1 playwright-cli open https://seven.sliccy.ai/', 'protected domain sliccy.ai'],
      ['echo playwright-cli; eval "$browser_command"', 'command too dynamic to check'],
    ];
    const params = new URLSearchParams([
      ...[...allowed, ...blocked.map(([command]) => command)].map((command) => [
        'tool',
        JSON.stringify({ name: 'bash', args: { command } }),
      ]),
      ['answer', 'Checked browser command boundaries.'],
    ]);
    const owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    await connection.prompt('Check the browser command boundaries.');
    const results = connection.transcript.value.entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => entry.model[0].content.map((part) => part.text ?? '').join(''));
    const invocations = new TextDecoder().decode(
      await client.fs.readFile('/tmp/browser-invocations')
    );
    await owner.release();
    return { allowed, blocked, results, invocations };
  });
  assert.equal(seen.results.length, seen.allowed.length + seen.blocked.length);
  for (const [index, command] of seen.allowed.entries()) {
    assert.doesNotMatch(seen.results[index], /Tool call blocked|Rule:/, command);
  }
  assert.match(seen.results[4], /issue-created/);
  assert.match(seen.results[5], /issue-created[\s\S]*issue-created/);
  for (const [index, [command, rule]] of seen.blocked.entries()) {
    assert.ok(seen.results[seen.allowed.length + index].includes(`Rule: ${rule}`), command);
  }
  assert.doesNotMatch(seen.invocations, /sliccy\.ai|foreign\.kernel|9222\.kernel/);
  assert.equal(seen.invocations.trim().split('\n').length, 4);
});
