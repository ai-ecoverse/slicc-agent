const move = FileSystemFileHandle.prototype.move;
FileSystemFileHandle.prototype.move = async function (dir, name, ...rest) {
  if (this.name.endsWith('.code') || (typeof name === 'string' && name.endsWith('.code')))
    throw new DOMException('injected rename failure', 'InvalidModificationError');
  return move.call(this, dir, name, ...rest);
};

let copies = 0;
const create = FileSystemFileHandle.prototype.createWritable;
FileSystemFileHandle.prototype.createWritable = async function (...options) {
  if (this.name.endsWith('.code') && !this.name.startsWith('.tmp-')) {
    if (copies < 4) {
      copies += 1;
      throw new DOMException('injected copy failure', 'NoModificationAllowedError');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return create.apply(this, options);
};
