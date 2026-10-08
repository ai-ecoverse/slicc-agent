import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';

const options = {
  roots: [
    ['/dist-test/', 'dist-test/'],
    ['/dist/', 'dist/'],
    ['/bin/', 'bin/'],
    ['/packages/', 'packages/'],
    ['/node_modules/@ai-ecoverse/', 'node_modules/@ai-ecoverse/'],
    ['/node_modules/quickjs-wasi/', 'node_modules/quickjs-wasi/'],
    ['/', 'test/integration/page/'],
  ],
  isolated: true,
  coverage: ['/dist-test/'],
};

export const launch = () => start(options);

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ ...options, port: Number(env.PORT ?? 8080) });
  console.log(`slicc-agent test page on ${url}`);
}
