> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Repo Hygiene Cleanup

Date: 2026-03-04 (America/Los_Angeles)

## Applied Cleanup

1. Deleted generated duplicate fixtures:
   - `managed-skills/e2e-date-skill-*` (11 directories)
2. Deleted stale historical evidence artifacts:
   - old timestamp wave files under `reports/enablement/artifacts/`
3. Updated `.gitignore`:
   - `managed-skills/e2e-date-skill-*/`
   - `reports/enablement/artifacts/*`
   - `!reports/enablement/artifacts/.gitkeep`
4. Added keepfile:
   - `reports/enablement/artifacts/.gitkeep`

## Delete/Archive Candidates (Remaining)

## H1 - `src/routing/*` reply-routing runtime not wired in hub/api composition

- Paths:
  - `src/routing/friday-reply-routing-service.ts`
  - `src/routing/friday-reply-route-repository.ts`
  - `src/routing/friday-reply-queue-repository.ts`
  - `src/routing/friday-reply-queue-job.ts`
- Reason:
  - No production callsite found in `src/hub` or `src/api`.
- Risk level: Medium
- Rollback:
  - keep module as-is (current state) until integration or formal deprecation decision.

## H2 - Docs-only reference payloads with legacy TODO matrices

- Paths:
  - `docs/reports/ops/friday-openclaw-bridge-matrix-2026-03-01.csv`
  - similar design matrices under `docs/reports/ops/`
- Reason:
  - Contains many stale TODO records unrelated to current runtime contract.
- Risk level: Low
- Rollback:
  - archive to date-stamped folder (`docs/archive/`) instead of deletion.

## Dependency Cleanup Suggestions

Evidence command:

```bash
cd .
npx --yes depcheck --json
```

Observed candidates (needs manual verification before removal):

1. `@tailwindcss/postcss` (devDependency)
2. `autoprefixer` (devDependency)
3. `postcss` (devDependency)
4. `shadcn` (devDependency)

Important note:

- `ui/postcss.config.cjs` currently references `@tailwindcss/postcss` and `autoprefixer`, so these are likely active in UI build pipeline.
- `depcheck` also reports parse noise in one test file and docs-only pseudo imports; treat output as advisory, not auto-delete authority.

## .gitignore Recommendations (Status)

- Implemented now:
  - generated managed skill timestamp folders blocked
  - generated enablement artifacts blocked
- Existing good rules retained:
  - `node_modules/`, `dist/`, `coverage/`, `.env*`, `.friday/`

## Validation Steps After Cleanup

```bash
npm run -s typecheck
npm run -s lint
npm run -s test -- test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts
```

All passed in this sweep.
