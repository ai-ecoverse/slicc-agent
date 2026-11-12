import type { Context } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  type JsonObject,
  type ToolExecutionApi,
  type ToolRegistration,
  type Wrap,
  wrapTool,
} from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { gatedRun } from '../guests/guard.ts';
import { withExec } from '../kernel/with-exec.ts';
import { INTENT_TOOLS, intentOf, withoutIntent } from './said.ts';

export const INTENTS = 'slicc-intents';
export const INTENT_ENV = 'SLICC_INTENT';
export const INTENT_DESCRIPTION =
  'What this call does, as 2–6 words starting with a present participle, in the user\'s language, such as "Backing up the dataset\'s access list". No credentials, secrets or command output.';

export const INTENT_LENGTH = 120;

const INTENT = { type: 'string', maxLength: INTENT_LENGTH, description: INTENT_DESCRIPTION };

type Schema = { properties?: Record<string, unknown> };

export function withIntent(parameters: object): object {
  const schema = parameters as Schema;
  return { ...schema, properties: { intent: INTENT, ...schema.properties } };
}

function told(env: ExecutionEnv, intent: string): ExecutionEnv {
  return withExec(env, (command, options, context) =>
    env.exec(command, { ...options, env: { ...options?.env, [INTENT_ENV]: intent } }, context)
  );
}

function bashIntent(bash: ToolRegistration): Wrap {
  return wrapTool(bash, (inner) => ({
    ...inner,
    parameters: withIntent(inner.parameters),
    async execute(args, api, context: Context) {
      const said = intentOf(inner.name, args);
      const rest = withoutIntent(inner.name, args as JsonObject);
      if (!said || !api.env || (await gatedRun(api, context)))
        return inner.execute(rest, api, context);
      const wrapped = Object.create(api, { env: { value: told(api.env, said) } });
      return inner.execute(rest, wrapped, context);
    },
  }));
}

export function inherited(name: string, args: JsonObject, intent: string): JsonObject {
  if (name !== 'bash' || typeof args.intent === 'string') return args;
  return { intent, ...args };
}

function codemodeIntent(codemode: ToolRegistration): Wrap {
  return wrapTool(codemode, (inner) => ({
    ...inner,
    parameters: withIntent(inner.parameters),
    async execute(args, api, context: Context) {
      const said = intentOf(inner.name, args);
      const rest = withoutIntent(inner.name, args as JsonObject);
      if (!said) return inner.execute(rest, api, context);
      const executeTool: ToolExecutionApi['executeTool'] = (name, nested, ...more) =>
        api.executeTool(name, inherited(name, nested, said), ...more);
      const wrapped = Object.create(api, { executeTool: { value: executeTool } });
      return inner.execute(rest, wrapped, context);
    },
  }));
}

function stripped(tool: ToolRegistration): Wrap {
  return wrapTool(tool, (inner) => ({
    ...inner,
    execute: (args, api, context: Context) =>
      inner.execute(withoutIntent(inner.name, args as JsonObject), api, context),
  }));
}

function offered(tool: ToolRegistration): Wrap {
  return tool.name === 'bash' ? bashIntent(tool) : codemodeIntent(tool);
}

export function intentExtension(tools: readonly ToolRegistration[], on = true): Extension {
  const wraps = tools
    .filter((tool) => INTENT_TOOLS.has(tool.name))
    .map((tool) => (on ? offered(tool) : stripped(tool)));
  return defineExtension({ name: INTENTS, wraps });
}
