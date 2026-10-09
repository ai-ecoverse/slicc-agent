export interface KernelStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date | number;
  ino?: number;
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
  env?: Record<string, string>;
  pgid?: number;
  onStdout?(bytes: Uint8Array): void;
  onStderr?(bytes: Uint8Array): void;
}

export interface KernelClient {
  fs: KernelFs;
  spawn(argv: readonly string[], options: SpawnOptions): Promise<KernelProcess>;
  kill?(pid: number, signal?: string): Promise<void>;
  ps?(): Promise<readonly { pid: number; ppid?: number }[]>;
}
