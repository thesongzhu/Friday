# Workspace Diff Review

Reviews the current workspace diff with a pre-landing mindset.

Design pattern: **Reviewer**

## Review Protocol

1. Load the checklist from `references/diff-review-checklist.md`.
2. Run `git diff` to capture the current workspace changes.
3. Evaluate each changed file against the checklist sections (Risk Assessment → Correctness → Landing Safety).
4. For each finding, report:
   - **Severity** (blocker / warning / info)
   - **File** and line range
   - **Issue** (what is risky or incorrect)
   - **Action** (what to do before landing)
5. Summarize: risky hotspots, missing validation coverage, and the next landing-safe action.

## Constraints

- Focus on the diff, not the entire codebase.
- A clean diff with no findings should produce a short "ready to land" confirmation.

Typical triggers:

- `review current changes`
- `review this diff`
- `what is risky in my current workspace changes`
