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
- `startAgent({ worker })` takes the Web Lock `slicc-agent`, so one tab at a time owns the agent worker, and waits while another tab holds it. `connect()` returns an `AgentConnection` (`control`, `transcript`, `prompt()`, and `webhook(name, { id?, headers?, body })`, which hands a webhook delivery, such as one from the tray hub, to the licks without a chord `Context`), `restart()` replaces the worker (durable resumes from SQLite), and `release()` stops it and lets the next tab take over. `port()` returns a raw `MessagePort` into the worker instead, for another tab: hand it over (through a SharedWorker, say), and that tab calls `connectAgent(port)`. A caller that already holds the lock passes `held: true`. A connection's `closed` resolves when its port ends (with the error, if any), and from then on its states keep their last values.
- **Followers over a link** (PR 18): `port({ readOnly: true })` and `connect({ readOnly: true })` give a view-only connection, and `port({ pages: false })` a full one that never takes `panel` requests (see Panels).
  - **What a view-only connection can do:** it sees the transcript, the agents, settings state and remote-control `watch`, and may call `wait` and `changesOpen`.
  - **What it can't:** every other `AgentControl` method, settings action and remote-control `prompt` or `abort` is refused with `EACCES` ("this follower can watch, but not send, steer or abort"). Send and compact answer `accepted: false` with that code. The worker serves view-only ports from a second pi-server whose session gets these narrowed services.
  - **Carrying the connection over a byte stream:** `linkEndpoint({ write, close })` is a `PortEndpoint` that `connectAgent` accepts. Feed it the stream's bytes with `receive(bytes)` and its end with `end(error?)`. On the owner's side, `bridgePort(port, { write, close })` does the same for the `MessagePort` from `port()`.
  - **The bytes:** each `PortChannel` message becomes a frame: a `u32` big-endian length, then a tag (0 data, 1 hello with the server id, 2 close), then the payload. A frame is at most 16 MiB, and a malformed one ends the link.
  - **A newer owner:** agent 5.0 greets with `slicc-agent-link/2 <server id>` and speaks Chord frames instead of pi-protocol. A follower that gets such a hello closes the port at once and gets a connection whose `mismatch` is "That SLICC runs a newer version of the agent than this one, so this tab can't follow it. Update this SLICC, then reload this page." Its states are empty, every call rejects with `EPROTO` and that sentence, and `closed` stays pending, so a follower that retries on close doesn't loop. The spectrum adapter shows the sentence as a notice in the follower's chat.

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
- string commands run as `bash -c`. All of one agent's commands share one process group: the first leads it and later ones join it with `spawn({ pgid })` (slicc-kernel ≥ 1.19.0, client protocol 1.3), so `ps -o pgid` and `kill -- -<pgid>` cover a whole scoop from any terminal.
  - **Fallbacks:** if the group has no live member left (`ESRCH`) or belongs to another session (`EPERM`), the command leads a new group that later commands join. On an older kernel (`ENOSYS`), every command leads its own group, as before.
  - **Timeouts and aborts** kill only that command: its descendants are read from `ps()` first, then all are killed together with it, so a background job the agent started earlier keeps running. A process forked in the instant between that snapshot and the kill can slip through; it ends when the agent's groups are stopped;
- output past the spill limits goes to `/tmp/slicc-agent-output-*.log`;
- files and directories go through the kernel's OPFS view and metadata sidecar;
- `watch()` uses the kernel client's own `fs.watch` (slicc-kernel protocol 1.1), so a change made through the kernel by any process or client is reported in the same task. A watched path whose parent is renamed or replaced counts as changed, and a watched symbolic link also reports changes to its target. Writers that bypass the kernel, such as spectrum's Files panel writing OPFS directly, are caught by a rescan every 2 s (`watch: { rescanMs }`). On a kernel without `fs.watch` (`ENOSYS`), or for a target that doesn't exist yet, it polls every 100 ms instead; `watch: { mode: 'polling' }` forces that.

A conversation without a `cwd` works in `/home`.

**Kernel users.** A `KernelSource` may also have `users` (`add`, `remove`, `list`, as `kernel.users`), and its `connect` takes `{ user, agentId }` for a client bound to that user. The page builds the kernel's `connect({ user, tag })` from them, and so decides what the tag looks like. It may also have `groups` (`list`, `addMember`, `removeMember`, as `kernel.groups`). With `users`, the worker gets a second port next to the kernel's, for these calls (`kernelPorts(self)` resolves `{ kernel, admin? }`), and the `AgentHost` has `users`, a pool of one bound client per agent (`userClients`). Without `users` (or with `runAgentWorker(self, { users: false })`), nothing changes, and everything below about users doesn't apply:

```js
const owner = await startAgent({
  worker,
  kernel: {
    connect: (options) =>
      options?.user
        ? kernel.connect({ user: options.user, tag: JSON.stringify({ kind: 'agent', agentId: options.agentId }) })
        : kernel.connect(),
    users: kernel.users,
  },
});
```

At boot, the worker sets `/.slicc`, where the session database lives in OPFS, to `0700`, so that only root can read it through the kernel.

With users, each cone and each scoop is a kernel user, and works as that user:
- **Users and groups:**
  - a cone `cone` or `cone-<n>` is the user of the same name, in `sudo`, with home `/home/<cone>` (`0710`) and umask `077`;
  - a scoop is `scoop-<handle>`, a member of its cone's group, with home `/home/scoop-<handle>` (`2750`, the cone's group) and umask `027`.
  - So a cone reads its scoops' work, and a scoop reads only what its cone shares with `chmod g+r` (and `g+x` on the folders on the way).
  - The worker adds every user at boot, and on every change to `slicc.agents`. Stopping, dropping or removing a scoop removes its user and its home; scoops go before their cone.
- **Clients:** a conversation's bash, file tools and codemode, and its background tasks, use its agent's bound client. Its cwd defaults to its home, and the kernel sets `HOME`, `USER` and `PATH`. The client carries the page's tag for its agentId, so a `sudo` prompt names the agent.
- **The `agent` command:** each user has its own request spool, `/var/lib/slicc/agent/requests/<user>/` (`0700`). The spool's owner is the caller, so a `SLICC_AGENT` that names someone else is refused. `--file` and `--system-prompt-file` are read as the caller.
- **Sharing in a sync run:** when the caller's cwd, or a `--read-only` path, is inside the caller's home, the run first shares it with the scoop: `chmod -R g+rX` on it and `g+x` on the folders above it. The v6 form's working folder gets `g+rwX`, plus `g+s` on its folders. The modes stay afterwards.
- **Where things are:**

  | | |
  |---|---|
  | settings, MCP servers, `AGENTS.md`, prompts, roles | `/etc/slicc/agent/` (root); `mcp.json` is the worker's alone |
  | skills for every agent | `/usr/share/skills/` (root, `0755`), as without users |
  | an agent's own skills | `~/.pi/agent/skills` and `~/.agents/skills` in its home; only that agent sees them |
  | memory | `/root/.pi/agent/memory/` and `/root/.pi/agent/agent-memory/` (root; agents use `memory_write` and `memory`) |
  | licks | each cone's `~/.slicc`, whose jobs are named `<cone>:<name>` and whose `cone` target is that cone; root's `/root/.slicc`, whose `cone` is the active cone |
  | sprinkles | each cone's `~/sprinkles`, every cone's in the rail, with the id `<cone>/<name>` (the cone's id, such as `cone-2`) and the cone as `agentId`; `panel open sprinkle:<cone>/<name>` opens one, and spectrum scopes the rest by cone. welcome and suggestions keep their plain ids. spectrum ≥ 1.56.0 groups the rail by cone, with the selected cone first; an older spectrum lists them ungrouped. A sprinkle's files are read as its owner, inside the owner's home |
  | the gelatiere | its procedure and crontab line in the first cone's home, written as that cone; `gelatiere install` and `suggest` run as the caller |
  | scoop reports | the cone's `~/.slicc/reports/<handle>/` |
  | sync transcripts | `/tmp/agent-sessions/<user>/` (`0700`), or `~/sessions/` with `--persist-session` |
  | the suggestions store and catalog cache, the welcome flag and profile | `/var/lib/slicc/agent/shared/` (root, `0700`). The built-in welcome and suggestions sprinkles read it as `/shared/…`, through the worker and only inside that folder; a user's sprinkle reads `/shared/…` as its owner's home |
- **No migration:** there's nothing for old installs. Every install starts with this layout.
- **The scoop guard** stays on until the kernel reports `users: 'enforce'`; then the kernel's permissions decide.

### The worker seven starts

`@ai-ecoverse/slicc-agent/agent-worker` is a complete agent worker. It waits for the page kernel's port, then:
- attaches to the kernel and routes every cross-origin `fetch` through the kernel's transport, whose router picks a linked `slicc` exit, the extension or the page's own fetch, and every `<port>.kernel.localhost` request to the kernel's loopback (`loopbackFetch`). Same-origin and credentialed (`credentials: 'include'`) requests, and all of them when the kernel has no transport (`traits.unavailable`), use the worker's own fetch, since only it carries the browser's cookies. The system prompt names the route from the traits at attach: `traits.exit` (`{ kind: 'local' | 'remote' | 'tailnet', caps }`, from slicc-bios while it has a default exit) says a linked slicc exit, one on another device or the tailnet's exit node, and any other kind a linked exit, and without it `crossOrigin: 'cors'` says the page's own fetch;
- opens the vault-backed credentials (see Credentials), the AWS Bedrock provider and the session in OPFS SQLite;
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

`runAgentWorker(self, options)` is the same with its parts replaceable (model, providers, kernel attach, the account store, storage).

**Providers.** The first provider is AWS Bedrock with a Bedrock API key as the bearer token; the default model is `us.anthropic.claude-sonnet-5-5`. Requests go to `us-west-2` unless the account's `region` field names another one (`AWS_REGION`). The account publishes that field as `fields: [{ name: 'region', label: 'Region' }]`, and `connect` takes it. Bedrock sends no CORS headers, so it needs a CORS-free transport, and its account says so (`needs: 'cors-free-transport'`).

**Adobe.** `adobeProvider()` reaches Adobe's LLM proxy (`ADOBE_PROXY`) with the user's IMS token as a bearer. Its models come from the proxy's `/v1/config` once a token is stored: Anthropic-style models go through pi-ai's `anthropic-messages` API at the proxy root, `api: 'openai'` models through `openai-completions` under `/v1`, and hidden ones are skipped. Every request to the proxy (turns on either API, Clef, `/v1/config` and `/v1/usage`) carries an `X-Session-Id` that is fixed for the worker and an `X-Slicc-Version` (slicc-agent's version, `adobeProvider({ session, version })`); the proxy refuses turns without them. They're added where the request is built, over the caller's and the model's headers, because pi-ai 1.0.4 keeps a provider's `headers` but never sends them. The account is a sign-in (`auth: 'oauth'`): `AgentSettings.signIn('adobe')` returns the IMS `clientId`, `scopes` and `imsEnvironment` from `/v1/config`, fetched in the worker through the transport. The page runs the IMS popup and seals the token in the vault itself (bios: `seal { kind: 'model', provider: 'adobe', name: 'ADOBE_IMS_TOKEN', source: 'oauth:adobe', expiresAt }`), so `createAgentModel(connection, { login })` takes a `login(providerId, signIn, { signal })` that resolves `{ sealed: true }`; the adapter then calls `connect('adobe')` with no secret. A `login` that still returns a token is refused with "Adobe sign-in needs seven's vault: update seven", and the token never reaches the worker. IMS gives no refresh token, so an expired record shows the account as `expired`, and Sign in (or Reconnect) runs `login` again. While it runs, the account shows as `signing-in` (spectrum ≥ 1.34.0), and `SettingsPort.cancel(id)` aborts the signal; a cancelled sign-in never connects, even if the login resolves late. The adapter calls `login` before anything else in the click's task, so the page can open its popup while it still has the user's gesture, and `signIn()` then fetches the IMS options lazily. The weekly budget from `/v1/usage` is in the settings state as `budget` (refreshed on connect and every five minutes), and the `tray` adapter shows it in spectrum's TrayStatus. Until the proxy allows `*.sliccy.ai` (vibemigration#228), Adobe needs a CORS-free transport like Bedrock. An expired session's error card (a 401, or a refusal whose type or message says the token is invalid or expired) offers **Log in**; any other refusal, such as a 403 `missing_required_header`, shows the proxy's message, with the HTTP status and error type below it (`403 missing_required_header`) and **Retry**.

**Classifiers.** The Adobe provider also registers Cloudflare's Clef classifiers as `adobe/clef` and `adobe/clef-flash` (`adobeClassifiers()`): `type: 'classifier'` models on pi-ai's `cloudflare-workers-ai-system-one` API with `baseUrl: <proxy>/v1/ai`, so `models.classify(model, { state, questions })` posts `{ model: '@cf/cloudflare/clef', input }` to the proxy's `/v1/ai/run` with the IMS token as the bearer. The provider maps its short ids to the Workers AI names, and pi parses the answers and prices the usage ($0.24 per million input tokens for Clef, $0.09 for Clef Flash, nothing for output), which counts against the same weekly budget. They are classifiers only: `models.getModels()`, the settings `models` and the picker list chat models, and `models.getAvailableOfType('classifier', 'adobe')` returns them only while an Adobe token is stored.

**Model credentials.** They live in the vault, never in the worker (see Credentials).

**Settings.** The `slicc.agent.settings` service shows the models and accounts and takes `connect(providerId, secret, fields)` and `disconnect(providerId)`. An account's `id` is its lookup key: the pi-ai provider id for model accounts (the vault record's `provider`), and `mcp:<server>` for MCP servers (the record's `server` is the `mcp.json` key); `provider` is only the display name. Accounts whose key the agent reads from the vault carry `store: 'vault'`: spectrum (SPEC-S4) `put`s the key into the vault itself, then calls `connect(id)` with no secret, and the agent rereads `records()`. `fields` holds an account's non-secret settings (`Account.fields`, unknown names ignored), kept in `/.slicc/accounts.json`. `disconnect` clears them; removing the key is spectrum's `vault.remove(name, kind)`, since the agent port can't remove records. `connect` with a secret is refused for every model account ("API keys are kept in seven's vault: update seven"); the only secret it still takes is an MCP sign-in's callback answer.

### In slicc-spectrum

`@ai-ecoverse/slicc-agent/spectrum` turns an `AgentConnection` into slicc-spectrum's `AgentPort`, so `<slicc-app>` shows the real agent:

```js
import { createAgentModel } from '@ai-ecoverse/slicc-agent/spectrum';

const agent = await owner.connect();
app.model = { ...createKernelModel({ kernel, root }), ...createAgentModel(agent, { storage: localStorage }) };
```

`createAgentModel()` returns the `agent`, `settings`, `tray`, `sprinkles`, `memory`, `changes` and `monitor` ports, and `page`, the tab's end of the `panel` bridge, when it's given `page: { tab, run }` (see Panels). Settings keeps the UI preferences in `storage`; model and thinking belong to the conversation, and accounts and models come from the worker.

The adapter keeps the replicated transcript and maps it on every update. User, assistant and compaction entries become messages; tool results fill in the tool calls they answer; the generation in flight shows as a streaming message; retries and running compactions show as system messages. A failed generation ends in an error card whose action fits the error: credential errors (an invalid or missing key, 401/403, not authorized) open settings, a model the account can't use offers the model picker, and anything else offers Retry. A content-filter stop is different: every later request resends the content that tripped the filter, so Retry, and any new message, would be stopped again. Content-filter stops are Bedrock's `content_filtered` and `guardrail_intervened`, Anthropic's `sensitive` and refusals, and OpenAI's `content_filter`. Their card leads with "The model's content filter stopped this reply." and offers **Drop the last turn** (spectrum ≥ 1.12.0). `AgentControl.rewind(messageId)` finds the user turn before that message and forks the cone's conversation at the entry before it (`Conversation.fork`, so `pi.agent` comes back as it was there). It points the cone at the fork and returns the turn's prompt, which spectrum puts back into the composer. Forking the very first turn creates a fresh conversation with the same model and thinking level. The filtered branch stays in storage, off the active path. The fork starts with a `slicc.rewound` entry that shows as a "Rewound 1 turn" notice, and clicking the card of an earlier filtered turn rewinds that turn.

Each cone's active conversation is in the session document `slicc.agents` (the root until the first rewind). The host's transcript follows it across forks. Rewinding is refused while the cone itself is running or has queued input, because a fork starts with an empty inbox, but never because its scoops are busy (see Cones and scoops). A background compaction still running on the old branch finishes there. A fork also starts with fresh `pi.usage`. Credential and model errors lead with a plain sentence ("Bedrock rejected the API key.", "This model isn't available with the current account.") and keep the provider's raw error as `detail`, which spectrum (≥ 1.11.0) shows underneath. `busy()` and `queue()` read durable's live and inbox documents. Steering is the default (#4): a send or a steer goes out with `whenBusy: 'steer'`, so while a run is going it joins after the current tool round, and a `queue` send is a follow-up. User messages carry `delivered` from the host's deliveries; entries the host didn't record (from before a reload) count as steered when they follow a tool result. Cones and scoops are below; the freezer and questions come later. Licks show as spectrum's lick cards (below). slicc-spectrum is an optional peer dependency (≥ 1.59.0, the lowest whose monitor, tray and panel types match the agent's; `npm run typecheck` fails on anything older), used for types only, so package managers don't install it next to the agent.

Each agent in `list()` has a real `contextFill` and `unread`:
- **`contextFill`** is the context the agent uses, as a share of its model's `contextWindow` from the settings' model list. The tokens are those of the newest assistant's usage after the active head, counted the way pi-ai's `calculateContextTokens` does (`totalTokens`, or input, output and both cache counts). Aborted and failed turns don't count. After a compaction, the kept turns' usage no longer counts. Until the next turn reports its usage, the fill is estimated the way pi does it, at four characters a token, over the summary and the kept entries (without the system prompt and tools). An unknown model also reads 0. The Monitor's "Fullest context" and its context alerts use the same functions (`src/context.ts`).
- **`unread`** counts the assistant messages an agent finished while it wasn't the tab's `active()` agent. Answers already there when the page opened don't count, but an agent that appears later counts from its first answer. It's counted once the turn is done, and `select(id)` resets it to 0. Each change emits `agents`. It lives in the adapter, so each tab keeps its own, and it isn't stored.

Each tool call shows its input in the way that suits it:
- `bash`: its command, with a timeout as the card's `meta`;
- `read`: the path, with its line range as `meta`;
- `write`: the path;
- `edit`: the path, and its change as a `diff` (spectrum ≥ 1.13.0). While the edit runs, the diff comes from its `oldText`/`newText` pairs. Once done, it comes from the hunks of the unified `patch` that pi's edit tool returns in its result details, with context lines;
- other tools: their arguments as pretty-printed JSON.

#### Attachments

A send's `Outgoing.attachments` reach the model. In the page, `send()` reads each attachment's `url` (a `data:` or `blob:` URL) into bytes before anything else, so a `blob:` URL spectrum revokes later has already been read, and passes them on `SendRequest.attachments` as `{ name, mimeType, kind, data?, text?, path? }`, where `data` is base64 because chord carries JSON only. It skips attachments with an `error` and secrets. In the worker, `control.send` turns them into the user message:
- an image (`image/png`, `jpeg`, `gif` or `webp`) becomes a pi-ai `ImageContent` part after a short `<attachment kind="image" …>` text part that names it;
- a text file is inlined as `<attachment kind="text" name="…" type="…">` with its text, and with its `path` when it is an @-mention;
- any other file is written with the conversation's own environment, so the user's own client in users mode, into `uploads/` under the conversation's `cwd` (`/home` by default), and the text says `Saved at <path>.` A free name gets `-1`, `-2` and so on;
- for a model whose `input` lacks `image`, an image is saved the same way and the text adds "This model can't see images, so the image was saved as a file instead." (pi-ai alone would put `(image omitted: model does not support images)` in its place, and the image would be lost to the tools.)
- an attachment with only a `path` is mentioned by its path.

Images are limited to 5 MiB, other files to 8 MiB, and one message's attachments to 10 MiB together, because one pi protocol frame holds 16 MiB and providers refuse bigger images anyway. The page first shrinks an image over the limit (to 1600 px, as image reads do). Anything still too big isn't sent, and a notice says why, for example "photo.png is larger than 5 MiB, so it can't be sent.". Text and inlined files go through the vault's scrubbing like any send; images can't be scrubbed as text. The replicated transcript and views don't carry the full images: the host swaps every image part over 48 KB, in entries and in the inbox, for a JPEG thumbnail of at most 256 px and 48 KB (made once per image in the worker with `OffscreenCanvas`) plus `full: { mimeType, size }`, so a conversation with many images still attaches in one 16 MiB frame. The model still gets the full image from storage. The transcript maps the parts back to spectrum's user message `attachments`, with the thumbnail as `url` and the id `ref:<entry>:<message>:<part>`. When such an attachment is sent again, by Retry or from the composer after a rewind, the adapter fetches the full image with `AgentControl.image({ entry, message, part })`. A remote `prompt()` takes the same `attachments`.

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

**Triage.** A watch or webhook file can add `"triage": "<which events the agent should see>"`, a sentence of 1–1000 characters such as `"pushes to main that touch src/"`. Then each of its events (a debounced batch of changes, or a webhook request) first goes to Clef Flash (`adobe/clef-flash`, see Classifiers) with the channel, source, title, text, body (cut at 4000 characters) and up to 50 paths. One `choice` question asks whether the event matches that sentence: `act` or `ignore`. When the answer is `ignore` with a probability of at least 0.75 (`TRIAGE_SKIP`), the lick isn't delivered and starts no turn. Instead, a passive `slicc.lick-triage` entry goes into the target's transcript. It has no model message, so neither the model nor the chat sees it, and it records the would-be lick with the triage sentence, the decision, Clef's confidence and probabilities, the model and the cost. An event whose delivery id was already seen isn't triaged again. A skipped one is remembered only after its record is written, under a `requestId` taken from the delivery id, so a crash in between neither loses the record nor writes it twice. Triage fails open: without an Adobe sign-in, or when the proxy errors, times out (15 s) or returns any other answer, the lick is delivered as usual. Watch notices (stopped, overflow), config errors, frozen notices, crontab jobs and boot licks are never triaged. A small webhook event is about 220 input tokens, which is $0.00002 against the weekly budget; a 4000-character body is about $0.0001.

**Sources.**
- `fswatch`: the kernel environment's `watch()` reports changed paths; those matching the glob are collected for `debounce` ms and delivered as one lick with `changed` or `gone` per path. A watch that overflows or stops says so in a lick (a stopped one with `severity="error"`, an overflow with `severity="warn"`), and saving its file restarts it. Changes made while no worker runs aren't reported. **The agent's own changes are dropped**, so it never licks itself: the kernel environment records every path its file tools write, edit, move or remove, and the time its `bash` commands run; a change to such a path within 2 s, or any change while an agent command runs or within 2 s after it, counts as the agent's. A change the user makes while an agent command runs is therefore dropped too. Background processes the agent started (`&`) aren't tracked, so their changes do lick.
- `cron`: each line is a background durable task owned by the root conversation (`slicc.cron`), so Stop and rewinds don't affect it and it survives reloads. It sleeps until the next due time on the Harness clock, then delivers to the target the cone pointer names at that moment. Each due time is delivered exactly once, also across a worker restart: the fire's id is `<name>@<due time>`. **Missed fires** (seven was closed or the tab asleep) are delivered once, as one lick whose `count` is 1 plus the missed fires and whose text says how many were missed (counted exactly up to 100,000, then "at least 100,000"); the next fire is then computed from now. Editing a line replaces its task; removing it aborts the task.
- `webhook`: each request is its own lick, with the headers and the body; a delivery `id` makes retries idempotent.
- `upgrade`: when the worker starts with a different slicc-agent version than the session recorded, with the release notes link. Every change of version is its own lick, also back and forth.
- `session-reload`: when the kernel's boot time (`btime` in `/proc/stat`) differs from the last worker start and the cone ran `bash` since then. The page reloaded, so the kernel's processes are gone; the lick lists background commands (`&`, `nohup`, `setsid`, `disown`) that are no longer running. Durable itself resumes an interrupted run.

**Decisions.** A lick channel with a handler (`licks.handle(channel, { confirm, dismiss })`) gets `actions="confirm dismiss"` (or one of them), and its card is pending until decided. The agent decides with the tools `lick_confirm` and `lick_dismiss` (`{ lick_id, reason? }`); the user decides from the card (`AgentPort.resolveLick` → `AgentControl.resolveLick`), which runs the handler and writes a `slicc.lick-state` entry that tells the agent. The state comes from these entries in the transcript, so rewinds and forks keep it consistent. Deciding twice, an unknown id, or an action the channel doesn't have is an error result. No channel in this release has a handler yet; scoop permission requests, upskill links and mount recovery will. The two tools' cards are folded into the lick card.

### Cones and scoops

A **cone** is a top-level agent the user talks to; a **scoop** is a helper agent with its own conversation and its own folder, `/scoops/<handle>/`. The session document `slicc.agents` is the registry. The first cone's id is `cone`, later ones `cone-<n>`, counting up only. A scoop's id is `scoop:<handle>`, where the handle is its name made safe for a folder; a handle that is or was ever taken gets `-2`, `-3` and so on, so ids and folders are never reused. `AgentControl` adds `selectCone`, `createCone`, `createScoop`, `stopAgent`, `drop` (stop a scoop, as `agent stop` does) and `unqueue(agentId, submissionId)`; `send` and `configure` take an `agentId`. Its errors are sentences the UI can show as they are, such as "A cone named harbor already exists." The transcript service adds `agents`, a summary of every cone and scoop, and `views`, one durable view per live agent, which the spectrum adapter shows in the agents rail (the header picker lists cones only). With spectrum ≥ 1.23.0 the rail drops scoops and the picker creates cones; the adapter needs spectrum ≥ 1.28.0, whose Drop confirmation says the working folder is deleted. A scoop created from the rail has a provisional id until the worker answers; the adapter then moves the selection, and sends, to the id the worker gave it. Each connection keeps its own selection: an adapter starts on the agent's current cone, and then keeps the cone it shows when another tab selects another. `selectCone` still sets that current cone, which is where licks, the `agent` CLI and sprinkles go by default. So that one tab never acts on another tab's cone, `compactAgent(agentId, instructions)` and `resolveAgentLick(agentId, lickId, state)` name their agent, and the adapter uses them.

Each scoop is owned by a background durable task, its **anchor**, so Stop in its cone doesn't end it; `agent stop` and Drop do. They keep its transcript in durable storage and its reports in `/scoops/<handle>/reports/`, which report licks point at, and remove its working folder `/scoops/<handle>/workspace`. Each request handed to a scoop gets a **reporter** task that waits for the run, writes the answer to `/scoops/<handle>/reports/<task id>.md` and reports it to whoever asked. Requests from a cone's or a scoop's bash report into that agent's `pi.inbox` as a lick, through the licks outbox, so they steer and coalesce like any lick; requests from a terminal report nowhere, and a user typing in a scoop's chat gets the answer there. In a scoop's chat, a request someone else sent shows who sent it (`UserMessage.from`): the asking cone's or scoop's name, with `origin: 'agent'` so spectrum (≥ 1.26.0) shows it as that agent's request with an "Agent" badge, or `terminal` without an origin. Once the request is placed, the reporter appends a `slicc.from` entry (`{ from, entry }`) without model messages, and the adapter sets `from` on that entry's message. A request withdrawn before it was placed leaves no entry. The report lick's text is `[scoop <name> (<role>) <status>]`, and its body has the report's path and line count and a 1,000-character preview. A scoop's prompt has a `scoop` section with its name, its cone, its folders and its limits. The `agent` command is taught by the built-in `agent` skill (below), whose description says that roles exist and that `agent list --agents` lists them.

**The `agent` command.** One bash script is installed under seven names, `agent`, `subagent`, `memory`, `gelatiere`, `freezer`, `models` and `panel`, in `/usr/local/bin`, mode `0755`, which is on every user's `PATH`, so the user, a cone or a scoop runs it in any bash. A file at one of those paths that isn't slicc-agent's (it lacks the `slicc-agent/1` request marker), such as a root global package's `memory`, is left alone, with one warning per boot in the worker's console. Root's `$PNPM_HOME/bin` (`/usr/local/share/pnpm/bin`) is on root's `PATH` only: other users find root's installed packages in `/usr/bin`, but not loose scripts. Copies that earlier versions put in the kernel's `$PNPM_HOME/bin` are removed, so they can't shadow the new ones for root. It writes a request (NUL-separated fields: `slicc-agent/1`, the name it was called by, `$SLICC_AGENT`, or `tab:$SLICC_TAB` from a terminal that has only that, the working directory, its pid, argc, the arguments and stdin) to `/var/lib/slicc/agent/requests/in/` and polls `out/` for the answer and exit code (with an optional `<id>.err`, the answer's stdout is `<id>.out` and its stderr `<id>.err`); the worker writes `<id>.ack` when it picks a request up, and the script gives up after 20 s without one ("the SLICC agent isn't running", exit 1). The kernel environment exports `SLICC_AGENT`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL` into every agent command, so the worker knows the caller, and `PLAYWRIGHT_CLI_SESSION` with the same agent id, so each agent's `playwright-cli` keeps its own current tab (slicc-cdp #129). The user's terminals get none of these. `/var/lib/slicc/agent/scoops/<handle>/metadata.json` mirrors each scoop's state for scripts.
- `agent [options] --prompt <text>` (or `--file <path>`, or `-` for stdin, or v6's `agent <cwd> <allowed-commands> <prompt>`) is **synchronous**: an ephemeral scoop runs, and the command prints its final answer and exits 0, or prints the reason on stderr and exits 1. Afterwards the scoop is stopped, its folder removed, its conversation marked dropped and its transcript archived as Markdown in `/tmp/agent-sessions/<handle>.md` (`/home/sessions/` with `--persist-session`, nowhere with `--no-persist-session`). The script traps TERM, INT and HUP and cancels the scoop, and the worker checks the script's pid in the kernel's process table every second for a SIGKILL. If the caller's run is still going when the bash call dies (a bash timeout), the scoop continues and its answer arrives as a `bash` lick; `--background-after <seconds>` does the same on purpose. Sync calls nest up to three deep. Allowed commands in v6's form are told to the scoop, not enforced.
- `agent --async …` (= `subagent spawn …`) starts a persistent scoop and prints its handle; only cones start them. `list [--agents]`, `status`, `rename`, `send [--follow-up]`, `wait [--timeout <s>] [--notify]` (30 s by default; `--notify` returns at once and brings the answers together in one `scoop-wait` lick) and `stop` manage them. From a scoop, `agent send parent "<note>"` posts a progress note to its cone as a lick, coalesced per scoop.
- Options: `--name`, `--agent <role>`, `--model <provider/model>`, `--thinking <level>` or `--effort low|medium|high|max`, `--tools <a,b>` (or `auto`/`full`), `--read-only <paths>`, `--system-prompt[-file]`. `--schema-b64`, `--tools output`, `--session`, `--resume`, `--image`, `--no-escalate`, `--minimal` and `--usage` answer "not supported in SLICC yet".

**The `models` command** is the same script as `agent`, installed as `models`, and reads the models and accounts the Settings picker shows (`createAgentSettings`):
- `models` (or `models list`) lists every model of a connected account, `*` marking the caller's current one, with its label and account; `models current` prints the current `provider/model`. Both take `--json`.
- `models use <provider/model> [--thinking <level>]` switches the caller's model the way the Settings picker does (`Conversation.configure`): a cone's or a scoop's own, or, in a terminal, the active cone's. An unknown id exits 1 naming the three closest ids; a model whose account isn't connected exits 1 and says to connect it in Settings.
- `models --help` prints the usage; an unknown verb exits 2 with it.

**Roles** are pi agent files: Markdown with a frontmatter subset (`name`, `description`, `tools`, `model`, `thinking`, `memory`, `inheritProjectContext`, `inheritGlobalContext`, …) and the role's prompt as the body, added to the scoop's instructions. The built-ins are `scout`, `worker`, `reviewer`, `oracle`, `delegate` and `gelatiere` (below). The first source with a name wins: `~/.pi/agent/agents/`, then the built-ins, then packages (see Package resources) that name a folder in `pi-subagents.agents` or `pi.subagents.agents`. A package role that loses its name is skipped with a warning in `agent list`. A project's `.pi/agents/` will count only in trusted folders, and folders can't be trusted yet. `~/.pi/agent/settings.json` can override roles (`subagents.agentOverrides`) and set the limits `subagents.maxLiveScoops` (16 live scoops per cone) and `subagents.maxPerTurn` (64 scoops started per cone turn), which the worker counts for both kinds.

**Isolation, for now.** The file tools of a scoop write only under its folder and `/tmp`, plus the cwd of a v6-form call, and read those, their cone's working folder (`/home` by default) and `--read-only` paths; paths are normalized, `..` included, before the check. bash isn't confined, and the scoop is told so: the guard is a guardrail, not a boundary. A scoop's commands share one process group (see Bash and files on slicc-kernel), and stopping the scoop signals it, together with any group recorded for the scoop on an older kernel.

**Rewind.** Dropping a turn never waits for scoops. Scoops the dropped turn created are stopped and marked gone; requests it handed to older scoops are aborted and their reports withdrawn; scoops it stopped come back idle, with a fresh, empty working folder. The `slicc.rewound` entry lists them, and its notice says "Stopped scoop X. Restored scoop Y."

### Skills and prompt templates

Skills and prompt templates work as in pi's coding-agent. pi's loaders read with Node's `fs` and come with its whole CLI, so they're ported here over the kernel environment, keeping pi's rules and prompt text word for word.

**Skills** follow the [Agent Skills specification](https://agentskills.io/specification):
- **The format.** A skill is a folder with a `SKILL.md`, whose frontmatter has a `name` (lowercase letters, digits and single hyphens, at most 64 characters; the folder name if missing) and a required `description` (at most 1,024 characters). `disable-model-invocation: true` hides a skill from the model. `license`, `compatibility`, `metadata` and `allowed-tools` are accepted, and `allowed-tools` restricts nothing.
- **Where skills are found.** These roots are scanned in this order:
  1. `~/.pi/agent/skills`;
  2. `~/.agents/skills`;
  3. `/usr/share/skills`, the global skills every cone and scoop sees, such as those imported from SLICC 6;
  4. the built-ins, which the worker writes to `/var/lib/slicc/agent/skills` on every start;
  5. packages whose `package.json` lists folders in `pi.skills` (see Package resources).

  On a name collision the first skill found wins: an agent's own skills shadow the global ones, a global skill shadows a built-in, and a built-in shadows a package's. A missing root is skipped.
- **The global folder.** On every start the worker, as root, creates `/usr/share/skills` if it's missing and sets it to 0755, so it's root's and readable by everyone; once kernel users give each cone its own user and the kernel checks file modes, only root (the worker, sudo or the human) writes there, and every cone and scoop reads it. Each skill's `source` is `user`, `global`, `package` or `builtin`.
- **Inside a root.** Folders with `SKILL.md` are found at any depth, and a `SKILL.md` ends its branch. A `.md` file with a description directly in a root counts too. Folders starting with `.` and `node_modules` are skipped. Symbolic links are followed, but each folder is read once by its real path, so a link back up a tree can't loop. Scoops may `read` the folders of the loaded skills, even outside their own folders.
- **Problems.** A problem (a missing description, a bad name, a collision, a line the frontmatter parser can't read) becomes one lick with `severity="warn"` per distinct problem. A skill without a description is skipped; any other problem only warns.
- **Untrusted folders.** A project's `.pi/skills` and `.agents/skills` are read only in trusted folders, which come with PR 21.

The worker watches the roots and reloads on change. A `skills` prompt section, given to cones and scoops, lists every skill's name, description and location in pi's `<available_skills>` block, and the model reads a `SKILL.md` with the `read` tool when a task matches.

**Prompt templates.**
- **Where they come from.** Each is a Markdown file directly in `~/.pi/agent/prompts`, one of the built-ins in `/var/lib/slicc/agent/prompts`, or in a package's `pi.prompts` (a file, a folder or `folder/*.md`), read in that order. Its name is the file name, and the first one with a name wins; a later one is a collision problem.
- **Frontmatter.** `description` (otherwise the first line) and `argument-hint`.
- **Substitutions.** `$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:-default}`, `${@:N}` and `${@:N:L}`, with shell-like quoting of the arguments.

**Package resources.** Skills, prompt templates and roles also come from packages, read as files and never run. Two roots are scanned, in this order:
1. `/node_modules`, the kernel's certified system packages;
2. `/opt/user/node_modules`, "your packages": a pnpm project that root owns (0755, files 0644), which cones can't write. The agent only reads it, so it works for every user. A missing `/opt/user` is fine.

Root's global pnpm (`/usr/local/share/pnpm`) isn't scanned. The first name wins. A package name already found in an earlier root is skipped whole: none of that copy's skills, prompts or roles load. A skill, prompt or role whose name is already taken (by `~/.pi/agent`, the global folder, a built-in or an earlier package) is skipped too. Each skip, of a package that declares pi resources or of a name, is one `warn` problem lick per session, naming the package's path and what it would have shadowed. Roles report theirs in `agent list`. Extension code (PR 20) will load from `/opt/user` under the same rule, which replaces the earlier `/opt/agent-extensions` plan.

**Commands.**
- **How they expand.** `AgentControl.send` expands `/skill:<name> [request]` (the skill's body in a `<skill name location>` block, then the request) and `/<template> [arguments]`, exactly as pi does. Only text sent from a composer is expanded: licks and `agent send` never are.
- **What the composer shows.** The transcript service's `commands` lists templates (`kind: 'prompt'`) and skills (`skill:<name>`, `kind: 'skill'`), and the spectrum adapter returns them from `AgentPort.commands()`.

**Built-ins.**
- **Skills:**
  - `agent`: the `agent` and `subagent` commands;
  - `licks`: schedules, watches and webhooks as files in `~/.slicc`, replacing v6's `automation`;
  - `skill-authoring`: writing skills and templates for SLICC.
- **Templates:** `/parallel-review` and `/review-loop`, from [pi-subagents](https://github.com/nicobailon/pi-subagents) (MIT). Their wording is kept, and they're rewritten to use `agent --async --agent reviewer|worker`, `agent wait --notify`, `agent send` and `agent stop` instead of pi-subagents' `subagent` tool. The parts that need workflow scripts or forked contexts are left out.

**v6 skills.** None of the 29 skills SLICC v6 ships runs here unchanged. They name v6 paths (`/shared`, `/workspace`) or commands this kernel doesn't have. By what they wait for:
- **Rewritten here:** `delegation` (now the `agent` skill), `automation` (now `licks`), `skill-authoring`, `sprinkles`, `welcome` and `transcript-export` (now `freezer show`).
- **Memory:** `memory` is rewritten here (below); its `status`, `log`, `curate` and `dream` and the curation ledger are not ported. `gelatiere` is rewritten here (below), reading v6's www.sliccy.com catalog; `wiki` needs its `wiki` CLI.
- **The tray hub, upskill or the Install/Update panel:** `upgrade` (`upgrade apply`, bios#70), `handoff`, `slicc`, `ssh`, `cherry`.
- **A browser and CDP:** `playwright-cli` is rewritten as the `browser` skill (below); `computer` and `v86` don't apply.
- **v6's JS realm, `.jsh` and `ipk` (slicc-kernel#68):** `jshd`, `mcp`, `workflows`, `package-execution`, `biome`, `ffmpeg`.
- **Commands the kernel doesn't have:** `mount`, `theme`, `dips`, `image-processing` (ImageMagick), `dns` (`dig`), `meminfo`, `x-search` (xAI credentials).

### Codemode

The model can write a short JavaScript program that calls its tools, with the `codemode` tool from pi's [`@earendil-works/pi-codemode`](https://www.npmjs.com/package/@earendil-works/pi-codemode). Only the script's output reaches the model, so a script can run tool calls in a loop or in parallel and filter large results first. Codemode is separate from v6's `.jsh` and the node shim: it has no Node APIs, file system, network or timers, only the agent's tools.

**On by default.** Cones and scoops get `codemode` next to their other tools, which stay declared as before (pi's `codemode.mode: on`). `"defaultTools": ["-codemode"]` in `~/.pi/agent/settings.json` turns it off. The setting is read when the worker starts.

**The tool** follows coding-agent's `codemode` tool:
- **Input.** The input is raw JavaScript, run as the body of an async function. An optional first line, `// @options: {"max_output_tokens": …, "timeout_ms": …}`, sets an output budget and a deadline. The budget defaults to 10,000 tokens, and there's no deadline by default.
- **Tools.** `tools.<name>(args)` calls the agent's own tools through their registrations, so a scoop's file guard applies to nested calls too. Arguments are validated as for a model call. `bash` resolves to `{ output, exit_code }`, also for a non-zero exit; the other tools resolve to their text and reject on an error.
- **Globals.** `text()`, `image()`, `console.*`, `return`, `exit()`, `ALL_TOOLS`, and `store()`/`load()`.
- **The store** lives in the conversation document `slicc.codemode`, which is rewindable and forks as of the fork point, so each branch keeps its own values. Writes are kept only when the script succeeds.
- **The result** starts with `Script completed` or `Script failed` and the wall time. Several text items each start with `==> text N/M <==`, and `console` lines come last in one `<console_output>` block. A failure adds `Script error:` with the error and the tool calls made before it, which aren't undone. Output past the budget keeps its start and end, and the full text goes to `/tmp/slicc-codemode-<call>.txt`.
- **Discovery.** With MCP servers (below), `searchTools(query, { limit?, namespace? })`, `describeTool(name)` and `describeNamespace(name)` find the MCP tools that aren't listed.
- **Not ported.** coding-agent's `models`.

**In the browser.** pi-codemode runs QuickJS (`quickjs-wasi`) in a worker of its own, so a spinning script never blocks the agent worker.
- **The worker.** It starts through `node:worker_threads`, which slicc-bios provides as an `environment` stub (see Patched dependencies).
- **The wasm.** The agent compiles `quickjs.wasm` itself and hands it over: it walks up the `node_modules` folders from its own module, as bios's resolver does, and fetches the first `quickjs-wasi/quickjs.wasm` it finds. On Node, pi-codemode loads it itself.
- **Isolation.** Seven is cross-origin isolated, so pi-codemode's `SharedArrayBuffer` interrupt works.
- **Overrides.** `runAgentWorker` takes `codemodeWasm` and `codemodeWorker` to override both, for bundled hosts.

### MCP servers

MCP servers reachable over Streamable HTTP become native agent tools. The client is pi's [`@earendil-works/pi-mcp`](https://www.npmjs.com/package/@earendil-works/pi-mcp), and the rest is a port of coding-agent's built-in `mcp` extension (`docs/mcp.md`), which needs Node and can't load in the worker. stdio servers wait for slicc-kernel#68, and the `slicc-mcp` CLI is a separate project.

**The file** is `~/.pi/agent/mcp.json` in pi's format, so a pi or Claude Code `mcpServers` block can be pasted in:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://docs.example/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search the product docs",
      "toolExposure": { "search": "direct", "delete_*": "hidden" }
    }
  }
}
```

- **Fields.** `url`, `type` (`http` or `streamable-http`), `headers`, `exposure`, `toolExposure`, `enabled`, `timeout` (seconds, default 60; progress resets it) and `description`.
- **Refused.** `command` (stdio), `type: "sse"`, `auth`, the `oauth` fields that need a loopback or a client secret, `!command` values, and literal secrets: a credential-like header (`Authorization`, `Cookie`, or a name with `token`, `key`, `secret`, `password` or `session`) or a URL with a password or a key in its query. The file is readable by every agent, so it holds only `${NAME}` placeholders.
- **Problems.** Each refused or broken entry is skipped and becomes one `warn` lick naming the server and the field; the other servers still connect.
- **Reconcile.** The worker watches the file. An unchanged server keeps its session, a changed one reconnects, and a removed one is closed and loses its tools. A server added later posts a "connected" lick naming its URL.

**Per agent.** Today every cone reads the one file in `/home` and gets every enabled server. A scoop doesn't read a file of its own: it inherits its cone's servers, and a role's `tools:` or `agent --tools` list narrows them. A list with no `mcp__` entry gets no MCP servers. A list with `mcp__docs__search` or `mcp__docs__*` keeps only those, and `codemode` is added so codemode tools stay reachable. The resource tools must be listed by name, and they reach only the servers the list names. A nested scoop without a list inherits its calling scoop's list. A `beforeTool` hook blocks the model's calls outside the list, and codemode scripts only get the tools on it. When kernel users give each cone its own home, each cone reads `~/.pi/agent/mcp.json` in that home, and scoops keep inheriting from their cone.

**Secrets.** `${NAME}` placeholders resolve to the vault's placeholders for that server (`records()`: an `mcp` record with `server` equal to the `mcp.json` key and that name, else the server's only record when the headers use one name, else an unbound record of that name, which covers mcpcat's `${MCP_<NAME>_TOKEN}` bridge tokens). The headers go out holding placeholders, and the vault fills them in its `mcp` op, only for that server's registered URL. A server whose record is missing comes up as needing one, with a lick, and reconnects when the record appears. The worker never holds a value; server log lines are scrubbed through the vault before they reach `~/.pi/agent/mcp.log`. **OAuth.** A server without an `Authorization` header that answers 401 needs a sign-in, as in pi. Its row in Settings › MCP servers offers Connect, which opens a pop-up on the authorization server, found through the server's protected-resource metadata (RFC 9728) or `oauth.authServerMetadataUrl`. SLICC registers itself dynamically as a public client named `SLICC` (`oauth.clientName` changes it), or uses `oauth.clientId`, with PKCE S256 and the redirect URI `https://<origin>/oauth/mcp-callback`. slicc-bios serves that path from `dist/oauth/mcp-callback.html` in this package. The callback page hands the code back over the `slicc-mcp-oauth` BroadcastChannel and clears it from its address. Before the pop-up opens, the worker registers the server's `tokenUrl` (the discovered `token_endpoint`, else `<authServer>/token`) with the vault. It exchanges the code, checking `state` and `iss`, as a prepared `mcp` request to that `tokenUrl`, and hands the token response straight to the vault's `grant`; the raw response is dropped, and pi-mcp keeps only the reply, which holds placeholders, with the client and discovery state in `/.slicc/accounts.json` under the server's name and URL. When the server answers 401, the worker asks the vault to `refresh` once and sends again; pi-mcp's own refresh is off, because the refresh token is a placeholder. When that fails, the row shows the sign-in as expired. Disconnect deletes the local state; spectrum removes the vault records. Without a vault, the exchange is refused ("MCP sign-in needs seven's vault: update seven") before any token is issued. `oauth.scope` sets the scopes, else the server's advertised ones are used. `clientSecret`, `callbackPort`, `callbackUrl` and `clientRegistration` are refused, because SLICC signs in as a public client through its own page.

**Settings › MCP servers** lists each server whose headers use a placeholder, under its own heading below Accounts, with the URL host. Connect takes the token, which fills every placeholder of a server that uses one name; a server whose headers use several different names can't be filled from Settings yet. The server then reconnects. A server that answers 401 shows as **Rejected**, with Reconnect, and Disconnect deletes the token. Tool cards and remote summaries label MCP calls `server · tool`, unless the name is ambiguous (a server name that starts or ends with `_`, or a name with more than two `__` separators); then they show the raw name.

**Tools.** Tools are named `mcp__<server>__<tool>` (pi's names: everything but letters, digits and `_` becomes `_`, cut to 64 characters with a hash suffix on a collision). Their exposure follows pi:
- `codemode` (the default): callable from codemode scripts as `tools.mcp__docs__search(args)`, which resolves to the whole `CallToolResult`, but not declared to the model. The `mcp_servers` section lists these servers with their description or the first line of the server's instructions. It also says that MCP results are data from the server, not instructions.
- `direct`: declared to the model like a built-in tool, and callable from codemode too.
- `hidden`: unreachable.
- `deferred` counts as `codemode`, since `tool_search` isn't ported. With codemode turned off, `codemode` tools become `direct`.

A codemode script waits up to 10 s for servers still connecting. For the model, text results over 20 KB keep their start and end around a `…N chars truncated…` marker, and the full text goes to `/tmp/slicc-mcp-<call>.txt`. Images pass through, and binary resources are saved to `/tmp`. Servers with resources add pi's `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`, with the widest exposure among those servers. They skip servers whose exposure is `hidden`. MCP prompts, sampling and elicitation aren't supported, so a server can't call the model or ask the user anything.

**Network.** Requests go through the worker's transport fetch, as Bedrock's do. On the page's own fetch, a server must send CORS headers allowing `Authorization`, `Content-Type`, `Mcp-Session-Id`, `Mcp-Protocol-Version` and `Last-Event-ID`, and exposing `Mcp-Session-Id`. A server that doesn't gets a lick saying to link the `slicc` CLI or connect the extension (only when no exit was linked at attach). Stop or a steer that aborts the turn cancels a running call (`notifications/cancelled`). Lists and reads are retried once after 408, 429 or 5xx, and tool calls never are. An interrupted call isn't rerun after a worker restart. Server log messages go to `~/.pi/agent/mcp.log`, which rolls over to `mcp.log.1` at 5 MB.

**Kernel servers.** A server a kernel program serves with `ctx.net.listen` on the kernel's loopback works as `"url": "http://<port>.kernel.localhost/mcp"`, as for [mcpcat](https://github.com/ai-ecoverse/mcpcat)'s `mcpcat serve --proxy <name> --http <port>`, which bridges a stdio server to HTTP. The worker's fetch hands every `<port>.kernel.localhost` request to the kernel client's `loopbackFetch` on that port, whatever the transport, so it needs no CORS headers, no service worker and no open `/os/` tab, SSE streams have no idle limit, and the request carries no `Origin`. The URL's own port is ignored, as slicc-bios ignores it. The route shares the browser guard's rule (`ownKernelServer`): any other `*.kernel.localhost` name, the CDP facade's `9222.kernel.localhost` included, fails before anything is sent, so no URL in a config can drive SLICC's own pages. `test/integration/mcp-loopback.test.mjs` runs a JS kernel program as the server and calls its tool on the page and relay routes, with a JSON-RPC answer streamed as SSE, and checks that an entry on 9222 is refused.

**Limiting a server** until approvals (PR 25): `"enabled": false`; `"exposure": "hidden"` with a `toolExposure` allow list; `toolExposure` deny patterns; role and `--tools` lists for scoops; and tokens or scopes that allow only what the server should do.

### Memory

pi has no memory store or memory tool; its coding agent loads context files, and [pi-subagents](https://github.com/nicobailon/pi-subagents) gives a role a `MEMORY.md`. Both are ported here over `ExecutionEnv`.

**Context files.** As in pi, `~/.pi/agent/AGENTS.md` and then one file per folder from `/` down to the working directory (the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`) form the `project_context` section, read before every request. Only files inside `/home` (and a scoop's `/scoops` folder) load, after following links: files in mounted folders or other roots are user content from outside SLICC and wait for folder trust, so the section lists them as not loaded and why. A scoop with a role gets project files unless the role says `inheritProjectContext: false`, and the global file only with `inheritGlobalContext: true`, as in pi-subagents.

**Memory files.** One `MEMORY.md` per scope, plain markdown: `## <section>`, `### <title>`, an optional `tag: user|feedback|project` line, then the body. Text outside a `###` is kept and shown as an entry named after its section.
- `global`, shared: `~/.pi/agent/memory/MEMORY.md`;
- a cone: `~/.pi/agent/memory/<cone id>/MEMORY.md`;
- a role with `memory: { scope: user, path: <path> }`: `~/.pi/agent/agent-memory/<path>/MEMORY.md`, pi-subagents' layout, so role files move between the two; with `scope: project`, `<root>/.pi/agent-memory/<path>/MEMORY.md` under the nearest folder with `.pi` or `.git`, inside `/home`.

The `memory` section, read before every request, holds the first 200 lines (at most 16 KB) of each file the agent sees, as reference data rather than instructions: a cone sees global and its own, a scoop global read-only and its role's. Changes show from the next request on.

**`memory_write`** saves, replaces (same section and title) or removes one entry in the caller's own file, or in `global` for cones. Writes to a file are serialized and re-read the file, so edits by hand survive. A file holds 16 KB; a write over that must make it smaller. Anything that looks like a secret (API keys, tokens, `Authorization` values, private keys, `password=`, launch URLs with a `#key`) is redacted before it's written. A role with `memory` and write tools gets `memory_write` in its tool list.

**Extraction.** Durable compacts a long conversation into a summary; before it does, a `beforeCompact` hook (which never declines or replaces the summary) schedules a `slicc.memory-extract` task for the cone. A cone that has been idle for `memory.idleMinutes` (30 by default, `0` turns the idle trigger off) gets the same task. The task runs only when there is something new since the last extraction (a cursor per conversation in the session document `slicc.memory-extract`), makes one model call, with the cone's model unless `memory.extractModel` names a cheaper one (`provider/model`), and writes the proposed entries through `memory_write`'s writer into the cone's memory file, within its 16 KB. The transcript it sends is redacted first, its prompt forbids secrets, and the writer redacts again. `"memory": { "extract": false }` in `~/.pi/agent/settings.json` turns extraction off. v6's curator scoop, three-way merge, curation ledger and dreamer aren't ported.

**The gelatiere.** SLICC's resident advisor, as in v6, is a scoop with the built-in `gelatiere` role. That role has its own memory (`memory: { scope: user, path: gelatiere }`), so it keeps its notes there.
- `gelatiere init` starts the scoop in the first cone, writes `~/.pi/agent/GELATIERE.md` (its procedure, which the user can edit) unless it exists, and puts one crontab line `0 3 * * * gelatiere scoop:<handle> …` in `~/.slicc/crontab`, replacing an older one.
- **Procedure updates:** at every boot, an existing GELATIERE.md that is a shipped version (its sha-256 is in `SHIPPED`, or matches `GELATIERE.md.sha256`, written whenever the agent writes the file) is replaced by the built-in one. A file with the user's edits is kept, the new built-in one goes to `~/.pi/agent/GELATIERE.new.md`, and `gelatiere status` says so.
- On each pass it reads memory, the installed skills, the roles and the lick files, and writes at most three suggestions as JSON. `gelatiere suggest <file>` validates them and folds them into `/home/.gelatiere/suggestions.json` by id:
  - kinds `skill`, `use-case`, `tip`, `skill-idea` and `issue`;
  - a `skill` with its name and its GitHub `repo` (`owner/repo`);
  - https URLs only;
  - secrets redacted;
  - at most 50 open;
  - dismissed and taken ids are never reopened.
- `gelatiere deliver` sends each cone named in a suggestion's `cones` (or the first cone) one `sprinkle` lick with the action `gelatiere-suggestions`. The built-in `gelatiere` skill answers it with `panel open sprinkle:suggestions`, and looks ids up in the store before installing or trying anything.
- `gelatiere install <id>` is what a card's Install leads to. It installs [upskill](https://github.com/ai-ecoverse/gh-upskill) if it's missing (`command -v upskill || curl -fsSL …/install.sh | bash`, into `$PNPM_HOME`), runs `upskill <repo> [--path <folder>] (--skill <name> | --all) --dest-path ~/.pi/agent/skills`, checks that the skill (or, with `all`, at least one new skill) is there for the skills loader, and marks the suggestion taken. It refuses a single skill that's already installed. A `skill` suggestion may carry `path` (a folder in the repo) and `all: true` instead of `skill`. In seven, upskill reaches GitHub through the page's fetch, which `raw.githubusercontent.com` and `api.github.com` allow with CORS; `GITHUB_TOKEN` raises GitHub's rate limit. Before anyone clicks, the card shows where the skill comes from: "Installs github from github.com/example/skills".
- `gelatiere run`, `list [--all] [--json]`, `dismiss <id>` and `status` complete the command.
- `gelatiere catalog [--refresh] [--all] [--json]` reads v6's catalog: `https://www.sliccy.com/skills/catalog.json`, the company's `<slug>.json` and the optional `use-cases.json`. Each is the Edge Delivery sheet shape `{ data: [rows] }` with string fields.
  - Skill rows have `name`, `displayName`, `description`, `repo`, `path`, `skill`, `installAll`, the affinity lists `apps`, `tasks`, `role` and `purpose`, and `boost`. Use-case rows have `name`, `displayName`, `description`, `prompt`, `skills`, the same affinity lists and `boost`.
  - It ranks rows as v6 does (apps ×3, tasks ×2, role +1, purpose +1, all times `boost`; rows that score 0 are dropped unless `--all`) against the welcome profile, which the welcome card's `onboarding-complete` writes to `/home/.welcome.json`. Without a profile the ranking is `boost` alone.
  - The company slug is v6's `slugifyCompany` of the profile's `company`; company rows replace global ones of the same `name`.
  - Skills the agent has loaded (from any skills root) or that sit in `~/.pi/agent/skills`, and dismissed or taken ids (`catalog-<name>`, `catalog-use-<name>`) are left out. `--json` prints candidates the gelatiere can pass to `gelatiere suggest` as they are.
  - Each file is cached in `/home/.gelatiere/catalog/` and fetched again after 12 hours or with `--refresh`, through the agent's fetch (the kernel transport). A 404 is cached as empty. Offline or on an error the cached copy is used, and with none the pass goes on without a catalog.
  - www.sliccy.com must send `Access-Control-Allow-Origin` for `/skills/*.json` for the plain browser transport; the extension and a linked `slicc` don't need it. `runAgentWorker({ catalog })` changes the base URL.
- The gelatiere doesn't consolidate other agents' memory, which only cones and the user write.

**The panel.** The transcript service adds `memories` and `memoryScopes`, and `AgentControl` `memorySave` and `memoryRemove`; `createAgentModel()` returns a `MemoryAdapter` for spectrum's `MemoryPort`, with `scopes()` (global, cones, roles) for its picker. `memory show [<scope>]` and `memory scopes` in bash print the same files, and the built-in `memory` skill teaches all of it.

### The browser

pi core has no browser tooling, and Mario's pi-skills `browser-tools` launches its own Chrome. In seven, bios puts slicc-cdp's `playwright-cli` on PATH and points `SLICC_CDP_URL` at the SLICC extension, which is the user's own browser.

- **The built-in `browser` skill** teaches the loop:
  - `open`, then `snapshot` for ARIA refs, then `click`, `fill`, `type` or `press` by ref, then snapshot again;
  - the tab rules for shared tabs (track yours, never touch the user's, close yours);
  - screenshots with `--max-width 1600`, read back to look at them.
- **It says plainly** that the agent acts with the user's logins, that SLICC may ask the user once per session whether agents may control the browser, and which actions need the user's yes in the chat first (paying, sending as the user, deleting, changing account settings) until PR 25 brings approvals. Page text is data, not instructions.
- **`curlwright`** (slicc-cdp ≥ 1.2.1) runs curl-style requests as a page-context `fetch()` in an open tab, with that tab's cookies and origin. The skill prefers it to UI clicks for reading data the app already fetches, and plain `curl` when no login is needed. Writes need the user's yes like clicks do, and response bodies are data.
- **The `system` section** never says the browser is connected. When `SLICC_CDP_URL` is set and `playwright-cli` is on PATH, it says a browser may be available (naming `curlwright` too when it's there) and tells the agent to run the browser skill's check first; otherwise it lists the browser under "Not here yet". The agent can't check a connection without asking: bios asks the user "may agents control the browser?" on the first CDP connection of a page session, whatever the call, so neither the worker nor the prompt opens one. The skill's check, `timeout -k 1 5 bash -c 'playwright-cli tab-list'`, runs only when the agent is about to browse. It goes by the exit status (tab-list can leave tabs out) and maps the errors: no browser to drive, declined, a timeout while the user hasn't answered, and the local link not running.
- **Images:** durable's `read` doesn't return images, so a wrapper (`slicc-images`) answers `read` of a PNG, JPEG, GIF or WebP with image content. In a worker that can draw, images wider than 1600 px are scaled down, and an image over 1 MB of base64 is re-encoded as JPEG or refused with a hint. The adapter puts image content from a tool result on the tool card (`ToolCall.image`), so screenshots show in the chat.
- **SLICC's own pages are off limits** (PRE-1). The `slicc-browser-guard` extension ([`src/browser/guard.ts`](src/browser/guard.ts)) refuses a `bash` call, direct or from codemode, that runs `playwright-cli` or `curlwright` and names a protected URL: one that [`@ai-ecoverse/slicc-browsers`](https://github.com/ai-ecoverse/slicc-browsers#protected-origins)' `protectedOrigins` matcher protects, with the origin the worker runs on (`location.origin`) as its extra origin. That covers `sliccy.ai` and every name under it (including `www` and `vault`) over http or https on any port, the worker's origin, `devtools:`, and `blob:`, `filesystem:` and `view-source:` by their inner URL. It also refuses `*.kernel.localhost` names other than the agent's own kernel servers, `<port>.kernel.localhost` for a port 1–65535 other than the CDP facade's 9222. The answer is "SLICC's own pages can't be opened or driven from the browser tools.", and the `browser` skill says so too.
  - **How it reads a command:** a shell tokenizer ([`src/browser/shell.ts`](src/browser/shell.ts)) removes quotes and escapes (`'…'`, `"…"`, `$'…'`, `$"…"`, `\`), and reads into `$(…)`, backticks, `<(…)` and words that are themselves scripts, such as `bash -c` and `eval` arguments, four levels deep. If any word is `playwright-cli` or `curlwright` (by its last path segment), every word is checked: as a URL, as `https://` plus the word, after a `NAME=` or `--flag=` prefix, and for URLs and `//host` inside it. Tabs and newlines are removed and surrounding spaces trimmed, as the URL parser does; the matcher parses with the WHATWG `URL`, so case, IDNA, full-width characters, percent escapes, backslashes and userinfo all count. `about:blank`, `about:srcdoc` and the empty URL are allowed: a tab `playwright-cli` opens has no SLICC opener, and a command that also names a protected URL is refused anyway.
  - **The list** is slicc-browsers' `catalog.json` `protectedOrigins` with its reference matcher `protected.mjs`, wrapped by [`src/browser/origins.ts`](src/browser/origins.ts) (`protectedMatcher(extra)`); the unit tests run every URL and target vector in its `protected.json`. `*.kernel.localhost` isn't on the shared list; that rule is this guard's own. The build keeps the `with { type: 'json' }` import attribute, so the catalog loads unbundled.
  - **What it can't catch:** it's defence in depth, and the browser tools themselves (slicc-cdp, the kernel's CDP facade and slicc-cli's `cdp` link) enforce the rule. It doesn't see a URL built at run time (from a variable set elsewhere, `printf`, brace expansion or a file), a browser command whose name is built at run time, a script or program file that drives the browser, a tab id (`--tab`, `tab-select`) that points at a SLICC tab, or a page that navigates there by itself. It may refuse a command that only names a SLICC URL alongside a browser command, such as `curl https://seven.sliccy.ai && playwright-cli open https://example.com`.
- There are no browser licks yet.

### The freezer

pi durable keeps every conversation and entry in the session database, and has no archive flag and no delete (#75). The `slicc.agents` registry is the index of which conversations exist and what they are, so the Freezer lists from it, as Lars put it: the list of sessions in the database.

- **The list** (`frozen` on the transcript service): every cone, frozen cone, scoop and `agent` run the registry knows.
  - Each row has its id, name (names needn't be unique), title, model, message count and last activity.
  - **Titles.** A conversation's title starts as its first user line. pi durable has no conversation name (pi-coding-agent's `setSessionName` writes a `session_info` entry in its own JSONL sessions, which slicc doesn't run), so a live cone or scoop keeps its title in its `slicc.agents` record as `title` and `titled`. That works like pi's `prompt-url-widget` extension: the name stays provisional until it's final.
    - After the first finished turn (the last entry is an assistant message that stopped normally), and once more after the third, one background call writes a title of at most six words, in the user's language.
    - A trivial first message waits for the third turn and keeps its first line until then. Trivial means fewer than four words once punctuation, symbols and emoji are stripped ("hi", "hey 👋", "你好"), unless it is a single unspaced run of eight or more characters, which is how Chinese, Japanese or Thai write a sentence. There's no greeting list, so the rule works the same in every language.
    - A scoop or `agent` run that stops before it was titled is titled once from its finished transcript. One that can't be titled is settled without a call, and a stopped row keeps its title.
    - A title still on its way when a scoop is reset or rewound is dropped. Rewinding a scoop clears its title, as a cone's new conversation does.
    - The call uses `memory.extractModel`, else the conversation's model. Clef classifiers only answer choices, so they can't write a title.
    - The transcript sent is the model-visible text, cut at 4000 characters. Vault values are scrubbed and secret-shaped text is redacted first.
    - A failed or empty answer keeps the first line and isn't retried. So a live cone or scoop costs at most two calls, and a cone one more at freeze.
    - `"titles": false` in `~/.pi/agent/settings.json` turns every model title off.
    - The title moves with the cone. Freeze and New conversation copy it into the frozen row, then the final call replaces it there. Thaw brings it back as final, also from a stopped scoop. A new conversation, or a scoop's reset, starts untitled.
    - The Agents panel shows it as each cone's and scoop's summary (spectrum's `title`).
    - The call goes through the same `Models` (and so `scope.fetch` and the vault) as every chat request.
  - **Tool labels.** Spectrum groups tool runs into clusters and asks `AgentPort.toolLabel(agentId, callIds)` once a cluster forms (three runs), and again with the longer id list each time it grows, even while it still runs. The agent answers with an imperative label of three to eight words, or `null`, and spectrum keeps its own summary either way.
    - The label comes from the cluster's tool inputs and outputs (each output cut at 600 characters), through the title model and the title scrubber. A vault that is locked or not ready gives `null`, so no unscrubbed text goes out.
    - A growing cluster costs about two calls. The first call happens when it forms, with any run still going shown as running. The second happens when it settles: every run has a result and the turn has moved on (assistant text, the end of the turn, or a new user message). A pull for a longer list while a run is still going doesn't call. It waits, up to ten minutes, for the cluster to settle and is then relabelled, unless an even longer pull takes over; then it gets the prefix's label. A cluster that settled and grows later gets one relabel. A pull for a list that a longer cached or pending one extends gets the prefix's label.
    - Each id list costs at most one call, however many tabs ask, including calls still in flight. Labels live in the session's `slicc.labels` doc (the newest 500) and reach every tab through the transcript service's `labels`. A reload, freeze or thaw reads them without calling again, and a watch-only tab only waits for one.
    - Only clusters with a call made after the agent started are labelled; older ones get `null` unless already labelled. Each agent makes at most six label calls a minute, and two of them are kept for settled relabels, which wait for room instead of being dropped.
    - The spend goes into the conversation's `pi.usage`, so the Monitor counts it like any other model call.
    - `"toolLabels": false` in `~/.pi/agent/settings.json` turns labels off, apart from `"titles"`.
  - It also has `kind` (`cone`, `scoop` or `agent`), `live` and `thawedAs`.
  - Live rows come first, then the newest. A stopped conversation's numbers are read once and cached.
- **New conversation** (spectrum's `clear` and `/clear`, Lars's W9) gives the same cone, with its id and name, a fresh conversation with the same configuration, when the chat isn't empty. The old conversation becomes a frozen row. On a scoop, `clear` is a plain reset.
- **Delete cone** (the Freezer's freeze):
  - its run and its scoops' runs stop;
  - it moves from `cones` to `frozen` with its live scoops marked frozen, keeping their transcripts and workspaces;
  - if it was active, another cone is selected, and if it was the last one, a fresh cone takes its name.
  - 14b's memory extraction runs first, and one background call (with `memory.extractModel` or the cone's model) gives it a short title.
- **Thaw:**
  - **A frozen cone** comes back under its old id when that's free (otherwise a new `cone-<n>`), keeping its name, with its scoops unfrozen.
  - **A live row** just opens: it's selected.
  - **A stopped scoop or `agent` run comes back as a cone, as a fork:** a conversation's task ownership can't change, so `Conversation.fork` at its last entry gives an ownerless conversation with the cone's tools and instructions, cwd `/home`, and the scoop's model and thinking level. It becomes `cone-<n>` with the scoop's name, and the scoop's row records `thawedAs`.
  - The thawed cone's first entry is a `slicc.thawed` line the model sees and spectrum shows as a notice: whose conversation it was, and whether its workspace is still there or was deleted when it stopped.
- **Remove** (the Freezer's delete, `discard`):
  - on a frozen cone, it removes the record, marks its scoops gone and deletes their folders;
  - on a stopped scoop or `agent` run, it sets `removed` (a tombstone in the registry, so the row never returns) and deletes its folder.
  - The history stays in the session database. Live rows can't be removed.
- **While frozen:**
  - a frozen cone's scoops aren't listed by `agent list`, and `agent send|wait|stop` on one says it is frozen with its cone;
  - cron fires, watches and webhooks aimed at it are skipped, and the active cone gets one `warn` lick per source naming what was skipped;
  - sprinkles it owned send to the active cone;
  - it can't be rewound.
- **The `freezer` command** is the same script as `agent`:
  - `freezer list` shows every conversation with its kind, and `(live)` on live ones;
  - `freezer show <id>` shows a conversation as Markdown, which replaces v6's `transcript-export`;
  - `freezer thaw <id>` thaws it.
  - The gelatiere's pass reads frozen chats with it.
- **The panel:** `AgentControl` has `freeze` (Delete cone), `newChat` (New conversation), `thaw` and `discard` (Remove).

### Changes

pi has no git integration and no changes list; pi coding-agent leaves that to the user's git. So the Changes surface is git, run in the kernel, and works only when git is installed and only in git repos.

- **What's listed:** each repo's unstaged work, the working tree against the index (`git --no-optional-locks status --porcelain=v1 -z --untracked-files=all`).
  - Untracked files show as added, and a rename shows as a deleted plus an added file.
  - `before` is the index version (`git show :<path>`) and `after` is the working file. Binary files and files over 1 MB get null for both, which spectrum shows as "no diff".
  - At most 200 files per repo are listed. There's no store of our own, and `agentId` is null, because git doesn't know which agent wrote a file.
- **The spectrum adapter's `commands()`** returns `curl -fsSL https://get.sliccy.ai/slicc | sh`, which spectrum ≥ 1.67.0 shows as a Copy block under either empty state, after the text's own commands.
- **Without git,** `unavailable()` says git isn't installed and how to get it (`pnpm add -g @ai-ecoverse/wasm-git`). **With git but no repo,** it says to `git init` a folder under /home, and that cloning from the internet needs slicc or the SLICC extension linked; cloning over HTTPS through the page alone fails. Seven doesn't preinstall git; the user or the agent installs it with that command.
- **The `system` section** has a Git line. With `git` on PATH, it says local repositories work and that clone, fetch and push need slicc linked or the extension connected. Without it, it gives the agent `pnpm add -g @ai-ecoverse/wasm-git` to install it when needed. Seven doesn't preinstall git (Lars, 2026-10-09). The install line also names the other tested packages that aren't preinstalled: `@ai-ecoverse/wasi-esbuild` (esbuild), `@ai-ecoverse/wasi-typescript` (tsc), `@ai-ecoverse/wasi-biome` (biome), for PDFs `@ai-ecoverse/wasm-poppler` (pdftotext and friends) and `@ai-ecoverse/wasm-qpdf` (qpdf), and for Python `@ai-ecoverse/wasix-python` (python3, pip) with `@ai-ecoverse/wasix-uv-shim@0.1.0-1` (a uv-compatible shim, pinned while the package is new; only `uv run` uses the venv until kernel#168).
- **Which repos:**
  - the repo of each live agent's cwd (`git rev-parse --show-toplevel`), with the active cone's first;
  - plus a scan of /home and each /mnt/<name>, three levels deep and at most 200 directories per level, skipping node_modules and dot-directories.
  - Repos under /tmp and /var/lib/slicc are left out.
- **When it scans:** lazily, when the surface first asks, then on file events in /home, /mnt and /scoops and when the agents change, debounced by 500 ms, with at most one scan running and one trailing scan queued, so an `unzip` or `pnpm install` costs two scans. Events inside a known repo's .git count only for its index, HEAD and refs. A new .git, or an overflow, rescans for repos.
- **Accept** stages the file (`git add -A -- <path>`), so it leaves the list; committing stays the user's job.
- **Revert** discards the unstaged change: `git restore -- <path>`, or deleting an untracked file. Spectrum asks first with its negative confirm, because this can't be undone.
- **Rewind** leaves files alone. When the dropped turn had a write, edit, bash or codemode call, its notice adds "Changed files stay; use Changes or git to revert them."
- **The port:** the transcript service adds `changes` (`{ unavailable, changes }`), and `AgentControl` adds `changesOpen`, `changeAccept` and `changeRevert`. `createAgentModel()` returns `changes`, spectrum's `ChangesPort`, with `repo` on each change.

### The live monitor

Spectrum's Monitor panel (`MonitorPort`, opened from the Budget chip) shows the agent's task graph, its usage and the kernel's process table. Most of it comes from pi durable as is:
- **Tasks:** `harness.watchTaskGraph()` gives every live task with its kind, owner, conversation, state and abort mark.
- **Usage:** `harness.usage()` gives the session's tokens and cost. The cost is pi-ai's, recorded with each response.
- **Failures, retries and usage changes:** one `subscribeCommits` listener catches them, the way `watchEvents` derives `task_failed`.
- **Agent state:** each agent's `pi.live`, `pi.inbox` and `pi.agent` come from the views the host already mounts. `inspect()` runs only on a resync.

The process table is the worker's root client's `ps()`. Each process is named after the agent whose process group it's in.

**Cost.** Nothing runs while no panel is open.
- **Opening and closing:** `AgentControl.monitorOpen(lease, resync)` opens a lease of 30 s. The adapter renews it every 10 s while spectrum listens, and `monitorClose` ends it. A tab that dies lets its lease expire.
- **While any lease is live:**
  - the task graph watch and the commit listener run;
  - `ps()` is polled every 2 s;
  - usage is re-read at most every 2 s after a commit touched `pi.usage`;
  - the feed is rebuilt at most once a second, and only a changed feed goes out.
- **When the last lease ends,** all of that stops, and the feed keeps its last value with `open: false`.

**The feed.** The transcript service adds `monitor`, a `MonitorFeed` with these parts:
- `usage`;
- `agents`, each with running, queued, tool, retry, last error, model, context tokens and, on kernels that report CPU times, the CPU share of its processes;
- `tasks`;
- `processes`, with each one's CPU times and share of a core on kernels that report them (see CPU);
- `problems`, the newest 50 failed tasks, retries and failed turns since the panel opened;
- `paused`.

**What the feed never holds:** environment variables, tool arguments, task inputs and credentials.
- **Command lines** lose the `export …;` prefix the kernel environment adds to agent commands, are joined, run through the memory redaction (which also catches `NAME=value` for secret-like names, and `--token x`), and cut to 160 characters. Error texts get the same treatment.
- **View-only connections** get their own state from the worker, in which each command is only its program name, so the arguments never cross the link.
- **Users mode:** the human's panel is root's, so it sees every process. A cone's bound client would see only its own, by the kernel's hidepid.

**The port.** `createAgentModel()` returns a `MonitorAdapter`. Its first `snapshot` listener opens the lease (with a resync), and its last one closes it.
- **Vitals:** the Adobe budget, spend (or tokens when every model is free) with its hourly rate, active agents, running tools and tasks, processes, process memory, CPU and the fullest context.
- **Alerts:**

  | Alert | Warn | Error |
  |---|---|---|
  | Budget | 80% | 95% |
  | Retries | from the third attempt, or after 2 min | from the sixth |
  | Failed tasks and failed last turns | | always |
  | A Stop still waiting | after 30 s | |
  | Processes in one agent's group | over 32 | over 64 |
  | Processes in the kernel | over 128 | over 256 |
  | A zombie | after 60 s | |
  | A background process of an agent, on kernels without CPU times | after 30 min | after an hour |
  | An agent's process group at 90% of a core or more, on kernels with CPU times | for 2 min | for 4 min, or at 180% |
  | Context | 80% | |
  | A paused scheduler | always | |

  An alert that suggests a command, such as a runaway's `kill -- -412`, a background process's `kill 52` or a zombie's parent, keeps its `detail` a full sentence and puts the plain command in `command`, with the lead-in for it, such as "To stop it, run", in `commandLabel`. Spectrum shows the label and the command as a code chip after the detail; an older spectrum shows only the detail. A process row takes the severity of its alerts, so it's red only when its alert is at error.

- **Sections:** cones and scoops, tasks as a tree per cone, processes, recent problems, pending changes and sprinkles. Each row has an `id`, and agents and tasks have a `depth` (at most 6), which spectrum (≥ 1.57.0) draws as indentation.
- **More sections:** `createAgentModel(connection, { monitor: { extra } })` adds the page's own sections, such as terminals, browser tabs and tray followers.

**CPU.** From slicc-kernel 1.67.1, `ps()` entries carry `utime` and `stime`, each process's CPU time in milliseconds. The feed passes them on, and each process's `cpu` is its share of one core between the last two polls: `null` on the first poll, or when a pid is restarted or reused. An agent's `cpu` sums its processes. The adapter remembers since when each agent's process group has been at 90% of a core or more, and raises `runaway-cpu-<pgid>`, "research is using a lot of CPU", once that has lasted 2 min. Process rows and agent rows end their meta with the share, rounded like top (`97% CPU`, `140% CPU`, with a non-breaking space), unless it's unknown or under 1%. The CPU vital is the agents' summed share (`97%`, "of one core"), with the last 30 feeds as its series and no meter, since a share of one core has no ceiling. With CPU times, an idle long-running process raises no alert. On older kernels, none of these fields appear, and the age alert stays.

**Memory.** From slicc-kernel 1.61.0, `ps()` entries carry `rss`, each process's wasm memory. When they do, the monitor shows a Process memory vital and each process row's size. On older kernels, both are left out. `/proc/meminfo`'s `MemTotal` is a placeholder. The tray chip gets no `spent` or `rate`, so spectrum (≥ 1.57.0) shows only what's known.

### Sprinkles

A sprinkle is a small HTML panel next to the chat. pi has nothing for this; it's SLICC's UI, rendered by slicc-spectrum (≥ 1.23) through its `SprinklePort`.

**Files.** Every `.shtml` file in `/home/sprinkles`, as `<name>.shtml` or `<name>/<name>.shtml`, is a sprinkle. `<name>` is 1–64 of `a-z 0-9 . _ -`, and `welcome` is reserved for the built-in one. Its `<title>` and `<link rel="icon" href="<lucide name>">` give its title and rail icon (default `sparkles`). The worker watches the folder: the transcript service's `sprinkles` lists every one with its HTML, so spectrum gives each a rail button, and editing a file reloads its panel. Deleting the file retires it.

**Owners.** Each sprinkle talks to one agent, its owner. The first `panel open sprinkle:<name>` from a cone or a scoop makes the caller's cone its owner; until then it's the active cone at the time of the send. Nothing reassigns an owner afterwards, and `suggestions` always follows the active cone. Owners live in the session document `slicc.sprinkles`.

**Talking back.**
- **Sends.** `SprinklePort.send(id, { action, data, target })` becomes `AgentControl.sprinkleSend`, then a lick on the `sprinkle` channel for the owner: source `sprinkle:<name>`, the action as its text and the data as JSON in its body. It steers and coalesces per sprinkle like any lick.
- **Calls.** `SprinklePort.call(id, method, args)` becomes `AgentControl.sprinkleCall`:
  - `readFile` and `exists` reach only `/home`, with `/shared/…` mapped to `/home/…` so SLICC's own sprinkles run unchanged. Paths with `.` or `..` segments are refused, and a link is followed only if its target is in `/home` too;
  - `getState` and `setState` keep one JSON value per sprinkle in `slicc.sprinkles`;
  - there's no `exec`: a sprinkle that asks for one gets an error telling it to send the agent a message with `slicc.lick()` instead, so every command goes through an agent and its transcript.

**There's no `sprinkle` command.** An agent opens a sprinkle with `panel open sprinkle:<name>` and lists them with `panel list` (see Panels). An agent version that installed `sprinkle` leaves a copy in `/usr/local/bin` or `$PNPM_HOME/bin`; the worker removes it when that copy is slicc-agent's.

**Shipped sprinkles.** Only `welcome` and `suggestions`, with slicc-spectrum's reviewed copy.
- **Welcome.** The worker posts it inline in the first cone's chat once per session, as a `slicc.sprinkle` entry that the adapter shows as an inline sprinkle. It's the only inline sprinkle. Its `onboarding-complete` send writes `/home/.welcomed`, which the card checks, and the profile to `/home/.welcome.json` for the gelatiere's catalog ranking, and the built-in `welcome` skill answers the lick.
- **Suggestions.** It's listed once the gelatiere's store `/home/.gelatiere/suggestions.json` exists, and owned by the active cone. Its `gelatiere-dismiss` send marks the suggestion in the store and never reaches an agent; `gelatiere-install` and `gelatiere-try` mark it taken and go to the owner as licks. Its `exec` for use cases is refused, so it shows its static empty state.

The built-in `sprinkles` skill teaches the files, the bridge and `panel open sprinkle:<name>`.

### Panels

The `panel` command lets an agent, or the user in a terminal, list, open, close, focus and move the panels of a SLICC tab, sprinkles included as `sprinkle:<name>`. slicc-spectrum owns the command: `panelCommand(app, argv, caller)` parses argv, knows the panel ids and the guard rails, and answers `{ stdout, stderr, code }` with codes 0, 1, 2 and 5. The agent only carries the request to one tab and brings the answer back, so new verbs and flags need no agent release. pi has nothing for this; it's SLICC's UI.

**The command** is the same script as `agent`, installed as `panel`. It forwards argv with the caller `{ agentId, cone, readOnly: false }`, untouched apart from `--tab`:
- `agentId` is the calling cone or scoop (`cone`, `cone-2`, `scoop:<id>`), or `null` from a terminal;
- `cone` is the caller's cone: a scoop's own cone, or the active cone for a terminal;
- a terminal with `SLICC_TAB` set (bios sets it in each tab's terminals) sends that tab's id, and the request goes to that tab, with its cone.

The agent reads three things itself:
- **`panel tabs [--json]`** never reaches a tab: the agent answers it from the bridge's registered tabs, one line per tab with its id, cone, `visible` or `hidden`, `focused` or `-`, and how long ago it was last active, best first; `--json` prints `[{ tab, cone, visible, focused, lastActive }]`. A cone or a scoop sees only the tabs showing its cone, the user at a terminal sees every tab.
- **`--tab <tab>`** or `--tab=<tab>`, anywhere in argv, sends the command to that tab and is removed before argv is forwarded. It overrides `SLICC_TAB`. A cone or a scoop can only name a tab showing its own cone; the user at a terminal can name any tab, and the tab's cone becomes the caller's cone. A tab that isn't open, or isn't on the caller's cone, exits 3 with a sentence that points to `panel tabs`; `--tab` without a value exits 2.
- **`panel open sprinkle:<name>`** from a cone or a scoop sets the sprinkle's owner to the caller's cone first, if it has none (see Sprinkles).

It prints the tab's stdout and stderr on their own streams and exits with its code. The script transport has an optional `.err` file next to `.out` for this. The agent owns two codes:
- **3:** no open tab shows the caller's cone ("panel: no open SLICC tab shows cone <cone>; …"), or the `--tab` tab isn't open or reachable. Nothing is queued;
- **4:** the tab didn't pick the request up within 5 s, didn't answer within 5 s more, or went away meanwhile. Late answers are dropped.

**The bridge** is the `slicc.agent.pages` service, a sibling of `slicc.agent.remote` with the same long-poll stream: `open(tab)`, `report(stream, tab)`, `next(stream, waitMs)`, `answer(stream, id, result)` and `close(stream)`. A tab reports `{ tab, kinds: ['panel'], cone, visible, focused, lastActive }`. Each request goes to exactly one tab and is never retried elsewhere: the `--tab` tab, the `SLICC_TAB` tab if it's open, otherwise the tab on the caller's cone that is visible and focused, then visible, then the latest active. A tab is dropped when it closes its stream, when its attachment goes, or after 30 s without a poll, and each attachment reaches only its own streams.

**The page side.** `createAgentModel(connection, { page: { tab, run } })` starts a `PageAdapter`. It reports the tab's selected cone (`AgentAdapter.active()`, or a scoop's cone), `document.visibilityState`, `document.hasFocus()` and the time of the last pointer or key event, debounced by 250 ms. It answers each request with `run(argv, caller)`, which bios points at spectrum's `panelCommand` (≥ 1.59.0). `PageRun` uses the agent's own types, and `test/integration/panel-run.ts` type-checks `(argv, caller) => panelCommand(app, argv, caller)` against it. The integration test runs the real `panelCommand` on a `<slicc-app>` with the dummy model under the agent's ports. Without `run` the tab never registers, so the bridge works with older spectrums too.

**Followers never execute.** Read-only attachments (`owner.port({ readOnly: true })`) and attachments made with `owner.port({ pages: false })`, which bios uses for link followers, get a `slicc.agent.pages` whose `open` answers `{ error }`, so they are never chosen.

### Remote control

`remoteControl(connection, { agent? })` from `@ai-ecoverse/slicc-agent/page` gives a linked CLI's `slicc prompt`, `slicc watch` and `slicc abort` (the `agent` stream of the slicc link protocol, §5.11) as plain objects the page writes to the link as NDJSON. `agent()` names the agent, by default the cone the worker treats as current.

- **`prompt({ text, whenBusy = 'followUp', thinking = false, attachments? })`** sends the prompt, with attachments as on `SendRequest` (see Attachments), and resolves `{ delivered, events }`. `delivered` is `run`, `steer` or `follow-up`. A `reject` while busy throws an `Error` with `code: 'EBUSY'`, and any other refusal `EIO`. `events` starts at the prompt's own `user` event and ends with `{ t: 'end', reason, message? }` after the run that holds it. Leaving the loop closes the stream but never aborts the run.
- **`watch({ since, thinking })`** resolves `{ head, gap?, events }`. Without `since` it follows from the next event; with it, it first replays `since`'s own text or thinking whole, then everything after it, or answers `gap: true` when the transcript no longer holds it.
- **`abort()`** resolves `{ aborted }`, `false` when nothing was running.
- **Events** are `user`, `text`, `thinking` (only with `thinking`), `tool`, `tool-result`, `run`, `notice` and `error`. They are mapped in the worker from pi-durable's agent events (`watchEvents`: `run_start`/`run_end` with their inputs, message deltas, tool ends, retries, compactions) and polled by the page over the `slicc.agent.remote` service.
- **Ids:** entry ids for committed entries, `a<timestamp>.<block>` for an assistant message's blocks (stable from the first delta to the committed entry; `~n` when timestamps collide), and unique ids for transient notices.
- **What leaves the worker:** tool summaries of at most 200 characters (the tool's name and main argument), result summaries (a line count, or an error's first line), secrets redacted; never tool output.
- **Bounds:** a stream nobody polls for two minutes is dropped, and one more than 10 000 events behind ends with `{ t: 'end', reason: 'error' }`.

### Credentials

The agent never holds a secret's value. Values live in the vault (`vault.sliccy.ai`); the agent sees names and placeholders (`fnox_proxy_…`), and every text that could reach the model is scrubbed through the vault first. The design is secrets rev 4 (§3.12, §3.15–§3.18); scrubbing is AGENT-S1 and the model and MCP transport VAULT-2 (slicc-agent 4.0.0). Without a vault port there are no model credentials.

- **The port.** bios posts `{ kernel, admin, vault, scrub }` to the worker, where `vault` is a `MessagePort` to the vault frame (role `agent`) and `scrub` the last-known `{ needed, version }`, or `null` when no vault ever connected. On a vault reload it posts `{ vault, scrub }` again, and the worker resends its unanswered ops. The agent port gets no events, so bios also posts `{ locked }` (a boolean, from the page port's `status`) whenever the lock changes; the worker reads the initial state from the vault's `welcome`. Without a port, or with `needed: false`, nothing is sent and every scrub is the identity. A `version` newer than the last pair read counts as `needed` until the new pair arrives.
- **The wire** is slicc-vault's `AgentOp`/`AgentReply` (`@ai-ecoverse/slicc-vault`, types only). Requests are `{ v: 1, id, op, ... }` and answers `{ v: 1, id, op, ... }` or `{ v: 1, id, error: { code, message } }`, in request order: `redact { texts }` (strings and `Uint8Array`s, answered in the same order and types, with `version`), the stream ops `redactStream`, `push { chunk }`, `end` and `drop` with the worker's string `stream` id, and `model`, `mcp`, `records`, `grant`, `refresh` and `endpoints`. The vault's first message, `welcome`, carries `status.scrub` and `status.locked`; version bumps come only from bios's `{ scrub }` posts and the `version` in answers.
- **Credentials by placeholder.** `records()` lists the `model` and `mcp` records (names, placeholders, states, never values). It is read at start, whenever `version` changes, and after `connect` and `disconnect`. The read-only `CredentialStore` behind pi-ai returns a model record's placeholder as the API key (found by `kind: 'model'` and `provider`), with the account's non-secret fields as its env (Bedrock's `region` as `AWS_REGION`); writing to it throws.
- **The transport.** The worker's `fetch` is `vaultFetch`: a request to a configured provider's base URL (Bedrock's standard `bedrock-runtime.*.amazonaws.com` and `-fips` endpoints included, so the AWS SDK's bearer requests are covered), or one carrying a model placeholder in its URL or headers, goes out as `model { provider?, request }`; MCP requests go out as `mcp { server, request }`, discovery and client registration included. The vault returns the request scrubbed over every value and with the credential filled in its headers or URL, and the existing transport sends it (`loopbackFetch` for a server on `http://<port>.kernel.localhost`); the response comes back directly. `EAGAIN` prepares the request once more; a refusal becomes a response (403 for `EACCES`, with the vault's sentence); a 401 calls `refresh { provider | server }` once and sends again. Anything else passes through, and without a vault every request does. Transport errors name only the method and origin, never a prepared URL or header.
- **Endpoints.** `endpoints { model: [{ provider, url }], mcp: [{ server, url, names?, tokenUrl? }] }` is sent when the port opens and whenever the providers, the accounts or `mcp.json` change: every https base URL of every provider, and every server URL with the `${NAME}`s its headers use. Registrations only add.
- **`slicc-secrets`**, a built-in extension modelled on [pi-fnox](https://github.com/Bucurenciu-Cristian/pi-fnox) (MIT, © 2026 Kicky), with its hooks mapped to pi-durable: `secret list --json` in the home env at start and whenever `version` changes (pi-fnox's `fnox export`; nothing goes into the worker's environment); an `afterTool` hook scrubbing every result's text, diagnostics and string `details` (pi-fnox's `tool_result`); a `secrets` system section with the names, placeholders, where each works and how to use them (`before_agent_start`); and `/secrets`, answered locally as a `slicc.secrets` entry (`/fnox-list`; reloading is automatic). When at least one secret is `shell = true`, every conversation command runs as `fnox exec --shell-grants -- <argv>` (pi-fnox's `spawnHook`). slicc-agent doesn't depend on `@kickythrust/pi-fnox`. Every conversation keeps the extension: new ones are pinned at creation, and conversations stored with an extension list that lacks it get it back at start.
- **Where text is scrubbed before anything keeps or cuts it:** command output, per stream, before the bash tool's tail window, the spill file and the live slot; `read`'s bytes (images aren't, and files over 8 MiB stream in 1 MiB chunks); MCP results before their middle cut and progress text; codemode output before its cut; user and remote sends after skill expansion; every lick (sprinkle sends and scoop results included) before triage and the outbox; and memory writes, before the pattern redaction. Remote-control summaries are built from stored entries only.
- **The hold.** A vault that doesn't answer within 2 s reads as `waiting`. Nothing unscrubbed is appended: tool results, sends and licks wait in memory, model requests wait before they start, and command output held past 32 MiB kills the command with "output held: waiting for the vault". The state is the transcript's `vault` field (`{ port, needed, version, locked, held }`), and remote `watch` streams get a `notice` "waiting for the vault" and one when it answers again.
- **In spectrum.** The agent port's `hold()` is `{ reason: 'locked', held }` while the vault needs a passkey, `{ reason: 'waiting', held }` while scrubbing is needed and the port isn't `ready`, and `null` otherwise, with a `hold` event on each change (and `null` when it clears); spectrum (≥ 1.62.0) shows it above the composer, and older spectrum ignores it. While a hold is up, the worker's active cone is busy (`working` when it isn't running), so the composer steers and queues; a send made during the hold waits in the tab, shown in that cone's queue, and goes to the worker once the hold clears; removing it before then means it's never sent. `/secrets` entries (`slicc.secrets`) show as a "Secrets listed" notice.
- **The 3.x store is wiped.** 3.x kept model and MCP keys in the IndexedDB database `slicc-agent-credentials`; 4.x doesn't migrate them. At start, before any model call, the worker reads only that database's record keys (never decrypting), deletes it, and keeps the accounts it found (`adobe` as Adobe, `amazon-bedrock` as Bedrock, `mcp:<server>|…` as the server, anything else by its providerId) in the session document `slicc.keys-moved`. A missing database, or no `indexedDB`, does nothing. The worker waits up to 3 s for the delete and claims the keys moved only once it succeeds. A delete blocked by an open 3.x tab shows no notice yet: if it succeeds later in the session (the tab closes) its accounts are added then, and otherwise the next start tries again. A delete that fails reports nothing. Once the vault's records are read, the accounts still without a record are the settings state's `moved`, and the spectrum adapter's `notices` port shows one notice, with model accounts first and MCP servers grouped after them: "Your keys moved to seven's vault. Add them again in Settings › Accounts: Adobe, Bedrock; MCP servers: github, jira." (or "…, and the MCP server github" for one). Dismissing it calls `AgentSettings.dismissMoved`, which marks the document, so it stays dismissed across reloads. An account without a record reads not connected. A model call that finds no credential ("Provider is not configured", "No API key") leads with "Adobe isn't connected." or "Bedrock isn't connected.", with "Connect it in Settings › Accounts." underneath instead of the raw error, and opens settings, and a send whose run finds no model because its account isn't connected (Adobe lists models only once signed in) shows the same error. "Your Adobe session has expired." is kept for a 401 from a token that exists. The settings state's `labels` names every model of a provider without a record from the agent's catalogue ("Claude Haiku 4.5 (US) on Bedrock"), and the adapter puts that name in the header of a reply whose model isn't in the picker, instead of the raw id.
- **Tests.** The worker never compiles values: `src/` takes only `import type { Hit }` from [`@ai-ecoverse/slicc-scrub`](https://www.npmjs.com/package/@ai-ecoverse/slicc-scrub), the vault's scrubber, and the package is a devDependency. The fake vault the tests use scrubs with that package, and its `vectors.json` (every form, line-wrapped base64 and hex included) runs through each scrub point and each cut. A suite-wide check asserts that no captured model request, entry, slot or memory file holds any form of a seeded value.

## The kernel

`@ai-ecoverse/slicc-kernel` is a peer dependency (`>=1.47.1 <2`, the first kernel with users and the H1 wasm commands; until 3.31.0 the floor was 1.26.3): the agent only calls `attachKernel`, the client end of the page kernel's port, so it must match the kernel the page runs. Seven chooses that version: slicc-bios pins the certified kernel next to the agent in `src/packages/agent/package.json`, and pnpm fills the peer from that pin. The devDependency is the lowest certified kernel the range allows (1.47.1), and the unit and integration tests run on it with the H1 wasm commands as devDependencies. A second CI job reruns the integration tests on the newest certified kernel (`NEWEST_CERTIFIED_KERNEL` in `.github/workflows/ci.yml`), with the wasm commands certified for it (`NEWEST_CERTIFIED_WASM`). Today the floor is 1.47.1 and the newest certified kernel 1.86.0; the second job moves by hand to each newer certified kernel, so both ends of the range are tested. If the port protocol ever breaks within 1.x, a patch release narrows the upper bound. Renovate opens PRs for the kernel, `wasi-pnpm`, the `wasm-*` packages and `slicc-cdp` but never merges them, because they move only after the homescoop coordinator certifies them.

## Patched dependencies

Fixes to pi stay in this repository. [`patches/patches.json`](patches/patches.json) lists each one with its `kind`, `package`, `patchedVersion`, `reason`, `removeWhen` and `verify` command, and an optional `marker` (a file in the package and a string it must contain):

- `monkeypatch`: code that runs in users' browsers is patched at runtime. pi-mcp parses SSE with Node's `Buffer.byteLength`, which browsers don't have. `patchSse()` in [`src/mcp/sse.ts`](src/mcp/sse.ts) replaces `StreamableHttpTransport.prototype.consumeSse` with the same parser measuring bytes with `TextEncoder`, before any server connects. `applyPatches()` in [`src/patches.ts`](src/patches.ts) applies them once before pi is used: `PortListener.start()` calls it, so `hostAgent` and a `PortListener` used directly with pi's `Server` both get them. Each one checks that the code it replaces still looks as expected and throws, naming its manifest entry, if not. Today there is one: pi-server's `Server.accept` calls `unref()` on its handshake timer, which browsers don't have, so the patch gives numeric timer ids a no-op `unref`.
- `patch-package`: repository-only fixes go in `patches/<package>+<version>.patch`, applied by a `postinstall` that runs [patch-package](https://github.com/ds300/patch-package). There are none yet.
- `environment`: something the host must provide.
  - pi-server imports `randomUUID` from `node:crypto`. slicc-bios serves a stub backed by `globalThis.crypto`, and the integration bundles alias it to `test/integration/shims/node-crypto.js`.
  - pi-codemode runs QuickJS in a `node:worker_threads` Worker. slicc-bios must serve a `node:worker_threads` stub that wraps a module Web Worker; inside the worker, the stub gives `parentPort` and `workerData` from the first message. `test/integration/shims/node-worker-threads.js` is that stub, and the integration bundles alias to it.
  - pi-mcp's index re-exports its stdio transport, which imports `node:child_process`, `node:process` and the CommonJS `cross-spawn` at the top. SLICC never constructs it, so slicc-bios's `node:*` stubs and CommonJS wrapping only have to let them load; `cross-spawn`, `which` and `isexe` also read the free globals `process` and `global` when they load. The MCP runtime is imported lazily, so if it fails to load, the agent still starts, and a configured `mcp.json` gets a lick saying MCP servers can't start. The integration bundles alias all three to `test/integration/shims/node-only.js`.
- `environment`, pruned from seven's install: slicc-bios's `/opt/agent` (its `src/packages/agent`) removes `@google/genai` and `esbuild` with pnpm overrides in `pnpm-workspace.yaml` (#22).
  - A real Bedrock turn loads 28 of 95 installed packages and never those two trees. Adobe's APIs reach only `@anthropic-ai/sdk`, `openai` and `partial-json`, so those stay.
  - The prune takes the install from 99 to 58 packages and `node_modules` from 143 to 92 MB.
  - The markers keep pi-ai's two Google APIs (Gemini and Vertex) lazy and chord's esbuild Node-only. Seven offers only the Bedrock and Adobe providers: if a Google provider is ever added, the bios override has to go first, and a failing marker is the reminder.

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

Releases are cut by semantic-release on every push to `main`, and only there, in two jobs. `main` only takes merges that the merge queue tested on that same commit, so the release runs no tests. The `tag` job runs on the bench pool, so it starts within a minute of the push. It computes the version, tags the commit and creates the GitHub release, with `npmPublish: false`. A run that starts after `main` has moved on skips, and the run for the newer commit releases it. The `publish` job runs on a GitHub-hosted runner, because npm's trusted publishing and provenance accept no self-hosted runner. It builds the tagged commit and publishes it, unless npm already has that version. Re-running a failed `publish` job completes the version.
