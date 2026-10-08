export interface Activity {
  wrote(path: string): void;
  began(): () => void;
  agentMade(path: string): boolean;
}

export interface ActivityOptions {
  windowMs?: number;
  now?: () => number;
}

function related(changed: string, written: string): boolean {
  return (
    changed === written || changed.startsWith(`${written}/`) || written.startsWith(`${changed}/`)
  );
}

export function createActivity(options: ActivityOptions = {}): Activity {
  const windowMs = options.windowMs ?? 2000;
  const now = options.now ?? Date.now;
  const writes = new Map<string, number>();
  let running = 0;
  let lastExec = Number.NEGATIVE_INFINITY;
  const recent = (at: number) => now() - at <= windowMs;
  return {
    wrote(path) {
      writes.set(path, now());
    },
    began() {
      running++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        running--;
        lastExec = now();
      };
    },
    agentMade(path) {
      if (running > 0 || recent(lastExec)) return true;
      let found = false;
      for (const [written, at] of writes) {
        if (!recent(at)) writes.delete(written);
        else if (related(path, written)) found = true;
      }
      return found;
    },
  };
}
