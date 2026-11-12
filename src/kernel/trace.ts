import type { KernelClient, TraceBatch, TraceEvent } from './client.ts';

export const CALL_TAG = 'call:';
export const PROGRAMS_KEPT = 16;
export const NAMES_HELD = 64;
export const PIDS_HELD = 1024;
export const QUEUE_HELD = 4096;
export const LINGER_MS = 2000;
export const TRACE_LIMIT = 4096;
export const INTENT_HELD = 1000;

export interface RanProgram {
  name: string;
  status?: number;
  signal?: string;
  quiet?: true;
}

export interface Ran {
  programs: RanProgram[];
  ms: number;
  more?: number;
  dropped?: number;
  intent?: string;
}

export interface CallTrace {
  tag: string;
  report(ran: Ran): void;
}

type Proc = {
  pid: number;
  ppid: number;
  start: number;
  end?: number;
  name?: string;
  status?: number;
  signal?: string;
  cpu: number;
};

const INTERPRETERS =
  /^(?:(?:ba|da|z|k|c|tc|fi)?sh|node|jsh|deno|bun|tsx|python[\d.]*|pypy[\d.]*|perl[\d.]*|ruby[\d.]*|php[\d.]*|lua[\d.]*)$/;
const NAME = /^[^\s/\p{Cc}\p{Cf}]{1,64}$/u;
const SAYERS = new Set(['intent', 'playwright-cli']);

function leaf(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? '';
}

export function programOf(
  argv: readonly string[],
  exe?: string
): { name: string; args: readonly string[] } | undefined {
  const first = leaf(argv[0] ?? '') || leaf(exe ?? '');
  const script = argv[1] ?? '';
  const shebang =
    INTERPRETERS.test(first) &&
    script.includes('/') &&
    !script.startsWith('-') &&
    !/\s/.test(script) &&
    NAME.test(leaf(script));
  const name = shebang ? leaf(script) : first;
  if (!NAME.test(name)) return undefined;
  return { name, args: argv.slice(shebang ? 2 : 1) };
}

export function argvIntent(args: readonly string[]): string | undefined {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    if (arg === '--') return undefined;
    if (arg === '--intent') return args[at + 1];
    if (arg.startsWith('--intent=')) return arg.slice('--intent='.length);
  }
  return undefined;
}

const sigpipe = (proc: Proc) => proc.status === 141 || proc.signal === 'SIGPIPE';

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  a.every((word, at) => (at === 0 ? leaf(word) === leaf(b[0] as string) : word === b[at]));

export class Collector {
  readonly #procs = new Map<number, Proc>();
  readonly #names = new Map<string, { first: number; cpu: number }>();
  readonly #launchers: readonly (readonly string[])[];
  #queue: TraceEvent[] | undefined = [];
  #root: number | undefined;
  #rootEnded = false;
  #dropped = 0;
  #more = 0;
  #intent: string | undefined;
  #wake: (() => void) | undefined;

  constructor(argv: readonly string[], launchers: number) {
    this.#launchers = Array.from({ length: launchers }, (_, at) => argv.slice(at));
  }

  feed(batch: TraceBatch): void {
    this.#dropped += batch.dropped;
    for (const event of batch.events) {
      if (!this.#queue) this.#take(event);
      else if (this.#queue.length < QUEUE_HELD) this.#queue.push(event);
      else this.#dropped++;
    }
    this.#check();
  }

  begin(pid: number): void {
    this.#root = pid;
    const queued = this.#queue ?? [];
    this.#queue = undefined;
    for (const event of queued) this.#take(event);
    this.#check();
  }

  #proc(pid: number, ppid: number, seq: number): Proc | undefined {
    const found = this.#procs.get(pid);
    if (found) return found;
    if (this.#procs.size >= PIDS_HELD) {
      this.#dropped++;
      return undefined;
    }
    const made: Proc = { pid, ppid, start: seq, cpu: 0 };
    this.#procs.set(pid, made);
    return made;
  }

  #launcher(proc: Proc, argv: readonly string[]): boolean {
    return proc.name === undefined && this.#launchers.some((each) => same(argv, each));
  }

  #take(event: TraceEvent): void {
    if (event.type === 'exit') {
      this.#exit(event);
      return;
    }
    const proc = this.#proc(event.pid, event.ppid, event.seq);
    if (!proc || event.type === 'fork' || this.#launcher(proc, event.argv)) return;
    const program = programOf(event.argv, event.exe);
    if (!program) return;
    proc.name = program.name;
    if (this.#intent === undefined && SAYERS.has(program.name)) {
      const said = argvIntent(program.args);
      if (said) this.#intent = said.slice(0, INTENT_HELD);
    }
    if (this.#names.has(program.name)) return;
    if (this.#names.size >= NAMES_HELD) {
      this.#more++;
      proc.name = undefined;
      return;
    }
    this.#names.set(program.name, { first: event.seq, cpu: 0 });
  }

  #exit(event: Extract<TraceEvent, { type: 'exit' }>): void {
    if (event.pid === this.#root) this.#rootEnded = true;
    const proc = this.#procs.get(event.pid);
    if (!proc || proc.end !== undefined) return;
    proc.end = event.seq;
    proc.status = event.status;
    if (event.signal) proc.signal = event.signal;
    proc.cpu = (event.utime ?? 0) + (event.stime ?? 0);
    const named = proc.name === undefined ? undefined : this.#names.get(proc.name);
    if (named) named.cpu += proc.cpu;
  }

  get done(): boolean {
    return this.#rootEnded && [...this.#procs.values()].every((proc) => proc.end !== undefined);
  }

  #check(): void {
    if (this.done) this.#wake?.();
  }

  settled(ms: number): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        resolve();
      }
      this.#wake = finish;
    });
  }

  #related(a: Proc, b: Proc): boolean {
    const above = (low: Proc, high: Proc) => {
      const seen = new Set<number>();
      for (
        let at = this.#procs.get(low.ppid);
        at && !seen.has(at.pid);
        at = this.#procs.get(at.ppid)
      ) {
        if (at.pid === high.pid) return true;
        seen.add(at.pid);
      }
      return false;
    };
    return above(a, b) || above(b, a);
  }

  #piped(proc: Proc): boolean {
    const end = proc.end ?? Number.POSITIVE_INFINITY;
    for (const other of this.#procs.values())
      if (
        other !== proc &&
        other.start < end &&
        (other.end ?? Number.POSITIVE_INFINITY) > proc.start &&
        !this.#related(proc, other)
      )
        return true;
    return false;
  }

  #quiet(proc: Proc, killed: boolean): boolean {
    if (proc.pid === this.#root) return true;
    if (killed && proc.signal !== undefined) return true;
    return sigpipe(proc) && this.#piped(proc);
  }

  facts(ms: number, killed: boolean): Ran {
    const ranked = [...this.#names].sort(([, a], [, b]) => b.cpu - a.cpu || a.first - b.first);
    const kept = ranked.slice(0, PROGRAMS_KEPT);
    const programs = kept.map(([name]) => this.#program(name, killed));
    const more = this.#more + ranked.length - kept.length;
    return {
      programs,
      ms,
      ...(more ? { more } : {}),
      ...(this.#dropped ? { dropped: this.#dropped } : {}),
      ...(this.#intent ? { intent: this.#intent } : {}),
    };
  }

  #program(name: string, killed: boolean): RanProgram {
    const runs = [...this.#procs.values()]
      .filter((proc) => proc.name === name && proc.end !== undefined)
      .sort((a, b) => (a.end as number) - (b.end as number));
    const loud = runs.find((proc) => proc.status !== 0 && !this.#quiet(proc, killed));
    const shown = loud ?? runs.find((proc) => proc.status !== 0) ?? runs.at(-1);
    if (!shown) return { name };
    return {
      name,
      status: shown.status as number,
      ...(shown.signal ? { signal: shown.signal } : {}),
      ...(shown.status !== 0 && !loud ? { quiet: true as const } : {}),
    };
  }
}

export interface Tracer {
  collector: Collector;
  close(): void;
}

export async function follow(
  client: KernelClient,
  tag: string,
  argv: readonly string[],
  launchers: number
): Promise<Tracer | undefined> {
  if (typeof client.trace !== 'function') return undefined;
  const collector = new Collector(argv, launchers);
  try {
    const subscription = await client.trace(tag, (batch) => collector.feed(batch), {
      limit: TRACE_LIMIT,
    });
    return { collector, close: () => subscription.close() };
  } catch {
    return undefined;
  }
}
