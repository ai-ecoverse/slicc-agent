# slicc-agent

`@ai-ecoverse/slicc-agent`: SLICC's agent core on pi durable. Node ≥ 24, ESM, TypeScript in `src/`, built per file (no bundling) into `dist/` by `build.mjs`; seven loads it unbundled from OPFS. Lint with `slicc-lint`. No comments in any file. Agent guidance lives only in this AGENTS.md (≤1000 characters); no CLAUDE.md. Unit tests stay in gitignored `test/unit/`, run only for changed code (100% diff coverage). Regressions are caught by integration tests in `test/integration/` (Chromium, CI) that test behaviour through public surfaces, not internals; every bug fix adds one. Tests use pi's faux provider, never a real LLM. Publish from `main` with semantic-release and fledgling trusted publishing (`ci.yml`).
Never send fixes upstream to pi: patch here and list each patch in `patches/patches.json` (README, "Patched dependencies").
Before building agent functionality, check whether pi (durable, ai, coding-agent) already provides it.
