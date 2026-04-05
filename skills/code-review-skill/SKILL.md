# Code Review Skill

Reviews code for bugs, inefficiencies, and adherence to best practices, providing actionable improvement suggestions.

Design pattern: **Reviewer**

## Review Protocol

1. Load the checklist from `references/review-checklist.md`.
2. Analyze every changed file against each checklist section (Critical → High → Medium → Low).
3. For each finding, report:
   - **Severity** (critical / high / medium / low)
   - **Location** (file:line)
   - **Issue** (what is wrong)
   - **Fix** (concrete code suggestion)
4. Group findings by severity, then by file.
5. End with a summary: total findings per severity, overall verdict (approve / request changes).

## Constraints

- Do NOT invent issues that are not evidenced in the code.
- Mark severity accurately — false critical findings erode trust.
- If no issues are found, say so explicitly.

Typical triggers:

- `review this code`
- `find bugs in this code`
- `code quality check`
- `suggest improvements for this code`
