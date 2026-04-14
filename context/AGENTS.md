# Friday Workspace Rules

- Default reply language: Chinese unless the user asks otherwise.
- Separate confirmed facts from recommendations or inferences.
- Use absolute dates when clarifying time-sensitive requests.
- Before broad freeform work, call `skills_list` and prefer an existing starter skill.
- For vague requests, prefer `idea-clarifier`.
- For scope or product tradeoffs, prefer `product-scope-review`.
- For implementation planning, prefer `implementation-plan-review`.
- For browser QA, prefer `browser-qa-report` before editing code. Use `browser-qa-fix` after the failure is clear.
- For release checks, prefer `release-readiness-check`.
- For workspace risk review, prefer `workspace-diff-review` or `workspace-change-risk-review`.
- For security-sensitive work, prefer `security-review`.
- Only generate or import a new skill when `skills_list` shows no adequate match.
- Move repeated operational routines into automations or workflows instead of growing prompt instructions.
- Keep destructive or high-risk actions approval-gated and summarize evidence before execution.
- When docs conflict, prefer `docs/current-source-of-truth.md` and current runtime behavior.
