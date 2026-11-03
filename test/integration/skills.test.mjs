import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';
import corpus from './fixtures/frontmatter.json' with { type: 'json' };

const chrome = await launch();
after(() => chrome.close());

const LINKEDIN = `---
name: linkedin
description: Manage a LinkedIn company page — publish posts with consistent brand
  voice, grow engagement, respond to comments, analyze performance, preview profiles,
  and aggregate engagement for the monday dispatcher. Maintains a knowledge base of
  content ideas, audience insights, and brand guidelines. Use when the user wants to
  publish a LinkedIn post, draft LinkedIn content, check LinkedIn comments, respond
  to engagement, plan content strategy, review brand voice, view a LinkedIn profile,
  or manage a company page. Activate on mentions of LinkedIn, LinkedIn post, company
  page, social media, content calendar, engagement, brand voice, or audience growth.
allowed-tools: bash
---
Manage the company page.`;
const DESCRIPTION = LINKEDIN.split('description: ')[1]
  .split('\nallowed-tools:')[0]
  .split('\n')
  .map((line) => line.trim())
  .join(' ');

test('boot lists the full bundled LinkedIn description without warn licks', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(
    page,
    'the LinkedIn skill on boot',
    async (skill) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ['usr', 'share', 'skills', 'linkedin'])
        dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (
        await dir.getFileHandle('SKILL.md', { create: true })
      ).createWritable();
      await writable.write(skill);
      await writable.close();
      await import('/dist-test/page.js');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      const owner = await startTracked({
        worker: () => new Worker('/dist-test/main-worker.js?answer=Done.', { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const agent = createAgentModel(connection, { storage: localStorage }).agent;
      await agent.ready();
      await when(
        [connection.commands],
        () => connection.commands.value.some((command) => command.name === 'skill:linkedin'),
        'the LinkedIn skill'
      );
      const result = {
        skill: connection.commands.value.find((command) => command.name === 'skill:linkedin'),
        warnings: agent
          .messages()
          .filter((message) => message.role === 'lick' && message.severity === 'warn'),
      };
      await owner.release();
      return result;
    },
    LINKEDIN
  );
  assert.equal(seen.skill.description, DESCRIPTION);
  assert.deepEqual(seen.warnings, []);
});

test('bundled skills, roles, templates and the profile fixture retain their old descriptions', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const fixtures = corpus.filter((row) => !row.file.startsWith('packages/'));
  const seen = await staged(
    page,
    'the frontmatter compatibility corpus',
    async (fixtures) => {
      for (const fixture of fixtures) {
        let dir = await navigator.storage.getDirectory();
        for (const part of ['usr', 'share', 'skills', fixture.expected.fields.name])
          dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (
          await dir.getFileHandle('SKILL.md', { create: true })
        ).createWritable();
        await writable.write(fixture.text);
        await writable.close();
      }
      await import('/dist-test/page.js');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      const owner = await startTracked({
        worker: () => new Worker('/dist-test/main-worker.js?answer=Done.', { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const agent = createAgentModel(connection, { storage: localStorage }).agent;
      await agent.ready();
      await when(
        [connection.commands],
        () => connection.commands.value.some((command) => command.name === 'skill:deploy-notes'),
        'the profile fixture skill'
      );
      await when(
        [files(kernel, ['/usr/local/bin'])],
        async () => (await kernel.run(['bash', '-c', 'test -x /usr/local/bin/agent'])).status === 0,
        'the agent command'
      );
      const roles = await kernel.run(['bash', '-c', 'agent list --agents']);
      const result = {
        commands: connection.commands.value,
        roles,
        warnings: agent
          .messages()
          .filter((message) => message.role === 'lick' && message.severity === 'warn'),
      };
      await owner.release();
      return result;
    },
    fixtures
  );
  assert.equal(seen.roles.status, 0);
  assert.doesNotMatch(seen.roles.stdout, /warning:/);
  for (const row of corpus) {
    const { fields } = row.expected;
    if (row.file.includes('/agents/')) {
      assert.ok(
        seen.roles.stdout.includes(`${fields.name}\tbuiltin\t${fields.description}`),
        row.file
      );
    } else {
      const name = row.file.includes('/prompts/')
        ? row.file.split('/').at(-1).replace(/\.md$/, '')
        : `skill:${fields.name}`;
      assert.equal(
        seen.commands.find((command) => command.name === name)?.description,
        fields.description,
        row.file
      );
    }
  }
  assert.deepEqual(seen.warnings, []);
});

test('boot salvages a skill with a stray line and preserves another full description', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(
    page,
    'skills with one stray frontmatter line',
    async (skills) => {
      for (const [name, skill] of Object.entries(skills)) {
        let dir = await navigator.storage.getDirectory();
        for (const part of ['usr', 'share', 'skills', name])
          dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (
          await dir.getFileHandle('SKILL.md', { create: true })
        ).createWritable();
        await writable.write(skill);
        await writable.close();
      }
      await import('/dist-test/page.js');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      const owner = await startTracked({
        worker: () => new Worker('/dist-test/main-worker.js?answer=Done.', { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const agent = createAgentModel(connection, { storage: localStorage }).agent;
      await agent.ready();
      await when(
        [connection.commands],
        () => connection.commands.value.some((command) => command.name === 'skill:linkedin'),
        'the unaffected skill'
      );
      const result = {
        commands: connection.commands.value,
        warnings: agent
          .messages()
          .filter((message) => message.role === 'lick' && message.severity === 'warn'),
      };
      await owner.release();
      return result;
    },
    {
      'stray-note':
        '---\nname: stray-note\ndescription: does x\nThis is a note\nlicense: MIT\n---\nUseful instructions.',
      linkedin: LINKEDIN,
    }
  );
  assert.equal(
    seen.commands.find((command) => command.name === 'skill:stray-note')?.description,
    'does x'
  );
  assert.equal(
    seen.commands.find((command) => command.name === 'skill:linkedin')?.description,
    DESCRIPTION
  );
  assert.equal(seen.warnings.length, 1);
  assert.match(JSON.stringify(seen.warnings[0]), /stray-note/);
  assert.match(JSON.stringify(seen.warnings[0]), /at line 4/);
});

for (const [shape, restriction] of [
  ['tools list', 'tools:\n  - read\n  - !x grep'],
  ['explicit key', '? tools: [read, grep]'],
  ['compact tools', 'tools:[read, grep]\nlicense: MIT'],
  ['tagged tools', 'tools: [read, mcp__*, !x]'],
]) {
  test(`a malformed role ${shape} cannot launch a scoop with default tools`, async (t) => {
    const page = await chrome.page(t);
    await page.goto('/');
    const seen = await staged(
      page,
      'malformed role restrictions',
      async (restriction) => {
        await import('/dist-test/page.js');
        const { bootKernel } = await import('/kernel.js');
        const kernel = await bootKernel();
        const { attachKernel } = await import(
          '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
        );
        const terminal = await attachKernel(await kernel.connect());
        await terminal.fs.mkdir('/home/.pi/agent/agents', { recursive: true });
        await terminal.fs.writeFile(
          '/home/.pi/agent/agents/reader.md',
          `---\nname: reader\ndescription: read only\n${restriction}\n---\nYou only read.`
        );
        const owner = await startTracked({
          worker: () =>
            new Worker('/dist-test/main-worker.js?answer=Unexpected.', { type: 'module' }),
          kernel: { connect: () => kernel.connect() },
        });
        await owner.connect();
        await when(
          [files(kernel, ['/usr/local/bin'])],
          () => terminal.fs.exists('/usr/local/bin/agent'),
          'the agent command'
        );
        const listed = await kernel.run(['bash', '-c', 'agent list --agents']);
        const spawned = await kernel.run([
          'bash',
          '-c',
          'agent --role reader --prompt "Write a file"',
        ]);
        const scoops = await kernel.run(['bash', '-c', 'agent list']);
        await owner.release();
        return { listed, spawned, scoops };
      },
      restriction
    );
    assert.doesNotMatch(seen.listed.stdout, /^reader\t/m);
    assert.notEqual(seen.spawned.status, 0);
    assert.match(
      seen.spawned.stderr + seen.spawned.stdout,
      /unknown.*role|role.*unknown|not found/i
    );
    assert.doesNotMatch(seen.scoops.stdout, /reader/);
  });
}
