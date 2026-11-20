const channel = new BroadcastChannel('held-sudo-run');
const queued = new Map();
const told = new WeakSet();
channel.addEventListener('message', ({ data }) => {
  if (data !== 'go') return;
  for (const [port, calls] of [...queued]) {
    queued.delete(port);
    for (const call of calls) call();
  }
});
const hold = (port, call) => {
  const calls = queued.get(port) ?? [];
  calls.push(call);
  queued.set(port, calls);
};
const listen = MessagePort.prototype.addEventListener;
MessagePort.prototype.addEventListener = function (type, listener, ...rest) {
  if ((type !== 'message' && type !== 'close') || typeof listener !== 'function')
    return listen.call(this, type, listener, ...rest);
  return listen.call(
    this,
    type,
    function (event) {
      const run = () => listener.call(this, event);
      if (type === 'message' && event.data?.op === 'sudo-run') {
        if (!told.has(event)) channel.postMessage({ held: event.data.options?.tag });
        told.add(event);
        return hold(this, run);
      }
      if (queued.has(this)) return hold(this, run);
      return run();
    },
    ...rest
  );
};
