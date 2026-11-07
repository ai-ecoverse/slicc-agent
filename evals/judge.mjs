import { readFile, writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { createModels } from '@earendil-works/pi-ai/models';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { ADOBE, adobeProvider } from '../src/adobe.ts';
import {
  approvalJudge,
  DEFAULT_POLICY,
  JUDGE_MODEL,
  JUDGE_TIMEOUT,
  judgeState,
  questionsOf,
  route,
  verdictOf,
} from '../src/approvals/index.ts';
import { CLOUDFLARE, ensureJudgeCreds, judgeCredentials } from './judge-creds.mjs';

const file = new URL('./judge.json', import.meta.url);
const named = argv.flatMap((arg, i) => (argv[i - 1] === '--model' ? [arg] : []));
const record = argv.includes('--record');
const refs = (named.length ? named : [`${JUDGE_MODEL.provider}/${JUDGE_MODEL.modelId}`]).map(
  (name) => {
    const [provider, ...rest] = name.split('/');
    return { provider, modelId: rest.join('/') };
  }
);
const providers = new Set(refs.map((ref) => ref.provider));
ensureJudgeCreds(providers, env);
const models = createModels({ credentials: judgeCredentials(env) });
if (providers.has(ADOBE)) models.setProvider(adobeProvider());
if (providers.has(CLOUDFLARE)) models.setProvider(cloudflareWorkersAIProvider());
const set = JSON.parse(await readFile(file, 'utf8'));
const detailOf = (entry) => {
  if (entry.kind === 'sudo')
    return {
      command: entry.command,
      target: entry.target ?? 'root',
      cwd: entry.cwd ?? '/',
      ...(entry.stdin ? { stdin: entry.stdin } : {}),
      ...(entry.rootOnly ? { rootOnly: entry.rootOnly } : {}),
      writable: true,
    };
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
const intentOf = (entry) => ({
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
  let spent = 0;
  const judge = approvalJudge({
    models,
    model: async () => ref,
    intent: async (item) => intentOf(set.cases.find((entry) => `eval-${entry.name}` === item.id)),
    timeoutMs: JUDGE_TIMEOUT,
    spend: async (_item, result) => {
      spent += result.usage?.cost.total ?? 0;
    },
  });
  const round = (value) => Number(value.toFixed(3));
  const rounded = (values) =>
    Object.fromEntries(Object.entries(values).map(([key, p]) => [key, round(p)]));
  const guest = async (entry) => {
    const raw = await models.classify(
      model,
      {
        state: judgeState(itemOf(entry), intentOf(entry), 'eval'),
        questions: questionsOf(itemOf(entry)),
      },
      { timeoutMs: JUDGE_TIMEOUT, maxRetries: 1 }
    );
    spent += raw.usage?.cost.total ?? 0;
    const judged = verdictOf(raw, name);
    const level = raw.answers.level?.probabilities;
    const aligned = raw.answers.aligned?.probability;
    const seen =
      level && typeof aligned === 'number'
        ? { level: rounded(level), aligned: round(aligned) }
        : undefined;
    return { judged, seen };
  };
  const sudo = async (entry) => {
    const judged = await judge(itemOf(entry), {});
    const { actions, intent } = judged.verdict ?? {};
    return {
      judged,
      seen: actions && intent ? { actions: rounded(actions), intent: rounded(intent) } : undefined,
    };
  };
  const rows = [];
  for (const entry of set.cases) {
    const started = Date.now();
    const { judged, seen } = await (entry.kind === 'sudo' ? sudo(entry) : guest(entry));
    const ms = Date.now() - started;
    const verdict = judged.verdict;
    const requester = { kind: entry.kind === 'sudo' ? 'agent' : 'guest' };
    const got = route(verdict, requester, 'judge', entry.present === true);
    const always = entry.always === undefined || verdict?.always === entry.always;
    const ok = got === entry.expect && always;
    if (!ok) misses += 1;
    rows.push({
      case: entry.name,
      expect: entry.expect,
      got,
      level: verdict?.level ?? '',
      routine: verdict?.routine?.toFixed(3),
      aligned: typeof verdict?.aligned === 'number' ? verdict.aligned.toFixed(3) : '',
      always: verdict?.always ?? '',
      ms,
      ok: ok ? 'yes' : 'NO',
      error: judged.error ?? '',
    });
    if (record && ref === refs[0] && seen) entry.recorded = seen;
  }
  cost += spent;
  console.log(`\n${name}`);
  console.table(rows);
}
console.log(`misses: ${misses}, cost: $${cost.toFixed(4)}`);
if (record) {
  set.placeholder = false;
  await writeFile(file, `${JSON.stringify(set, null, 2)}\n`);
}
exit(misses ? 1 : 0);
