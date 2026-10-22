import {
  type Context,
  type JsonValue,
  type ReplicatedState,
  replicatedState,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  CommitPublication,
  ConversationView,
  Harness,
  TaskGraph,
  TaskGraphNode,
  TaskGraphWatch,
  TaskRecord,
  UsageState,
} from '@earendil-works/pi-durable';
import { type AgentsState, live } from '../agents.ts';
import { contextTokens } from '../context.ts';
import type { Report, Reports } from '../reports.ts';
import type {
  MonitorAgent,
  MonitorFeed,
  MonitorLease,
  MonitorProblem,
  MonitorProcess,
  MonitorTask,
} from '../services.ts';
import { commandLine, program, redacted } from './redact.ts';

export interface PsEntry {
  pid: number;
  ppid?: number;
  pgid?: number;
  argv?: readonly string[];
  tty?: unknown;
  started?: number;
  state?: string;
  uid?: number;
  rss?: number;
  utime?: number;
  stime?: number;
}

export interface CpuMark {
  started: number;
  total: number;
  at: number;
}

export interface CpuReading {
  marks: Map<number, CpuMark>;
  shares: Map<number, number | null>;
}

function timed(entry: PsEntry): entry is PsEntry & { utime: number; stime: number } {
  return typeof entry.utime === 'number' && typeof entry.stime === 'number';
}

export function cpuShares(
  entries: readonly PsEntry[],
  previous: ReadonlyMap<number, CpuMark>,
  at: number
): CpuReading {
  const marks = new Map<number, CpuMark>();
  const shares = new Map<number, number | null>();
  for (const entry of entries) {
    if (!timed(entry)) continue;
    const mark = { started: entry.started ?? 0, total: entry.utime + entry.stime, at };
    const last = previous.get(entry.pid);
    marks.set(entry.pid, mark);
    shares.set(
      entry.pid,
      last && last.started === mark.started && mark.total >= last.total && at > last.at
        ? Math.round(((mark.total - last.total) / (at - last.at)) * 1000) / 1000
        : null
    );
  }
  return { marks, shares };
}

export function agentCpu(processes: readonly MonitorProcess[], agentId: string): number | null {
  if (!processes.some((row) => typeof row.cpu === 'number')) return null;
  let sum = 0;
  for (const row of processes) if (row.agentId === agentId) sum += row.cpu ?? 0;
  return Math.round(sum * 1000) / 1000;
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface MonitorOptions {
  harness: Pick<Harness, 'watchTaskGraph' | 'usage' | 'subscribeCommits' | 'inspect'>;
  agents: { state(): Readonly<AgentsState>; onChange(listener: () => void): () => void };
  views: ReplicatedState<Record<string, ConversationView>>;
  reports?: Reports;
  kernel?: { ps?(): Promise<readonly PsEntry[]> };
  groups?: { owned(owner: number): number[] };
  users?: () => Promise<readonly { name: string; uid: number }[]>;
  now?: () => number;
  timers?: Timers;
  ttlMs?: number;
  psMs?: number;
  psTimeoutMs?: number;
  throttleMs?: number;
  usageMs?: number;
  context?: Context;
}

export interface Monitor {
  readonly state: ReplicatedState<MonitorFeed>;
  readonly viewState: ReplicatedState<MonitorFeed>;
  open(lease: string | null, resync: boolean, context: Context): Promise<MonitorLease>;
  close(lease: string, context: Context): Promise<void>;
  active(): boolean;
  dispose(): Promise<void>;
}

export const TTL_MS = 30000;
export const PS_MS = 2000;
export const PS_TIMEOUT_MS = 5000;
export const THROTTLE_MS = 1000;
export const USAGE_MS = 2000;
export const PROBLEMS_MAX = 50;

export const globalTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function emptyFeed(): MonitorFeed {
  return {
    open: false,
    at: 0,
    usage: null,
    agents: [],
    tasks: [],
    processes: null,
    kernel: 'checking',
    problems: [],
    paused: false,
  };
}

interface Live {
  run?: unknown;
  generation?: { attempt: number; retry?: { at: number; error: string } };
  tools?: { name: string; status: string; taskId?: unknown }[];
}

interface ModelMessage {
  stopReason?: string;
  errorMessage?: string;
}

export function totals(usage: UsageState): { tokens: number; cost: number; free: boolean } {
  let tokens = 0;
  let cost = 0;
  for (const bucket of [usage.models, usage.tools])
    for (const entry of Object.values(bucket)) {
      tokens += entry.totalTokens ?? 0;
      cost += entry.cost?.total ?? 0;
    }
  return { tokens, cost, free: cost === 0 };
}

function phaseOf(node: TaskGraphNode): string {
  return 'phase' in node.state ? node.state.phase : node.state.outcome;
}

function lastAssistant(view: ConversationView | undefined) {
  const entries = view?.entries ?? [];
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at] as (typeof entries)[number];
    if (entry.kind === 'pi.assistant')
      return { id: String(entry.id), message: (entry.model?.[0] ?? {}) as ModelMessage };
  }
  return undefined;
}

function conversations(state: Readonly<AgentsState>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, scoop] of Object.entries(state.scoops)) out.set(scoop.conversation, id);
  for (const [id, cone] of Object.entries(state.cones)) out.set(cone.conversation, id);
  return out;
}

function liveAgents(state: Readonly<AgentsState>) {
  const cones = Object.entries(state.cones).map(([id, cone]) => ({
    id,
    name: cone.name,
    kind: 'cone' as const,
    parentId: null,
    conversation: cone.conversation,
  }));
  const scoops = Object.entries(state.scoops)
    .filter(([, scoop]) => live(scoop))
    .map(([id, scoop]) => ({
      id,
      name: scoop.name,
      kind: 'scoop' as const,
      parentId: scoop.parent,
      conversation: scoop.conversation,
    }));
  return [...cones, ...scoops];
}

export function narrowed(feed: MonitorFeed, programs: ReadonlyMap<number, string>): MonitorFeed {
  if (!feed.processes) return feed;
  return {
    ...feed,
    processes: feed.processes.map((row) => ({ ...row, command: programs.get(row.pid) ?? '' })),
  };
}

interface Settings {
  now: () => number;
  timers: Timers;
  context: Context;
  psMs: number;
  psTimeoutMs: number;
  throttleMs: number;
  usageMs: number;
}

type Agent = ReturnType<typeof liveAgents>[number];

class Session {
  stopped = false;
  readonly #options: MonitorOptions;
  readonly #settings: Settings;
  readonly #publish: (feed: MonitorFeed, view: MonitorFeed) => void;
  readonly #off: (() => void)[] = [];
  readonly #handles = new Set<unknown>();
  #watch: TaskGraphWatch | undefined;
  #graph: TaskGraph = { tasks: {} };
  #usage: UsageState | null = null;
  #processes: readonly PsEntry[] | null = null;
  #cpu: CpuReading = { marks: new Map(), shares: new Map() };
  #kernel: MonitorFeed['kernel'];
  #users = new Map<number, string>();
  #paused = false;
  #problems: MonitorProblem[] = [];
  #seen = new Map<string, number>();
  #next = new Map<string, number>();
  #build: unknown;
  #usageTimer: unknown;
  #lastBuild = Number.NEGATIVE_INFINITY;
  #last = '';

  constructor(
    options: MonitorOptions,
    settings: Settings,
    publish: (feed: MonitorFeed, view: MonitorFeed) => void
  ) {
    this.#options = options;
    this.#settings = settings;
    this.#publish = publish;
    this.#kernel = options.kernel?.ps ? 'checking' : 'unreachable';
  }

  start(): void {
    const options = this.#options;
    this.#off.push(
      options.harness.subscribeCommits((publication) => this.#commit(publication)),
      options.agents.onChange(() => this.schedule()),
      options.views.subscribe(() => this.schedule())
    );
    if (options.reports) {
      for (const report of [...options.reports.list()].reverse()) this.#reported(report);
      this.#off.push(
        options.reports.subscribe((report) => {
          this.#reported(report);
          this.schedule();
        })
      );
    }
    void options.harness.watchTaskGraph(this.#settings.context).then(
      (watch) => this.#watching(watch),
      () => undefined
    );
    void options.users?.().then(
      (list) => {
        this.#users = new Map(list.map((user) => [user.uid, user.name]));
        this.schedule();
      },
      () => undefined
    );
    this.#poll();
    this.refresh();
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.#off) off();
    for (const handle of this.#handles) this.#settings.timers.clear(handle);
    this.#handles.clear();
    void this.#watch?.stop();
  }

  refresh(): void {
    void this.#readUsage();
    void this.#options.harness.inspect(this.#settings.context).then(
      (inspection) => {
        this.#paused = inspection.scheduling === 'paused';
        this.schedule();
      },
      () => undefined
    );
    this.schedule();
  }

  schedule(): void {
    if (this.stopped || this.#build !== undefined) return;
    const wait = Math.max(0, this.#lastBuild + this.#settings.throttleMs - this.#settings.now());
    this.#build = this.#later(() => {
      this.#build = undefined;
      this.#emit();
    }, wait);
  }

  #later(task: () => void, ms: number): unknown {
    if (this.stopped) return undefined;
    const handle = this.#settings.timers.set(() => {
      this.#handles.delete(handle);
      if (!this.stopped) task();
    }, ms);
    this.#handles.add(handle);
    return handle;
  }

  #watching(watch: TaskGraphWatch): void {
    if (this.stopped) {
      void watch.stop();
      return;
    }
    this.#watch = watch;
    this.#graph = watch.value;
    this.schedule();
    watch.start(async (graph) => {
      this.#graph = graph;
      this.schedule();
    });
  }

  #readUsage(): Promise<void> {
    return this.#options.harness.usage(this.#settings.context).then(
      (usage) => {
        this.#usage = usage;
        this.schedule();
      },
      () => undefined
    );
  }

  #poll(): void {
    const kernel = this.#options.kernel;
    if (!kernel?.ps) return;
    let settled = false;
    const settle = (entries: readonly PsEntry[] | null) => {
      if (settled || this.stopped) return;
      settled = true;
      this.#settings.timers.clear(timeout);
      this.#handles.delete(timeout);
      this.#processes = entries;
      if (entries) this.#cpu = cpuShares(entries, this.#cpu.marks, this.#settings.now());
      this.#kernel = entries ? 'ok' : 'unreachable';
      this.schedule();
      this.#later(() => this.#poll(), this.#settings.psMs);
    };
    const timeout = this.#later(() => settle(null), this.#settings.psTimeoutMs);
    kernel.ps().then(settle, () => settle(null));
  }

  #problem(entry: MonitorProblem): void {
    if (this.#problems.some((known) => known.id === entry.id)) return;
    this.#problems.unshift(entry);
    this.#problems.length = Math.min(this.#problems.length, PROBLEMS_MAX);
  }

  #commit(publication: CommitPublication): void {
    let changed = false;
    for (const change of publication.changes) {
      if (change.type === 'task') changed = this.#failed(change.value) || changed;
      else if (change.type === 'document' && change.record.kind === 'pi.usage')
        this.#usageChanged();
    }
    if (changed) this.schedule();
  }

  #reported(report: Report): void {
    const owner =
      report.conversationId === null
        ? null
        : (conversations(this.#options.agents.state()).get(report.conversationId) ?? null);
    this.#problem({
      id: report.id,
      at: report.at,
      agentId: owner,
      kind: report.id.startsWith('task:') ? 'task' : 'report',
      message: redacted(report.message),
      report: { type: report.type, source: report.source },
    });
  }

  #failed(task: TaskRecord<JsonValue, JsonValue, JsonValue>): boolean {
    if (task.state.status !== 'terminal') return false;
    const outcome = task.state.outcome;
    if (outcome.status !== 'faulted' && outcome.status !== 'orphaned') return false;
    this.#problem({
      id: `task:${task.id}`,
      at: this.#settings.now(),
      agentId: conversations(this.#options.agents.state()).get(task.conversationId) ?? null,
      kind: 'task',
      message: redacted(outcome.status === 'faulted' ? outcome.error.message : outcome.reason),
    });
    return true;
  }

  #usageChanged(): void {
    if (this.#usageTimer !== undefined) return;
    this.#usageTimer = this.#later(() => {
      this.#usageTimer = undefined;
      void this.#readUsage();
    }, this.#settings.usageMs);
  }

  #since(key: string): number {
    const at = this.#seen.get(key) ?? this.#settings.now();
    this.#next.set(key, at);
    return at;
  }

  #agent(agent: Agent, view: ConversationView | undefined, tools: Map<string, string>) {
    const liveDoc = view?.docs['pi.live'] as Live | undefined;
    for (const slot of liveDoc?.tools ?? [])
      if (slot.taskId !== undefined) tools.set(String(slot.taskId), slot.name);
    const inbox = view?.docs['pi.inbox'] as { items?: unknown[] } | undefined;
    const doc = view?.docs['pi.agent'] as
      | { model?: { provider: string; modelId: string } }
      | undefined;
    const generation = liveDoc?.generation;
    const retry = generation?.retry
      ? {
          attempt: generation.attempt,
          since: this.#since(`retry:${agent.id}`),
          error: redacted(generation.retry.error),
        }
      : null;
    if (retry)
      this.#problem({
        id: `retry:${agent.id}:${retry.since}`,
        at: retry.since,
        agentId: agent.id,
        kind: 'retry',
        message: retry.error,
      });
    const last = lastAssistant(view);
    const failed =
      last?.message.stopReason === 'error' ? redacted(last.message.errorMessage || 'error') : null;
    if (failed && last)
      this.#problem({
        id: `turn:${last.id}`,
        at: this.#settings.now(),
        agentId: agent.id,
        kind: 'turn',
        message: failed,
      });
    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      parentId: agent.parentId,
      model: doc?.model ? `${doc.model.provider}/${doc.model.modelId}` : null,
      running: Boolean(liveDoc?.run),
      queued: inbox?.items?.length ?? 0,
      tool: liveDoc?.tools?.find((slot) => slot.status === 'running')?.name ?? null,
      retry,
      failed,
      context: contextTokens(view),
    };
  }

  #task(node: TaskGraphNode, owners: Map<number, string>, details: Map<string, string>) {
    const id = String(node.id);
    const status = node.state.status;
    return {
      id,
      kind: node.kind,
      detail: details.get(id) ?? null,
      agentId: owners.get(node.conversationId) ?? null,
      owner: node.owner === undefined ? null : String(node.owner),
      status,
      phase: phaseOf(node),
      background: node.background,
      aborting: node.abortRequested ? this.#since(`abort:${id}`) : null,
      since: this.#since(`task:${id}:${status}`),
      waits: node.state.status === 'waiting' ? node.state.on.length : 0,
      until: node.state.status === 'sleeping' ? node.state.until : null,
      blocked: node.blocked ?? null,
    };
  }

  #process(entry: PsEntry, groups: Map<number, string>, programs: Map<number, string>) {
    const argv = entry.argv ?? [];
    const pgid = entry.pgid ?? entry.pid;
    const zombie = entry.state === 'Z';
    programs.set(entry.pid, program(argv));
    const uid = entry.uid;
    return {
      pid: entry.pid,
      ppid: entry.ppid ?? 0,
      pgid,
      user:
        uid === undefined ? null : (this.#users.get(uid) ?? (uid === 0 ? 'root' : `uid ${uid}`)),
      agentId: groups.get(pgid) ?? null,
      command: commandLine(argv),
      state: zombie ? ('Z' as const) : ('S' as const),
      started: entry.started ?? 0,
      zombie: zombie ? this.#since(`zombie:${entry.pid}`) : null,
      tty: Boolean(entry.tty),
      rss: typeof entry.rss === 'number' ? entry.rss : null,
      ...(timed(entry)
        ? { utime: entry.utime, stime: entry.stime, cpu: this.#cpu.shares.get(entry.pid) ?? null }
        : {}),
    };
  }

  #emit(): void {
    this.#lastBuild = this.#settings.now();
    this.#next = new Map();
    const registry = this.#options.agents.state();
    const views = this.#options.views.value ?? {};
    const agents = liveAgents(registry);
    const details = new Map<string, string>();
    const rows: MonitorAgent[] = agents.map((agent) =>
      this.#agent(agent, views[agent.id], details)
    );
    for (const scoop of Object.values(registry.scoops))
      details.set(String(scoop.anchor), scoop.name);
    const owners = conversations(registry);
    const tasks: MonitorTask[] = Object.values(this.#graph.tasks).map((node) =>
      this.#task(node, owners, details)
    );
    const groups = new Map<number, string>();
    for (const agent of agents)
      for (const pgid of this.#options.groups?.owned(agent.conversation) ?? [])
        groups.set(pgid, agent.id);
    const programs = new Map<number, string>();
    const entries = this.#processes;
    const processes: MonitorProcess[] | null =
      entries?.map((entry) => this.#process(entry, groups, programs)) ?? null;
    if (entries?.some(timed))
      for (const row of rows) row.cpu = agentCpu(processes as MonitorProcess[], row.id);
    this.#seen = this.#next;
    const feed: MonitorFeed = {
      open: true,
      at: this.#lastBuild,
      usage: this.#usage ? totals(this.#usage) : null,
      agents: rows,
      tasks,
      processes,
      kernel: this.#kernel,
      problems: [...this.#problems],
      paused: this.#paused,
    };
    const key = JSON.stringify({ ...feed, at: 0 });
    if (key === this.#last) return;
    this.#last = key;
    this.#publish(feed, narrowed(feed, programs));
  }
}

export function createMonitor(options: MonitorOptions): Monitor {
  const settings: Settings = {
    now: options.now ?? Date.now,
    timers: options.timers ?? globalTimers,
    context: options.context ?? BACKGROUND_CONTEXT,
    psMs: options.psMs ?? PS_MS,
    psTimeoutMs: options.psTimeoutMs ?? PS_TIMEOUT_MS,
    throttleMs: options.throttleMs ?? THROTTLE_MS,
    usageMs: options.usageMs ?? USAGE_MS,
  };
  const { now, timers, context } = settings;
  const ttlMs = options.ttlMs ?? TTL_MS;
  const state = replicatedState<MonitorFeed>(emptyFeed());
  const viewState = replicatedState<MonitorFeed>(emptyFeed());
  const leases = new Map<string, number>();
  let session: Session | undefined;
  let sweep: unknown;
  const publish = (feed: MonitorFeed, view: MonitorFeed) => {
    state.replace(context, feed);
    viewState.replace(context, view);
  };
  const stop = () => {
    if (sweep !== undefined) timers.clear(sweep);
    sweep = undefined;
    const current = session;
    if (!current) return;
    session = undefined;
    current.stop();
    publish(
      { ...(state.value as MonitorFeed), open: false },
      { ...(viewState.value as MonitorFeed), open: false }
    );
  };
  const arm = () => {
    if (sweep !== undefined) timers.clear(sweep);
    sweep = timers.set(expire, Math.max(0, Math.min(...leases.values()) - now()));
  };
  const expire = () => {
    sweep = undefined;
    const at = now();
    for (const [lease, until] of [...leases]) if (until <= at) leases.delete(lease);
    if (leases.size) arm();
    else stop();
  };
  return {
    state,
    viewState,
    async open(lease, resync) {
      const id = lease ?? crypto.randomUUID();
      leases.set(id, now() + ttlMs);
      arm();
      if (!session) {
        session = new Session(options, settings, publish);
        session.start();
      } else if (resync) session.refresh();
      return { lease: id, ttlMs };
    },
    async close(lease) {
      if (!leases.delete(lease)) return;
      if (leases.size) arm();
      else stop();
    },
    active: () => session !== undefined,
    async dispose() {
      leases.clear();
      stop();
    },
  };
}
