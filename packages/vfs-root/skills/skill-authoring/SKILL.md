---
name: skill-authoring
description: Write, edit or debug a skill or a prompt template for SLICC, or explain how SLICC finds and loads them. Covers SKILL.md frontmatter, writing a description that routes well, where skills and templates live, and /skill:name and /template commands.
---

# Writing skills and prompt templates

SLICC follows the [Agent Skills specification](https://agentskills.io/specification) and pi's prompt templates. Skills written for pi or for other Agent Skills tools work here unchanged, as long as the commands they use exist in SLICC.

## A skill is a folder with SKILL.md

```text
~/.pi/agent/skills/pdf-tools/
├── SKILL.md
├── scripts/extract.sh
└── references/formats.md
```

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

- `name`: lowercase letters, digits and hyphens, at most 64 characters, no leading, trailing or double hyphens. Without it, the folder name is used. Match the folder name to stay portable.
- `description` (required, at most 1024 characters): this is all you see of a skill until you load it, so say what it does **and** when to use it. "Helps with PDFs" is too vague to route on.
- `disable-model-invocation: true` keeps a skill out of your list; only `/skill:name` loads it.
- `license`, `compatibility`, `metadata` and `allowed-tools` are accepted. `allowed-tools` doesn't restrict anything here.

Refer to bundled files with paths relative to the skill folder; the skill's location tells you where that is.

## Where SLICC looks

In this order; when two skills share a name, the first one found wins and the other is reported:

1. `~/.pi/agent/skills/`
2. `~/.agents/skills/`
3. `/workspace/skills/`, for skills copied from SLICC v6
4. packages under `/node_modules` whose `package.json` lists folders in `pi.skills`
5. SLICC's built-in skills in `/var/lib/slicc/agent/skills/` (rewritten on every start; don't edit them there)

Folders containing `SKILL.md` are found at any depth; a plain `.md` file with a `description` directly in one of these folders counts as a skill too. Folders starting with `.` and `node_modules` are skipped. A project's `.pi/skills` or `.agents/skills` folder is read only once the folder is trusted, which SLICC doesn't support yet.

Changes are picked up at once. A skill with a problem (no description, a bad name, a name collision) is reported in a lick that names the file.

## Prompt templates

A prompt template is a Markdown file that becomes a `/` command the user types:

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

Saved as `~/.pi/agent/prompts/review.md`, it's `/review`. Only `.md` files directly in that folder count. Packages can add templates with `pi.prompts`, and SLICC ships `/parallel-review` and `/review-loop`.

Substitutions: `$1`, `$2`, …; `$@` or `$ARGUMENTS` for all arguments; `${1:-default}`; `${@:-default}`; `${@:N}` and `${@:N:L}` for slices. Arguments are split like a shell does, so `/review "API compatibility"` is one argument.

## Commands

- `/skill:name [request]` loads the skill and adds the request after it.
- `/template [arguments]` expands the template.

Both only work when the user types them in a chat; text that arrives in licks or from `agent send` is never expanded.

## What v6 skills need

v6 skills keep working where their commands exist. Many refer to v6 paths (`/shared/…`, `/workspace/…`) or v6-only commands (`ipk`, `.jsh`, `playwright-cli`, `upskill`, `sprinkle`, `mount`, …); rewrite those parts before relying on them.
