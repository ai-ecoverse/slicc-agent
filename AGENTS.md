# slicc-agent

`@ai-ecoverse/slicc-agent`: SLICC's agent core on pi durable. Node ≥ 24, ESM, TypeScript in `src/`, built per file (no bundling) into `dist/` by `build.mjs`; seven loads it unbundled from OPFS. Lint with `slicc-lint`. No comments in any file. Agent guidance lives only in this AGENTS.md (≤1000 characters); no CLAUDE.md. Unit tests stay in gitignored `test/unit/` (`npm run test:unit`, 100% diff coverage); integration tests in `test/integration/` run in Chromium in CI. Tests use pi's faux provider, never a real LLM. Publish from `main` with semantic-release and fledgling trusted publishing (`release.yml`).
Never send fixes upstream to pi: patch here and list each patch in `patches/patches.json` (README, "Patched dependencies").
