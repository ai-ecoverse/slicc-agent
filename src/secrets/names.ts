import { type Context, type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Vault } from './vault.ts';

export interface SecretRule {
  domain: string;
  header?: string;
  methods?: string[];
  paths?: string[];
  proposed?: true;
}

export interface SecretName {
  name: string;
  placeholder: string | null;
  exec: false | 'any' | 'argv' | 'shell';
  rules: SecretRule[];
  fnox: boolean;
}

export interface SecretListing {
  names: SecretName[];
  error: string | null;
  exposed: string[];
}

export const DESCRIBE = 'fnox env --json --describe';
export const RULES = 'fnox proxy rules --json';
export const SEALED_LIST = `exec 3<>/dev/sealed && printf '%s' '{"v":1,"op":"list"}' >&3 && cat <&3`;
export const NO_PROXY = 'No [proxy] configuration found';
export const MISSING = "fnox isn't installed";
export const EXPOSED =
  'shell grants are off: fnox exec would also give every command the unsealed fnox secrets';

const FNOX_ENV = /(^|[\s;&|(])fnox\s+env(\s|$)/;
const DESCRIBING = /(^|\s)--describe(\s|$)/;

export function guarded(command: string): string {
  if (FNOX_ENV.test(command) && !DESCRIBING.test(command))
    throw new Error(
      `refused to run ${JSON.stringify(command)}: without --describe it prints values`
    );
  return command;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : undefined;
}

function ruleOf(value: unknown): SecretRule[] {
  const rule = value as Record<string, unknown> | null;
  if (typeof rule?.domain !== 'string') return [];
  const methods = strings(rule.methods);
  const paths = strings(rule.paths);
  return [
    {
      domain: rule.domain,
      ...(typeof rule.header === 'string' && rule.header ? { header: rule.header } : {}),
      ...(methods?.length ? { methods } : {}),
      ...(paths?.length ? { paths } : {}),
    },
  ];
}

const EXEC = new Set(['any', 'argv', 'shell']);

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const line = (text: string) => text.replace(/\s+/g, ' ').trim();

export class Unavailable extends Error {
  readonly detail: string | undefined;
  constructor(shown: string, detail?: string) {
    super(shown);
    this.detail = detail;
  }
}

const word = (value: unknown, shape: RegExp) =>
  typeof value === 'string' && shape.test(value) ? value : undefined;

export interface FnoxKey {
  name: string;
  injected: boolean;
}

export function parseDescribe(text: string): FnoxKey[] {
  const keys = (json(text) as { keys?: unknown } | null | undefined)?.keys;
  if (!Array.isArray(keys)) throw new Unavailable('fnox env --describe printed unparseable output');
  return keys.flatMap((item: Record<string, unknown> | null) =>
    item?.kind === 'secret' && typeof item.key === 'string'
      ? [
          {
            name: item.key,
            injected: (item.injectable as { exec?: unknown } | undefined)?.exec !== false,
          },
        ]
      : []
  );
}

export function parseRules(text: string): Map<string, SecretRule[]> {
  const rules = (json(text) as { rules?: unknown } | null | undefined)?.rules;
  if (!Array.isArray(rules)) throw new Unavailable('fnox proxy rules printed unparseable output');
  const out = new Map<string, SecretRule[]>();
  for (const rule of rules as (Record<string, unknown> | null)[]) {
    if (typeof rule?.secret !== 'string') continue;
    const found = ruleOf(rule).map((item) => ({ ...item, proposed: true as const }));
    out.set(rule.secret, [...(out.get(rule.secret) ?? []), ...found]);
  }
  return out;
}

export function parseSealed(text: string): Omit<SecretName, 'fnox'>[] {
  const reply = json(text) as { secrets?: unknown; error?: { code?: unknown; message?: unknown } };
  if (reply?.error) {
    const code = word(reply.error.code, /^[A-Z][A-Z0-9_]{0,31}$/);
    throw new Unavailable(
      code ? `the vault refused to list secrets (${code})` : 'the vault refused to list secrets',
      `${String(reply.error.code ?? '')} ${String(reply.error.message ?? '')}`
    );
  }
  if (!Array.isArray(reply?.secrets))
    throw new Unavailable("the vault's list reply is unparseable");
  return reply.secrets.flatMap((item: Record<string, unknown> | null) => {
    if (typeof item?.name !== 'string' || typeof item.placeholder !== 'string') return [];
    const exec = EXEC.has(item.exec as string) ? (item.exec as SecretName['exec']) : false;
    const rules = Array.isArray(item.rules) ? item.rules.flatMap(ruleOf) : [];
    return [{ name: item.name, placeholder: item.placeholder, exec, rules }];
  });
}

export function joinNames(
  keys: readonly FnoxKey[],
  proposed: ReadonlyMap<string, SecretRule[]>,
  sealed: readonly Omit<SecretName, 'fnox'>[]
): SecretListing {
  const vault = new Map(sealed.map((item) => [item.name, item]));
  const rules = (name: string, own: SecretRule[]) =>
    own.length ? own : (proposed.get(name) ?? []);
  const named = keys.map(({ name }): SecretName => {
    const held = vault.get(name);
    return held
      ? { ...held, rules: rules(name, held.rules), fnox: true }
      : { name, placeholder: null, exec: false, rules: rules(name, []), fnox: true };
  });
  const known = new Set(keys.map((key) => key.name));
  const extra = sealed
    .filter((item) => !known.has(item.name))
    .map((item) => ({ ...item, rules: rules(item.name, item.rules), fnox: false }));
  const exposed = keys.filter((key) => key.injected && !vault.has(key.name)).map((key) => key.name);
  return { names: [...named, ...extra], error: null, exposed };
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  env: ExecutionEnv,
  label: string,
  command: string,
  context: Context
): Promise<Ran> {
  const out = { stdout: '', stderr: '' };
  const ran = await env.exec(
    guarded(command),
    {
      onOutput: (text, _using, info) => {
        out[info?.stream === 'stderr' ? 'stderr' : 'stdout'] += text;
      },
    },
    context
  );
  if (!ran.ok)
    throw new Unavailable(`${label} couldn't run (${ran.error.code})`, ran.error.message);
  return { code: ran.value.exitCode ?? 1, ...out };
}

const KINDS: Record<string, string> = {
  config: 'the fnox config has an error; check /etc/fnox/config.toml',
};

function failed(label: string, ran: Ran): Unavailable {
  if (ran.code === 127) return new Unavailable(MISSING);
  const error = (json(ran.stdout) as { error?: { kind?: unknown; message?: unknown } } | undefined)
    ?.error;
  const kind = word(error?.kind, /^[a-z][a-z_]{0,31}$/);
  const detail = typeof error?.message === 'string' ? error.message : undefined;
  if (kind) return new Unavailable(KINDS[kind] ?? `${label} failed (${kind})`, detail);
  return new Unavailable(`${label} exited ${ran.code}`, detail);
}

async function describe(env: ExecutionEnv, context: Context) {
  const label = 'fnox env --describe';
  const ran = await run(env, label, DESCRIBE, context);
  if (ran.code !== 0) throw failed(label, ran);
  return parseDescribe(ran.stdout);
}

async function rules(env: ExecutionEnv, context: Context) {
  const ran = await run(env, 'fnox proxy rules', RULES, context);
  if (ran.code === 1 && ran.stderr.includes(NO_PROXY)) return new Map<string, SecretRule[]>();
  if (ran.code !== 0) throw failed('fnox proxy rules', ran);
  return parseRules(ran.stdout);
}

async function sealed(env: ExecutionEnv, context: Context) {
  const ran = await run(env, '/dev/sealed', SEALED_LIST, context);
  if (ran.code !== 0) throw new Unavailable(`/dev/sealed couldn't be read (exit ${ran.code})`);
  return parseSealed(ran.stdout);
}

export interface Listed {
  listing: SecretListing;
  details: string[];
}

export async function listNames(env: ExecutionEnv, context: Context): Promise<Listed> {
  const [keys, proposed, held] = await Promise.allSettled([
    describe(env, context),
    rules(env, context),
    sealed(env, context),
  ]);
  if (keys.status === 'fulfilled' && proposed.status === 'fulfilled' && held.status === 'fulfilled')
    return { listing: joinNames(keys.value, proposed.value, held.value), details: [] };
  const failures = [keys, proposed, held].flatMap((item) =>
    item.status === 'rejected'
      ? [
          item.reason instanceof Unavailable
            ? item.reason
            : new Unavailable('listing failed', String(item.reason)),
        ]
      : []
  );
  return {
    listing: {
      names: [],
      error: [...new Set(failures.map((item) => item.message))].join('; '),
      exposed: [],
    },
    details: failures.flatMap((item) => (item.detail ? [line(item.detail)] : [])),
  };
}

export interface Names {
  readonly state: MutableReplicatedState<SecretListing>;
  refresh(context: Context): Promise<void>;
  close(): void;
}

export function secretNames(
  env: ExecutionEnv,
  vault: Pick<Vault, 'state' | 'texts'>,
  warn: (message: string) => void = (message) => console.warn(message)
): Names {
  const state = replicatedState<SecretListing>({ names: [], error: null, exposed: [] });
  let version = vault.state.value.version;
  let warned: string | null = null;
  let lock: Promise<unknown> = Promise.resolve();
  const report = async (listing: SecretListing, details: string[]) => {
    const said = listing.error ?? (listing.exposed.length ? EXPOSED : null);
    const fresh = said !== warned;
    warned = said;
    if (said && fresh) {
      const shown = details.length
        ? await vault.texts(details).then(
            (texts) => texts.join('; ').slice(0, 200),
            () => ''
          )
        : '';
      const named = listing.error ? '' : listing.exposed.join(', ');
      warn(
        `slicc-secrets: ${listing.error ? `secrets are unavailable: ${said}` : `${said}: ${named}`}${shown ? ` (${shown})` : ''}`
      );
    }
  };
  const refresh = (context: Context) => {
    const run = lock.then(async () => {
      const { listing, details } = await listNames(env, context);
      state.replace(context, listing);
      void report(listing, details);
    });
    lock = run.catch(() => undefined);
    return run;
  };
  const off = vault.state.subscribe((value, context) => {
    if (value.version === version) return;
    version = value.version;
    void refresh(context).catch(() => undefined);
  });
  return { state, refresh, close: off };
}
