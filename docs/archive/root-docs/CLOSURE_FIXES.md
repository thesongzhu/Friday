> Status: Superseded historical root document. Retained for archive purposes; prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md) and the [`Documentation Hub`](../../README.md).

# Closure Fixes

Date: 2026-03-04 (America/Los_Angeles)

## Applied in This Sweep

## F1 - Remove duplicated generated managed-skills fixtures

- Problem:
  - 11 historical `managed-skills/e2e-date-skill-*` directories were committed and loaded by default skill scanning.
- Evidence:
  - `git ls-files managed-skills/e2e-date-skill-*`
  - Hub default includes `managed-skills`: `src/hub/friday-hub-bootstrap.ts:256`
  - No static reference to these specific paths: `rg -n "e2e-date-skill-|managed-skills/e2e" src test scripts docs`
- Fix:
  - Deleted all `managed-skills/e2e-date-skill-*` directories.
  - Added `.gitignore` guard: `managed-skills/e2e-date-skill-*/`.
- Closure impact:
  - Removes startup scan noise and fixture drift risk.

## F2 - Prune duplicated historical enablement artifacts

- Problem:
  - Multiple timestamp waves of screenshot/desktop/discord artifacts were committed with no additional route value.
- Evidence:
  - `git ls-files reports/enablement/artifacts`
  - `E2E_RESULTS.md` references only latest `177267509*` set.
- Fix:
  - Deleted older `177267358*` and `177267390*` artifact wave files.
  - Added `.gitignore` guard: `reports/enablement/artifacts/*` and kept `!reports/enablement/artifacts/.gitkeep`.
- Closure impact:
  - Keeps one traceable evidence set while preventing future artifact sprawl.

## F3 - Preserve artifact directory contract safely

- Problem:
  - Ignoring entire artifact directory risks accidental removal from repo structure.
- Fix:
  - Added `reports/enablement/artifacts/.gitkeep`.
- Closure impact:
  - CI/docs paths remain stable while generated files stay out of Git by default.

## Deferred (Documented, Not Changed)

## D1 - Shared history-hydration helper extraction

- Current state:
  - Similar history load/dedupe/trim logic exists in hub, API runtime, and sessions tool.
- Why deferred:
  - Refactor touches core message context behavior; requires dedicated regression matrix.
- Guardrail now:
  - Existing route tests cover channel/API/session run behavior.
