import type { Context, JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, Harness, TaskId } from '@earendil-works/pi-durable';
import { UsageDoc } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { Check, Errors } from 'typebox/schema';
import type { Agents } from '../agents.ts';
import type { Layout } from '../layout.ts';
import { findRole, type Role, type Roles } from '../roles/roles.ts';
import type { ReportResult } from '../scoops/extension.ts';
import { modelOf, type Scoops } from '../scoops/service.ts';
import { MAX_SCHEMA } from './script.ts';

export const EFFORT: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};

export interface AgentCall {
  prompt: string;
  label?: string;
  phase?: string;
  schema?: JsonValue;
  model?: string;
  effort?: string;
  agentType?: string;
}

export interface StepHost {
  harness: Harness;
  agents: Agents;
  scoops: Scoops;
  roles: (context: Context) => Promise<Roles>;
  env: Pick<ExecutionEnv, 'remove'>;
  layout: Layout;
}

export class StepError extends Error {
  readonly outputTokens: number;

  constructor(message: string, outputTokens = 0) {
    super(message);
    this.outputTokens = outputTokens;
  }
}

export interface Planned {
  name: string;
  prompt: string;
  role?: Role;
  model?: { provider: string; modelId: string };
  thinking?: string;
  schema?: object;
}

function schemaOf(value: JsonValue | undefined): object | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new StepError('agent(): schema must be a JSON Schema object');
  if (JSON.stringify(value).length > MAX_SCHEMA)
    throw new StepError('agent(): schema is at most 64 KiB');
  return value;
}

export function instruction(schema: object): string {
  return `\n\nEnd your work with a final answer that is only JSON, with no other text and no code fence, matching this JSON Schema:\n${JSON.stringify(schema)}`;
}

const OPTIONS = new Set(['prompt', 'label', 'phase', 'schema', 'model', 'effort', 'agentType']);

function checked(call: unknown): AgentCall {
  if (typeof call !== 'object' || call === null || Array.isArray(call))
    throw new StepError('agent(): options must be an object');
  const given = call as Record<string, unknown>;
  if (typeof given.prompt !== 'string' || !given.prompt.trim())
    throw new StepError('agent() needs a prompt string');
  if ('isolation' in given) throw new StepError('agent(): isolation is not supported in SLICC');
  const unknown = Object.keys(given).find((key) => !OPTIONS.has(key));
  if (unknown) throw new StepError(`agent(): unknown option ${unknown}`);
  return given as unknown as AgentCall;
}

export function plan(given: unknown, roles: Roles): Planned {
  const call = checked(given);
  const role = call.agentType === undefined ? undefined : findRole(roles.roles, call.agentType);
  if (call.agentType !== undefined && !role)
    throw new StepError(`agent(): there is no agent role ${call.agentType}`);
  const model = call.model === undefined ? undefined : modelOf(String(call.model));
  if (call.model !== undefined && !model)
    throw new StepError(`agent(): model must be provider/model, not ${call.model}`);
  const thinking = call.effort === undefined ? undefined : EFFORT[String(call.effort)];
  if (call.effort !== undefined && !thinking)
    throw new StepError('agent(): effort must be low, medium, high, xhigh or max');
  const schema = schemaOf(call.schema);
  const label = typeof call.label === 'string' && call.label.trim() ? call.label : undefined;
  return {
    name: label ?? role?.name ?? 'workflow',
    prompt: schema ? `${call.prompt}${instruction(schema)}` : call.prompt,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(schema ? { schema } : {}),
  };
}

export function parseAnswer(text: string, schema: object): JsonValue {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  const body = (fenced ? fenced[1] : text) as string;
  let value: JsonValue;
  try {
    value = JSON.parse(body.trim()) as JsonValue;
  } catch {
    throw new Error(`agent(): the answer is not JSON: ${body.trim().slice(0, 120)}`);
  }
  if (!Check(schema as never, value)) {
    const [, errors] = Errors(schema as never, value) as unknown as [
      boolean,
      { instancePath: string; message: string }[],
    ];
    const detail = errors
      .slice(0, 1)
      .map((error) => `: ${error.instancePath || '/'} ${error.message}`)
      .join('');
    throw new Error(`agent(): the answer does not match the schema${detail}`);
  }
  return value;
}

export async function outputTokens(
  harness: Harness,
  conversation: number,
  context: Context
): Promise<number> {
  const usage = await harness.snapshot(UsageDoc, conversation as ConversationId, context);
  return Object.values(usage?.models ?? {}).reduce(
    (sum, entry) => sum + ((entry as { output?: number }).output ?? 0),
    0
  );
}

export async function cleanup(host: StepHost, folder: string): Promise<void> {
  const id = `scoop:${folder}`;
  const record = host.agents.state().scoops[id];
  await host.scoops.stop(id, false, BACKGROUND_CONTEXT).catch(() => undefined);
  if (record)
    await host.env
      .remove(
        host.layout.scoopRoot(record.folder),
        { recursive: true, force: true },
        BACKGROUND_CONTEXT
      )
      .catch(() => undefined);
}

export async function settle(
  host: StepHost,
  folder: string,
  task: number,
  planned: Planned,
  wait: (task: number) => Promise<ReportResult>,
  context: Context
): Promise<{ value: JsonValue; outputTokens: number }> {
  const result = await wait(task);
  const record = host.agents.state().scoops[`scoop:${folder}`];
  const spent = record ? await outputTokens(host.harness, record.conversation, context) : 0;
  if (result.failed)
    throw new StepError(`agent(): the agent ended without an answer: ${result.failed}`, spent);
  if (!planned.schema) return { value: result.text, outputTokens: spent };
  try {
    return { value: parseAnswer(result.text, planned.schema), outputTokens: spent };
  } catch (error) {
    throw new StepError((error as Error).message, spent);
  }
}

export async function waitReport(
  wait: (id: TaskId<ReportResult>, context: Context) => Promise<{ state: unknown }>,
  task: number,
  context: Context
): Promise<ReportResult> {
  const settled = (await wait(task as TaskId<ReportResult>, context)) as {
    state: { outcome: { status: string; result?: ReportResult } };
  };
  const outcome = settled.state.outcome;
  return outcome.status === 'completed' && outcome.result
    ? outcome.result
    : { text: '', failed: outcome.status, path: null };
}
