const channel = new BroadcastChannel('stalled-ps');
let stalled = false;
channel.addEventListener('message', ({ data }) => {
  if (data === 'stall') {
    stalled = true;
    channel.postMessage('stalled');
  }
});
const listen = MessagePort.prototype.addEventListener;
MessagePort.prototype.addEventListener = function (type, listener, ...rest) {
  if (type !== 'message' || typeof listener !== 'function')
    return listen.call(this, type, listener, ...rest);
  return listen.call(
    this,
    type,
    function (event) {
      if (stalled && event.data?.op === 'ps') return undefined;
      return listener.call(this, event);
    },
    ...rest
  );
};
