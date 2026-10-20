export const HELD_CHANNEL = 'slicc-held';
export const HELD_MARK = 'slicc-sign-in-';
export const HOLD_WAIT_MS = 6000;
export const UNHELD = "SLICC couldn't protect the sign-in window. Try again.";

export interface HeldChannel {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

export type Listen = (name: string) => HeldChannel;

const listen: Listen = (name) => new BroadcastChannel(name) as unknown as HeldChannel;

export function markerUrl(marker: string): string {
  return `about:blank#${HELD_MARK}${marker}`;
}

export function askHold(
  marker: string,
  signal: AbortSignal,
  options: { listen?: Listen; wait?: number } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = (options.listen ?? listen)(HELD_CHANNEL);
    const finish = (held: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      channel.close();
      resolve(held);
    };
    const stop = () => finish(false);
    const timer = setTimeout(stop, options.wait ?? HOLD_WAIT_MS);
    signal.addEventListener('abort', stop, { once: true });
    channel.onmessage = ({ data }) => {
      const answer = data as { type?: unknown; marker?: unknown } | null;
      if (answer?.marker !== marker) return;
      if (answer.type === 'held' || answer.type === 'none') finish(true);
      else if (answer.type === 'unheld') finish(false);
    };
    if (signal.aborted) stop();
    else channel.postMessage({ type: 'hold', marker });
  });
}

export function refusal(held: Promise<boolean>, refuse: () => void = () => {}): Promise<void> {
  const refused = held.then((ok) => {
    if (ok) return;
    refuse();
    throw new Error(UNHELD);
  });
  refused.catch(() => undefined);
  return refused;
}

export function unlessRefused<T>(work: Promise<T>, refused: Promise<void>): Promise<T> {
  return Promise.race([work, refused.then(() => work)]);
}
