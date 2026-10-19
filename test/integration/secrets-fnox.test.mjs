import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const FNOX = { 'node_modules/@ai-ecoverse/wasi-fnox/': ['package.json', 'bin/fnox.wasm'] };
const GH = 'fnox_proxy_000000000000000000000071';
const SHELLY = 'fnox_proxy_000000000000000000000072';
const SHELL_VALUE = 'shell-granted-value-0072';
const CONFIG = `default_provider = "seven"

[providers.seven]
type = "sealed"

[secrets]
GH_TOKEN = { provider = "seven", value = "${GH}" }
SHELLY = { provider = "seven", value = "${SHELLY}" }
LOCAL = { default = "plain-local-value", env = false }

[[proxy.rules]]
secret = "GH_TOKEN"
domain = "api.github.com"
header = "Authorization"
`;
const SEALED = [
  {
    name: 'GH_TOKEN',
    placeholder: GH,
    value: 'gh-real-value-000071',
    exec: false,
    rules: [{ secret: 'GH_TOKEN', domain: 'api.github.com', header: 'authorization' }],
  },
  { name: 'SHELLY', placeholder: SHELLY, value: SHELL_VALUE, exec: 'shell', rules: [] },
  {
    name: 'VAULT_ONLY',
    placeholder: 'fnox_proxy_000000000000000000000073',
    value: 'v',
    exec: false,
    rules: [],
  },
];

async function agentWith(t, { config, fnox, sealed, steps }) {
  const page = await chrome.page(t);
  await page.goto('/');
  return page.evaluate(
    async ({ config, extra, sealed, steps }) => {
      if (config !== null) {
        let dir = await navigator.storage.getDirectory();
        for (const part of ['etc', 'fnox'])
          dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (
          await dir.getFileHandle('config.toml', { create: true })
        ).createWritable();
        await writable.write(config);
        await writable.close();
      }
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const hook = fakeSealed(sealed);
      const kernel = await bootKernel(extra, {
        env: { FNOX_CONFIG_DIR: '/etc/fnox' },
        sealed: hook,
      });
      const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
      let worker;
      const owner = await startAgent({
        worker: () =>
          (worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' })),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const answer = await connection.prompt('Go.');
      await connection.control.send(
        { text: '/secrets', whenBusy: 'steer', requestId: null },
        BACKGROUND_CONTEXT
      );
      const listedEntry = () =>
        connection.transcript.value.entries.find((entry) => entry.kind === 'slicc.secrets');
      for (let n = 0; n < 200 && !listedEntry(); n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const channel = new MessageChannel();
      const requests = new Promise((resolve) => {
        channel.port1.onmessage = ({ data }) => resolve(data);
      });
      worker.postMessage({ requests: channel.port2 }, [channel.port2]);
      const result = {
        answer,
        listed: listedEntry()?.model[0].content,
        requests: await requests,
        entries: JSON.stringify(connection.transcript.value.entries),
        sealed: hook.log.map(({ op, shellGrants, argv }) => ({ op, shellGrants, argv })),
      };
      await owner.release();
      return result;
    },
    { config, extra: fnox ? FNOX : {}, sealed, steps }
  );
}

const systemOf = (requests) => JSON.parse(requests[0]).messages[0].sections.secrets;

test('fnox secrets: a sealed secret is in the prompt with its placeholder and where it works, and in /secrets', async (t) => {
  const seen = await agentWith(t, {
    config: CONFIG,
    fnox: true,
    sealed: SEALED,
    steps: [{ answer: 'Seen.' }],
  });
  assert.equal(seen.answer, 'Seen.');
  const system = systemOf(seen.requests);
  assert.ok(system.includes(`- GH_TOKEN = ${GH}: api.github.com, header authorization`), system);
  assert.ok(system.includes(`- SHELLY = ${SHELLY}: in every bash`), system);
  assert.ok(system.includes('- LOCAL = $LOCAL: not sealed'), system);
  assert.ok(
    system.includes('- VAULT_ONLY = fnox_proxy_000000000000000000000073: not in the fnox config'),
    system
  );
  assert.ok(!system.includes('plain-local-value'));
  assert.equal(seen.listed, 'The user listed secrets: GH_TOKEN, SHELLY, LOCAL, VAULT_ONLY.');
});

test('fnox secrets: a shell-granted secret wraps bash in fnox exec --shell-grants, and the command sees its value', async (t) => {
  const hash = createHash('sha256').update(SHELL_VALUE).digest('hex');
  const command = `test "$(printf %s "$SHELLY" | sha256sum | cut -c1-64)" = ${hash} && echo granted-match || echo "no-match:$SHELLY"`;
  const seen = await agentWith(t, {
    config: CONFIG,
    fnox: true,
    sealed: SEALED,
    steps: [{ tool: { name: 'bash', args: { command } } }, { answer: 'Done.' }],
  });
  assert.equal(seen.answer, 'Done.');
  const granted = seen.sealed.filter((request) => request.op === 'materialize');
  assert.ok(granted.length >= 1, JSON.stringify(seen.sealed));
  assert.ok(granted.every((request) => request.shellGrants === true));
  assert.ok(granted.some((request) => request.argv.at(-1).endsWith(command)));
  assert.ok(seen.sealed.some((request) => request.op === 'materializeConsume'));
  assert.ok(seen.entries.includes('granted-match'), seen.entries);
  assert.ok(!seen.entries.includes(SHELL_VALUE));
});

test('fnox secrets: without fnox the prompt and /secrets say secrets are unavailable', async (t) => {
  const seen = await agentWith(t, {
    config: CONFIG,
    fnox: false,
    sealed: SEALED,
    steps: [{ tool: { name: 'bash', args: { command: 'echo plain-run' } } }, { answer: 'Done.' }],
  });
  const line = "Secrets are unavailable: fnox isn't installed.";
  assert.ok(systemOf(seen.requests).includes(line), systemOf(seen.requests));
  assert.equal(seen.listed, line);
  assert.ok(seen.entries.includes('plain-run'));
  assert.ok(!seen.sealed.some((request) => request.op === 'materialize'));
});

test('fnox secrets: a fnox that exits non-zero says the config has an error, and never quotes it', async (t) => {
  const leaky = 'plain-leaky-value-9911';
  const seen = await agentWith(t, {
    config: `[secrets]\nLOCAL = "${leaky}"\n`,
    fnox: true,
    sealed: SEALED,
    steps: [{ answer: 'Seen.' }],
  });
  const line = 'Secrets are unavailable: the fnox config has an error; check /etc/fnox/config.toml';
  assert.ok(systemOf(seen.requests).includes(line), systemOf(seen.requests));
  assert.ok(seen.listed.startsWith(line), seen.listed);
  for (const text of [seen.entries, ...seen.requests]) assert.ok(!text.includes(leaky));
  assert.ok(!systemOf(seen.requests).includes(GH));
});

test('fnox secrets: an unsealed secret fnox exec would hand out keeps shell grants off, and says so', async (t) => {
  const exposed = CONFIG.replace(
    'LOCAL = { default = "plain-local-value", env = false }',
    'LOCAL = { default = "plain-local-value" }'
  );
  const seen = await agentWith(t, {
    config: exposed,
    fnox: true,
    sealed: SEALED,
    steps: [
      { tool: { name: 'bash', args: { command: 'echo "local:${LOCAL:-unset}"' } } },
      { answer: 'Done.' },
    ],
  });
  const off =
    'Shell grants are off: fnox exec would also give every command the unsealed fnox secrets LOCAL; seal them or set env = false for them.';
  const system = systemOf(seen.requests);
  assert.ok(system.includes(off), system);
  assert.ok(system.includes(`- SHELLY = ${SHELLY}\n`), system);
  assert.ok(seen.listed.endsWith(off), seen.listed);
  assert.ok(!seen.sealed.some((request) => request.op === 'materialize'));
  assert.ok(seen.entries.includes('local:unset'), seen.entries);
  assert.ok(!seen.entries.includes('plain-local-value'));
});

test('fnox secrets: an empty config with no sealed secrets shows no secrets', async (t) => {
  const seen = await agentWith(t, {
    config: 'default_provider = "seven"\n\n[providers.seven]\ntype = "sealed"\n',
    fnox: true,
    sealed: [],
    steps: [{ answer: 'Seen.' }],
  });
  assert.ok(systemOf(seen.requests).includes('No secrets are configured'));
  assert.equal(seen.listed, 'The user listed secrets: none.');
});
