import { type Context, type MutableReplicatedState, replicatedState } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Vault } from './vault.ts';

export interface SecretRule {
  domain: string;
  header?: string;
  methods?: string[];
  paths?: string[];
}

export interface SecretName {
  name: string;
  placeholder: string;
  exec: false | 'any' | 'argv' | 'shell';
  rules: SecretRule[];
}

export const LIST = 'secret list --json';

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
      ...(typeof rule.header === 'string' ? { header: rule.header } : {}),
      ...(methods ? { methods } : {}),
      ...(paths ? { paths } : {}),
    },
  ];
}

const EXEC = new Set(['any', 'argv', 'shell']);

export function parseNames(text: string): SecretName[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { secrets?: unknown } | null)?.secrets;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: Record<string, unknown> | null) => {
    if (typeof item?.name !== 'string' || typeof item.placeholder !== 'string') return [];
    const exec = EXEC.has(item.exec as string) ? (item.exec as SecretName['exec']) : false;
    const rules = Array.isArray(item.rules) ? item.rules.flatMap(ruleOf) : [];
    return [{ name: item.name, placeholder: item.placeholder, exec, rules }];
  });
}

export async function listNames(env: ExecutionEnv, context: Context): Promise<SecretName[]> {
  let out = '';
  const ran = await env
    .exec(
      LIST,
      {
        onOutput: (text, _using, info) => {
          if (info?.stream !== 'stderr') out += text;
        },
      },
      context
    )
    .catch(() => undefined);
  return ran?.ok && ran.value.exitCode === 0 ? parseNames(out) : [];
}

export interface Names {
  readonly state: MutableReplicatedState<SecretName[]>;
  refresh(context: Context): Promise<void>;
  close(): void;
}

export function secretNames(env: ExecutionEnv, vault: Pick<Vault, 'state'>): Names {
  const state = replicatedState<SecretName[]>([]);
  let version = vault.state.value.version;
  let lock: Promise<unknown> = Promise.resolve();
  const refresh = (context: Context) => {
    const run = lock.then(async () => state.replace(context, await listNames(env, context)));
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
