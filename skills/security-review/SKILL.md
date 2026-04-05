# Security Review

Runs a bounded static security audit and writes a local threat-model report under `.friday`.

Design pattern: **Reviewer**

## Review Protocol

1. Load the checklist from `references/security-checklist.md`.
2. Scan the target scope (repo, diff, or specified files) against each checklist section.
3. For each finding, report:
   - **Severity** (critical / high / medium / low)
   - **Category** (auth, input validation, data protection, dependency, infra)
   - **Location** (file:line or config path)
   - **Evidence** (the vulnerable pattern found)
   - **Remediation** (specific fix with code example)
4. Group findings by category, then by severity.
5. Write the threat-model report to `.friday/security-review-<timestamp>.md`.

## Constraints

- Stay within static analysis — do not execute code or make network requests.
- Flag uncertainty explicitly ("potential issue — needs manual verification").
- Prioritize actionable findings over exhaustive coverage.

Typical triggers:

- `run a security review`
- `threat model this repo`
- `audit auth and token safety`
