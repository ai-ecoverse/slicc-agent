const HELD = 'home/.pi/agent/memory/held/MEMORY.md';
const LATER = 'home/.pi/agent/agent-memory/reviewer/MEMORY.md';
const channel = new BroadcastChannel('held-memory');
const waiting = [];
let armed = false;
let reads = 0;
channel.addEventListener('message', ({ data }) => {
  if (data === 'arm') {
    armed = true;
    channel.postMessage('armed');
  }
  if (data === 'release') for (const go of waiting.splice(0)) go();
  if (data === 'count') channel.postMessage({ reads });
});
const bytes = File.prototype.arrayBuffer;
const open = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = async function (...options) {
  const file = await open.apply(this, options);
  const path = (await (await navigator.storage.getDirectory()).resolve(this))?.join('/');
  if (path === LATER)
    file.arrayBuffer = function () {
      reads += 1;
      return bytes.call(this);
    };
  if (path === HELD)
    file.arrayBuffer = async function () {
      if (armed) {
        armed = false;
        channel.postMessage('held');
        await new Promise((resolve) => waiting.push(resolve));
      }
      return bytes.call(this);
    };
  return file;
};
