> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Quality Gate

Date: 2026-03-04 (America/Los_Angeles)

## One-Command Gate (recommended)

```bash
cd .
npm run -s typecheck \
  && npm run -s lint \
  && npm run -s check:alignment \
  && npm run -s test -- \
      test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
      test/e2e/api/friday-api-workflows-routes.test.ts \
      test/e2e/api/friday-api-auth-rbac-errors.test.ts \
      test/integration/marketplace/friday-marketplace-install-closure.test.ts \
      test/integration/agent/friday-browser-resilience-integration.test.ts
```

## Executed in This Audit

1. `npm run -s typecheck` -> pass
2. `npm run -s lint` -> pass
3. `npm run -s check:alignment` -> pass
4. targeted e2e/integration command above -> pass (`5 files`, `51 passed`, `1 skipped`)

## CI Recommendation

Add/ensure these stages in CI (blocking):

1. `typecheck`
2. `lint`
3. `check:alignment`
4. `e2e-closure-targeted` (the 5-file route/failure closure pack)

Optional nightly expansion:

1. full `npm test`
2. `npm run -s test:contracts`
3. `npm run -s test:integration:openclaw-overlap`
