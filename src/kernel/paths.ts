export function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
      else if (!absolute) parts.push(part);
    } else parts.push(part);
  }
  const joined = parts.join('/');
  if (absolute) return `/${joined}`;
  return joined || '.';
}

export function resolve(cwd: string, path: string): string {
  return normalize(path.startsWith('/') ? path : `${cwd}/${path}`);
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
