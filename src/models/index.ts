import type { Context } from '@earendil-works/chord';
import type { Models } from '@earendil-works/pi-ai/models';
import type { AgentChange, Conversation } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import { THINKING } from '../scoops/cli.ts';
import type { AgentSettings, ModelChoice, SettingsState } from '../services.ts';

export type Answer = { code: number; out: string };

const LEVELS = [...THINKING].join(', ');

export const USAGE = `usage:
  models [list] [--json]                          the models you can use, * marks the current one
  models current [--json]                         the current model
  models use <provider/model> [--thinking <level>]  switch this agent's model, as the Settings picker does

levels: ${LEVELS}
In an agent's bash, models switches that cone or scoop; in a terminal, the active cone.
`;

export interface ModelsOptions {
  agents: Agents;
  settings: Pick<AgentSettings, 'state'>;
  catalog: Pick<Models, 'getProviders' | 'getModels'>;
}

const ok = (out: string): Answer => ({ code: 0, out });
const fail = (out: string, code = 1): Answer => ({ code, out: `models: ${out}\n` });

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        (previous[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    previous = row;
  }
  return previous[b.length] as number;
}

export function closest(wanted: string, ids: readonly string[], count = 3): string[] {
  const target = wanted.toLowerCase();
  const score = (id: string) => {
    const lower = id.toLowerCase();
    const tail = lower.slice(lower.indexOf('/') + 1);
    const near = Math.min(distance(target, lower), distance(target, tail));
    return lower.includes(target) || target.includes(tail) ? near - 1000 : near;
  };
  return [...new Set(ids)]
    .map((id) => ({ id, score: score(id) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, count)
    .map((entry) => entry.id);
}

function agentOf(agents: Agents, caller: string | null): string {
  if (caller?.startsWith('cone:')) return caller.slice(5);
  return caller ?? agents.activeCone();
}

async function conversationOf(agents: Agents, caller: string | null, context: Context) {
  const id = agentOf(agents, caller);
  const found = await agents.conversation(id, context);
  if (!found) throw new Error(`there is no agent ${id}`);
  return found;
}

type Current = { id: string | null; thinking: string };

async function currentOf(conversation: Conversation, context: Context): Promise<Current> {
  const agent = await conversation.agent(context);
  return {
    id: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : null,
    thinking: agent.thinkingLevel,
  };
}

function stateOf(options: ModelsOptions): SettingsState {
  return options.settings.state.value ?? { models: [], accounts: [] };
}

function account(state: SettingsState, choice: ModelChoice): string {
  const providerId = choice.id.slice(0, choice.id.indexOf('/'));
  const found = state.accounts.find((entry) => entry.id === providerId);
  return found?.identity ? `${choice.provider} (${found.identity})` : choice.provider;
}

function rows(state: SettingsState, current: Current) {
  return state.models.map((choice) => ({
    id: choice.id,
    label: choice.label,
    provider: choice.provider,
    account: account(state, choice),
    reasoning: choice.reasoning,
    contextWindow: choice.contextWindow,
    current: choice.id === current.id,
  }));
}

function list(state: SettingsState, current: Current, json: boolean): Answer {
  const listed = rows(state, current);
  if (json) return ok(`${JSON.stringify(listed, null, 2)}\n`);
  const lines = listed.map(
    (row) => `${row.current ? '*' : ' '} ${row.id}\t${row.label}\t${row.account}`
  );
  if (!listed.length) lines.push('no models: connect an account in Settings');
  if (current.id && !listed.some((row) => row.current))
    lines.push(`current: ${current.id}, whose account is not connected`);
  return ok(`${lines.join('\n')}\n`);
}

function show(state: SettingsState, current: Current, json: boolean): Answer {
  if (!json) return ok(`${current.id ?? 'none'}\n`);
  const found = rows(state, current).find((row) => row.current);
  return ok(
    `${JSON.stringify({ id: current.id, thinking: current.thinking, label: found?.label ?? null, provider: found?.provider ?? null, available: Boolean(found) }, null, 2)}\n`
  );
}

function refuse(options: ModelsOptions, state: SettingsState, wanted: string): Answer {
  const at = wanted.indexOf('/');
  const providerId = at > 0 ? wanted.slice(0, at) : '';
  const modelId = wanted.slice(at + 1);
  const disconnected = state.accounts.find(
    (entry) => entry.id === providerId && entry.status !== 'connected'
  );
  const known = options.catalog.getModels(providerId);
  if (disconnected && (!known.length || known.some((model) => model.id === modelId)))
    return fail(
      `${wanted} needs the ${disconnected.provider} account; connect it in Settings, then try again`
    );
  const ids = [
    ...state.models.map((choice) => choice.id),
    ...options.catalog
      .getProviders()
      .flatMap((provider) =>
        options.catalog.getModels(provider.id).map((model) => `${provider.id}/${model.id}`)
      ),
  ];
  const near = closest(wanted, ids);
  return fail(
    `there is no model ${wanted}${near.length ? `; the closest are ${near.join(', ')}` : ''}`
  );
}

async function use(
  options: ModelsOptions,
  argv: readonly string[],
  caller: string | null,
  context: Context
): Promise<Answer> {
  const rest: string[] = [];
  let thinking: string | undefined;
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at] as string;
    if (arg === '--thinking') {
      thinking = argv[++at];
      if (thinking === undefined) return fail('--thinking needs a level', 2);
    } else if (arg.startsWith('-')) return fail(`unknown option ${arg}`, 2);
    else rest.push(arg);
  }
  if (rest.length !== 1) return { code: 2, out: USAGE };
  if (thinking !== undefined && !THINKING.has(thinking))
    return fail(`--thinking must be one of ${LEVELS}`, 2);
  const wanted = rest[0] as string;
  const state = stateOf(options);
  const choice = state.models.find((entry) => entry.id === wanted);
  if (!choice) return refuse(options, state, wanted);
  const at = wanted.indexOf('/');
  const change: AgentChange = {
    model: { provider: wanted.slice(0, at), modelId: wanted.slice(at + 1) },
    ...(thinking ? { thinkingLevel: thinking as AgentChange['thinkingLevel'] } : {}),
  };
  const conversation = await conversationOf(options.agents, caller, context);
  await conversation.configure(change, context);
  const now = await currentOf(conversation, context);
  return ok(`now using ${now.id} (${choice.label}), thinking ${now.thinking}\n`);
}

export function modelsCommand(options: ModelsOptions) {
  return async (argv: readonly string[], caller: string | null, context: Context) => {
    try {
      const [verb = 'list', ...rest] = argv;
      if (verb === '--help' || verb === '-h' || verb === 'help') return ok(USAGE);
      if (verb === 'use') return await use(options, rest, caller, context);
      const listing = verb === 'list' || verb === '--json';
      if (!listing && verb !== 'current') return { code: 2, out: USAGE };
      const flags = verb === '--json' ? argv : rest;
      const unknown = flags.find((arg) => arg !== '--json');
      if (unknown) return { code: 2, out: USAGE };
      const json = flags.includes('--json');
      const state = stateOf(options);
      const current = await currentOf(
        await conversationOf(options.agents, caller, context),
        context
      );
      return listing ? list(state, current, json) : show(state, current, json);
    } catch (error) {
      return fail((error as Error).message);
    }
  };
}
