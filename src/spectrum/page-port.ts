import type { PanelCaller, PanelOutput } from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import type { PageRequest, PageResult, PageTab } from '../remote/pages.ts';
import type { AgentAdapter } from './agent-port.ts';

export const REPORT_MS = 250;
export const POLL_MS = 10000;

export type PageRun = (
  argv: readonly string[],
  caller: PanelCaller
) => PanelOutput | Promise<PanelOutput>;

export interface PageTarget {
  addEventListener(type: string, listener: () => void, options?: boolean): void;
  removeEventListener(type: string, listener: () => void, options?: boolean): void;
}

export interface PageDocument extends PageTarget {
  readonly visibilityState: string;
  hasFocus(): boolean;
}

export interface PageOptions {
  tab: string;
  run?: PageRun;
  document?: PageDocument;
  window?: PageTarget;
  now?: () => number;
  reportMs?: number;
  pollMs?: number;
}

async function quietly(call: () => Promise<void> | undefined): Promise<void> {
  try {
    await call();
  } catch {}
}

const ACTIVITY = ['pointerdown', 'keydown'];
const FOCUS = ['focus', 'blur'];

export class PageAdapter {
  readonly #connection: AgentConnection;
  readonly #agent: AgentAdapter;
  readonly #options: PageOptions;
  readonly #run: PageRun;
  readonly #now: () => number;
  readonly #off: (() => void)[] = [];
  #stream: string | null = null;
  #lastActive: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  readonly done: Promise<void>;

  constructor(
    connection: AgentConnection,
    agent: AgentAdapter,
    options: PageOptions & { run: PageRun }
  ) {
    this.#connection = connection;
    this.#agent = agent;
    this.#options = options;
    this.#run = options.run;
    this.#now = options.now ?? Date.now;
    this.#lastActive = this.#now();
    const doc = options.document ?? (globalThis as { document?: PageDocument }).document;
    const win = options.window ?? (globalThis as { window?: PageTarget }).window;
    const schedule = () => this.#schedule();
    const active = () => {
      this.#lastActive = this.#now();
      this.#schedule();
    };
    if (doc) this.#listen(doc, 'visibilitychange', schedule);
    if (win) {
      for (const type of FOCUS) this.#listen(win, type, schedule);
      for (const type of ACTIVITY) this.#listen(win, type, active);
    }
    this.#off.push(agent.on('active', schedule));
    const agents = connection.agents?.subscribe(schedule);
    if (agents) this.#off.push(agents);
    this.done = this.#loop().catch(() => undefined);
  }

  #listen(target: PageTarget, type: string, listener: () => void): void {
    target.addEventListener(type, listener, true);
    this.#off.push(() => target.removeEventListener(type, listener, true));
  }

  #cone(): string | null {
    const summary = this.#connection.agents?.value;
    const agents = summary?.agents ?? [];
    let id: string | null = this.#agent.active();
    for (let hops = 0; id && hops <= agents.length; hops++) {
      const found = agents.find((agent) => agent.id === id);
      if (!found || found.kind === 'cone') return id;
      id = found.parentId;
    }
    return summary?.active ?? id;
  }

  state(): PageTab {
    const doc = this.#options.document ?? (globalThis as { document?: PageDocument }).document;
    return {
      tab: this.#options.tab,
      kinds: ['panel'],
      cone: this.#cone(),
      visible: doc ? doc.visibilityState === 'visible' : false,
      focused: doc ? doc.hasFocus() : false,
      lastActive: this.#lastActive,
    };
  }

  #schedule(): void {
    if (this.#disposed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const stream = this.#stream;
      if (!stream || this.#disposed) return;
      void quietly(() => this.#connection.pages?.report(stream, this.state(), BACKGROUND_CONTEXT));
    }, this.#options.reportMs ?? REPORT_MS);
  }

  async #loop(): Promise<void> {
    const pages = this.#connection.pages;
    if (!pages) return;
    while (!this.#disposed) {
      const opened = await pages.open(this.state(), BACKGROUND_CONTEXT);
      if ('error' in opened) return;
      this.#stream = opened.stream;
      if (this.#disposed) break;
      let done = false;
      while (!done && !this.#disposed) {
        const batch = await pages.next(
          opened.stream,
          this.#options.pollMs ?? POLL_MS,
          BACKGROUND_CONTEXT
        );
        for (const request of batch.requests) void this.#handle(opened.stream, request);
        done = batch.done;
      }
    }
    const stream = this.#stream;
    if (stream) await pages.close(stream, BACKGROUND_CONTEXT);
  }

  async #handle(stream: string, request: PageRequest): Promise<void> {
    let result: PageResult;
    try {
      result = await this.#run(request.argv, request.caller);
    } catch (error) {
      result = { stdout: '', stderr: `panel: ${(error as Error).message}\n`, code: 1 };
    }
    await quietly(() =>
      this.#connection.pages?.answer(stream, request.id, result, BACKGROUND_CONTEXT)
    );
  }

  dispose(): Promise<void> {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const off of this.#off.splice(0)) off();
    const stream = this.#stream;
    if (stream) void quietly(() => this.#connection.pages?.close(stream, BACKGROUND_CONTEXT));
    return this.done;
  }
}
