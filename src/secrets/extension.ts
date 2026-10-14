import type { Context, JsonValue } from '@earendil-works/chord';
import {
  type AgentChange,
  type Cursor,
  defineExtension,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  type Storage,
  section,
  type ToolExecutionResult,
  ToolTask,
} from '@earendil-works/pi-durable';
import { TITLES } from '../titles/extension.ts';
import type { Names, SecretName } from './names.ts';
import type { Scrub } from './scrub.ts';
import type { Vault } from './vault.ts';
import { listedLine, SECRETS_KIND } from './view.ts';

export { listedLine, SECRETS_KIND };

export const SECRETS = 'slicc-secrets';
export const SECRETS_COMMAND = '/secrets';
export const SHELL_GRANTS = ['fnox', 'exec', '--shell-grants', '--'] as const;

export const MODEL_LINE =
  "Credentials are env vars (`$NAME`) holding placeholders; `secret list` shows them and where each works. The vault fills in the real value only in the listed header, for the listed domain, method and path, over HTTPS (curl, git, fetch). Adding a rule means editing `/etc/fnox/config.toml` with sudo, which the user approves. `fnox exec` gives real values only for secrets the user enabled for exec, and the secrets listed as 'in every bash' already hold real values in your commands. Everything is logged, and stored values are replaced by their placeholder in everything you see; edit around placeholders, since files show them too. Never ask the user to paste a credential into the chat.";

type Leaf = { get(): string; set(text: string): void };

function leaves(value: JsonValue, out: Leaf[], set: (next: JsonValue) => void): void {
  if (typeof value === 'string') {
    out.push({ get: () => value, set });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, at) => {
      leaves(item, out, (next) => {
        value[at] = next;
      });
    });
    return;
  }
  if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      leaves(item as JsonValue, out, (next) => {
        (value as Record<string, JsonValue>)[key] = next;
      });
}

export async function scrubResult(
  result: ToolExecutionResult,
  scrub: Pick<Scrub, 'texts'>
): Promise<ToolExecutionResult | undefined> {
  const content = [...(result.content ?? [])];
  const diagnostics = [...(result.diagnostics ?? [])];
  const details =
    result.details === undefined ? undefined : (structuredClone(result.details) as JsonValue);
  const found: Leaf[] = [];
  content.forEach((item, at) => {
    if (item.type === 'text')
      found.push({ get: () => item.text, set: (text) => void (content[at] = { ...item, text }) });
  });
  diagnostics.forEach((item, at) => {
    found.push({
      get: () => item.message,
      set: (message) => void (diagnostics[at] = { ...item, message }),
    });
  });
  let replaced = details;
  if (details !== undefined)
    leaves(details, found, (next) => {
      replaced = next;
    });
  const before = found.map((leaf) => leaf.get());
  const after = await scrub.texts(before);
  if (after.every((text, at) => text === before[at])) return undefined;
  found.forEach((leaf, at) => {
    leaf.set(after[at] as string);
  });
  const kept = result.content as ToolExecutionResult['content'] & unknown[];
  if (kept) kept.splice(0, kept.length, ...content);
  return {
    ...result,
    ...(kept ? { content: kept } : {}),
    ...(result.diagnostics ? { diagnostics } : {}),
    ...(replaced === undefined ? {} : { details: replaced }),
  };
}

function where(name: SecretName): string {
  const rules = name.rules.map((rule) =>
    [
      rule.domain,
      rule.header ? `header ${rule.header}` : '',
      rule.methods?.length ? rule.methods.join(' ') : '',
      rule.paths?.length ? rule.paths.join(' ') : '',
    ]
      .filter(Boolean)
      .join(', ')
  );
  const shell = name.exec === 'shell' ? ['in every bash'] : [];
  const parts = [...rules, ...shell];
  return parts.length ? `: ${parts.join('; ')}` : '';
}

export function renderSecrets(names: readonly SecretName[]): string | undefined {
  if (!names.length) return undefined;
  const lines = names.map((name) => `- ${name.name} = ${name.placeholder}${where(name)}`);
  return [MODEL_LINE, '', ...lines].join('\n');
}

export function secretsEntry(names: readonly SecretName[]) {
  return {
    kind: SECRETS_KIND,
    data: { names: structuredClone(names) as unknown as JsonValue },
    model: [{ role: 'user' as const, content: listedLine(names), timestamp: Date.now() }],
  };
}

export function shellGrants(names: Pick<Names, 'state'>) {
  return (argv: readonly string[]): readonly string[] =>
    names.state.value.some((name) => name.exec === 'shell') ? [...SHELL_GRANTS, ...argv] : argv;
}

const missing = (list: readonly { name: string }[]) =>
  [SECRETS, TITLES].filter((name) => !list.some((extension) => extension.name === name));

export function pinned<T extends AgentChange>(change: T): T {
  const list = change.extensions;
  if (!Array.isArray(list)) return change;
  const added = missing(list);
  return added.length
    ? { ...change, extensions: [...list, ...added.map((name) => ({ name }))] }
    : change;
}

export async function repin(
  harness: Pick<Harness, 'conversation'>,
  storage: Pick<Storage, 'scanConversations'>,
  context: Context
): Promise<number> {
  let fixed = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, 100, cursor, context);
    for (const record of page.items) {
      const conversation = await harness.conversation(record.id, context);
      if (!conversation) continue;
      const agent = await conversation.agent(context);
      if (!missing(agent.extensions).length) continue;
      await conversation.configure(pinned({ extensions: agent.extensions }), context);
      fixed++;
    }
    cursor = page.next;
  } while (cursor);
  return fixed;
}

export function secretsExtension(deps: {
  names: Pick<Names, 'state'>;
  vault: Pick<Vault, 'ready' | 'texts'>;
}): Extension {
  return defineExtension({
    name: SECRETS,
    sections: [section('secrets', () => renderSecrets(deps.names.state.value))],
    hooks: [
      hook(ToolTask, { afterTool: (_call, result) => scrubResult(result, deps.vault) }),
      hook(GenerationTask, {
        beforeRequest: async () => {
          await deps.vault.ready();
          return undefined;
        },
      }),
    ],
  });
}
