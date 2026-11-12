export interface KernelStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date | number;
  ino?: number;
  mode?: number;
  uid?: number;
}

export interface KernelFs {
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<KernelStat>;
  lstat(path: string): Promise<KernelStat>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  watch?(
    paths: readonly string[],
    options: { recursive: boolean },
    onChange: (change: { paths: string[] } | { overflow: true }) => void
  ): Promise<{ close(): unknown }>;
}

export interface KernelProcess {
  pid: number;
  pgid: number;
  exited: Promise<number>;
  signal(name?: string): unknown;
}

export interface SpawnOptions {
  cwd?: string;
  user?: string | number;
  env?: Record<string, string>;
  pgid?: number;
  tag?: string;
  stdin?: Uint8Array;
  onStdout?(bytes: Uint8Array): void;
  onStderr?(bytes: Uint8Array): void;
}

export interface TraceExit {
  type: 'exit';
  pid: number;
  status: number;
  signal?: string;
  at?: number;
}

export type TraceEvent = TraceExit | { type: 'exec' | 'fork'; pid: number };

export interface SudoRunOptions {
  stdout?: string;
  stderr?: string;
  tag?: string | string[];
}

export interface SudoRunning {
  pid: number;
  pgid: number;
  ended: Promise<{ status: number; signal?: string }>;
}

export interface KernelClient {
  fs: KernelFs;
  protocol?: readonly number[];
  sudoRun?(request: object, options: SudoRunOptions): Promise<SudoRunning>;
  trace?(
    tag: string,
    onEvents: (batch: { events: TraceEvent[]; dropped: number }) => void | Promise<unknown>,
    options?: { limit?: number }
  ): Promise<{ close(): void }>;
  spawn(argv: readonly string[], options: SpawnOptions): Promise<KernelProcess>;
  kill?(pid: number, signal?: string): Promise<void>;
  ps?(): Promise<
    readonly {
      pid: number;
      ppid?: number;
      pgid?: number;
      state?: string;
      argv?: readonly string[];
      uid?: number;
      tag?: string;
      tags?: readonly string[];
    }[]
  >;
  loopbackFetch?(
    request: Request,
    options: { port: number; signal?: AbortSignal }
  ): Promise<Response>;
}
