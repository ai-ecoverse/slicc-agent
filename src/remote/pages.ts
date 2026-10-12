import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Answer } from '../scoops/service.ts';
import { Stream } from './host.ts';

export const PAGES_IDLE_MS = 30000;
export const PICK_MS = 5000;
export const ANSWER_MS = 5000;
export const MAX_PENDING = 100;

export interface PageTab {
  tab: string;
  kinds: string[];
  cone: string | null;
  visible: boolean;
  focused: boolean;
  lastActive: number;
}

export interface PageCaller {
  agentId: string | null;
  cone: string;
  readOnly?: boolean;
}

export interface PageRequest {
  id: string;
  kind: 'panel';
  argv: string[];
  caller: PageCaller;
}

export interface PageResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type PagesOpened = { stream: string } | { error: string };

export interface PageBatch {
  requests: PageRequest[];
  done: boolean;
}

export interface AgentPages {
  open(tab: PageTab, context: Context): Promise<PagesOpened>;
  report(stream: string, tab: PageTab, context: Context): Promise<void>;
  next(stream: string, waitMs: number, context: Context): Promise<PageBatch>;
  answer(stream: string, id: string, result: PageResult, context: Context): Promise<void>;
  close(stream: string, context: Context): Promise<void>;
}

export interface PageAsk {
  kind: 'panel';
  argv: readonly string[];
  agentId: string | null;
  cone: string;
  tab: string | null;
}

export interface Pages extends AgentPages {
  request(ask: PageAsk): Promise<PageResult>;
  command(
    argv: readonly string[],
    caller: { agentId: string | null; cone: string; tab: string | null },
    context: Context
  ): Promise<Answer>;
  tabs(): PageTab[];
  dispose(): Promise<void>;
}

export interface PagesOptions {
  now?: () => number;
  idleMs?: number;
  sweepMs?: number;
  pickMs?: number;
  answerMs?: number;
}

interface Pending {
  stream: string;
  cone: string;
  timer: ReturnType<typeof setTimeout>;
  settle(result: PageResult): void;
}

interface Entry {
  id: string;
  stream: Stream<PageRequest>;
  tab: PageTab;
  serial: number;
}

function tabOf(value: PageTab): PageTab {
  return {
    tab: String(value?.tab ?? ''),
    kinds: Array.isArray(value?.kinds) ? value.kinds.map(String) : [],
    cone: typeof value?.cone === 'string' ? value.cone : null,
    visible: value?.visible === true,
    focused: value?.focused === true,
    lastActive: Number.isFinite(value?.lastActive) ? Number(value.lastActive) : 0,
  };
}

function resultOf(value: PageResult): PageResult {
  return {
    stdout: typeof value?.stdout === 'string' ? value.stdout : '',
    stderr: typeof value?.stderr === 'string' ? value.stderr : '',
    code: Number.isInteger(value?.code) ? value.code : 1,
  };
}

function rank(entry: Entry): number {
  if (entry.tab.visible && entry.tab.focused) return 2;
  return entry.tab.visible ? 1 : 0;
}

export function noTab(cone: string): PageResult {
  return {
    stdout: '',
    stderr: `panel: no open SLICC tab shows cone ${cone}; open SLICC or switch a tab to ${cone}\n`,
    code: 3,
  };
}

export function noAnswer(cone: string): PageResult {
  return {
    stdout: '',
    stderr: `panel: the tab showing cone ${cone} didn't answer; try again\n`,
    code: 4,
  };
}

export function ownedPages(pages: AgentPages): AgentPages & { release(): void } {
  const mine = new Set<string>();
  return {
    async open(tab, context) {
      const opened = await pages.open(tab, context);
      if ('stream' in opened) mine.add(opened.stream);
      return opened;
    },
    async report(stream, tab, context) {
      if (mine.has(stream)) await pages.report(stream, tab, context);
    },
    async next(stream, waitMs, context) {
      if (!mine.has(stream)) return { requests: [], done: true };
      const batch = await pages.next(stream, waitMs, context);
      if (batch.done) mine.delete(stream);
      return batch;
    },
    async answer(stream, id, result, context) {
      if (mine.has(stream)) await pages.answer(stream, id, result, context);
    },
    async close(stream, context) {
      if (mine.delete(stream)) await pages.close(stream, context);
    },
    release() {
      for (const stream of mine) void pages.close(stream, BACKGROUND_CONTEXT);
      mine.clear();
    },
  };
}

export function createPages(options: PagesOptions = {}): Pages {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? PAGES_IDLE_MS;
  const pickMs = options.pickMs ?? PICK_MS;
  const answerMs = options.answerMs ?? ANSWER_MS;
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Pending>();
  let serial = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const drop = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    void entry.stream.finish();
  };
  const sweep = () => {
    for (const [id, entry] of entries) if (now() - entry.stream.touched > idleMs) drop(id);
    if (!entries.size && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const fail = (stream: string) => {
    for (const waiting of [...pending.values()])
      if (waiting.stream === stream) waiting.settle(noAnswer(waiting.cone));
  };
  const choose = (ask: PageAsk): Entry | undefined => {
    const live = [...entries.values()].filter((entry) => entry.tab.kinds.includes(ask.kind));
    const named = ask.tab
      ? live.filter((entry) => entry.tab.tab === ask.tab).sort((a, b) => b.serial - a.serial)[0]
      : undefined;
    if (named) return named;
    return live
      .filter((entry) => entry.tab.cone === ask.cone)
      .sort(
        (a, b) => rank(b) - rank(a) || b.tab.lastActive - a.tab.lastActive || b.serial - a.serial
      )[0];
  };
  const request = (ask: PageAsk): Promise<PageResult> => {
    sweep();
    const entry = choose(ask);
    const cone = entry?.tab.cone ?? ask.cone;
    if (!entry) return Promise.resolve(noTab(cone));
    const id = `p${++serial}-${crypto.randomUUID()}`;
    const item: PageRequest = {
      id,
      kind: ask.kind,
      argv: [...ask.argv],
      caller: { agentId: ask.agentId, cone, readOnly: false },
    };
    return new Promise((resolve) => {
      const settle = (result: PageResult) => {
        const waiting = pending.get(id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        pending.delete(id);
        const at = entry.stream.queue.indexOf(item);
        if (at >= 0) entry.stream.queue.splice(at, 1);
        resolve(result);
      };
      pending.set(id, {
        stream: entry.id,
        cone,
        timer: setTimeout(() => settle(noAnswer(cone)), pickMs),
        settle,
      });
      entry.stream.push([item]);
    });
  };
  const pages: Pages = {
    async open(tab) {
      sweep();
      const id = `t${++serial}-${crypto.randomUUID()}`;
      const stream = new Stream<PageRequest>(
        async () => {
          entries.delete(id);
          fail(id);
        },
        now(),
        MAX_PENDING,
        []
      );
      entries.set(id, { id, stream, tab: tabOf(tab), serial });
      timer ??= setInterval(sweep, options.sweepMs ?? idleMs / 4);
      return { stream: id };
    },
    async report(id, tab) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.tab = tabOf(tab);
      entry.stream.touched = now();
    },
    async next(id, waitMs, context) {
      const entry = entries.get(id);
      if (!entry) return { requests: [], done: true };
      entry.stream.touched = now();
      const signal = context.abortSignal;
      await entry.stream.wait(Math.max(0, Math.min(waitMs, idleMs / 2)), signal);
      if (signal?.aborted) {
        drop(id);
        signal.throwIfAborted();
      }
      entry.stream.touched = now();
      const requests = entry.stream.queue.splice(0);
      for (const item of requests) {
        const waiting = pending.get(item.id);
        if (!waiting) continue;
        clearTimeout(waiting.timer);
        waiting.timer = setTimeout(() => waiting.settle(noAnswer(waiting.cone)), answerMs);
      }
      const done = entry.stream.done;
      if (done) entries.delete(id);
      return { requests, done };
    },
    async answer(id, request, result) {
      const waiting = pending.get(request);
      if (waiting?.stream !== id) return;
      waiting.settle(resultOf(result));
    },
    async close(id) {
      drop(id);
    },
    request,
    async command(argv, caller) {
      const result = await request({ kind: 'panel', argv, ...caller });
      return { code: result.code, out: result.stdout, err: result.stderr };
    },
    tabs: () => [...entries.values()].map((entry) => ({ ...entry.tab })),
    async dispose() {
      clearInterval(timer);
      timer = undefined;
      const all = [...entries.keys()];
      for (const id of all) drop(id);
    },
  };
  return pages;
}
