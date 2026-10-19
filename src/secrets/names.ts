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
}

export const DESCRIBE = 'fnox env --json --describe';
export const RULES = 'fnox proxy rules --json';
export const SEALED_LIST = `exec 3<>/dev/sealed && printf '%s' '{"v":1,"op":"list"}' >&3 && cat <&3`;
export const NO_PROXY = 'No [proxy] configuration found';
export const MISSING = "fnox isn't installed";

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

const line = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

export function parseDescribe(text: string): string[] {
  const keys = (json(text) as { keys?: unknown } | null | undefined)?.keys;
  if (!Array.isArray(keys)) throw new Error('fnox env --describe printed unparseable output');
  return keys.flatMap((item: Record<string, unknown> | null) =>
    item?.kind === 'secret' && typeof item.key === 'string' ? [item.key] : []
  );
}

export function parseRules(text: string): Map<string, SecretRule[]> {
  const rules = (json(text) as { rules?: unknown } | null | undefined)?.rules;
  if (!Array.isArray(rules)) throw new Error('fnox proxy rules printed unparseable output');
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
  if (reply?.error)
    throw new Error(
      `the vault refused list: ${line(`${reply.error.code ?? ''} ${reply.error.message ?? ''}`)}`
    );
  if (!Array.isArray(reply?.secrets)) throw new Error("the vault's list reply is unparseable");
  return reply.secrets.flatMap((item: Record<string, unknown> | null) => {
    if (typeof item?.name !== 'string' || typeof item.placeholder !== 'string') return [];
    const exec = EXEC.has(item.exec as string) ? (item.exec as SecretName['exec']) : false;
    const rules = Array.isArray(item.rules) ? item.rules.flatMap(ruleOf) : [];
    return [{ name: item.name, placeholder: item.placeholder, exec, rules }];
  });
}

export function joinNames(
  keys: readonly string[],
  proposed: ReadonlyMap<string, SecretRule[]>,
  sealed: readonly Omit<SecretName, 'fnox'>[]
): SecretName[] {
  const vault = new Map(sealed.map((item) => [item.name, item]));
  const rules = (name: string, own: SecretRule[]) =>
    own.length ? own : (proposed.get(name) ?? []);
  const named = keys.map((name): SecretName => {
    const held = vault.get(name);
    return held
      ? { ...held, rules: rules(name, held.rules), fnox: true }
      : { name, placeholder: null, exec: false, rules: rules(name, []), fnox: true };
  });
  const known = new Set(keys);
  const extra = sealed
    .filter((item) => !known.has(item.name))
    .map((item) => ({ ...item, rules: rules(item.name, item.rules), fnox: false }));
  return [...named, ...extra];
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
  if (!ran.ok) throw new Error(`${label}: ${line(ran.error.message)}`);
  return { code: ran.value.exitCode ?? 1, ...out };
}

function failed(label: string, ran: Ran): Error {
  if (ran.code === 127) return new Error(MISSING);
  const message = (json(ran.stdout) as { error?: { message?: unknown } } | undefined)?.error
    ?.message;
  return new Error(
    typeof message === 'string'
      ? `${label} failed: ${line(message)}`
      : `${label} exited ${ran.code}`
  );
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
  if (ran.code !== 0) throw new Error(`/dev/sealed couldn't be read (exit ${ran.code})`);
  return parseSealed(ran.stdout);
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function listNames(env: ExecutionEnv, context: Context): Promise<SecretListing> {
  const [keys, proposed, held] = await Promise.allSettled([
    describe(env, context),
    rules(env, context),
    sealed(env, context),
  ]);
  if (keys.status === 'fulfilled' && proposed.status === 'fulfilled' && held.status === 'fulfilled')
    return { names: joinNames(keys.value, proposed.value, held.value), error: null };
  const errors = [keys, proposed, held].flatMap((item) =>
    item.status === 'rejected' ? [reason(item.reason)] : []
  );
  return { names: [], error: [...new Set(errors)].join('; ') };
}

export interface Names {
  readonly state: MutableReplicatedState<SecretListing>;
  refresh(context: Context): Promise<void>;
  close(): void;
}

export function secretNames(
  env: ExecutionEnv,
  vault: Pick<Vault, 'state'>,
  warn: (message: string) => void = (message) => console.warn(message)
): Names {
  const state = replicatedState<SecretListing>({ names: [], error: null });
  let version = vault.state.value.version;
  let warned: string | null = null;
  let lock: Promise<unknown> = Promise.resolve();
  const refresh = (context: Context) => {
    const run = lock.then(async () => {
      const listing = await listNames(env, context);
      if (listing.error && listing.error !== warned)
        warn(`slicc-secrets: secrets are unavailable: ${listing.error}`);
      warned = listing.error;
      state.replace(context, listing);
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
