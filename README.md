# slicc-agent

SLICC's agent core, built on pi's [durable](https://github.com/earendil-works/pi/tree/main/packages/durable) harness. It runs in a dedicated worker next to [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel) and is shown by [slicc-spectrum](https://github.com/ai-ecoverse/slicc-spectrum). The plan is in [ai-ecoverse/slicc-agent#2](https://github.com/ai-ecoverse/slicc-agent/issues/2).

The package ships unbundled ESM: `dist/` holds one file per source file and imports pi's packages by name, so [slicc-bios](https://github.com/ai-ecoverse/slicc-bios) installs it from its lockfile like any other package, and `pnpm upgrade @ai-ecoverse/slicc-agent` updates it in place.

## Use

```js
import { connectAgent, openAgent, serveAgent } from '@ai-ecoverse/slicc-agent';

serveAgent(self, openAgent({ models, model: { provider: 'amazon-bedrock', modelId } }));

const agent = connectAgent(new Worker(workerUrl, { type: 'module' }));
await agent.prompt('What is in /home?');
```

- `openAgent({ models, model, storage?, registry?, settings? })` opens a durable Harness (in memory unless `storage` is given) and its root conversation. `prompt(text)` submits an input and resolves with the answer's text.
- `openOpfsSqliteStorage({ directory?, file? })` keeps the session in wasm SQLite ([`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)) in an `opfs-sahpool` pool, by default `/.slicc/agent/` in OPFS. It needs a dedicated worker. Only one worker holds a pool at a time: the opener takes a Web Lock per directory and waits until every file of the pool can be opened before sqlite-wasm installs it, because a failed install deletes the pool's directory. `openMemorySqliteStorage()` keeps the same database in memory. Pass either as `storage`.
- `serveAgent(endpoint, agent)` answers prompts that arrive on a worker or `MessagePort`; `connectAgent(endpoint)` is the page side.

## Develop

```sh
npm install
npm run build
npm run test:unit
npm test
npm run lint
```

`npm test` builds `dist/`, bundles a test worker that runs the agent on pi's faux provider, and runs the integration tests in Chromium through the [slicc-shared-web harness](https://github.com/ai-ecoverse/slicc-shared-web#integration-test-harness). Unit tests live in `test/unit/`, which stays out of git; the pre-commit hook requires every changed line in `src/` to be covered. No test calls a real model.
