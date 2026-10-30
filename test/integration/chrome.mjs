import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';

const options = {
  roots: [
    ['/dist-test/', 'dist-test/'],
    ['/7/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist-test/', 'dist-test/'],
    ['/dist/', 'dist/'],
    ['/bin/', 'bin/'],
    ['/packages/', 'packages/'],
    ['/node_modules/@ai-ecoverse/', 'node_modules/@ai-ecoverse/'],
    ['/node_modules/quickjs-wasi/', 'node_modules/quickjs-wasi/'],
    ['/', 'test/integration/page/'],
  ],
  isolated: true,
  coverage: env.SLICC_COVERAGE ? ['/dist-test/'] : [],
};

export const launch = (more = {}) => start({ ...options, ...more });

export const staged = (page, label, fn, ...args) =>
  page.run(
    {
      label,
      everyMs: 200,
      marker: () => [globalThis.waiting ?? null, globalThis.progress?.() ?? null],
    },
    fn,
    ...args
  );

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ ...options, port: Number(env.PORT ?? 8080) });
  console.log(`slicc-agent test page on ${url}`);
}
