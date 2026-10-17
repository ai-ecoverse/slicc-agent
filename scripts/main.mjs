import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export const isMain = (url) =>
  Boolean(process.argv[1]) && real(process.argv[1]) === real(fileURLToPath(url));
