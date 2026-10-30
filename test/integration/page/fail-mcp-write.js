const create = FileSystemFileHandle.prototype.createWritable;
FileSystemFileHandle.prototype.createWritable = async function (...options) {
  if (/^mcp\.json\..+\.tmp$/.test(this.name))
    throw new DOMException('injected write failure', 'NoModificationAllowedError');
  return create.apply(this, options);
};
