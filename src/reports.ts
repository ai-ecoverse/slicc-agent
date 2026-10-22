import type { ReportInfo } from '@earendil-works/pi-durable';

export const REPORTS_MAX = 50;

export interface Report {
  id: string;
  at: number;
  type: ReportInfo['type'];
  message: string;
  conversationId: number | null;
  taskId: number | null;
  source: string | null;
}

export interface Reports {
  list(): readonly Report[];
  subscribe(listener: (report: Report) => void): () => void;
}

export interface ReportSink extends Reports {
  record(error: unknown, info: ReportInfo): void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function sourceOf(info: ReportInfo): string | null {
  if ('extension' in info && info.extension) return info.extension;
  if (info.type === 'host_error') return info.callback;
  return null;
}

function conversationOf(info: ReportInfo): number | null {
  if ('task' in info && info.task) return Number(info.task.conversationId);
  if (info.type === 'extension_error' && info.conversationId !== undefined)
    return Number(info.conversationId);
  return null;
}

export function createReports(now: () => number = Date.now, max = REPORTS_MAX): ReportSink {
  const kept: Report[] = [];
  const listeners = new Set<(report: Report) => void>();
  let next = 0;
  return {
    record(error, info) {
      const task = 'task' in info && info.task ? Number(info.task.id) : null;
      const report: Report = {
        id:
          info.type === 'task_faulted' && task !== null ? `task:${task}` : `report:${(next += 1)}`,
        at: now(),
        type: info.type,
        message: messageOf(error),
        conversationId: conversationOf(info),
        taskId: task,
        source: sourceOf(info),
      };
      kept.unshift(report);
      kept.length = Math.min(kept.length, max);
      for (const listener of listeners) listener(report);
    },
    list: () => [...kept],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
