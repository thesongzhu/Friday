# Friday Agent Operating Rules

This file is the first project-local rule entry for work in `/Users/jarvis/Projects/Friday`.
Read it before every Friday task, before editing, before staging, and before asking another agent to review.

If this file conflicts with a higher-priority system/developer/user instruction, follow the higher-priority instruction and tell the user about the conflict. If this file conflicts with `/Users/jarvis/Desktop/friday_master_workflow_prompt.md`, stop and ask before acting.

## Required Sources To Read Before Work

Before any code, test, config, docs, workflow, skill, memory, provider, UI, system, release, or automation change:

1. Read this file.
2. Read `/Users/jarvis/Desktop/friday_master_workflow_prompt.md`.
3. Read `context/AGENTS.md`.
4. Run and inspect current `git status --short --branch`.
5. Read current diff for any touched or related files.
6. Read the relevant Friday source, tests, audit notes, route/runtime wiring, state model, approval boundary, memory boundary, and evidence path.
7. If using an external guideline or repo, read the actual source before merging it into Friday behavior.

Never claim a fresh full-repo line-by-line reread unless it actually happened in the current session.

## Current Guideline Inputs

These rules merge:

- Friday workspace rules from `context/AGENTS.md`.
- The Friday master workflow prompt at `/Users/jarvis/Desktop/friday_master_workflow_prompt.md`.
- The user's hard rules in this thread.
- The Karpathy-inspired guideline repo `https://github.com/forrestchang/andrej-karpathy-skills`, read at commit `2c606141936f1eeef17fa3043a72095b4765b9c2`.

The external guideline principles are applied as behavior rules, not copied as a new architecture:

- Think before coding.
- Keep the solution simple.
- Make surgical changes.
- Define verifiable success criteria and loop until verified.

## Absolute Hard Rules

- Do not change code, tests, config, docs, data, prompts, workflows, generated files, or repo state unless the user has clearly allowed that scope.
- Do not change Friday's vision, architecture direction, safety policy, approval semantics, memory semantics, release proof standard, or product behavior by assumption.
- Do not add compatibility layers, fallback paths, defensive code, silent degradation, alternate routes, disabled fallbacks, or broad guards unless they are necessary for a proven fail-closed safety boundary and the user has approved that boundary.
- Do not use "minimum change" as an excuse to patch symptoms while leaving root cause or other live routes open.
- Do not overbuild. If the complete fix is 100 lines, do not write 200. If a small fix leaves a route unclosed, it is not complete.
- Do not add abstractions for one-time code, speculative flexibility, or future cases that were not requested.
- Do not refactor unrelated code.
- Do not reformat unrelated code.
- Do not improve adjacent comments, names, imports, style, or structure unless your own change made that cleanup necessary.
- Do not delete pre-existing dead code unless the user explicitly asks.
- Do not change tests to weaken requirements, hide failures, skip coverage, or make fake proof pass.
- Do not treat mock-only tests, green CI, stubs, skipped tests, FAST_MODE, disabled routes, or local assumptions as real closure proof.
- Do not write or echo API keys, tokens, passkeys, cookies, secret fragments, or credentials into files, logs, screenshots, prompts, reports, tests, or commits.
- Do not run destructive git commands, broad resets, broad checkout, or `git add .`.

## Ask-Before-Act Rules

Stop and ask the user before acting if:

- A new problem appears.
- A new route or bypass appears.
- A new implementation choice appears.
- The current facts conflict with an earlier decision.
- A reviewer fails or reviewers disagree.
- A mechanism might be intentionally designed this way.
- A fix touches safety, permissions, approval, secrets, tokens, sockets, remote control, MCP, providers, channels, system runtime, memory, context compression, self-modification, workflow execution, skill execution, plugin trust, release proof, or default-on behavior.
- A fix touches protected/user/historical dirty files or pending-review hunks.
- A fix would alter test expectations, acceptance criteria, or release gates.
- You do not fully understand the root cause.

When asking, use a human-friendly format:

- Explain the finding in plain language.
- Give a concrete example.
- Offer 2-3 options.
- Mark the recommended option.
- Explain UX, architecture, safety, and later-phase impact.
- Ask only the important blocking questions; do not flood the user.

Low-risk verification commands and read-only investigation may proceed without asking, but any mutation or new boundary decision must be confirmed first.

## Bug-Fix Root Cause Protocol

For bugs, failures, regressions, or reviewer blockers:

1. Reproduce or identify the concrete failing route.
2. Trace every live entrypoint that can reach the same behavior.
3. Identify the root cause, not just the first symptom.
4. Check whether the current behavior is intentional.
5. Ask before changing if the fix affects a boundary or previously chosen direction.
6. Add or run tests that prove the bug route is closed.
7. Run regression checks for nearby routes that should still work.

Do not "just patch" without finding root cause. Do not stop after closing one route if equivalent routes remain open.

## Surgical Change Protocol

Every changed line must trace directly to the approved goal.

Before editing, state:

- Target file.
- Why this file must change.
- Whether it is clean, dirty, protected, pending-review, or already modified by this phase.
- What route/state/approval/memory/evidence/test/UX line is affected.
- How it will be verified.

Inside an approved subphase, you do not need per-hunk approval unless a new risk appears. If a new risk appears, stop immediately.

## Friday-Specific Closure Rules

Friday's target is a stable core plus pluggable Lego system:

- Capability must not be available until validation, approval, evidence, and rollback are real.
- Mutating actions must pass the approved gate for that surface.
- External skills, workflows, plugins, providers, and MCP must not become agent-available until their lifecycle is closed.
- Memory, UI preferences, runtime evidence, and inferred/candidate memories must stay separate.
- Guide Lens preferences/avatar may persist, but must not pollute memory.
- High-impact safety/execution/memory/testing/automation preferences require Review Center or equivalent approved confirmation before durable activation.
- Self-heal and self-upgrade must produce plan, diff, tests, evidence, rollback pointer, reviewer results, and user-visible summary.
- Context compaction must reload the master prompt, current ledger, current git status/diff, and relevant findings before acting.
- Release/default-on proof must be real runtime/provider/browser/manual evidence, not mock-only proof.

## Verification Protocol

Before staging any meaningful change:

- Run focused tests for the touched route.
- Run typecheck when TypeScript contracts can be affected.
- Run lint when touched files can affect lint.
- Run `git diff --check`.
- Run secret scan when keys or secret-like context were involved.
- Inspect `git status --short --branch`.
- Use two isolated read-only reviewers for meaningful subphases.
- If either reviewer fails, fix only the blocker inside approved scope, then rerun verification and reviewers.

## Git Protocol

- Never use `git add .`.
- Prefer hunk-stage or exact file/patch stage.
- Stage only approved files/hunks.
- Inspect `git diff --cached --name-status`.
- Inspect `git diff --cached --check`.
- Confirm staged diff belongs only to the approved subphase.
- Do not stage protected/user/historical dirty changes.
- Do not stage pending-review hunks unless explicitly approved.
- Commit and push only after verification and reviewers pass, unless the user explicitly chooses a different workflow.

## Existing Friday Workspace Rules

The rules in `context/AGENTS.md` remain active. In particular:

- Default reply language is Chinese unless the user asks otherwise.
- Separate confirmed facts from recommendations or inferences.
- Use absolute dates when clarifying time-sensitive requests.
- Prefer existing Friday skills/workflows before creating new ones.
- Keep destructive or high-risk actions approval-gated and summarize evidence before execution.
- When docs conflict, prefer `docs/current-source-of-truth.md` and current runtime behavior.

## Karpathy Guideline Mapping For Friday

Think before coding:

- Do not silently choose an interpretation.
- Do not hide confusion.
- Surface tradeoffs before implementation.

Simplicity first:

- Build the smallest complete fix.
- No speculative abstraction.
- No unnecessary fallback, compatibility, configurability, or defensive code.

Surgical changes:

- Touch only what is required.
- Match existing style.
- Clean up only artifacts introduced by your own change.

Goal-driven execution:

- Convert tasks into verifiable success criteria.
- For bug fixes, prove the failing route fails before or is clearly identified, then prove it is fixed.
- Loop until the approved goal is actually verified.
