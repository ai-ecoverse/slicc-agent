import { headerList } from '../net.ts';
import { HOPS, MOVED, nextHop, outgoing } from '../secrets/fetch.ts';
import type { OutgoingRequest } from '../secrets/vault-types.ts';
import { ownOrigin } from './config.ts';

type Fetch = typeof fetch;

function unfollowed(url: string): TypeError {
  return new TypeError(`${new URL(url).origin} answered with a redirect that wasn't followed`);
}

function sent(inner: Fetch, current: OutgoingRequest, signal: AbortSignal, manual: boolean) {
  return inner(current.url, {
    method: current.method,
    headers: current.headers,
    signal,
    credentials: 'omit',
    redirect: manual ? 'manual' : 'follow',
    ...(current.body === undefined ? {} : { body: current.body as BodyInit }),
  });
}

async function dropped(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function offPage(inner: Fetch, origin: string, shows: () => boolean): Fetch {
  const refuse = (url: string) => {
    if (new URL(url).origin === origin) throw new TypeError(ownOrigin(origin));
  };
  return async (input, init) => {
    const request = new Request(input, { ...init, credentials: 'omit' });
    refuse(request.url);
    if (request.redirect !== 'follow') return inner(input, { ...init, credentials: 'omit' });
    let current = await outgoing(request, headerList(request, input, init));
    let manual = shows();
    for (let hops = 0; ; ) {
      refuse(current.url);
      const response = await sent(inner, current, request.signal, manual);
      const opaque = response.type === 'opaqueredirect';
      if (response.url && new URL(response.url).origin === origin) {
        await dropped(response);
        throw new TypeError(ownOrigin(origin));
      }
      if (!opaque && !(MOVED.has(response.status) && response.headers.has('location')))
        return response;
      await dropped(response);
      if (opaque && manual) {
        manual = false;
        continue;
      }
      const next = !opaque && hops < HOPS ? nextHop(current, response) : undefined;
      if (!next) throw unfollowed(current.url);
      current = next;
      hops += 1;
    }
  };
}
