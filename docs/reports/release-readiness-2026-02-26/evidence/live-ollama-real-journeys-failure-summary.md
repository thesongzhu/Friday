> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Live Ollama Journeys Failure Summary (Captured from test run output)

Source run:
- Command: `FRIDAY_E2E_LIVE_OLLAMA=1 npx vitest run test/e2e/live/friday-real-journeys.e2e.test.ts`
- Result: `10 tests | 8 failed | 2 passed`
- Duration: `913.09s`

Key failure signatures observed in stderr output:

1. Scenario 2
- Assertion failed: `expected false to be true`
- File: `test/e2e/live/friday-real-journeys.e2e.test.ts:293`
- Symptom: `generationSucceeded` remained `false`.

2. Scenario 4/6/10 and others
- API error payload repeatedly returned: `TOKEN_EXPIRED` with message `Token has expired`.
- Example location: `test/e2e/live/_helpers/api.ts:83` (from `setModelRouting`).

3. Scenario 5/7/9
- Unauthorized responses after earlier long-running steps.
- Assertions failed with status mismatch: `expected 200` but received `401`.

Interpretation:
- The suite runs long enough to cross default access token lifetime; later scenario calls use expired token without refresh.
