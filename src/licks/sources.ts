import type { Context } from '@earendil-works/chord';
import type { Conversation, Harness, TaskId } from '@earendil-works/pi-durable';
import type { ExecutionEnv, FileWatcher } from '@earendil-works/pi-durable/env';
import type { Activity } from '../kernel/activity.ts';
import type { Jobs } from '../kernel/jobs.ts';
import { ROOT_USER } from '../layout.ts';
import { type Attachment, attachmentPart } from './attachment.ts';
import { type BootFacts, booting, LicksHostDoc } from './boot.ts';
import { type ConfigError, parseWebhook, type WebhookEntry } from './config.ts';
import {
  type CronJob,
  installJobs,
  type LegacyJob,
  legacyJobs,
  relickJobs,
  sendCommand,
} from './crontab.ts';
import { type ConfigFiles, configFiles, Watches } from './fswatch.ts';
import type { LickChannel, LickTarget } from './lick.ts';
import type { LickEvent, Licks } from './licks.ts';

export const SLICC_DIR = '.slicc';

export interface LickSourcesOptions {
  harness: Harness;
  root: Conversation;
  cone: () => Conversation;
  env: ExecutionEnv;
  home: string;
  licks: Licks;
  flushEvery?: number;
  activity?: Activity;
  jobs?: Jobs;
  dirs?: () => readonly LickDir[] | Promise<readonly LickDir[]>;
  cronUser?: (target: LickTarget, place: LickDir) => string | undefined;
  fetch?: typeof fetch;
}

export interface LickDir {
  dir: string;
  home: string;
  cone: string | null;
  env?: ExecutionEnv;
}

export function scopedTarget(target: LickTarget, cone: string | null): LickTarget {
  return cone && target === 'cone' ? (`cone:${cone}` as LickTarget) : target;
}

export function scopedName(name: string, cone: string | null): string {
  return cone ? `${cone}:${name}` : name;
}

function scoped<T extends { name: string; target: LickTarget }>(entry: T, cone: string | null): T {
  return { ...entry, name: scopedName(entry.name, cone), target: scopedTarget(entry.target, cone) };
}

export interface WebhookDelivery {
  id?: string;
  headers?: Record<string, string>;
  body: unknown;
  verified?: boolean;
  attachment?: Attachment;
}

export async function withAttachment(
  delivery: WebhookDelivery,
  fetcher: typeof fetch | undefined
): Promise<WebhookDelivery> {
  const { attachment, ...rest } = delivery;
  if (!attachment) return delivery;
  const part = await attachmentPart(attachment, fetcher);
  return { ...rest, body: [rest.body, part].filter(Boolean).join('\n\n') };
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

export function configLick(
  error: ConfigError,
  home: string,
  cone: string | null = null
): LickEvent {
  const file = shortPath(error.file, home);
  const channel: LickChannel = error.file.includes('/watches/')
    ? 'fswatch'
    : error.file.includes('/webhooks/')
      ? 'webhook'
      : 'cron';
  const text = `${error.line ? `line ${error.line}: ` : ''}${error.error}`;
  return {
    channel,
    source: `config:${file}`,
    title: `Invalid ${file}`,
    text,
    body: error.file.endsWith('/crontab.migrated')
      ? "Its jobs in the kernel crontab still lack --lick=cron, so they don't fire as cron licks; add it with crontab -."
      : channel === 'cron'
        ? 'Not moved into the kernel crontab until the file is fixed; the installed crontab is unchanged.\nThe format is in the slicc-agent README.'
        : 'Ignored until the file is fixed.\nThe formats are in the slicc-agent README.',
    target: scopedTarget('cone', cone),
    severity: 'error',
    eventId: hash(`${file}\n${text}`),
  };
}

export const UNVERIFIED = "verified: false (the gateway couldn't check this request's signature)";

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
    body: [delivery.verified === false ? UNVERIFIED : '', headers, payload]
      .filter(Boolean)
      .join('\n\n'),
    target: entry.target,
    coalesce: false,
    ...(delivery.id ? { eventId: delivery.id } : {}),
    ...(entry.triage ? { triage: entry.triage } : {}),
  };
}

async function webhooksIn(
  files: ConfigFiles,
  dir: string,
  context: Context
): Promise<{ entries: Map<string, WebhookEntry>; errors: ConfigError[] }> {
  const errors: ConfigError[] = [];
  const into = new Map<string, WebhookEntry>();
  for (const name of await files.list(dir, context)) {
    if (name.endsWith('.v6')) continue;
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
  return { entries: into, errors };
}

export function createLickSources(options: LickSourcesOptions): LickSources {
  const { harness, env, licks, home } = options;
  const files = configFiles(env);
  const deliver = (event: LickEvent, context: Context) => licks.deliver(event, context);
  const boots = booting(harness, options.cone, deliver, options.jobs);
  const dirsOf = options.dirs ?? (() => [{ dir: `${home}/${SLICC_DIR}`, home, cone: null }]);
  const watching = new Map<string, Watches>();
  const watchesOf = (place: LickDir) => {
    let found = watching.get(place.dir);
    if (!found) {
      const retarget = (event: LickEvent, context: Context) =>
        deliver({ ...event, target: scopedTarget(event.target, place.cone) }, context);
      found = new Watches(place.env ?? env, retarget, place.home, options.activity);
      watching.set(place.dir, found);
    }
    return found;
  };
  let webhooks = new Map<string, WebhookEntry>();
  const relicked = new Set<string>();
  let control: FileWatcher | undefined;
  let controlled = '';
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
    const places = await dirsOf();
    const errors: { error: ConfigError; place: LickDir }[] = [];
    const hooks = new Map<string, WebhookEntry>();
    for (const place of places) {
      const crontab = [...(await relick(place, context)), ...(await migrate(place, context))];
      const watchErrors = await watchesOf(place).reconcile(`${place.dir}/watches`, context);
      const found = await webhooksIn(files, `${place.dir}/webhooks`, context);
      for (const entry of found.entries.values()) {
        const named = scoped(entry, place.cone);
        hooks.set(named.name, named);
      }
      for (const error of [...crontab, ...watchErrors, ...found.errors])
        errors.push({ error, place });
    }
    for (const [dir, watches] of [...watching])
      if (!places.some((place) => place.dir === dir)) {
        watching.delete(dir);
        await watches.close(context);
      }
    webhooks = hooks;
    for (const { error, place } of errors)
      await deliver(configLick(error, place.home, place.cone), context);
    await watchControl(places, context);
  }

  function byUser(place: LickDir, jobs: readonly LegacyJob[]): Map<string, LegacyJob[]> {
    const users = new Map<string, LegacyJob[]>();
    for (const job of jobs) {
      const user = options.cronUser?.(job.target, place) ?? place.cone ?? ROOT_USER;
      users.set(user, [...(users.get(user) ?? []), job]);
    }
    return users;
  }

  async function relick(place: LickDir, context: Context): Promise<ConfigError[]> {
    if (relicked.has(place.dir)) return [];
    relicked.add(place.dir);
    const file = `${place.dir}/crontab.migrated`;
    const text = await files.read(file, context);
    if (text === undefined) return [];
    const errors: ConfigError[] = [];
    for (const [user, list] of byUser(place, legacyJobs(text).jobs))
      for (const problem of await relickJobs(env, user, list, context))
        errors.push({ file, ...problem });
    return errors;
  }

  async function migrate(place: LickDir, context: Context): Promise<ConfigError[]> {
    const file = `${place.dir}/crontab`;
    const text = await files.read(file, context);
    if (!text?.trim()) return [];
    const { jobs, problems } = legacyJobs(text);
    if (problems.length) return problems.map((problem) => ({ file, ...problem }));
    const users = new Map<string, CronJob[]>();
    for (const [user, list] of byUser(place, jobs))
      users.set(
        user,
        list.map((job) => ({
          name: job.name,
          schedule: job.schedule,
          command: sendCommand(job.target, job.message),
          line: job.line,
        }))
      );
    const errors: ConfigError[] = [];
    for (const [user, list] of users)
      for (const problem of await installJobs(env, user, list, context))
        errors.push({ file, ...problem });
    if (errors.length) return errors;
    await env.writeFile(`${file}.migrated`, text, context);
    await env.remove(file, { force: true }, context);
    return [];
  }

  async function retire(context: Context): Promise<void> {
    const stored = (await harness.snapshot(LicksHostDoc, context))?.cron ?? {};
    const records = Object.values(stored);
    if (!records.length) return;
    for (const record of records)
      await harness.abortTask(record.task as TaskId, context).catch(() => undefined);
    await harness.commit(async (tx) => {
      (await tx.doc(LicksHostDoc)).cron = {};
    }, context);
  }

  async function watchControl(places: readonly LickDir[], context: Context): Promise<void> {
    const key = places.map((place) => place.dir).join('\n');
    if (key === controlled || closed) return;
    controlled = key;
    await control?.close(context);
    const result = await env.watch(
      places.map((place) => ({ path: place.dir, recursive: true })),
      () => scheduleReconcile(context),
      context
    );
    control = result.ok ? result.value : undefined;
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
      await retire(context);
      await reconcile(context);
      flushTimer = setInterval(() => {
        void flushIfWaiting(context).catch(() => undefined);
      }, options.flushEvery ?? 2000);
    },
    reconcile,
    boot: boots.boot,
    async webhook(name, delivery, context) {
      const entry = webhooks.get(name);
      if (!entry) return false;
      await deliver(
        webhookLick(name, entry, await withAttachment(delivery, options.fetch)),
        context
      );
      return true;
    },
    async close(context) {
      closed = true;
      boots.stop();
      clearTimeout(reconcileTimer);
      clearInterval(flushTimer);
      await control?.close(context);
      for (const watches of watching.values()) await watches.close(context);
    },
  };
}
