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
const read = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = async function (...options) {
  if (this.name === 'MEMORY.md') {
    reads += 1;
    if (armed) {
      armed = false;
      channel.postMessage('held');
      await new Promise((resolve) => waiting.push(resolve));
    }
  }
  return read.apply(this, options);
};
