import type { Context, JsonValue } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
  type Wrap,
  wrapTool,
} from '@earendil-works/pi-durable';
import type { ShellExecOptions } from '@earendil-works/pi-durable/env';
import { gatedRun } from '../guests/guard.ts';
import type { TracedExecOptions } from '../kernel/exec.ts';
import { CALL_TAG, type Ran } from '../kernel/trace.ts';
import { withExec } from '../kernel/with-exec.ts';
import { RAN_KEY, saidIntent } from './shown.ts';

export const RAN = 'slicc-ran';

async function kept(ran: Ran, api: ToolExecutionApi, context: Context): Promise<Ran> {
  const { intent, ...rest } = ran;
  const said = intent && !(await gatedRun(api, context)) ? saidIntent(intent) : '';
  return said ? { ...rest, intent: said } : rest;
}

function merged(details: JsonValue | undefined, ran: Ran): JsonValue {
  const base =
    details && typeof details === 'object' && !Array.isArray(details) ? details : undefined;
  return { ...base, [RAN_KEY]: ran as unknown as JsonValue };
}

function traced(bash: ToolRegistration): Wrap {
  return wrapTool(bash, (inner) => ({
    ...inner,
    async execute(args, api, context: Context) {
      const env = api.env;
      if (!env) return inner.execute(args, api, context);
      let ran: Ran | undefined;
      const trace = { tag: `${CALL_TAG}${api.callId}`, report: (facts: Ran) => void (ran = facts) };
      const exec = withExec(env, (command, options, at) =>
        env.exec(command, { ...options, trace } as TracedExecOptions as ShellExecOptions, at)
      );
      const wrapped = Object.create(api, { env: { value: exec } });
      let result: Awaited<ReturnType<typeof inner.execute>>;
      try {
        result = await inner.execute(args, wrapped, context);
      } catch (error) {
        const facts = ran as Ran | undefined;
        if (facts)
          await api
            .details(merged(undefined, await kept(facts, api, context)), context)
            .catch(() => undefined);
        throw error;
      }
      const facts = ran as Ran | undefined;
      if (!facts) return result;
      return { ...result, details: merged(result.details, await kept(facts, api, context)) };
    },
  }));
}

export function ranExtension(tools: readonly ToolRegistration[]): Extension {
  const bash = tools.find((tool) => tool.name === 'bash');
  return defineExtension({ name: RAN, wraps: bash ? [traced(bash)] : [] });
}
