const channel = new BroadcastChannel('held-memory');
const waiting = [];
let armed = false;
let held;
let later;
let reads = 0;
const find = async (path) => {
  let dir = await navigator.storage.getDirectory();
  const parts = path.split('/');
  const name = parts.pop();
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  return dir.getFileHandle(name);
};
channel.addEventListener('message', async ({ data }) => {
  if (data === 'arm') {
    held = await find('home/.pi/agent/memory/held/MEMORY.md');
    later = await find('home/.pi/agent/agent-memory/reviewer/MEMORY.md');
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
  if (this.name !== 'MEMORY.md' || !held) return file;
  if (await this.isSameEntry(later))
    file.arrayBuffer = function () {
      reads += 1;
      return bytes.call(this);
    };
  if (await this.isSameEntry(held))
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
