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

type Options = { listen?: Listen; wait?: number };

function ask(
  message: { type: string; marker: string },
  answers: Readonly<Record<string, boolean>>,
  signal: AbortSignal,
  options: Options
): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = (options.listen ?? listen)(HELD_CHANNEL);
    const finish = (answer: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      channel.close();
      resolve(answer);
    };
    const stop = () => finish(false);
    const timer = setTimeout(stop, options.wait ?? HOLD_WAIT_MS);
    signal.addEventListener('abort', stop, { once: true });
    channel.onmessage = ({ data }) => {
      const answer = data as { type?: unknown; marker?: unknown } | null;
      if (answer?.marker !== message.marker || typeof answer.type !== 'string') return;
      if (Object.hasOwn(answers, answer.type)) finish(answers[answer.type]);
    };
    if (signal.aborted) stop();
    else channel.postMessage(message);
  });
}

export function askBase(marker: string, signal: AbortSignal, options: Options = {}) {
  return ask({ type: 'base', marker }, { based: true }, signal, options);
}

export function askHold(
  marker: string,
  signal: AbortSignal,
  options: Options & { based?: boolean } = {}
): Promise<boolean> {
  const message = { type: 'hold', marker, ...(options.based ? { based: true, expect: 1 } : {}) };
  return ask(message, { held: true, none: true, unheld: false }, signal, options);
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
