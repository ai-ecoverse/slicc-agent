import { readFile, writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { createModels } from '@earendil-works/pi-ai/models';
import { ADOBE, adobeProvider } from '../src/adobe.ts';
import {
  DEFAULT_POLICY,
  JUDGE_MODEL,
  JUDGE_QUESTIONS,
  JUDGE_TIMEOUT,
  judgeState,
  routed,
  verdictOf,
} from '../src/approvals/index.ts';

const file = new URL('./judge.json', import.meta.url);
const token = env.SLICC_ADOBE_IMS_TOKEN;
if (!token) {
  console.error('evals/judge.mjs: set SLICC_ADOBE_IMS_TOKEN to run the live judge evals');
  exit(2);
}
const named = argv.flatMap((arg, i) => (argv[i - 1] === '--model' ? [arg] : []));
const record = argv.includes('--record');
const refs = (named.length ? named : [`${JUDGE_MODEL.provider}/${JUDGE_MODEL.modelId}`]).map(
  (name) => {
    const [provider, ...rest] = name.split('/');
    return { provider, modelId: rest.join('/') };
  }
);
const credentials = {
  read: async (id) => (id === ADOBE ? { type: 'api_key', key: token } : undefined),
  list: async () => [{ providerId: ADOBE, type: 'api_key' }],
  modify: async () => undefined,
  delete: async () => undefined,
};
const models = createModels({ credentials });
models.setProvider(adobeProvider());
const set = JSON.parse(await readFile(file, 'utf8'));
const detailOf = (entry) => {
  if (entry.kind === 'sudo')
    return { command: entry.command, target: entry.target ?? 'root', cwd: entry.cwd ?? '/' };
  if (entry.kind === 'guest-tool') return { tool: entry.tool, summary: entry.summary };
  return { text: entry.text, attachments: [] };
};
const itemOf = (entry) => ({
  id: `eval-${entry.name}`,
  kind: entry.kind,
  agentId: 'cone',
  requester:
    entry.kind === 'sudo'
      ? { kind: 'agent', name: 'sliccy', agentId: 'cone' }
      : { kind: 'guest', name: 'Pat', seat: 'eval' },
  tier: 'agent',
  state: 'pending',
  decidedBy: null,
  always: false,
  createdAt: 0,
  expiresAt: 0,
  detail: detailOf(entry),
});
const intent = async (entry) => ({
  policy: DEFAULT_POLICY,
  messages: entry.owner ?? set.owner,
  memory: [],
});
let misses = 0;
let cost = 0;
for (const ref of refs) {
  const name = `${ref.provider}/${ref.modelId}`;
  const model = models.getModelOfType('classifier', ref.provider, ref.modelId);
  if (!model) {
    console.error(`no classifier ${name}`);
    exit(2);
  }
  const rows = [];
  for (const entry of set.cases) {
    const raw = await models.classify(
      model,
      { state: judgeState(itemOf(entry), await intent(entry), 'eval'), questions: JUDGE_QUESTIONS },
      { timeoutMs: JUDGE_TIMEOUT, maxRetries: 1 }
    );
    const judged = verdictOf(raw, name);
    const got = routed(judged.outcome, entry.present === true);
    cost += raw.usage?.cost.total ?? 0;
    const low = raw.answers.risk?.probabilities?.low;
    const aligned = raw.answers.aligned?.probability;
    const ok = got === entry.expect;
    if (!ok) misses += 1;
    rows.push({
      case: entry.name,
      expect: entry.expect,
      judge: judged.outcome,
      got,
      low: low?.toFixed(3),
      aligned: aligned?.toFixed(3),
      ok: ok ? 'yes' : 'NO',
      error: judged.error ?? '',
    });
    if (record && ref === refs[0] && typeof low === 'number' && typeof aligned === 'number')
      entry.recorded = { low: Number(low.toFixed(3)), aligned: Number(aligned.toFixed(3)) };
  }
  console.log(`\n${name}`);
  console.table(rows);
}
console.log(`misses: ${misses}, cost: $${cost.toFixed(4)}`);
if (record) {
  set.placeholder = false;
  await writeFile(file, `${JSON.stringify(set, null, 2)}\n`);
}
exit(misses ? 1 : 0);
