const create = FileSystemFileHandle.prototype.createWritable;
FileSystemFileHandle.prototype.createWritable = async function (...options) {
  if (this.name.endsWith('.code')) await new Promise((resolve) => setTimeout(resolve, 1000));
  return create.apply(this, options);
};
