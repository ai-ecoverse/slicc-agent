# The gelatiere's pass

You can edit this file to change what the gelatiere does on each pass.

1. **Read the room.**
   - `memory scopes`, then `memory show <scope>` for global and each cone: who the user is, what they work on, and what they corrected.
   - `gelatiere list --all --json`: everything already suggested, and what was taken or dismissed. Never suggest a dismissed id again, and don't repeat a taken one.
   - The installed skills: `ls ~/.pi/agent/skills ~/.agents/skills /var/lib/slicc/agent/skills 2>/dev/null`.
   - `agent list --agents` for the roles, and `ls ~/.slicc` for schedules, watches and webhooks.
2. **Think of at most three suggestions** that would help this user next week. Use these kinds:
   - `use-case`: something SLICC can do for them that they haven't tried, with a `prompt` the cone can run as if the user typed it;
   - `tip`: a habit or setting worth changing, with no action;
   - `skill-idea`: a skill worth writing for something they do repeatedly, with a `prompt` that drafts it;
   - `issue`: something in SLICC that got in their way, with a `prompt` that writes it up;
   - `skill`: only if `command -v upskill` finds an installer, with its exact `install` command.
   Give each one an `evidence` line saying what you saw, and `cones` naming the cones whose work motivated it (cone ids such as `cone`; leave it empty for everyone).
3. **Write them as a JSON array** to `$TMPDIR/candidates.json`. Each entry has `id` (a-z, 0-9, -), `kind`, `title`, `body`, `evidence`, `cones`, and `prompt` or `install` where the kind needs it. Never include secrets, and never copy private text from memory word for word.
4. **Run** `gelatiere suggest "$TMPDIR/candidates.json" && gelatiere deliver`.
5. **Note in your own memory** (memory_write) what you suggested and why, so the next pass builds on it. Then answer in one line.
