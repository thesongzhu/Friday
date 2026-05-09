# Friday Phase 3 Execution Protocol

Date: 2026-05-05
Branch: `codex/friday-lego-closure-repair`
Scope: Phase 3.0 protocol and WIP ledger before any further Phase 3 implementation.

## Status Summary

Phase 1 is already committed as `5e0bc54e Add canonical gate for Phase 1 mutations`.

Phase 2 is already committed as `7aa72a96 Default local system runtime safely`.

Phase 3 is not complete, not staged, and not committed. Current worktree state must be treated as mixed WIP until the Phase 3.0 ledger classifies every dirty and untracked file.

The latest Phase 3 review is not a fresh line-by-line re-read of the entire Friday repository. The current basis is the prior full audit artifacts, two isolated reviewer reports, and targeted read-only checks of Phase 3 external Lego files, diffs, and audit findings. Do not claim this round re-read 100% of Friday.

## Binding Hard Rules

- Do not start a new phase or subphase, or touch files outside the approved phase/subphase scope, without explicit user approval.
- Stop and ask the user before any new issue, new direction, new boundary, or implementation choice that was not already confirmed.
- Before each hunk, explain the intent, affected behavior, affected routes or mechanisms, and verification plan. Do not wait for per-hunk approval inside an approved phase/subphase unless there is a new issue, drift, unauthorized scope, or conflict.
- Do not fake proof. Mock-only tests, disabled routes, fallback paths, or green CI cannot be described as real runtime closure.
- Do not overwrite, revert, or normalize user or historical dirty worktree changes.
- Mixed dirty files may be touched only hunk-by-hunk inside the approved phase/subphase scope. If a user/historical hunk conflicts with Phase 3, stop and ask.
- Stage only verified Phase 3.0 protocol/ledger hunks. Use hunk staging and then inspect the staged diff before commit.
- Each subphase must follow: read relevant files first, state hunk intent/impact/tests before edits, stay inside the approved scope, verify, run two isolated reviewers, then hunk-stage, commit, and push only after pass.
- API keys and secrets may only be used through environment variables when explicitly allowed. They must not be written to files, logs, reports, tests, commits, or prompts.
- At the start of each new task or phase, present the current safety and execution rules to the user for confirmation. User edits become the next default shown back to the user.
- Every phase before, during, and after task state must be visible in the Codex UI task list.

## Hunk Announcement Format

Every future write inside an approved phase/subphase must be announced before editing with:

1. Target file and whether it is new, tracked dirty, or untracked.
2. Intent in plain language.
3. Expected behavior change.
4. Routes, mechanisms, state, or tests affected.
5. Verification command or evidence.
6. Explicit note if the file contains unrelated dirty hunks.

Continue inside the approved phase/subphase after the announcement. If the work reveals a new question, direction drift, unauthorized scope, user-change conflict, or unconfirmed risk, stop before editing the next hunk and ask the user.

## Locked Phase 3 Decisions

- Candidate storage is `stateDir/skill-candidates`.
- `/v1/skills/convert` is preview-only and must not write candidates.
- `/v1/skills/import` creates a staged candidate only. It must not directly install, promote, or mark a skill available.
- Skill-source deeplinks create candidates only. They must not directly install managed skills.
- A link implies stage authorization only when the user has a clear add, install, try, or upgrade intent. Ordinary shared links are preview-only.
- Shadow may copy artifacts into `managed-skills`, but the skill remains `not_installed` and unavailable to normal UI, API, agent, workflow, and channel execution.
- Lifecycle canary may use an internal-only trial key or flag. That capability must not be exposed through public API bodies, agent tools, or ordinary skill runs.
- Canary failure keeps shadow artifacts and evidence for diagnosis, but cannot promote or become available.
- Promote makes the external skill visible to UI, agent, workflow, and channel surfaces, but runtime execution still follows risk-based approval gates.
- Phase 3 rollback must make external skill artifact and status restoration real, not metadata-only.
- External executable code is high risk by default. Unknown permissions fail closed.
- External skill sandbox default is strict. Permission grants bind to the exact version digest, and updates require review again.
- Promote requires permission preview. GitHub and URL sources must be pinned to a concrete commit or hash before promote.
- External updates may be staged automatically as update candidates, but must not replace active versions automatically.
- External plugins require manual trust, locked version and hash, and renewed review on update before running in-process.
- External MCP servers go through the external lifecycle. Unpromoted MCP tools are not agent-available.
- Providers are available only after real validation succeeds.
- Lifecycle progress must notify the source channel and UI at key nodes. Waiting or stalled approvals send reminders every two hours unless the user changes that policy.
- Agents may recommend external candidates, but may not automatically download, install, or promote external capabilities.
- Agent-generated executable skills remain candidates. Only declarative read-only generated workflows or templates with machine proof may become directly available, and the user must be notified.
- Guide Lens preferences and avatar state are separate from memory.
- Runtime evidence is stored as evidence, not memory.
- Ordinary preference learning promotes after two similar signals and remains user-manageable. Safety and execution preferences are shown for confirmation at each task or phase.

## Current Known WIP Boundaries

The worktree currently has a large mixed WIP set. Phase 3.0 must produce a complete WIP ledger before any implementation continues.

Known categories that must be represented in the ledger:

- Existing untracked audit artifacts in `docs/audit/friday-lego-closure-audit-2026-05-04/`.
- Phase 3 candidate lifecycle WIP, including converter, candidate store, autonomy, skill route, executor, agent tool, UI, provider, plugin, MCP, workflow, and e2e harness files.
- User or historical dirty files that must not be staged or modified unless explicitly approved.
- The unauthorized test edit in `test/unit/skills/converter/friday-skill-converter-service.test.ts`, which is retained only as a pending review hunk and is not accepted automatically.
- Any mixed files, especially hub/bootstrap and broad runtime files, which require hunk-level handling.

## Isolated Reviewer Summaries

Reviewer 1 confirmed the core hard rules, branch, Phase 1 and Phase 2 commits, large uncommitted WIP, Phase 3 audit basis, and the unauthorized test edit. It concluded Phase 3 planning can continue, but coding cannot resume until open decisions are confirmed.

Reviewer 2 agreed with Reviewer 1 and added that the UI-visible task workflow must be treated as a hard rule. It also confirmed there is no staged diff and identified incomplete Phase 3 proof areas: promoted external skill run after restart, candidate storage policy, internal canary boundary, canary failure policy, and rollback depth.

Both reviewers warned not to claim this round is a full fresh 100% repository re-read.

## Phase 3.0 Outputs

Phase 3.0 must add:

- `15_phase3_execution_protocol.md`
- `16_phase3_wip_ledger.md`
- `16_phase3_wip_ledger.csv`

The ledger must cover every dirty and untracked file visible to Git, including generated audit artifacts, source files, tests, UI files, scripts, and the untracked candidate store/test files.

## Phase 3.0 Verification

Before Phase 3.0 can be staged:

- Confirm all three Phase 3.0 files exist.
- Confirm the ledger includes all current dirty and untracked files.
- Confirm no API key or secret token appears in the new Phase 3.0 files.
- Confirm no code, test, config, or unrelated audit file changed as part of Phase 3.0.
- Run two isolated reviewers against the Phase 3.0 outputs.
- Only after both reviewers pass, ask the user for hunk-stage approval.

## Later Phase 3 Acceptance

Later Phase 3 implementation cannot pass on tests alone. It must prove:

- Preview-only convert.
- Candidate-only import and deeplink stage.
- Unpromoted skills blocked from UI, API, agent, workflow, and channel execution.
- Internal canary proof without public bypass.
- Promote makes a skill available through all intended surfaces.
- Rollback restores the previous executable artifact and status.
- Restart preserves promoted availability and blocked candidate state.
- Real provider validation and real GitHub or URL evidence where applicable.
- Secret scan confirms no supplied key was written.
