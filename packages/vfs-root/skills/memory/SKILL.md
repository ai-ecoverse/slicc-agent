---
name: memory
description: Use this when the user asks what you remember, tells you to remember or forget something, corrects how you work, or when you learn a durable fact worth keeping across conversations. Covers the memory files, the memory_write tool, scopes and the `memory` command.
---

# Memory

Memory is plain markdown, one `MEMORY.md` per scope, shown to you in the `memory` section of your system prompt (the first 200 lines of each file):

| Scope | File | Who writes it |
| --- | --- | --- |
| `global` | `~/.pi/agent/memory/MEMORY.md` | cones, for every agent |
| a cone (`cone`, `cone-2`, …) | `~/.pi/agent/memory/<cone>/MEMORY.md` | that cone |
| a role (`role:<path>`) | `~/.pi/agent/agent-memory/<path>/MEMORY.md` | scoops of a role with `memory: { scope: user, path: <path> }` |

A role with `memory: { scope: project, path: <path> }` keeps it in `<project>/.pi/agent-memory/<path>/MEMORY.md`, where the project is the nearest folder above the scoop's working directory with a `.pi` or `.git`, inside /home.

## Writing

Use `memory_write` rather than editing the files:

- `section` and `title` name the entry; saving the same section and title again replaces it.
- `tag` is `user` (who the user is), `feedback` (how they want you to work) or `project` (facts about their work).
- `remove: true` forgets an entry. `scope: "global"` writes the shared file (cones only).

Keep entries short and durable: a preference, a correction, a convention, a project fact. Don't save one-off task details, transcripts, or anything secret (keys, tokens, passwords, signed or launch URLs); memory_write redacts what looks like one. Each file holds 16 KB; when it's full, merge or remove entries before adding.

The file format, if you or the user edit it by hand:

```markdown
## Preferences

### Lead with the result
tag: feedback

Keep replies short. Lead with the result, then the detail.
```

## The `memory` command

```bash
memory scopes          # every scope, its entry count and file
memory show [<scope>]  # print a memory file, yours by default
```

The user sees and edits the same entries in the Memory panel.

## Instructions are not memory

`AGENTS.md` and `CLAUDE.md` files hold instructions the user wrote: `~/.pi/agent/AGENTS.md` and the ones on your working directory's path inside /home are in the `project_context` section. Files in mounted folders are listed there as not loaded; they load once SLICC can trust a folder.
