import type {
  MonitorAlert,
  MonitorEvents,
  MonitorPort,
  MonitorRow,
  MonitorSection,
  MonitorSnapshot,
  MonitorStatus,
  MonitorVital,
} from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import type {
  BudgetState,
  ModelChoice,
  MonitorAgent,
  MonitorFeed,
  MonitorProcess,
  MonitorTask,
} from '../services.ts';
import { Emitter } from './emitter.ts';

export const RENEW_MS = 10000;
export const ROWS_MAX = 200;
export const HISTORY = 24;
export const BUDGET_WARN = 80;
export const BUDGET_ERROR = 95;
export const RETRY_WARN = 3;
export const RETRY_ERROR = 6;
export const RETRY_SLOW_MS = 120000;
export const FAILED_MS = 600000;
export const ABORT_MS = 30000;
export const ABORT_ROW_MS = 10000;
export const GROUP_MAX = 32;
export const TOTAL_MAX = 128;
export const ZOMBIE_MS = 60000;
export const STALE_MS = 1800000;
export const CONTEXT_WARN = 0.8;
export const DEPTH_MAX = 6;
const MINUTE = 60000;
const HOUR = 3600000;

export interface Sample {
  at: number;
  cost: number;
  tokens: number;
  active: number;
}

export interface MonitorInput {
  feed: MonitorFeed | undefined;
  budget: BudgetState | null | undefined;
  models: readonly ModelChoice[];
  changes: readonly { path: string; status: string }[];
  sprinkles: readonly { name: string; title: string }[];
  extra: readonly MonitorSection[];
  history: readonly Sample[];
  now: number;
}

const KINDS: Record<string, string> = {
  'pi.generation': 'generating',
  'pi.compaction': 'compacting',
  'slicc.cron': 'cron',
  'slicc.scoop-wait': 'agent wait',
  'slicc.scoop-reporter': 'report',
  'slicc.memory-extract': 'memory extraction',
};

export function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function count(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

function memoryVital(processes: readonly MonitorProcess[]): MonitorVital[] {
  const measured = processes.filter((row) => typeof row.rss === 'number');
  if (!measured.length) return [];
  const total = measured.reduce((sum, row) => sum + (row.rss as number), 0);
  const agents = measured
    .filter((row) => row.agentId)
    .reduce((sum, row) => sum + (row.rss as number), 0);
  return [
    {
      id: 'memory',
      label: 'Process memory',
      value: bytes(total),
      unit: `${bytes(agents)} by agents`,
    },
  ];
}

export function taskLabel(task: MonitorTask): string {
  if (task.kind === 'pi.tool') return task.detail ? `tool ${task.detail}` : 'tool';
  if (task.kind === 'slicc.scoop-anchor') return task.detail ? `scoop ${task.detail}` : 'scoop';
  return KINDS[task.kind] ?? task.kind;
}

function coneOf(agents: ReadonlyMap<string, MonitorAgent>, id: string | null): string | null {
  const visited = new Set<string>();
  let current = id === null ? undefined : agents.get(id);
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = agents.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current ? current.id : null;
}

function ordered(feed: MonitorFeed): MonitorAgent[] {
  const byId = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const out: MonitorAgent[] = [];
  for (const cone of feed.agents.filter((agent) => agent.kind === 'cone')) {
    out.push(cone);
    for (const agent of feed.agents)
      if (agent.kind === 'scoop' && coneOf(byId, agent.id) === cone.id) out.push(agent);
  }
  for (const agent of feed.agents) if (!out.includes(agent)) out.push(agent);
  return out;
}

export function taskTree(feed: MonitorFeed): { task: MonitorTask; depth: number }[] {
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const order = ordered(feed).map((agent) => agent.id);
  const rank = (task: MonitorTask) => {
    const at = task.agentId === null ? -1 : order.indexOf(task.agentId);
    return at < 0 ? order.length : at;
  };
  const groupOf = (task: MonitorTask) => coneOf(agents, task.agentId) ?? '';
  const byId = new Map(feed.tasks.map((task) => [task.id, task]));
  const children = new Map<string, MonitorTask[]>();
  const roots: MonitorTask[] = [];
  for (const task of feed.tasks) {
    const owner = task.owner === null ? undefined : byId.get(task.owner);
    if (owner && groupOf(owner) === groupOf(task)) {
      const list = children.get(owner.id) ?? [];
      list.push(task);
      children.set(owner.id, list);
    } else roots.push(task);
  }
  const sort = (list: MonitorTask[]) =>
    list.sort((a, b) => rank(a) - rank(b) || Number(a.id) - Number(b.id));
  const out: { task: MonitorTask; depth: number }[] = [];
  const visit = (task: MonitorTask, depth: number) => {
    out.push({ task, depth });
    for (const child of sort(children.get(task.id) ?? [])) visit(child, depth + 1);
  };
  for (const root of sort(roots)) visit(root, 0);
  return out;
}

function capped(rows: MonitorRow[]): MonitorRow[] {
  if (rows.length <= ROWS_MAX) return rows;
  const shown = rows.slice(0, ROWS_MAX - 1);
  return [
    ...shown,
    { id: 'more', name: `+${rows.length - shown.length} more`, meta: '', status: 'idle' },
  ];
}

function contextRatio(agent: MonitorAgent, models: readonly ModelChoice[]): number | null {
  const window = models.find((model) => model.id === agent.model)?.contextWindow;
  if (!agent.context || !window) return null;
  return Math.min(1, agent.context / window);
}

function rate(history: readonly Sample[], pick: (sample: Sample) => number): number | null {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last || last.at - first.at < MINUTE) return null;
  return ((pick(last) - pick(first)) / (last.at - first.at)) * HOUR;
}

function budgetVital(budget: BudgetState): MonitorVital {
  const resets = new Date(budget.resets);
  return {
    id: 'budget',
    label: `Budget (${budget.window})`,
    value: `${budget.percent}%`,
    ...(Number.isNaN(resets.getTime())
      ? {}
      : { unit: `resets ${resets.toISOString().slice(0, 16).replace('T', ' ')} UTC` }),
    ratio: Math.min(1, Math.max(0, budget.percent / 100)),
  };
}

function vitals(input: MonitorInput, feed: MonitorFeed): MonitorVital[] {
  const out: MonitorVital[] = [];
  if (feed.usage) {
    const free = feed.usage.free;
    const pick = (sample: Sample) => (free ? sample.tokens : sample.cost);
    const perHour = rate(input.history, pick);
    const series = input.history.map(pick);
    out.push({
      id: 'spend',
      label: free ? 'Tokens' : 'Spend',
      value: free ? count(feed.usage.tokens) : money(feed.usage.cost),
      unit: free ? 'tokens' : `${count(feed.usage.tokens)} tokens`,
      ...(perHour === null ? {} : { delta: `${free ? count(perHour) : money(perHour)}/h` }),
      ...(series.length > 1 ? { series } : {}),
    });
  }
  const active = feed.agents.filter((agent) => agent.running).length;
  const actives = input.history.map((sample) => sample.active);
  out.push({
    id: 'agents',
    label: 'Active agents',
    value: String(active),
    unit: `of ${feed.agents.length}`,
    ...(actives.length > 1 ? { series: actives } : {}),
  });
  const tools = feed.tasks.filter(
    (task) => task.kind === 'pi.tool' && task.status === 'running'
  ).length;
  out.push({
    id: 'tasks',
    label: 'Running',
    value: String(tools),
    unit: `${tools === 1 ? 'tool' : 'tools'} · ${feed.tasks.length} ${feed.tasks.length === 1 ? 'task' : 'tasks'}`,
  });
  out.push(
    feed.processes
      ? {
          id: 'processes',
          label: 'Processes',
          value: String(feed.processes.length),
          unit: `${feed.processes.filter((row) => row.agentId).length} by agents`,
        }
      : { id: 'processes', label: 'Processes', value: '—', unit: 'kernel not reachable' }
  );
  out.push(...memoryVital(feed.processes ?? []));
  const ratios = feed.agents
    .map((agent) => contextRatio(agent, input.models))
    .filter((ratio): ratio is number => ratio !== null);
  if (ratios.length) {
    const fullest = Math.max(...ratios);
    out.push({
      id: 'context',
      label: 'Fullest context',
      value: `${Math.round(fullest * 100)}%`,
      ratio: fullest,
    });
  }
  return out;
}

function stale(process: MonitorProcess, agents: ReadonlyMap<string, MonitorAgent>, now: number) {
  if (!process.agentId || process.state === 'Z' || !process.started) return false;
  if (agents.get(process.agentId)?.tool === 'bash') return false;
  return now - process.started > STALE_MS;
}

function groups(processes: readonly MonitorProcess[]): Map<number, MonitorProcess[]> {
  const out = new Map<number, MonitorProcess[]>();
  for (const process of processes) {
    if (!process.agentId) continue;
    const list = out.get(process.pgid) ?? [];
    list.push(process);
    out.set(process.pgid, list);
  }
  return out;
}

type Names = (id: string | null) => string;

function resetLine(budget: BudgetState): string {
  const resets = new Date(budget.resets);
  return Number.isNaN(resets.getTime())
    ? `The ${budget.window} budget is nearly used up.`
    : `Resets ${resets.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
}

function budgetAlerts(budget: BudgetState | null | undefined): MonitorAlert[] {
  if (!budget || budget.percent < BUDGET_WARN) return [];
  return [
    {
      id: 'budget',
      title: `Budget ${budget.percent}% used`,
      detail: resetLine(budget),
      severity: budget.percent >= BUDGET_ERROR ? 'error' : 'warn',
    },
  ];
}

function agentAlerts(input: MonitorInput, feed: MonitorFeed): MonitorAlert[] {
  const out: MonitorAlert[] = [];
  for (const agent of feed.agents) {
    const retry = agent.retry;
    if (retry && (retry.attempt >= RETRY_WARN || input.now - retry.since > RETRY_SLOW_MS))
      out.push({
        id: `retry-${agent.id}`,
        title: `${agent.name} is retrying (attempt ${retry.attempt})`,
        detail: retry.error,
        severity: retry.attempt >= RETRY_ERROR ? 'error' : 'warn',
      });
    if (agent.failed && !agent.running)
      out.push({
        id: `turn-${agent.id}`,
        title: `${agent.name}'s last turn failed`,
        detail: agent.failed,
        severity: 'error',
      });
  }
  return out;
}

function taskAlerts(input: MonitorInput, feed: MonitorFeed, nameOf: Names): MonitorAlert[] {
  const out: MonitorAlert[] = [];
  for (const problem of feed.problems)
    if (problem.kind === 'task' && input.now - problem.at < FAILED_MS)
      out.push({
        id: `failed-${problem.id}`,
        title: `A task of ${nameOf(problem.agentId)} failed`,
        detail: problem.message,
        severity: 'error',
      });
  for (const task of feed.tasks)
    if (task.aborting !== null && input.now - task.aborting > ABORT_MS)
      out.push({
        id: `abort-${task.id}`,
        title: `Stop is still waiting for ${taskLabel(task)}`,
        detail: `${nameOf(task.agentId)} asked it to stop ${age(input.now - task.aborting)} ago.`,
        severity: 'warn',
      });
  return out;
}

function crowdAlerts(processes: readonly MonitorProcess[], nameOf: Names): MonitorAlert[] {
  const out: MonitorAlert[] = [];
  for (const [pgid, members] of groups(processes))
    if (members.length > GROUP_MAX)
      out.push({
        id: `runaway-${pgid}`,
        title: `${nameOf((members[0] as MonitorProcess).agentId)} has ${members.length} processes`,
        detail: `Kill them with kill -- -${pgid}.`,
        severity: members.length > GROUP_MAX * 2 ? 'error' : 'warn',
      });
  if (processes.length > TOTAL_MAX)
    out.push({
      id: 'runaway-total',
      title: `The kernel has ${processes.length} processes`,
      detail: 'Something may be starting processes in a loop.',
      severity: processes.length > TOTAL_MAX * 2 ? 'error' : 'warn',
    });
  return out;
}

function processAlerts(input: MonitorInput, feed: MonitorFeed, nameOf: Names): MonitorAlert[] {
  const processes = feed.processes ?? [];
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const out = crowdAlerts(processes, nameOf);
  for (const process of processes) {
    if (process.zombie !== null && input.now - process.zombie > ZOMBIE_MS)
      out.push({
        id: `zombie-${process.pid}`,
        title: `Process ${process.pid} is a zombie`,
        detail: `Its parent ${process.ppid} hasn't reaped it.`,
        severity: 'warn',
      });
    if (stale(process, agents, input.now))
      out.push({
        id: `stale-${process.pid}`,
        title: `${process.command || `Process ${process.pid}`} has run for ${age(input.now - process.started)}`,
        detail: `${nameOf(process.agentId)} started it in the background. Kill it with kill ${process.pid}.`,
        severity: input.now - process.started > STALE_MS * 2 ? 'error' : 'warn',
      });
  }
  return out;
}

function contextAlerts(input: MonitorInput, feed: MonitorFeed): MonitorAlert[] {
  const out: MonitorAlert[] = [];
  for (const agent of feed.agents) {
    const ratio = contextRatio(agent, input.models);
    if (ratio !== null && ratio >= CONTEXT_WARN)
      out.push({
        id: `context-${agent.id}`,
        title: `${agent.name} is ${Math.round(ratio * 100)}% full`,
        detail: 'Compact it soon to keep replies fast.',
        severity: 'warn',
      });
  }
  if (feed.paused)
    out.push({
      id: 'scheduler',
      title: "The agent isn't scheduling work",
      detail: 'Its scheduler is paused.',
      severity: 'warn',
    });
  return out;
}

function alerts(input: MonitorInput, feed: MonitorFeed): MonitorAlert[] {
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const nameOf: Names = (id) => (id ? (agents.get(id)?.name ?? id) : 'the session');
  return [
    ...budgetAlerts(input.budget),
    ...agentAlerts(input, feed),
    ...taskAlerts(input, feed, nameOf),
    ...processAlerts(input, feed, nameOf),
    ...contextAlerts(input, feed),
  ];
}

function agentRow(agent: MonitorAgent, depth: number, models: readonly ModelChoice[]): MonitorRow {
  const ratio = contextRatio(agent, models);
  const word = agent.retry
    ? 'retrying'
    : agent.running
      ? 'running'
      : agent.failed
        ? 'failed'
        : 'idle';
  const status: MonitorStatus = agent.retry
    ? 'warn'
    : agent.running
      ? 'active'
      : agent.failed
        ? 'error'
        : 'idle';
  const meta = [word, agent.model, ratio === null ? null : `${Math.round(ratio * 100)}% context`]
    .filter(Boolean)
    .join(' · ');
  const badges = [
    ...(agent.queued ? [`${agent.queued} queued`] : []),
    ...(agent.tool ? [agent.tool] : []),
    ...(agent.retry ? [`retry ${agent.retry.attempt}`] : []),
  ];
  return {
    id: agent.id,
    name: agent.name,
    meta,
    status,
    depth,
    ...(badges.length ? { badges } : {}),
  };
}

function taskRow(
  task: MonitorTask,
  depth: number,
  nameOf: (id: string | null) => string,
  now: number
): MonitorRow {
  const aborting = task.aborting !== null && now - task.aborting > ABORT_ROW_MS;
  const status: MonitorStatus = aborting
    ? 'warn'
    : task.status === 'running' || task.status === 'completing'
      ? 'active'
      : 'idle';
  const badges = [
    ...(task.background ? ['background'] : []),
    ...(task.aborting !== null ? ['aborting'] : []),
    ...(task.waits ? [`waits on ${task.waits}`] : []),
  ];
  return {
    id: task.id,
    name: taskLabel(task),
    depth: Math.min(depth, DEPTH_MAX),
    meta: [nameOf(task.agentId), task.phase, age(now - task.since)].filter(Boolean).join(' · '),
    status,
    ...(badges.length ? { badges } : {}),
  };
}

function processRows(input: MonitorInput, feed: MonitorFeed): MonitorRow[] {
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const crowded = new Set<number>();
  for (const [pgid, members] of groups(feed.processes ?? []))
    if (members.length > GROUP_MAX) crowded.add(pgid);
  return (feed.processes ?? []).map((process) => {
    const runaway = stale(process, agents, input.now) || crowded.has(process.pgid);
    const badges = [
      ...(process.agentId ? [agents.get(process.agentId)?.name ?? process.agentId] : []),
      ...(process.tty ? ['terminal'] : []),
    ];
    return {
      id: String(process.pid),
      name: process.command || `[${process.pid}]`,
      meta: [
        `pid ${process.pid}`,
        process.user,
        typeof process.rss === 'number' ? bytes(process.rss) : null,
        process.started ? age(input.now - process.started) : null,
      ]
        .filter(Boolean)
        .join(' · '),
      status: runaway ? 'error' : process.state === 'Z' ? 'warn' : 'idle',
      ...(badges.length ? { badges } : {}),
    };
  });
}

const PROBLEM_KINDS = { task: 'task failed', retry: 'retry', turn: 'turn failed' } as const;

function depthOf(agents: ReadonlyMap<string, MonitorAgent>, agent: MonitorAgent): number {
  const visited = new Set<string>();
  let depth = 0;
  let current = agent;
  while (current.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = agents.get(current.parentId);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}

function sections(input: MonitorInput, feed: MonitorFeed): MonitorSection[] {
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const nameOf = (id: string | null) => (id ? (agents.get(id)?.name ?? id) : 'session');
  return [
    {
      id: 'agents',
      label: 'Cones and scoops',
      rows: ordered(feed).map((agent) =>
        agentRow(agent, Math.min(depthOf(agents, agent), DEPTH_MAX), input.models)
      ),
    },
    {
      id: 'tasks',
      label: 'Tasks',
      rows: capped(
        taskTree(feed).map(({ task, depth }) => taskRow(task, depth, nameOf, input.now))
      ),
    },
    { id: 'processes', label: 'Processes', rows: capped(processRows(input, feed)) },
    {
      id: 'problems',
      label: 'Recent problems',
      rows: feed.problems.map((problem) => ({
        id: problem.id,
        name: `${nameOf(problem.agentId)} · ${PROBLEM_KINDS[problem.kind]}`,
        meta: problem.message,
        status: problem.kind === 'retry' ? 'warn' : 'error',
      })),
    },
  ];
}

function pageSections(input: MonitorInput): MonitorSection[] {
  return [
    {
      id: 'changes',
      label: 'Pending changes',
      rows: input.changes.map((change) => ({
        id: change.path,
        name: change.path,
        meta: change.status,
        status: 'warn',
      })),
    },
    {
      id: 'sprinkles',
      label: 'Sprinkles',
      rows: input.sprinkles.map((sprinkle) => ({
        name: sprinkle.title,
        meta: sprinkle.name,
        status: 'idle',
      })),
    },
    ...input.extra,
  ];
}

export function monitorSnapshot(input: MonitorInput): MonitorSnapshot {
  const budget = input.budget ? [budgetVital(input.budget)] : [];
  const feed = input.feed;
  if (!feed?.at)
    return {
      vitals: budget,
      alerts: [],
      sections: pageSections(input),
      updatedAt: input.now,
    };
  return {
    vitals: [...budget, ...vitals(input, feed)],
    alerts: alerts(input, feed),
    sections: [...sections(input, feed), ...pageSections(input)],
    updatedAt: feed.at,
  };
}

export interface Intervals {
  every(run: () => void, ms: number): unknown;
  stop(handle: unknown): void;
}

export const globalIntervals: Intervals = {
  every: (run, ms) => setInterval(run, ms),
  stop: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface MonitorAdapterOptions {
  extra?: () => readonly MonitorSection[];
  renewMs?: number;
  intervals?: Intervals;
  now?: () => number;
}

interface Open {
  lease: Promise<string | null>;
  timer: unknown;
}

export class MonitorAdapter implements MonitorPort {
  readonly #connection: AgentConnection;
  readonly #emitter = new Emitter<MonitorEvents>();
  readonly #extra: () => readonly MonitorSection[];
  readonly #renewMs: number;
  readonly #intervals: Intervals;
  readonly #now: () => number;
  #listeners = 0;
  #open: Open | undefined;
  #history: Sample[] = [];

  constructor(connection: AgentConnection, options: MonitorAdapterOptions = {}) {
    this.#connection = connection;
    this.#extra = options.extra ?? (() => []);
    this.#renewMs = options.renewMs ?? RENEW_MS;
    this.#intervals = options.intervals ?? globalIntervals;
    this.#now = options.now ?? Date.now;
    connection.monitor?.subscribe(() => this.#update());
    connection.settings.state.subscribe(() => this.#update());
  }

  on<K extends keyof MonitorEvents>(
    type: K,
    listener: (detail: MonitorEvents[K]) => void
  ): () => void {
    const off = this.#emitter.on(type, listener);
    this.#listeners++;
    if (this.#listeners === 1) this.#start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      this.#listeners--;
      if (!this.#listeners) this.#stop();
    };
  }

  snapshot(): MonitorSnapshot {
    const settings = this.#connection.settings.state.value;
    return monitorSnapshot({
      feed: this.#connection.monitor?.value,
      budget: settings?.budget,
      models: settings?.models ?? [],
      changes: this.#connection.changes?.value?.changes ?? [],
      sprinkles: this.#connection.sprinkles?.value ?? [],
      extra: this.#extra(),
      history: this.#history,
      now: this.#now(),
    });
  }

  resync(): void {
    const open = this.#open;
    const control = this.#connection.control;
    if (open)
      void open.lease
        .then((lease) => (lease ? control.monitorOpen(lease, true, BACKGROUND_CONTEXT) : undefined))
        .catch(() => undefined);
    this.#emitter.emit('snapshot', this.snapshot());
  }

  #start(): void {
    const control = this.#connection.control;
    this.#history = [];
    const lease = control.monitorOpen(null, true, BACKGROUND_CONTEXT).then(
      (opened) => opened.lease || null,
      () => null
    );
    const renew = () =>
      void lease
        .then((held) => (held ? control.monitorOpen(held, false, BACKGROUND_CONTEXT) : undefined))
        .catch(() => undefined);
    this.#open = { lease, timer: this.#intervals.every(renew, this.#renewMs) };
  }

  #stop(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    this.#intervals.stop(open.timer);
    const control = this.#connection.control;
    void open.lease
      .then((held) => (held ? control.monitorClose(held, BACKGROUND_CONTEXT) : undefined))
      .catch(() => undefined);
  }

  #sample(): void {
    const feed = this.#connection.monitor?.value;
    if (!feed?.open || !feed.usage || this.#history.at(-1)?.at === feed.at) return;
    this.#history.push({
      at: feed.at,
      cost: feed.usage.cost,
      tokens: feed.usage.tokens,
      active: feed.agents.filter((agent) => agent.running).length,
    });
    if (this.#history.length > HISTORY) this.#history.shift();
  }

  #update(): void {
    if (!this.#listeners) return;
    this.#sample();
    this.#emitter.emit('snapshot', this.snapshot());
  }
}
