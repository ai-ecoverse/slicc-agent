const channel = new BroadcastChannel('held-memory');
const held = new WeakSet();
const later = new WeakSet();
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
const child = FileSystemDirectoryHandle.prototype.getFileHandle;
FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, ...options) {
  const handle = await child.call(this, name, ...options);
  if (name === 'MEMORY.md' && this.name === 'held') held.add(handle);
  if (name === 'MEMORY.md' && this.name === 'reviewer') later.add(handle);
  return handle;
};
const bytes = File.prototype.arrayBuffer;
const open = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = async function (...options) {
  const file = await open.apply(this, options);
  if (later.has(this))
    file.arrayBuffer = function () {
      reads += 1;
      return bytes.call(this);
    };
  if (held.has(this))
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
