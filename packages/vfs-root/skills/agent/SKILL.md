---
name: agent
description: Hand work to scoops (helper agents in SLICC) with the `agent` command, synchronously for quick bounded answers or asynchronously for long or parallel work. Scoops can take a role (scout, worker, reviewer, oracle, delegate and any you add); `agent list --agents` lists every role with its description.
---

# Agent

The `agent` command starts scoops: helper agents with their own conversation and their own folder under `/scoops/<handle>/`. A scoop cannot see your conversation, so every prompt must carry all the context it needs. The user can run the same command in a terminal and sees every scoop in the agents rail. `subagent` is the same command (`subagent spawn` = `agent --async`).

## Synchronous: you need the answer now

```sh
agent --name check --prompt "Read /home/app/src/config.ts and list every setting with its default"
agent --agent reviewer --file /tmp/diff.txt --prompt "Review this diff"
```

The command blocks, prints the scoop's final answer on stdout and exits 0, or exits non-zero with the reason on stderr. Use it like any command, in pipes and scripts. Afterwards the scoop is stopped, its folder is removed, and its transcript is archived in `/tmp/agent-sessions/<handle>.md` (`--persist-session` keeps it in `/home/sessions/`, `--no-persist-session` keeps none).

- Give the command a bash timeout that fits the work. If your bash call is stopped, the scoop stops too; if it only times out while you keep working, the scoop continues and its answer arrives later as a lick.
- `--background-after <seconds>` hands a long run over on purpose: after that many seconds the command prints the handle and returns, and the answer arrives as a lick.
- `--read-only <path,path>` lets the scoop read more folders. In v6's form, `agent <cwd> <allowed-commands> <prompt>`, the scoop works in `<cwd>` and is told which commands to use; that list is not enforced.
- Scoops can run `agent` themselves, up to three levels deep.

## Asynchronous: long or parallel work

```sh
agent --async --name implementation --prompt "Complete task"
subagent spawn --agent scout --prompt "Map how licks are delivered"
```

The command prints the scoop's handle at once. The scoop keeps working, and when it answers a request you sent, the report arrives as a `scoop-notify` lick: one line `[scoop <name> (<role>) <status>]`, the path of the full answer under `/scoops/<handle>/reports/`, its line count and a 1,000-character preview. Read the file when you need the whole answer. Only cones start async scoops.

To wake up once for several scoops instead of once per scoop:

```sh
agent wait --notify review scout
```

It returns at once, and one `scoop-wait` lick brings all their answers together. `agent wait <handle>...` blocks, 30 seconds by default (`--timeout <seconds>`), and prints the latest answers. Keep blocking waits short, because the user's messages can't reach you while you wait.

## Roles, models and tools

`--agent <role>` gives a scoop a role, such as scout, worker, reviewer, oracle or delegate; `agent list --agents` shows every role and where it comes from. Put your own roles in `~/.pi/agent/agents/`. A project's `.pi/agents` folder is read only once the folder is trusted, which SLICC doesn't support yet.

A scoop starts with your provider, model and thinking level. Use `--model provider/model`, `--thinking` or `--effort` only when you mean to choose differently. Never pass `$PI_PROVIDER`, `$PI_MODEL` or `$PI_REASONING_LEVEL` back explicitly.

Without `--tools`, a scoop gets read, write, edit and bash; `--tools read,bash` is an allowlist. grep, find and ls map to bash, and bash can change files, so no tool list is truly read-only. A scoop's read, write and edit tools reach only its folder, /tmp and its working folder, and read /home; its bash is not confined, and the scoop is told so.

## Inspect, talk, stop

```sh
agent list
agent status <handle>
agent rename <handle> "new name"
agent send <handle> "message"              # idle: a new request; busy: steers the current work
agent send <handle> --follow-up "message"  # busy: after the current work
agent stop <handle>
```

Stop every async scoop you no longer need. Stopping ends its work and removes it from the list; its transcript is kept, so rewinding a turn can bring it back, and its files stay in `/scoops/<handle>/`.

## From inside a scoop

A scoop can post a progress note to its cone; it arrives as a lick:

```sh
agent send parent "Halfway: the parser is done, starting on the tests"
```

## Limits

A cone can have 16 live scoops and start 64 per turn (`subagents.maxLiveScoops` and `subagents.maxPerTurn` in `~/.pi/agent/settings.json`).
