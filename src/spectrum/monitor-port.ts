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
import { contextRatio } from '../context.ts';
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
export const SAMPLE_MS = 2000;
export const ROWS_MAX = 200;
export const HISTORY = 24;
export const CPU_HISTORY = 30;
export const CPU_QUIET = 0.01;
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
export const CPU_SHARE = 0.9;
export const CPU_SUSTAIN_MS = 120000;
export const CONTEXT_WARN = 0.8;
export const DEPTH_MAX = 6;
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;

export type AgentMonitorAlert = MonitorAlert & { command?: string; commandLabel?: string };

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
  sprinkles?: readonly { name: string; title: string }[];
  extra: readonly MonitorSection[];
  history: readonly Sample[];
  now: number;
  hot?: ReadonlyMap<number, number>;
  cpu?: readonly number[];
  processes?: readonly number[];
  memory?: readonly number[];
}

export function record<T>(list: T[], value: T, max: number): void {
  list.push(value);
  if (list.length > max) list.shift();
}

function trend(series: readonly number[] | undefined): { series?: number[] } {
  return series && series.length > 1 ? { series: [...series] } : {};
}

const KINDS: Record<string, string> = {
  'pi.generation': 'generating',
  'pi.compaction': 'compacting',
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
  if (value > 0 && value < 0.01) return '<$0.01';
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

export function cpuText(share: number | null | undefined): string | null {
  if (typeof share !== 'number' || share < CPU_QUIET) return null;
  return `${Math.round(share * 100)}%\u00a0CPU`;
}

export function agentsCpu(feed: MonitorFeed): number | null {
  const shares = feed.agents
    .map((agent) => agent.cpu)
    .filter((share): share is number => typeof share === 'number');
  return shares.length ? shares.reduce((sum, share) => sum + share, 0) : null;
}

function cpuVital(feed: MonitorFeed, history: readonly number[]): MonitorVital[] {
  const share = agentsCpu(feed);
  if (share === null) return [];
  return [
    {
      id: 'cpu',
      label: 'CPU',
      value: `${Math.round(share * 100)}%`,
      unit: 'of one core',
      ...trend(history.map((value) => Math.round(value * 100))),
    },
  ];
}

function measuredOf(processes: readonly MonitorProcess[]): MonitorProcess[] {
  return processes.filter((row) => typeof row.rss === 'number');
}

export function memoryTotal(processes: readonly MonitorProcess[]): number | null {
  const measured = measuredOf(processes);
  return measured.length ? measured.reduce((sum, row) => sum + (row.rss as number), 0) : null;
}

function memoryVital(
  processes: readonly MonitorProcess[],
  history: readonly number[] | undefined
): MonitorVital[] {
  const total = memoryTotal(processes);
  if (total === null) return [];
  const measured = measuredOf(processes);
  const agents = measured
    .filter((row) => row.agentId)
    .reduce((sum, row) => sum + (row.rss as number), 0);
  return [
    {
      id: 'memory',
      label: 'Process memory',
      value: bytes(total),
      unit: `${bytes(agents)} by agents`,
      ...trend(history),
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

function agentContext(agent: MonitorAgent, models: readonly ModelChoice[]): number | null {
  return contextRatio(agent.context, agent.model, models);
}

function rate(history: readonly Sample[], pick: (sample: Sample) => number): number | null {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last || last.at - first.at < MINUTE) return null;
  return ((pick(last) - pick(first)) / (last.at - first.at)) * HOUR;
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function resetsIn(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return 'resets soon';
  if (ms >= DAY)
    return `resets ${RELATIVE.format(Math.floor(at / DAY) - Math.floor(now / DAY), 'day')}`;
  if (ms >= HOUR) return `resets ${RELATIVE.format(Math.floor(ms / HOUR), 'hour')}`;
  return `resets ${RELATIVE.format(Math.ceil(ms / MINUTE), 'minute')}`;
}

function budgetVital(budget: BudgetState, now: number): MonitorVital {
  const resets = new Date(budget.resets);
  return {
    id: 'budget',
    label: `Budget (${budget.window})`,
    value: `${budget.percent}%`,
    ...(Number.isNaN(resets.getTime())
      ? {}
      : {
          unit: resetsIn(resets.getTime(), now),
          hint: `resets ${resets.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        }),
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
      ...trend(series),
    });
  }
  const active = feed.agents.filter((agent) => agent.running).length;
  out.push({
    id: 'agents',
    label: 'Active agents',
    value: String(active),
    unit: `of ${feed.agents.length}`,
    ...trend(input.history.map((sample) => sample.active)),
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
          ...trend(input.processes),
        }
      : feed.kernel === 'checking'
        ? { id: 'processes', label: 'Processes', value: '…', unit: 'checking' }
        : { id: 'processes', label: 'Processes', value: '—', unit: 'kernel not reachable' }
  );
  out.push(...memoryVital(feed.processes ?? [], input.memory));
  out.push(...cpuVital(feed, input.cpu ?? []));
  const ratios = feed.agents
    .map((agent) => agentContext(agent, input.models))
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
  if (typeof process.utime === 'number') return false;
  if (agents.get(process.agentId)?.tool === 'bash') return false;
  return now - process.started > STALE_MS;
}

function zombied(process: MonitorProcess, now: number): boolean {
  return process.zombie !== null && now - process.zombie > ZOMBIE_MS;
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

export function groupCpu(
  processes: readonly MonitorProcess[]
): Map<number, { agentId: string; share: number }> {
  const out = new Map<number, { agentId: string; share: number }>();
  for (const [pgid, members] of groups(processes)) {
    const measured = members.filter((row) => typeof row.cpu === 'number');
    if (!measured.length) continue;
    const share = measured.reduce((sum, row) => sum + (row.cpu as number), 0);
    out.set(pgid, { agentId: (members[0] as MonitorProcess).agentId as string, share });
  }
  return out;
}

export function hotGroups(
  processes: readonly MonitorProcess[],
  at: number,
  previous: ReadonlyMap<number, number>
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [pgid, { share }] of groupCpu(processes))
    if (share >= CPU_SHARE) out.set(pgid, previous.get(pgid) ?? at);
  return out;
}

function busy(input: MonitorInput, processes: readonly MonitorProcess[]) {
  const shares = groupCpu(processes);
  const out: { pgid: number; agentId: string; share: number; held: number }[] = [];
  for (const [pgid, since] of input.hot ?? []) {
    const group = shares.get(pgid);
    const held = input.now - since;
    if (group && group.share >= CPU_SHARE && held >= CPU_SUSTAIN_MS)
      out.push({ pgid, ...group, held });
  }
  return out;
}

function cpuAlerts(input: MonitorInput, processes: readonly MonitorProcess[], nameOf: Names) {
  return busy(input, processes).map(
    (group): AgentMonitorAlert => ({
      id: `runaway-cpu-${group.pgid}`,
      title: `${nameOf(group.agentId)} is using a lot of CPU`,
      detail: `${Math.round(group.share * 100)}% of one core for ${Math.floor(group.held / MINUTE)} minutes.`,
      command: `kill -- -${group.pgid}`,
      commandLabel: 'To stop it, run',
      severity: cpuSeverity(group),
    })
  );
}

function cpuSeverity(group: { share: number; held: number }): 'warn' | 'error' {
  return group.share >= CPU_SHARE * 2 || group.held >= CPU_SUSTAIN_MS * 2 ? 'error' : 'warn';
}

function crowdSeverity(members: readonly MonitorProcess[]): 'warn' | 'error' {
  return members.length > GROUP_MAX * 2 ? 'error' : 'warn';
}

function staleSeverity(process: MonitorProcess, now: number): 'warn' | 'error' {
  return now - process.started > STALE_MS * 2 ? 'error' : 'warn';
}

function worse(
  a: 'warn' | 'error' | undefined,
  b: 'warn' | 'error' | undefined
): 'warn' | 'error' | undefined {
  return a === 'error' || b === 'error' ? 'error' : (a ?? b);
}

function resetLine(budget: BudgetState): string {
  const resets = new Date(budget.resets);
  return Number.isNaN(resets.getTime())
    ? `The ${budget.window} budget is nearly used up.`
    : `Resets ${resets.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
}

function budgetAlerts(budget: BudgetState | null | undefined): AgentMonitorAlert[] {
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

function agentAlerts(input: MonitorInput, feed: MonitorFeed): AgentMonitorAlert[] {
  const out: AgentMonitorAlert[] = [];
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

function taskAlerts(input: MonitorInput, feed: MonitorFeed, nameOf: Names): AgentMonitorAlert[] {
  const out: AgentMonitorAlert[] = [];
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

function crowdAlerts(processes: readonly MonitorProcess[], nameOf: Names): AgentMonitorAlert[] {
  const out: AgentMonitorAlert[] = [];
  for (const [pgid, members] of groups(processes))
    if (members.length > GROUP_MAX)
      out.push({
        id: `runaway-${pgid}`,
        title: `${nameOf((members[0] as MonitorProcess).agentId)} has ${members.length} processes`,
        detail: 'Something in it may be starting processes in a loop.',
        command: `kill -- -${pgid}`,
        commandLabel: 'To stop them, run',
        severity: crowdSeverity(members),
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

function processAlerts(input: MonitorInput, feed: MonitorFeed, nameOf: Names): AgentMonitorAlert[] {
  const processes = feed.processes ?? [];
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const out = [...crowdAlerts(processes, nameOf), ...cpuAlerts(input, processes, nameOf)];
  for (const process of processes) {
    if (zombied(process, input.now))
      out.push({
        id: `zombie-${process.pid}`,
        title: `Process ${process.pid} is a zombie`,
        detail: `Its parent ${process.ppid} hasn't reaped it.`,
        ...(process.ppid > 1
          ? { command: `kill ${process.ppid}`, commandLabel: 'To clear it, stop the parent' }
          : {}),
        severity: 'warn',
      });
    if (stale(process, agents, input.now))
      out.push({
        id: `stale-${process.pid}`,
        title: `${process.command || `Process ${process.pid}`} has run for ${age(input.now - process.started)}`,
        detail: `${nameOf(process.agentId)} started it in the background.`,
        command: `kill ${process.pid}`,
        commandLabel: 'To stop it, run',
        severity: staleSeverity(process, input.now),
      });
  }
  return out;
}

function contextAlerts(input: MonitorInput, feed: MonitorFeed): AgentMonitorAlert[] {
  const out: AgentMonitorAlert[] = [];
  for (const agent of feed.agents) {
    const ratio = agentContext(agent, input.models);
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

function alerts(input: MonitorInput, feed: MonitorFeed): AgentMonitorAlert[] {
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

const BLOCKED: Record<NonNullable<MonitorTask['blocked']>, string> = {
  missing_task: 'blocked: no definition',
  task_too_old: 'blocked: definition too old',
  migration_failed: 'blocked: migration failed',
  restart_limit: 'blocked: restart limit',
};

function taskRow(
  task: MonitorTask,
  depth: number,
  nameOf: (id: string | null) => string,
  now: number
): MonitorRow {
  const aborting = task.aborting !== null && now - task.aborting > ABORT_ROW_MS;
  const status: MonitorStatus =
    aborting || task.blocked
      ? 'warn'
      : task.status === 'running' || task.status === 'completing'
        ? 'active'
        : 'idle';
  const badges = [
    ...(task.background ? ['background'] : []),
    ...(task.aborting !== null ? ['aborting'] : []),
    ...(task.waits ? [`waits on ${task.waits}`] : []),
    ...(typeof task.until === 'number' ? [`sleeps ${age(task.until - now)}`] : []),
    ...(task.blocked ? [BLOCKED[task.blocked]] : []),
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

function drivers(members: readonly MonitorProcess[]): MonitorProcess[] {
  const hot = members.filter((row) => (row.cpu ?? 0) >= CPU_SHARE);
  if (hot.length) return hot;
  const top = members.reduce((best, row) => ((row.cpu ?? 0) > (best.cpu ?? 0) ? row : best));
  return [top];
}

function processRows(input: MonitorInput, feed: MonitorFeed): MonitorRow[] {
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const members = groups(feed.processes ?? []);
  const flagged = new Map<number, 'warn' | 'error'>();
  for (const group of busy(input, feed.processes ?? []))
    for (const row of drivers(members.get(group.pgid) as MonitorProcess[]))
      flagged.set(row.pid, cpuSeverity(group));
  return (feed.processes ?? []).map((process) => {
    const runaway = worse(
      worse(
        flagged.get(process.pid),
        stale(process, agents, input.now) ? staleSeverity(process, input.now) : undefined
      ),
      zombied(process, input.now) ? 'warn' : undefined
    );
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
        cpuText(process.cpu),
        process.started ? age(input.now - process.started) : null,
      ]
        .filter(Boolean)
        .join(' · '),
      status: runaway ?? 'idle',
      ...(badges.length ? { badges } : {}),
    };
  });
}

const PROBLEM_KINDS = { task: 'task failed', retry: 'retry', turn: 'turn failed' } as const;

function sections(input: MonitorInput, feed: MonitorFeed): MonitorSection[] {
  const agents = new Map(feed.agents.map((agent) => [agent.id, agent]));
  const nameOf = (id: string | null) => (id ? (agents.get(id)?.name ?? id) : 'session');
  return [
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
    ...input.extra,
  ];
}

export function monitorSnapshot(input: MonitorInput): MonitorSnapshot {
  const budget = input.budget ? [budgetVital(input.budget, input.now)] : [];
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
  sampleMs?: number;
  intervals?: Intervals;
  now?: () => number;
}

interface Open {
  lease: Promise<string | null>;
  timer: unknown;
  sampler: unknown;
}

export class MonitorAdapter implements MonitorPort {
  readonly #connection: AgentConnection;
  readonly #emitter = new Emitter<MonitorEvents>();
  readonly #extra: () => readonly MonitorSection[];
  readonly #renewMs: number;
  readonly #sampleMs: number;
  readonly #intervals: Intervals;
  readonly #now: () => number;
  #listeners = 0;
  #open: Open | undefined;
  #history: Sample[] = [];
  #hot = new Map<number, number>();
  #hotAt = -1;
  #cpu: number[] = [];
  #processes: number[] = [];
  #memory: number[] = [];

  constructor(connection: AgentConnection, options: MonitorAdapterOptions = {}) {
    this.#connection = connection;
    this.#extra = options.extra ?? (() => []);
    this.#renewMs = options.renewMs ?? RENEW_MS;
    this.#sampleMs = options.sampleMs ?? SAMPLE_MS;
    this.#intervals = options.intervals ?? globalIntervals;
    this.#now = options.now ?? Date.now;
    connection.monitor?.subscribe(() => this.#update());
    connection.settings.state.subscribe(() => this.#update());
    connection.changes?.subscribe(() => this.#update());
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
      extra: this.#extra(),
      history: this.#history,
      now: this.#now(),
      hot: this.#hot,
      cpu: this.#cpu,
      processes: this.#processes,
      memory: this.#memory,
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
    this.#hot = new Map();
    this.#hotAt = -1;
    this.#cpu = [];
    this.#processes = [];
    this.#memory = [];
    void control.changesOpen(BACKGROUND_CONTEXT).catch(() => undefined);
    const lease = control.monitorOpen(null, true, BACKGROUND_CONTEXT).then(
      (opened) => opened.lease || null,
      () => null
    );
    const renew = () =>
      void lease
        .then((held) => (held ? control.monitorOpen(held, false, BACKGROUND_CONTEXT) : undefined))
        .catch(() => undefined);
    this.#open = {
      lease,
      timer: this.#intervals.every(renew, this.#renewMs),
      sampler: this.#intervals.every(() => this.#poll(), this.#sampleMs),
    };
  }

  #stop(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    this.#intervals.stop(open.timer);
    this.#intervals.stop(open.sampler);
    const control = this.#connection.control;
    void open.lease
      .then((held) => (held ? control.monitorClose(held, BACKGROUND_CONTEXT) : undefined))
      .catch(() => undefined);
  }

  #sample(): void {
    const feed = this.#connection.monitor?.value;
    if (!feed?.open || !feed.usage || this.#history.at(-1)?.at === feed.at) return;
    record(
      this.#history,
      {
        at: feed.at,
        cost: feed.usage.cost,
        tokens: feed.usage.tokens,
        active: feed.agents.filter((agent) => agent.running).length,
      },
      HISTORY
    );
  }

  #track(): void {
    const feed = this.#connection.monitor?.value;
    if (!feed?.open || feed.at === this.#hotAt) return;
    this.#hotAt = feed.at;
    this.#hot = hotGroups(feed.processes ?? [], feed.at, this.#hot);
    const share = agentsCpu(feed);
    if (share !== null) record(this.#cpu, share, CPU_HISTORY);
  }

  #poll(): void {
    const feed = this.#connection.monitor?.value;
    if (!feed?.open || !feed.processes) return;
    record(this.#processes, feed.processes.length, CPU_HISTORY);
    const memory = memoryTotal(feed.processes);
    if (memory !== null) record(this.#memory, memory, CPU_HISTORY);
    this.#emitter.emit('snapshot', this.snapshot());
  }

  #update(): void {
    if (!this.#listeners) return;
    this.#sample();
    this.#track();
    this.#emitter.emit('snapshot', this.snapshot());
  }
}
