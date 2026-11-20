const WAIT = 10000;

export function sentHeaders(cdp, wait = WAIT) {
  const urls = new Map();
  const heard = [];
  const waiters = new Set();
  const enabling = [];
  const off = cdp.on(({ method, params }) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'worker')
      enabling.push(cdp.send('Network.enable', {}, params.sessionId).catch(() => undefined));
    if (method === 'Network.requestWillBeSent') {
      const seen = urls.get(params.requestId) ?? [];
      urls.set(params.requestId, [...seen, params.request.url]);
    }
    if (method === 'Network.requestWillBeSentExtraInfo') heard.push(params);
    if (method.startsWith('Network.requestWillBeSent')) for (const wake of waiters) wake();
  });
  const lower = (headers) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const recorded = (url) => {
    const { host } = new URL(url);
    return heard
      .filter((params) => urls.get(params.requestId)?.includes(url))
      .map((params) => lower(params.headers))
      .filter((headers) => headers.host === host);
  };
  return {
    off,
    ready: () => Promise.all(enabling),
    to: (url, count = 1) =>
      new Promise((resolve, reject) => {
        const settle = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        const check = () => {
          const found = recorded(url);
          if (found.length < count) return;
          settle();
          resolve(found);
        };
        const timer = setTimeout(() => {
          settle();
          const found = recorded(url).length;
          reject(new Error(`sentHeaders: ${found} of ${count} requests to ${url} in ${wait} ms`));
        }, wait);
        waiters.add(check);
        check();
      }),
  };
}
