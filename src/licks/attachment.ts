export const GATEWAY = 'https://ntfy.sliccy.ai';
export const ATTACHMENT_LIMIT = 256 * 1024;
export const ATTACHMENT_TIMEOUT_MS = 10_000;

export interface Attachment {
  url: string;
  name?: string;
  size?: number;
}

const TEXT =
  /^(text\/[\w.+-]+|application\/(json|x-ndjson|xml|yaml|x-yaml|javascript|ecmascript)|application\/[\w.+-]+\+(json|xml))$/;

export function attachmentLabel(attachment: Attachment): string {
  const bytes = attachment.size === undefined ? '' : `, ${attachment.size} bytes`;
  return `attachment ${attachment.name ?? 'file'}${bytes}`;
}

export function attachmentLine(attachment: Attachment): string {
  return `${attachmentLabel(attachment)}, not fetched: ${attachment.url}`;
}

function fromGateway(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === GATEWAY && parsed.pathname.startsWith('/file/');
  } catch {
    return false;
  }
}

class Refused extends Error {}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

async function capped(response: Response, cap: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new Refused();
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function textOf(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function why(error: unknown): string {
  const name = (error as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError')
    return `the gateway took longer than ${ATTACHMENT_TIMEOUT_MS / 1000} s`;
  return `the request failed: ${(error as Error | undefined)?.message || String(error)}`;
}

export async function attachmentPart(
  attachment: Attachment,
  fetcher: typeof fetch | undefined
): Promise<string> {
  const label = attachmentLabel(attachment);
  const { url } = attachment;
  if (!fetcher || !fromGateway(url)) return attachmentLine(attachment);
  const cap = Math.min(attachment.size ?? ATTACHMENT_LIMIT, ATTACHMENT_LIMIT);
  const refused = (reason: string) => `${label}, not fetched: ${reason}: ${url}`;
  const tooBig = refused(
    cap < ATTACHMENT_LIMIT
      ? `it is larger than its declared ${cap} bytes`
      : `it is larger than the ${ATTACHMENT_LIMIT / 1024} KiB limit`
  );
  if ((attachment.size ?? 0) > ATTACHMENT_LIMIT) return tooBig;
  const signal = AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { signal, credentials: 'omit', redirect: 'error' });
    const drop = () => void response.body?.cancel().catch(() => undefined);
    if (response.status === 404) {
      drop();
      return refused('it expired or was removed (404)');
    }
    if (!response.ok) {
      drop();
      return refused(`the gateway answered ${response.status}`);
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    const binary = `${label}, ${type || 'no type'}, binary, not inlined: ${url}`;
    if (!type || !TEXT.test(type)) {
      drop();
      return binary;
    }
    if (Number(response.headers.get('content-length')) > cap) {
      drop();
      return tooBig;
    }
    const text = textOf(await capped(response, cap, signal));
    return text === undefined ? binary : `${label}:\n${text}`;
  } catch (error) {
    return error instanceof Refused ? tooBig : refused(why(error));
  }
}
