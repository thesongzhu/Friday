# Phase 10 - Orphans, Dead Code, and Placeholder Hunt

Search terms included TODO, FIXME, HACK, mock, fake, demo, placeholder, stub, sample, hardcoded, test user, bypass, temporary, not implemented, coming soon, console.log, return true, disabled checks, and empty catches.

## High-Signal Findings

| Severity | Finding | Evidence | Risk |
| --- | --- | --- | --- |
| P1 | Channel implementations expose stubs as production-looking services. | `src/channels/whatsapp/whatsapp-service.ts:2,293`; `src/channels/signal/signal-service.ts:2`; `src/channels/irc/irc-service.ts`; `src/channels/line/line-service.ts`; `src/channels/slack/slack-service.ts`; Discord outbound stub comments/results. | UI can imply channel support while external delivery is not closed loop. |
| P1 | Plugin UI explicitly supports stub runtime mode. | `ui/src/routes/plugins-page.tsx:196,338`. | User may believe plugin runtime is active when machine is in stub mode. |
| P1 | Billing handler exists without route. | `src/marketplace/billing/friday-billing-webhook-handler.ts`; no registered route found. | Dead/unwired billing subsystem. |
| P2 | API E2E tests use stubs/mocks. | `test/e2e/api/friday-api-plugins-routes.test.ts` throws "not implemented in e2e stub"; skills route E2E uses `mock-skill-converter`; workflow API E2E uses placeholder IDs. | Passing tests overstate wiring. |
| P2 | Release truth process acknowledges mock evidence cannot prove shipping. | `.github/pull_request_template.md:21`. | Good policy, but current local evidence still has many mock/skipped paths. |
| P2 | Missing test file referenced by Vitest. | `npm test` failed on `test/unit/reflex/friday-reflex-routes.test.ts`. | Test suite cannot go green until file/config mismatch is fixed. |

## Additional Observations

- Many `console.log` hits are scripts/CI, acceptable but noisy.
- Tests intentionally exercise malformed input and log expected errors; these should be separated from unexpected stderr in CI.
- UI placeholders are mostly form placeholder text, not product fake data.
- Some `return true` hits are legitimate predicates, but permissive unknown rate-limit policy is a real concern.

## Recommended Cleanup

1. Add a capabilities matrix that labels real, stub, disabled, and sandbox-only channel/plugin modes in API and UI.
2. Remove or quarantine unwired billing code until the route and processor are implemented.
3. Fix missing reflex test reference.
4. Split mock proof from closed-loop proof in CI status names.
5. Add dead-code/unused export tooling once the test suite is stable.
