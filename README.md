# slicc-agent

SLICC's agent core, built on pi's [durable](https://github.com/earendil-works/pi/tree/main/packages/durable) harness. It runs in a dedicated worker next to [slicc-kernel](https://github.com/ai-ecoverse/slicc-kernel) and is shown by [slicc-spectrum](https://github.com/ai-ecoverse/slicc-spectrum). The plan is in [ai-ecoverse/slicc-agent#2](https://github.com/ai-ecoverse/slicc-agent/issues/2).

The package ships unbundled ESM: `dist/` holds one file per source file and imports pi's packages by name, so [slicc-bios](https://github.com/ai-ecoverse/slicc-bios) installs it from its lockfile like any other package, and `pnpm upgrade @ai-ecoverse/slicc-agent` updates it in place.

## Use

In the agent's dedicated worker:

```js
import { hostAgent, openAgent, openOpfsSqliteStorage, serveConnections } from '@ai-ecoverse/slicc-agent';

const storage = await openOpfsSqliteStorage();
serveConnections(self, openAgent({ models, model, storage }).then((agent) => hostAgent(agent)));
```

In the page:

```js
import { startAgent } from '@ai-ecoverse/slicc-agent/page';

const owner = await startAgent({ worker: () => new Worker(workerUrl, { type: 'module' }) });
const agent = await owner.connect();
agent.transcript.subscribe((view) => render(view));
await agent.prompt('What is in /home?');
```

- `openAgent({ models, model, storage?, registry?, settings? })` opens a durable Harness (in memory unless `storage` is given) and its root conversation, and resumes work a previous worker left unfinished.
- `openOpfsSqliteStorage({ directory?, file? })` keeps the session in wasm SQLite ([`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)) in an `opfs-sahpool` pool, by default `/.slicc/agent/` in OPFS. It needs a dedicated worker. Only one worker holds a pool at a time: the opener takes a Web Lock per directory and waits until every file of the pool can be opened before sqlite-wasm installs it, because a failed install deletes the pool's directory. `openMemorySqliteStorage()` keeps the same database in memory.
- `hostAgent(agent)` serves the agent with pi's protocol: a pi-server with one session, `agent`, whose Chord services are `slicc.agent.control` (send with `whenBusy` `steer`, `followUp` or `reject`, wait, withdraw, abort, compact) and `slicc.agent.transcript` (the conversation's durable view as replicated state, plus `deliveries`: how each user entry was delivered, `run`, `steer` or `follow-up`, derived by the host from where each send it accepted was placed: after a tool result it steered, queued first it's a follow-up or a late steer per its `whenBusy`, placed at once it started a run). `serveConnections(self, host)` hands it every `MessagePort` the page sends.
- `@ai-ecoverse/slicc-agent/page` has what the page needs (`startAgent`, `connectAgent`) without the agent's runtime: no pi-durable, pi-ai, providers or SQLite, which load only in the worker. `@ai-ecoverse/slicc-agent/spectrum` is just as light, and a test keeps both that way.
- `startAgent({ worker })` takes the Web Lock `slicc-agent`, so one tab at a time owns the agent worker, and waits while another tab holds it. `connect()` returns an `AgentConnection` (`control`, `transcript`, `prompt()`), `restart()` replaces the worker (durable resumes from SQLite), and `release()` stops it and lets the next tab take over.

### Bash and files on slicc-kernel

The page owns the one kernel (plan decision D3), and the agent worker attaches to it as a second client ([slicc-kernel#66](https://github.com/ai-ecoverse/slicc-kernel/issues/66)), so a terminal's `ps` and `kill` reach whatever the agent started.

```js
const owner = await startAgent({ worker, kernel: { connect: () => kernel.connect() } });
```

```js
import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { kernelEnvironment, kernelPort } from '@ai-ecoverse/slicc-agent';

const client = await attachKernel(await kernelPort(self));
registry.install(CodingTools);
const agent = await openAgent({ models, model, storage, registry, env: kernelEnvironment(client) });
```

`SliccKernelEnv` implements pi durable's `ExecutionEnv` on the kernel client and passes pi's environment conformance suite:
- string commands run as `bash -c`, each in its own process group; timeouts and aborts kill the group;
- output past the spill limits goes to `/tmp/slicc-agent-output-*.log`;
- files and directories go through the kernel's OPFS view and metadata sidecar;
- `watch()` uses the kernel client's own `fs.watch` (slicc-kernel protocol 1.1), so a change made through the kernel by any process or client is reported in the same task. A watched path whose parent is renamed or replaced counts as changed, and a watched symbolic link also reports changes to its target. Writers that bypass the kernel, such as spectrum's Files panel writing OPFS directly, are caught by a rescan every 2 s (`watch: { rescanMs }`). On a kernel without `fs.watch` (`ENOSYS`), or for a target that doesn't exist yet, it polls every 100 ms instead; `watch: { mode: 'polling' }` forces that.

A conversation without a `cwd` works in `/home`.

### The worker seven starts

`@ai-ecoverse/slicc-agent/agent-worker` is a complete agent worker. It waits for the page kernel's port, then:
- attaches to the kernel and routes its cross-origin `fetch` through the kernel's transport when that transport isn't bound by CORS (slicc-node, slicc-swift or slicc-extension);
- opens the encrypted credential store, the AWS Bedrock provider and the session in OPFS SQLite;
- installs durable's coding tools and SLICC's system prompt, and serves the agent.

The system prompt has a `system` section generated at startup from the running worker (`sliccPrompt(facts)`, `systemSection`). It covers:
- the slicc-agent version, read from its own `package.json`, and that bash runs on the page's slicc-kernel in the browser;
- the filesystem layout, with `/os` and `/opt` as the system;
- the commands on `PATH`, listed by a kernel bash;
- installing tools with `pnpm add -g`, and that there is no ipk;
- the active transport, from its traits: the page's fetch, a local proxy, or another relay that fetches without CORS (traits can't tell which);
- that `localhost` is the sandbox's own loopback;
- what isn't there yet: node or python3 when not on `PATH`, a browser or CDP tool, and GitHub credentials.

```js
const owner = await startAgent({
  worker: () => new Worker(new URL('@ai-ecoverse/slicc-agent/agent-worker', import.meta.url), { type: 'module' }),
  kernel: { connect: () => kernel.connect() },
});
```

`runAgentWorker(self, options)` is the same with its parts replaceable (model, providers, kernel attach, credentials, storage).

**Providers.** The first provider is AWS Bedrock with a Bedrock API key as the bearer token; the default model is `us.anthropic.claude-sonnet-5-5`. Requests go to `us-west-2` unless the stored credential names another region (`AWS_REGION`, set by `connect`'s `region`). The default applies when the credential is read, so keys stored earlier get it too. The settings UI has no region field yet. Bedrock sends no CORS headers, so it needs a CORS-free transport, and its account says so (`needs: 'cors-free-transport'`).

**Adobe.** `adobeProvider()` reaches Adobe's LLM proxy (`ADOBE_PROXY`) with the user's IMS token as a bearer. Its models come from the proxy's `/v1/config` once a token is stored: Anthropic-style models go through pi-ai's `anthropic-messages` API at the proxy root, `api: 'openai'` models through `openai-completions` under `/v1`, and hidden ones are skipped. Every request carries an `X-Session-Id` that is fixed for the worker. The account is a sign-in (`auth: 'oauth'`): `AgentSettings.signIn('adobe')` returns the IMS `clientId`, `scopes` and `imsEnvironment` from `/v1/config`, fetched in the worker through the transport. The page runs the IMS popup and passes the token to `connect`, so `createAgentModel(connection, { login })` takes a `login(providerId, signIn)` that returns a token. The adapter calls `login` before anything else in the click's task, so the page can open its popup while it still has the user's gesture, and `signIn()` then fetches the IMS options lazily. The weekly budget from `/v1/usage` is in the settings state as `budget` (refreshed on connect and every five minutes), and the `tray` adapter shows it in spectrum's TrayStatus. Until the proxy allows `*.sliccy.ai` (vibemigration#228), Adobe needs a CORS-free transport like Bedrock. An expired session's error card offers **Log in**.

**Credentials.** They live in the IndexedDB database `slicc-agent-credentials`, sealed with AES-GCM under a non-extractable key that never leaves WebCrypto. They never enter the session database or the transcript, and followers never see them.

**Settings.** The `slicc.agent.settings` service shows the models and accounts and takes `connect(providerId, apiKey)` and `disconnect(providerId)`.

### In slicc-spectrum

`@ai-ecoverse/slicc-agent/spectrum` turns an `AgentConnection` into slicc-spectrum's `AgentPort`, so `<slicc-app>` shows the real agent:

```js
import { createAgentModel } from '@ai-ecoverse/slicc-agent/spectrum';

const agent = await owner.connect();
app.model = { ...createKernelModel({ kernel, root }), ...createAgentModel(agent, { storage: localStorage }) };
```

`createAgentModel()` returns the `agent` and `settings` ports. Settings keeps the UI preferences in `storage`; model and thinking belong to the conversation, and accounts and models come from the worker.

The adapter keeps the replicated transcript and maps it on every update. User, assistant and compaction entries become messages; tool results fill in the tool calls they answer; the generation in flight shows as a streaming message; retries and running compactions show as system messages. A failed generation ends in an error card whose action fits the error: credential errors (an invalid or missing key, 401/403, not authorized) open settings, a model the account can't use offers the model picker, and anything else offers Retry. A content-filter stop is different: every later request resends the content that tripped the filter, so Retry, and any new message, would be stopped again. Content-filter stops are Bedrock's `content_filtered` and `guardrail_intervened`, Anthropic's `sensitive` and refusals, and OpenAI's `content_filter`. Their card leads with "The model's content filter stopped this reply." and offers **Drop the last turn** (spectrum ≥ 1.12.0). `AgentControl.rewind(messageId)` finds the user turn before that message and forks the cone's conversation at the entry before it (`Conversation.fork`, so `pi.agent` comes back as it was there). It points the cone at the fork and returns the turn's prompt, which spectrum puts back into the composer. Forking the very first turn creates a fresh conversation with the same model and thinking level. The filtered branch stays in storage, off the active path. The fork starts with a `slicc.rewound` entry that shows as a "Rewound 1 turn" notice, and clicking the card of an earlier filtered turn rewinds that turn.

Each cone's active conversation is in the session document `slicc.agents` (the root until the first rewind). The host's transcript follows it across forks. Rewinding is refused while the cone itself is running or has queued input, because a fork starts with an empty inbox, but never because its scoops are busy (see Cones and scoops). A background compaction still running on the old branch finishes there. A fork also starts with fresh `pi.usage`. Credential and model errors lead with a plain sentence ("Bedrock rejected the API key.", "This model isn't available with the current account.") and keep the provider's raw error as `detail`, which spectrum (≥ 1.11.0) shows underneath. `busy()` and `queue()` read durable's live and inbox documents. Steering is the default (#4): a send or a steer goes out with `whenBusy: 'steer'`, so while a run is going it joins after the current tool round, and a `queue` send is a follow-up. User messages carry `delivered` from the host's deliveries; entries the host didn't record (from before a reload) count as steered when they follow a tool result. Cones and scoops are below; the freezer and questions come later. Licks show as spectrum's lick cards (below). slicc-spectrum is an optional peer dependency (≥ 1.13.0), used for types only, so package managers don't install it next to the agent.

Each tool call shows its input in the way that suits it:
- `bash`: its command, with a timeout as the card's `meta`;
- `read`: the path, with its line range as `meta`;
- `write`: the path;
- `edit`: the path, and its change as a `diff` (spectrum ≥ 1.13.0). While the edit runs, the diff comes from its `oldText`/`newText` pairs. Once done, it comes from the hunks of the unified `patch` that pi's edit tool returns in its result details, with context lines;
- other tools: their arguments as pretty-printed JSON.

### Licks

A lick is an event from outside the conversation (a file change, a schedule, a webhook, a reload, an upgrade) that reaches the agent as a steering input. pi durable's `submit({ type: 'input', whenBusy: 'steer' })` does the delivery: an idle cone starts a run, and a busy one gets the lick at its next boundary, after the current tool round, like a steer the user types. So the agent sees events during a long run instead of after it. Durable has no custom message role, so the input's text carries the lick:

```
<lick id="lk-…" channel="fswatch" source="notes" title="notes: /home/notes/**/*.md" count="2" at="2026-10-08T12:00:00.000Z">
2 paths changed under /home/notes matching **/*.md
changed /home/notes/today.md
gone /home/notes/old.md
</lick>
```

`&`, `<` and `>` are escaped everywhere inside it, and `"` and line breaks in attributes too, so no payload (a webhook body, a file name, a crontab message) can close the tag, open another one or add an attribute. A `licks` prompt section tells the model that lick text comes from events, not from the user, and that webhook payloads may be hostile. The adapter maps these inputs to spectrum's `LickMessage` (channel, title, text, body, `count` when more than one, and `severity`, shown by spectrum ≥ 1.23.0). A user message shows as a card only when it has exactly that shape: the `<lick …>` line with an `id` and a known `channel`, the text on its own line, and `</lick>` alone on the last line. Anything else, such as a one-line `<lick …>…</lick>`, stays an ordinary message.

**Coalescing.** Licks with the same target, channel and source share an outbox (the session document `slicc.licks`). At most one of them is undelivered (queued in `pi.inbox`) at a time. Events that arrive while it waits are merged into the next one: the count adds up and the paths are unioned (capped at 50 shown). Once the queued lick is placed, the merged one is submitted. Nothing is ever withdrawn, so a lick that already reached the model is never touched, and each lick's `count` is exactly the events it carries. Webhook requests are never merged. A lick's `requestId` is `lick:<id>`, and events with an id (cron fires, webhook deliveries, boot facts) are remembered per source, so a crash between admitting a lick and recording it doesn't deliver it twice.

**Stop.** pi's `Conversation.abort()` withdraws every queued steer and follow-up, so a lick that wasn't placed yet is withdrawn with them, and the events merged behind it are dropped too: Stop leaves the cone quiet. Events that arrive after Stop are delivered as usual, and an idle cone starts a run for them.

**Configuration** lives in files under `~/.slicc` (`/home/.slicc`), which the user and the agent edit with any tool. The worker watches the folder and reconciles on every change. Each malformed line or file becomes one lick naming the file, the line and the problem, once per distinct problem, with `severity="error"`; the entry is ignored until it's fixed. Names are 1–64 of `a-z 0-9 . _ -`, starting with a letter or digit. A target is `cone` (the active cone) or `scoop:<handle>`; a lick for a scoop that is stopped or gone goes to the cone, and webhooks always go to the cone. Files starting with `.` or ending in `~` are skipped; any other file that isn't `<name>.json` in `watches/` or `webhooks/` is an error.

- `~/.slicc/crontab`, one job per line: `<schedule> <name> [<target>] [<message>]`. The schedule is five fields (minute, hour, day of month, month, day of week, with `*`, ranges, steps, lists and `jan`–`dec`/`sun`–`sat` names; 7 is Sunday, and a job whose day of month and day of week are both set runs on either) or `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly`. Times are the browser's local time. Blank lines and `#` comments are ignored.
  ```
  */15 9-17 * * mon-fri  standup  Summarize what changed in ~/notes since the last standup
  @daily                 backup   scoop:ops
  ```
- `~/.slicc/watches/<name>.json`: `{ "path": "~/notes", "glob": "**/*.md", "target": "cone", "message": "…", "debounce": 500 }`. `path` is absolute or starts with `~/`; `glob` (default `**`) is matched against paths relative to it, with `*`, `**`, `?`, `[…]` and `{a,b}`. `debounce` is 100–60000 ms. `node_modules` and `.git` are never scanned.
- `~/.slicc/webhooks/<name>.json`: `{ "target": "cone", "message": "…" }`. The URL comes from the tray hub (milestone E); until then, `AgentControl.webhook(name, { id, headers, body })` is how a delivery arrives.

**Sources.**
- `fswatch`: the kernel environment's `watch()` reports changed paths; those matching the glob are collected for `debounce` ms and delivered as one lick with `changed` or `gone` per path. A watch that overflows or stops says so in a lick (a stopped one with `severity="error"`, an overflow with `severity="warn"`), and saving its file restarts it. Changes made while no worker runs aren't reported. **The agent's own changes are dropped**, so it never licks itself: the kernel environment records every path its file tools write, edit, move or remove, and the time its `bash` commands run; a change to such a path within 2 s, or any change while an agent command runs or within 2 s after it, counts as the agent's. A change the user makes while an agent command runs is therefore dropped too. Background processes the agent started (`&`) aren't tracked, so their changes do lick.
- `cron`: each line is a background durable task owned by the root conversation (`slicc.cron`), so Stop and rewinds don't affect it and it survives reloads. It sleeps until the next due time on the Harness clock, then delivers to the target the cone pointer names at that moment. Each due time is delivered exactly once, also across a worker restart: the fire's id is `<name>@<due time>`. **Missed fires** (seven was closed or the tab asleep) are delivered once, as one lick whose `count` is 1 plus the missed fires and whose text says how many were missed (counted exactly up to 100,000, then "at least 100,000"); the next fire is then computed from now. Editing a line replaces its task; removing it aborts the task.
- `webhook`: each request is its own lick, with the headers and the body; a delivery `id` makes retries idempotent.
- `upgrade`: when the worker starts with a different slicc-agent version than the session recorded, with the release notes link. Every change of version is its own lick, also back and forth.
- `session-reload`: when the kernel's boot time (`btime` in `/proc/stat`) differs from the last worker start and the cone ran `bash` since then. The page reloaded, so the kernel's processes are gone; the lick lists background commands (`&`, `nohup`, `setsid`, `disown`) that are no longer running. Durable itself resumes an interrupted run.

**Decisions.** A lick channel with a handler (`licks.handle(channel, { confirm, dismiss })`) gets `actions="confirm dismiss"` (or one of them), and its card is pending until decided. The agent decides with the tools `lick_confirm` and `lick_dismiss` (`{ lick_id, reason? }`); the user decides from the card (`AgentPort.resolveLick` → `AgentControl.resolveLick`), which runs the handler and writes a `slicc.lick-state` entry that tells the agent. The state comes from these entries in the transcript, so rewinds and forks keep it consistent. Deciding twice, an unknown id, or an action the channel doesn't have is an error result. No channel in this release has a handler yet; scoop permission requests, upskill links and mount recovery will. The two tools' cards are folded into the lick card.

### Cones and scoops

A **cone** is a top-level agent the user talks to; a **scoop** is a helper agent with its own conversation and its own folder, `/scoops/<handle>/`. The session document `slicc.agents` is the registry. The first cone's id is `cone`, later ones `cone-<n>`, counting up only. A scoop's id is `scoop:<handle>`, where the handle is its name made safe for a folder; a handle that is or was ever taken gets `-2`, `-3` and so on, so ids and folders are never reused. `AgentControl` adds `selectCone`, `createCone`, `createScoop`, `stopAgent`, `drop` (stop a scoop and keep its folder) and `unqueue(agentId, submissionId)`; `send` and `configure` take an `agentId`. Its errors are sentences the UI can show as they are, such as "A cone named harbor already exists." The transcript service adds `agents`, a summary of every cone and scoop, and `views`, one durable view per live agent, which the spectrum adapter shows in the agents rail (the header picker lists cones only). With spectrum ≥ 1.23.0 the rail drops scoops and the picker creates cones. A scoop created from the rail has a provisional id until the worker answers; the adapter then moves the selection, and sends, to the id the worker gave it.

Each scoop is owned by a background durable task, its **anchor**, so Stop in its cone doesn't end it; `agent stop` does, and keeps its transcript and folder. Each request handed to a scoop gets a **reporter** task that waits for the run, writes the answer to `/scoops/<handle>/reports/<task id>.md` and reports it to whoever asked. Requests from a cone's or a scoop's bash report into that agent's `pi.inbox` as a lick, through the licks outbox, so they steer and coalesce like any lick; requests from a terminal report nowhere, and a user typing in a scoop's chat gets the answer there. The report lick's text is `[scoop <name> (<role>) <status>]`, and its body has the report's path and line count and a 1,000-character preview. A scoop's prompt has a `scoop` section with its name, its cone, its folders and its limits; a cone's has a `subagent` section with the `agent` skill and up to 16 roles.

**The `agent` command.** One bash script is installed as `agent` and `subagent` in `$PNPM_HOME/bin`, so the user, a cone or a scoop runs it in any bash. It writes a request (NUL-separated fields: `slicc-agent/1`, the name it was called by, `$SLICC_AGENT`, the working directory, its pid, argc, the arguments and stdin) to `/var/lib/slicc/agent/requests/in/` and polls `out/` for the answer and exit code; the worker writes `<id>.ack` when it picks a request up, and the script gives up after 20 s without one ("the SLICC agent isn't running", exit 1). The kernel environment exports `SLICC_AGENT`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` into every agent command, so the worker knows the caller. `/var/lib/slicc/agent/scoops/<handle>/metadata.json` mirrors each scoop's state for scripts.
- `agent [options] --prompt <text>` (or `--file <path>`, or `-` for stdin, or v6's `agent <cwd> <allowed-commands> <prompt>`) is **synchronous**: an ephemeral scoop runs, and the command prints its final answer and exits 0, or prints the reason on stderr and exits 1. Afterwards the scoop is stopped, its folder removed, its conversation marked dropped and its transcript archived as Markdown in `/tmp/agent-sessions/<handle>.md` (`/home/sessions/` with `--persist-session`, nowhere with `--no-persist-session`). The script traps TERM, INT and HUP and cancels the scoop, and the worker checks the script's pid in the kernel's process table every second for a SIGKILL. If the caller's run is still going when the bash call dies (a bash timeout), the scoop continues and its answer arrives as a `bash` lick; `--background-after <seconds>` does the same on purpose. Sync calls nest up to three deep. Allowed commands in v6's form are told to the scoop, not enforced.
- `agent --async …` (= `subagent spawn …`) starts a persistent scoop and prints its handle; only cones start them. `list [--agents]`, `status`, `rename`, `send [--follow-up]`, `wait [--timeout <s>] [--notify]` (30 s by default; `--notify` returns at once and brings the answers together in one `scoop-wait` lick) and `stop` manage them. From a scoop, `agent send parent "<note>"` posts a progress note to its cone as a lick, coalesced per scoop.
- Options: `--name`, `--agent <role>`, `--model <provider/model>`, `--thinking <level>` or `--effort low|medium|high|max`, `--tools <a,b>` (or `auto`/`full`), `--read-only <paths>`, `--system-prompt[-file]`. `--schema-b64`, `--tools output`, `--session`, `--resume`, `--image`, `--no-escalate`, `--minimal` and `--usage` answer "not supported in SLICC yet".

**Roles** are pi agent files: Markdown with a frontmatter subset (`name`, `description`, `tools`, `model`, `thinking`, …) and the role's prompt as the body, added to the scoop's instructions. The built-ins are `scout`, `worker`, `reviewer`, `oracle` and `delegate`. Later sources replace earlier ones by name: built-ins, then packages in the kernel's `node_modules` that name a folder in `pi-subagents.agents` or `pi.subagents.agents`, then `~/.pi/agent/agents/`. A project's `.pi/agents/` will count only in trusted folders, and folders can't be trusted yet. `~/.pi/agent/settings.json` can override roles (`subagents.agentOverrides`) and set the limits `subagents.maxLiveScoops` (16 live scoops per cone) and `subagents.maxPerTurn` (64 scoops started per cone turn), which the worker counts for both kinds.

**Isolation, for now.** The file tools of a scoop write only under its folder and `/tmp`, plus the cwd of a v6-form call, and read those, their cone's working folder (`/home` by default) and `--read-only` paths; paths are normalized, `..` included, before the check. bash isn't confined, and the scoop is told so: the guard is a guardrail, not a boundary. Every process group a scoop starts is recorded, and stopping the scoop signals them all.

**Rewind.** Dropping a turn never waits for scoops. Scoops the dropped turn created are stopped and marked gone; requests it handed to older scoops are aborted and their reports withdrawn; scoops it stopped come back idle. The `slicc.rewound` entry lists them, and its notice says "Stopped scoop X. Restored scoop Y."

## Patched dependencies

Fixes to pi stay in this repository. [`patches/patches.json`](patches/patches.json) lists each one with its `kind`, `package`, `patchedVersion`, `reason`, `removeWhen` and `verify` command, and an optional `marker` (a file in the package and a string it must contain):

- `monkeypatch`: code that runs in users' browsers is patched at runtime. `applyPatches()` in [`src/patches.ts`](src/patches.ts) applies them once before pi is used: `PortListener.start()` calls it, so `hostAgent` and a `PortListener` used directly with pi's `Server` both get them. Each one checks that the code it replaces still looks as expected and throws, naming its manifest entry, if not. Today there is one: pi-server's `Server.accept` calls `unref()` on its handshake timer, which browsers don't have, so the patch gives numeric timer ids a no-op `unref`.
- `patch-package`: repository-only fixes go in `patches/<package>+<version>.patch`, applied by a `postinstall` that runs [patch-package](https://github.com/ds300/patch-package). There are none yet.
- `environment`: something the host must provide. pi-server imports `randomUUID` from `node:crypto`; slicc-bios serves a stub backed by `globalThis.crypto`, and the integration bundles alias it to `test/integration/shims/node-crypto.js`.

`npm run lint:patches` (part of `npm run lint`) fails when an installed version differs from `patchedVersion`, a marker is gone, a monkeypatch isn't named in `src/patches.ts`, a patch file and its entry don't match, or `renovate.json` doesn't route the package to the `patched dependencies` group with automerge off. That group covers every `@earendil-works/*` package, so a pi bump is always a reviewed PR: rerun each entry's `verify`, then move `patchedVersion` forward or drop the entry.

## Develop

```sh
npm install
npm run build
npm run test:unit
npm test
npm run lint
```

`npm test` builds `dist/`, bundles a test worker that runs the agent on pi's faux provider, and runs the integration tests in Chromium through the [slicc-shared-web harness](https://github.com/ai-ecoverse/slicc-shared-web#integration-test-harness). Unit tests live in `test/unit/`, which stays out of git; the pre-commit hook requires every changed line in `src/` to be covered. No test calls a real model.
