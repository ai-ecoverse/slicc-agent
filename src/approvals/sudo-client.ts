import type { Readable } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { clientHost, holding } from '../client.ts';
import { AgentSudoService, SUDO_METHODS } from '../services.ts';
import { bound, type Remote, type Root } from '../serving.ts';
import { type PortEndpoint, PortLink } from '../wire.ts';
import type { Approval } from './record.ts';
import type { AgentSudo, SudoAnswer, SudoRequest } from './sudo.ts';

export interface ApproveOptions {
  signal?: AbortSignal;
  where?: string;
}

export const UNAVAILABLE = "The agent can't take this sudo request.";

export const unavailable = (cause?: unknown): Error =>
  Object.assign(new Error(UNAVAILABLE), { code: 'EAGAIN', ...(cause ? { cause } : {}) });

const missing = () => () => Promise.reject(unavailable());

export function answerOf(item: Approval | undefined): SudoAnswer | null {
  if (!item || item.state === 'pending') return null;
  return item.state === 'approved' && item.answer ? item.answer : 'deny';
}

function halted(stop: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (stop?.aborted) reject(unavailable());
    stop?.addEventListener('abort', () => reject(unavailable()), { once: true });
  });
}

async function open(endpoint: PortEndpoint, stop: AbortSignal | undefined) {
  const link = new PortLink(endpoint);
  let host: ReturnType<typeof clientHost> | undefined;
  const close = async () => {
    link.close('closed');
    await host?.close().catch(() => undefined);
  };
  const ended = link.ended.then((reason) => {
    throw reason ?? new Error('the agent closed the link');
  });
  ended.catch(() => undefined);
  const stopped = halted(stop);
  stopped.catch(() => undefined);
  try {
    await Promise.race([link.hello, ended, stopped]);
    const client = clientHost(link, 'sudo');
    host = client;
    const [handle] = (await Promise.race([holding(client, link, [AgentSudoService]), stopped])) as [
      Remote,
    ];
    if (handle.variant !== 'sudo') throw unavailable();
    const root: Root = (run, options) => client.root(run, options);
    const sudo = bound<Omit<AgentSudo, 'approvals'>>(handle, root, SUDO_METHODS, missing);
    return { sudo, approvals: handle.approvals as Readable<Approval[]>, ended, close };
  } catch (error) {
    await close();
    throw (error as { code?: unknown })?.code === 'EAGAIN' ? error : unavailable(error);
  }
}

function settled(
  approvals: Readable<Approval[]>,
  id: string,
  signals: { signal: AbortSignal | undefined; stop: AbortSignal | undefined },
  ended: Promise<never>
): Promise<{ answer: SudoAnswer; aborted: unknown }> {
  const { signal, stop } = signals;
  return new Promise((resolve) => {
    let off: () => void = () => undefined;
    let done = false;
    const finish = (answer: SudoAnswer, aborted: unknown = null) => {
      if (done) return;
      done = true;
      off();
      signal?.removeEventListener('abort', abort);
      stop?.removeEventListener('abort', halt);
      resolve({ answer, aborted });
    };
    const abort = () => finish('deny', signal?.reason ?? 'withdrawn');
    const halt = () => finish('deny');
    if (signal?.aborted) return abort();
    if (stop?.aborted) return halt();
    signal?.addEventListener('abort', abort, { once: true });
    stop?.addEventListener('abort', halt, { once: true });
    ended.catch(() => finish('deny'));
    off = approvals.subscribe((items) => {
      const answer = answerOf(items?.find((item) => item.id === id));
      if (answer) finish(answer);
    });
    if (done) off();
  });
}

export const WITHDRAW_MS = 5000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timedOut(
  link: { approvals: Readable<Approval[]>; ended: Promise<never> },
  id: string,
  expiresAt: number
): Promise<unknown> {
  let off: () => void = () => undefined;
  const left = new Promise<void>((resolve) => {
    off = link.approvals.subscribe((items) => {
      if (answerOf(items?.find((item) => item.id === id))) resolve();
    });
  });
  const wait = Math.max(0, expiresAt - Date.now()) + WITHDRAW_MS;
  return Promise.race([left, link.ended.catch(() => undefined), delay(wait)]).finally(() => off());
}

export async function askSudo(
  endpoint: PortEndpoint,
  request: SudoRequest,
  options: ApproveOptions = {},
  stop?: AbortSignal
): Promise<SudoAnswer> {
  const { signal } = options;
  const link = await open(endpoint, stop);
  try {
    if (signal?.aborted || stop?.aborted) return 'deny';
    const asked = await link.sudo.request(request, options.where ?? null, BACKGROUND_CONTEXT);
    if (asked.id === null) throw new Error(asked.error);
    const signals = { signal, stop };
    const { answer, aborted } = await settled(link.approvals, asked.id, signals, link.ended);
    if (aborted === 'expired') await timedOut(link, asked.id, request.expiresAt);
    else if (aborted)
      await Promise.race([
        link.sudo.withdraw(asked.id, String(aborted), BACKGROUND_CONTEXT),
        delay(WITHDRAW_MS),
      ]);
    return answer;
  } finally {
    await link.close();
  }
}
