import type { JsonValue } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  GenerationTask,
  hook,
  section,
  type ToolExecutionResult,
  ToolTask,
} from '@earendil-works/pi-durable';
import type { Names, SecretListing, SecretName } from './names.ts';
import type { Scrub } from './scrub.ts';
import type { Vault } from './vault.ts';
import { exposedLine, listedLine, SECRETS_KIND, unavailableLine } from './view.ts';

export { exposedLine, listedLine, SECRETS_KIND, unavailableLine };

export const SECRETS = 'slicc-secrets';
export const SECRETS_COMMAND = '/secrets';
export const SHELL_GRANTS = ['fnox', 'exec', '--shell-grants', '--'] as const;

export const MODEL_LINE =
  "Credentials are env vars (`$NAME`) holding placeholders, listed below with where each works (`fnox list` shows the fnox config). The vault fills in the real value only in the listed header, for the listed domain, method and path, over HTTPS (curl, git, fetch). Adding a rule means editing `/etc/fnox/config.toml` with sudo, which the user approves. `fnox exec` gives real values only for secrets the user enabled for exec, and the secrets listed as 'in every bash' already hold real values in your commands. Everything is logged, and stored values are replaced by their placeholder in everything you see; edit around placeholders, since files show them too. Never ask the user to paste a credential into the chat.";

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
  const content = [...(result.output ?? [])];
  const diagnostics = [...(result.diagnostics ?? [])];
  const copy = (value: JsonValue | undefined) =>
    value === undefined ? undefined : (structuredClone(value) as JsonValue);
  const details = copy(result.details);
  const structured = copy(result.structuredOutput);
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
  let output = structured;
  if (structured !== undefined)
    leaves(structured, found, (next) => {
      output = next;
    });
  const before = found.map((leaf) => leaf.get());
  const after = await scrub.texts(before);
  if (after.every((text, at) => text === before[at])) return undefined;
  found.forEach((leaf, at) => {
    leaf.set(after[at] as string);
  });
  const kept = result.output as ToolExecutionResult['output'] & unknown[];
  if (kept) kept.splice(0, kept.length, ...content);
  return {
    ...result,
    ...(kept ? { output: kept } : {}),
    ...(result.diagnostics ? { diagnostics } : {}),
    ...(replaced === undefined ? {} : { details: replaced }),
    ...(output === undefined ? {} : { structuredOutput: output }),
  };
}

function where(name: SecretName, granted: boolean): string {
  const rules = name.rules.map((rule) =>
    [
      rule.domain,
      rule.header ? `header ${rule.header}` : '',
      rule.methods?.length ? rule.methods.join(' ') : '',
      rule.paths?.length ? rule.paths.join(' ') : '',
      rule.proposed ? 'proposed in the fnox config, not yet accepted by the vault' : '',
    ]
      .filter(Boolean)
      .join(', ')
  );
  const shell = name.exec === 'shell' && granted ? ['in every bash'] : [];
  const sealed = name.placeholder === null ? ['not sealed'] : [];
  const config = name.fnox ? [] : ['not in the fnox config'];
  const parts = [...rules, ...shell, ...sealed, ...config];
  return parts.length ? `: ${parts.join('; ')}` : '';
}

export const NO_SECRETS =
  'No secrets are configured: the fnox config has no keys and the vault no sealed secrets.';

export function renderSecrets(listing: SecretListing): string {
  if (listing.error !== null) return unavailableLine(listing.error);
  if (!listing.names.length) return NO_SECRETS;
  const granted = !listing.exposed.length;
  const lines = listing.names.map(
    (name) => `- ${name.name} = ${name.placeholder ?? `$${name.name}`}${where(name, granted)}`
  );
  const off = granted ? [] : ['', exposedLine(listing.exposed)];
  return [MODEL_LINE, '', ...lines, ...off].join('\n');
}

export function secretsEntry(listing: SecretListing) {
  return {
    kind: SECRETS_KIND,
    data: {
      names: structuredClone(listing.names) as unknown as JsonValue,
      error: listing.error,
      exposed: [...listing.exposed],
    },
    model: [{ role: 'user' as const, content: listedLine(listing), timestamp: Date.now() }],
  };
}

export function granting(listing: SecretListing): boolean {
  return (
    listing.error === null &&
    !listing.exposed.length &&
    listing.names.some((name) => name.exec === 'shell')
  );
}

export function shellGrants(names: Pick<Names, 'state'>) {
  return (argv: readonly string[]): readonly string[] =>
    granting(names.state.value) ? [...SHELL_GRANTS, ...argv] : argv;
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
