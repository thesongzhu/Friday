# Design Plan Review

Reviews a UI or UX plan before implementation.

Design pattern: **Reviewer**

## Review Protocol

1. Load the checklist from `references/design-checklist.md`.
2. Evaluate the plan against each checklist section (User Experience → Information Architecture → Visual Design → Feasibility).
3. For each finding, report:
   - **Severity** (blocker / should-fix / suggestion)
   - **Section** (which checklist area)
   - **Issue** (what is missing or problematic)
   - **Recommendation** (concrete improvement)
4. Group findings by severity.
5. End with a verdict: ready for implementation / needs revision.

## Constraints

- Evaluate the plan as described — do not redesign it.
- Feasibility concerns should reference specific technical constraints.

Typical triggers:

- `review this design plan`
- `design critique this plan`
- `ui review before implementation`
