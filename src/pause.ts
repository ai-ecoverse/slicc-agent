import type { Context } from '@earendil-works/chord';

export interface PhaseClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
}

function tick(clock: PhaseClock, delayMs: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      disarm();
      reject(signal?.reason);
    };
    const disarm = clock.setTimer(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function pauseUntil(clock: PhaseClock, until: number, context: Context) {
  const signal = context.abortSignal;
  for (;;) {
    signal?.throwIfAborted();
    const remaining = until - clock.now();
    if (remaining <= 0) return;
    await tick(clock, remaining, signal);
  }
}
