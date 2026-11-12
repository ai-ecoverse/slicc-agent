import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

export function withExec(env: ExecutionEnv, exec: ExecutionEnv['exec']): ExecutionEnv {
  return new Proxy(env, {
    get(target, key) {
      if (key === 'exec') return exec;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
