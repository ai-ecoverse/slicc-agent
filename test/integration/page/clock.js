const realNow = Date.now.bind(Date);
const realSet = globalThis.setTimeout.bind(globalThis);
const realClear = globalThis.clearTimeout.bind(globalThis);
const asked = Number(new URLSearchParams(self.location.search).get('now'));
let offset = asked ? asked - realNow() : 0;
Date.now = () => realNow() + offset;
const timers = new Map();
let next = 2 ** 30;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  if (typeof fn !== 'function' || !(ms >= 1000)) return realSet(fn, ms, ...args);
  const id = next++;
  const fire = () => {
    const timer = timers.get(id);
    if (!timer) return;
    timers.delete(id);
    realClear(timer.real);
    fn(...args);
  };
  timers.set(id, { at: Date.now() + ms, real: realSet(fire, ms), fire });
  return id;
};
globalThis.clearTimeout = (id) => {
  const timer = timers.get(id);
  if (!timer) return realClear(id);
  timers.delete(id);
  realClear(timer.real);
};
new BroadcastChannel('slicc-test-clock').onmessage = ({ data }) => {
  offset = data.now - realNow();
  for (const timer of [...timers.values()]) if (timer.at <= Date.now()) timer.fire();
};
