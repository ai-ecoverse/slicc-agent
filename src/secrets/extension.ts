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
  'Credentials are env vars (`$NAME`) holding placeholders, listed below with where each works (`fnox list` shows the fnox config). The vault fills in the real value only in the listed header, for the listed domain, method and path, over HTTPS (curl, git, fetch). Adding a rule means editing `/etc/fnox/config.toml` with sudo: the user approving that sudo is the only acceptance there is, and the vault uses the rules in it as soon as it is written (`sealed list --json` shows the rules it uses now; the list below is read at start and can lag behind). It uses the rules of a secret only while the file is root-owned and not writable by others, and its `[secrets]` entry holds the placeholder of that secret: `NAME = { provider = "seven", value = "<placeholder>" }` (`sealed placeholder NAME` prints it); without the `value` the vault ignores the entry and every rule naming it, though `fnox check` passes. `fnox exec` gives real values only for secrets the user enabled for exec, and the secrets listed as \'in every bash\' already hold real values in your commands. Prefer an argv grant in `/etc/slicc/secrets-policy.toml` (`NAME = { argv = [["/absolute/program"]] }`) for a secret one program needs; `{ shell = true }` hands it to every bash. Everything is logged, and stored values are replaced by their placeholder in everything you see; edit around placeholders, since files show them too. Never ask the user to paste a credential into the chat.';

export const ASK_LINE =
  "When a secret you need is missing, ask the user for it: `fnox set NAME --ask` seals it and writes its entry to `fnox.toml` in the current directory, which the vault doesn't read (copy the entry into `/etc/fnox/config.toml` with sudo before adding its rules there), and `sealed ask NAME` keeps it in the vault only (`--prompt TEXT` says why you need it). The user types the value in a dialog, and the command prints only its placeholder. `fnox set` always asks for a new value and replaces an existing one, so use it only for a missing secret. Add `--reveal` to `sealed ask` only when a tool needs the plaintext itself, not where the vault fills it in a header, and pipe it straight into that tool (`sealed ask NAME --reveal | tool --password-stdin`): the user must allow every reveal, and you still see only the placeholder. A non-zero exit means the user declined or the request ended; don't ask again unless the user wants you to.";

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

export const unusedLine = (name: string, placeholder: string) =>
  `the vault uses none of these rules yet, and there is nothing for the user to accept: it takes rules only from a root-owned \`/etc/fnox/config.toml\` whose \`[secrets]\` entry is \`${name} = { provider = "seven", value = "${placeholder}" }\`; fix the file with sudo, then \`sealed list --json\` shows the rules the vault uses`;

function where(name: SecretName, granted: boolean): string {
  const rules = name.rules.map((rule) =>
    [
      rule.domain,
      rule.header ? `header ${rule.header}` : '',
      rule.methods?.length ? rule.methods.join(' ') : '',
      rule.paths?.length ? rule.paths.join(' ') : '',
      rule.proposed ? 'in the fnox config but not in effect' : '',
    ]
      .filter(Boolean)
      .join(', ')
  );
  const idle =
    name.placeholder !== null && name.rules.some((rule) => rule.proposed)
      ? [unusedLine(name.name, name.placeholder)]
      : [];
  const shell = name.exec === 'shell' && granted ? ['in every bash'] : [];
  const sealed = name.placeholder === null ? ['not sealed'] : [];
  const config = name.fnox ? [] : ['not in the fnox config'];
  const parts = [...rules, ...idle, ...shell, ...sealed, ...config];
  return parts.length ? `: ${parts.join('; ')}` : '';
}

export const NO_SECRETS =
  'No secrets are configured: the fnox config has no keys and the vault no sealed secrets.';

export function renderSecrets(listing: SecretListing): string {
  if (listing.error !== null) return unavailableLine(listing.error);
  if (!listing.names.length) return [NO_SECRETS, '', ASK_LINE].join('\n');
  const granted = !listing.exposed.length;
  const lines = listing.names.map(
    (name) => `- ${name.name} = ${name.placeholder ?? `$${name.name}`}${where(name, granted)}`
  );
  const off = granted ? [] : ['', exposedLine(listing.exposed)];
  return [MODEL_LINE, ASK_LINE, '', ...lines, ...off].join('\n');
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
