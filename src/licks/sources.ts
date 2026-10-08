import type { Context } from '@earendil-works/chord';
import type { Conversation, Harness } from '@earendil-works/pi-durable';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import { type BootFacts, bootLicks } from './boot.ts';
import { type ConfigError, parseCrontab, parseWebhook, type WebhookEntry } from './config.ts';
import type { cronTask } from './extension.ts';
import { type ConfigFiles, configFiles, Watches } from './fswatch.ts';
import type { LickChannel } from './lick.ts';
import type { LickEvent, Licks } from './licks.ts';
import { reconcileCron } from './schedules.ts';

export const SLICC_DIR = '.slicc';

export interface LickSourcesOptions {
  harness: Harness;
  root: Conversation;
  cone: () => Conversation;
  env: ExecutionEnv;
  home: string;
  licks: Licks;
  cron: ReturnType<typeof cronTask>;
  now?: () => number;
  flushEvery?: number;
}

export interface WebhookDelivery {
  id?: string;
  headers?: Record<string, string>;
  body: unknown;
}

export interface LickSources {
  start(context: Context): Promise<void>;
  reconcile(context: Context): Promise<void>;
  boot(facts: BootFacts, context: Context): Promise<void>;
  webhook(name: string, delivery: WebhookDelivery, context: Context): Promise<boolean>;
  close(context: Context): Promise<void>;
}

export function hash(text: string): string {
  let value = 2166136261;
  for (let at = 0; at < text.length; at++) value = Math.imul(value ^ text.charCodeAt(at), 16777619);
  return (value >>> 0).toString(36);
}

export function shortPath(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function configLick(error: ConfigError, home: string): LickEvent {
  const file = shortPath(error.file, home);
  const channel: LickChannel = error.file.includes('/watches/')
    ? 'fswatch'
    : error.file.includes('/webhooks/')
      ? 'webhook'
      : 'cron';
  const text = `${file}${error.line ? ` line ${error.line}` : ''}: ${error.error}`;
  return {
    channel,
    source: `config:${file}`,
    title: `Invalid ${file}`,
    text,
    body: 'Fix the file and save it again; until then this entry is ignored. The formats are in the slicc-agent README.',
    target: 'cone',
    eventId: hash(text),
  };
}

export function webhookLick(
  name: string,
  entry: WebhookEntry,
  delivery: WebhookDelivery
): LickEvent {
  const payload =
    typeof delivery.body === 'string' ? delivery.body : JSON.stringify(delivery.body, null, 2);
  const headers = Object.entries(delivery.headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return {
    channel: 'webhook',
    source: name,
    title: name,
    text: entry.message || `Webhook ${name} received a request`,
    body: [headers, payload].filter(Boolean).join('\n\n'),
    target: entry.target,
    coalesce: false,
    ...(delivery.id ? { eventId: delivery.id } : {}),
  };
}

async function webhooksIn(
  files: ConfigFiles,
  dir: string,
  into: Map<string, WebhookEntry>,
  context: Context
): Promise<ConfigError[]> {
  const errors: ConfigError[] = [];
  into.clear();
  for (const name of await files.list(dir, context)) {
    const file = `${dir}/${name}`;
    const json = await files.read(file, context);
    if (json === undefined) continue;
    try {
      const entry = parseWebhook(file, json);
      into.set(entry.name, entry);
    } catch (error) {
      errors.push({ file, error: (error as Error).message });
    }
  }
  return errors;
}

export function createLickSources(options: LickSourcesOptions): LickSources {
  const { harness, env, licks, home } = options;
  const dir = `${home}/${SLICC_DIR}`;
  const now = options.now ?? Date.now;
  const files = configFiles(env);
  const deliver = (event: LickEvent, context: Context) => licks.deliver(event, context);
  const watches = new Watches(env, deliver, home);
  const webhooks = new Map<string, WebhookEntry>();
  let control: FileWatcher | undefined;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lock.then(operation, operation);
    lock = run.catch(() => undefined);
    return run;
  };

  async function reconcileNow(context: Context): Promise<void> {
    if (closed) return;
    const crontabFile = `${dir}/crontab`;
    const crontab = parseCrontab(crontabFile, (await files.read(crontabFile, context)) ?? '');
    await reconcileCron({ ...options, now }, crontab.entries, context);
    const errors = [
      ...crontab.errors,
      ...(await watches.reconcile(`${dir}/watches`, context)),
      ...(await webhooksIn(files, `${dir}/webhooks`, webhooks, context)),
    ];
    for (const error of errors) await deliver(configLick(error, home), context);
  }

  const reconcile = (context: Context) => serial(() => reconcileNow(context));

  function scheduleReconcile(context: Context): void {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      void reconcile(context).catch(() => undefined);
    }, 300);
  }

  async function flushIfWaiting(context: Context): Promise<void> {
    if (await licks.pending(context)) await licks.flush(context);
  }

  return {
    async start(context) {
      await licks.flush(context);
      await reconcile(context);
      const result = await env.watch(
        [{ path: dir, recursive: true }],
        () => scheduleReconcile(context),
        context
      );
      if (result.ok) control = result.value;
      flushTimer = setInterval(() => {
        void flushIfWaiting(context).catch(() => undefined);
      }, options.flushEvery ?? 2000);
    },
    reconcile,
    boot: (facts, context) => bootLicks(harness, options.cone(), deliver, facts, context),
    async webhook(name, delivery, context) {
      const entry = webhooks.get(name);
      if (!entry) return false;
      await deliver(webhookLick(name, entry, delivery), context);
      return true;
    },
    async close(context) {
      closed = true;
      clearTimeout(reconcileTimer);
      clearInterval(flushTimer);
      await control?.close(context);
      await watches.close(context);
    },
  };
}
