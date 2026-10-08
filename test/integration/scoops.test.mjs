import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a terminal runs agent through the production worker: a sync call, an async scoop and a wait', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const answers = ['From the sync scoop.', 'From the async scoop.']
      .map((answer) => `answer=${encodeURIComponent(answer)}`)
      .join('&');
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const terminal = await attachKernel(await kernel.connect());
    const run = async (command) => {
      const decoder = new TextDecoder();
      let out = '';
      const process = await terminal.spawn(['bash', '-c', command], {
        cwd: '/home',
        onStdout: (bytes) => {
          out += decoder.decode(bytes);
        },
        onStderr: (bytes) => {
          out += decoder.decode(bytes);
        },
      });
      return { code: await process.exited, out };
    };
    for (let i = 0; i < 600; i++) {
      if (await terminal.fs.exists('/home/.local/share/pnpm/bin/agent')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sync = await run('agent --name probe --prompt "Say hello"');
    const archived = await terminal.fs.readFile('/tmp/agent-sessions/probe.md');
    const spawned = await run('subagent spawn --name helper --prompt "Work on it"');
    const waited = await run('agent wait helper --timeout 20');
    const listed = await run('agent list');
    const skills = await run('ls /var/lib/slicc/agent/skills /var/lib/slicc/agent/prompts');
    const commands = connection.commands.value.map((command) => `${command.kind}:${command.name}`);
    await owner.release();
    return {
      sync,
      archived: typeof archived === 'string' ? archived : new TextDecoder().decode(archived),
      spawned,
      waited,
      listed,
      skills,
      commands,
    };
  });
  assert.deepEqual(seen.sync, { code: 0, out: 'From the sync scoop.\n' });
  assert.match(
    seen.archived,
    /^# probe\n\n## Request\n\nSay hello\n\n## Answer\n\nFrom the sync scoop\.\n$/
  );
  assert.deepEqual(seen.spawned, { code: 0, out: 'helper\n' });
  assert.equal(seen.waited.code, 0);
  assert.match(seen.waited.out, /From the async scoop\./);
  assert.match(seen.listed.out, /^helper\t/m);
  assert.match(seen.skills.out, /agent\n/);
  assert.match(seen.skills.out, /review-loop\.md/);
  assert.ok(seen.commands.includes('prompt:parallel-review'));
  assert.ok(seen.commands.includes('skill:skill:licks'));
});
