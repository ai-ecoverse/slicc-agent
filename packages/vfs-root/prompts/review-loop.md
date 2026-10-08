---
description: Review/fix loop until clean
argument-hint: "[implementation request, cap or focus]"
---

Run a parent-orchestrated review loop for the requested work.

Use scoops with the `agent` command. Keep this conversation as the loop controller and final decision-maker. Scoops must receive concrete role-specific tasks, and a scoop doesn't see this conversation, so every task prompt must name the target, the repository path and what to do. Scoops can't start asynchronous scoops of their own, so the loop stays here.

Default to a maximum of 3 review rounds unless I specify a different cap. Count a review round each time fresh reviewers inspect the current diff after a worker pass. Stop early when reviewers find no P0 findings, no P1 fixes worth doing now, and no approved P2 notes that should be handled in this loop.

If the invocation includes an implementation request, first start one `worker` to implement the approved scope: `agent --async --agent worker --name implement --prompt "<task>"`, then `agent wait --notify implement`. If the current diff is already the target, start with review. Use only one writer against the working tree at a time.

Do not give writers tight deadlines. Give each writer a narrow delivery slice. If a writer runs long, ask for a checkpoint with `agent send <handle> "<request>"`: changed files, build and test state, remaining work, and commit or PR state.

For each review round, start fresh `reviewer` scoops in parallel (`agent --async --agent reviewer --name <angle> --prompt "<task>"`, then `agent wait --notify <handles…>`). Reviewers must inspect the repository, relevant instructions, and current diff directly from files and commands. They must not rely on the main conversation history and must not edit files. Stop each round's reviewers with `agent stop <handle>` once you have their answers.

Tell reviewers to filter on evidence, not severity. They should report only concrete current issues caused or made reachable by the target diff, with source proof, a test or repro, or a contract contradiction. Ask them to label findings P0/P1/P2 and end with `Merge verdict: BLOCK`, `Merge verdict: OK`, or `Merge verdict: OK with notes`. P0 blocks merge. P1 should be fixed before release. P2 is report-only. Use `blockers only` only for final pre-merge re-checks after P1/P2 findings are already captured, or for explicit emergency hotfix lanes.

Choose review angles from the actual change. Common angles are correctness/regressions, tests/validation, and simplicity/maintainability. Add security, performance, docs/API contracts, or user-flow validation when the work calls for it. Prefer three strong reviewers over many vague reviewers.

After reviewers return, synthesize their feedback into:
- P0 blockers or scope/product/architecture decisions that need user approval;
- P1 fixes worth doing now;
- P2 report-only notes or optional improvements;
- feedback to ignore or defer, with a short reason.

Do not blindly apply every reviewer suggestion. If reviewers surface an unapproved product, scope, or architecture decision, pause and ask me before starting a fix pass.

When an implementation worker answers, treat its answer as the transition into review, not as final completion, unless I explicitly asked for worker-only work, review-only output, or to stop after implementation.

When there are fixes worth doing now and the workflow is implementation-authorized, send them to the same worker with `agent send <handle> "<fixes>"`, so it keeps its context, and wait with `agent wait --notify <handle>`. Ask it to apply only those synthesized fixes, preserve the approved scope, run focused validation, and report changed files, commands run with exit codes, validation evidence, surprises, and anything left undone.

After a fix pass returns, run another review round only when it made material changes or addressed non-trivial findings. Do not keep looping for optional polish, speculative improvements, or findings already deferred.

For a targeted follow-up review, ask only three questions: whether the named finding was resolved, whether the fix introduced a new concrete defect in the fix blast radius, and whether prior P1/P2 notes still stand. End with a fix verdict and the merge verdict.

Stop and summarize when one of these is true:
- reviewers find no P0 blockers or P1 fixes worth doing now;
- remaining feedback is optional, speculative, or intentionally deferred;
- reviewers surface an unapproved decision that needs me;
- the max review-round cap is reached.

On completion, stop the worker with `agent stop <handle>`, inspect the final diff yourself, run or confirm focused validation where appropriate, and summarize the loop: rounds run, fixes applied, validation, remaining deferred items, and why the loop stopped.

Additional target, implementation request, max-iteration cap, or review focus from the slash command invocation:

$@
