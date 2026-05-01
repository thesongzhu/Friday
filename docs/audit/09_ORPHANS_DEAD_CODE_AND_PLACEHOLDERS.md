# Phase 10 - Orphans, Dead Code, and Placeholder Hunt

Search terms included TODO, FIXME, HACK, mock, fake, demo, placeholder, stub, sample, hardcoded, test user, bypass, temporary, not implemented, coming soon, console.log, return true, disabled checks, empty catches, marketplace, and passwordless.

## High-Signal Findings

| Severity | Finding | Evidence | Current Status |
| --- | --- | --- | --- |
| P1 resolved | Marketplace product mechanism kept appearing after being disabled. | Active-scope `rg` over `src ui scripts test package.json .env.example` returned no marketplace refs. | Resolved by PR #171. |
| P1 resolved | Passwordless/local bypass references remained in UI/tests/scripts. | Active-scope `rg` returned no `FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN`, `allowPasswordlessLocalLogin`, or `{ local: true }`. | Resolved. |
| P1 | Channel implementations expose stubs as production-looking services. | WhatsApp/Signal/IRC/LINE/Slack/Discord-related tests and services still include stub/sandbox behavior. | Open capability-truth risk. |
| P1 | Plugin UI/runtime can still be disabled or stub-like. | Plugin tests pass, but UI needs clear capability state. | Open UX/truth risk. |
| P2 | API/E2E tests still use stubs/mocks in places. | Contract/API/mock hub tests pass, but many live lanes are skipped. | Open evidence-labeling risk. |
| P2 | Dirty workspace contains duplicate untracked files. | `docs/audit/* 2.md`, `src/state/sqlite/migrations/* 3.ts`, duplicate reflex/workflow files. | Local hygiene issue; not part of branch. |

## Additional Observations

- Many stderr logs during tests are intentional malformed-input/failure-path assertions.
- Some `return true` hits are legitimate predicates; permissive unknown rate-limit policy remains a separate P2 security design item.
- `dist/` can contain stale compiled artifacts from earlier builds; active source/test/script scope is the canonical check for marketplace removal.

## Recommended Cleanup

1. Remove or quarantine local untracked duplicate files outside this branch.
2. Add a capabilities matrix that labels real, stub, disabled, and sandbox-only channel/plugin modes in API and UI.
3. Split mock proof from closed-loop proof in CI status names.
4. Add dead-code/unused export tooling once the live smoke lanes are stable.
