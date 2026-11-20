export function sentHeaders(cdp) {
  const urls = new Map();
  const heard = [];
  const off = cdp.on(({ method, params }) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'worker')
      cdp.send('Network.enable', {}, params.sessionId).catch(() => undefined);
    if (method === 'Network.requestWillBeSent') {
      const seen = urls.get(params.requestId) ?? [];
      urls.set(params.requestId, [...seen, params.request.url]);
    }
    if (method === 'Network.requestWillBeSentExtraInfo') heard.push(params);
  });
  const lower = (headers) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    off,
    to(url) {
      const { host } = new URL(url);
      return heard
        .filter((params) => urls.get(params.requestId)?.includes(url))
        .map((params) => lower(params.headers))
        .filter((headers) => headers.host === host);
    },
  };
}
