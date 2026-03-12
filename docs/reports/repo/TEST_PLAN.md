> Status: Historical report. This file is retained for audit and evidence; if it conflicts with current behavior, prefer [`docs/current-source-of-truth.md`](../../current-source-of-truth.md).

# Test Plan

Date: 2026-03-04 (America/Los_Angeles)

## Executed Command

```bash
cd .
npm run -s test -- \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  test/e2e/api/friday-api-workflows-routes.test.ts \
  test/e2e/api/friday-api-auth-rbac-errors.test.ts \
  test/integration/marketplace/friday-marketplace-install-closure.test.ts \
  test/integration/agent/friday-browser-resilience-integration.test.ts
```

Result summary:

- Test files: `5 passed`
- Tests: `51 passed`, `1 skipped`
- Type errors: none

## Core Route E2E (Success)

| Promise | Test file + case | Assertion focus | User-visible closure evidence | Artifact / output |
|---|---|---|---|---|
| P2 channel message closure | `test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts` -> `G route closure: webchat completed run returns user-visible message plus image artifacts` | outbound text + image | user receives completion + attachment | `reports/enablement/artifacts/browser-screenshot-1772680584314.png` |
| P5 browser artifact closure | same file -> `C/G route closure: browser screenshot produces user-visible artifact path and on-disk file` | path exists and file size > 0 | artifact path propagated to output | `reports/enablement/artifacts/browser-screenshot-1772680584314.png` |
| P6 desktop enabled closure | same file -> `desktop enabled route closure: desktop tool executes session_info and returns user-visible response` | desktop tool call succeeds | user-visible desktop session_info response | `reports/enablement/artifacts/desktop-session-info-1772680586722.json` |
| P6 mcp enabled closure | same file -> `mcp enabled route closure: mcp tool lists configured servers and returns user-visible response` | mcp tool success | returned server list visible to user | `reports/enablement/artifacts/mcp-list-servers-1772680586843.json` |
| P2 Discord delivery closure | same file -> `G2 route closure: discord inbound message produces user-visible outbound message with attached artifact file` | outbound message + attachment bytes | user sees Discord reply and artifact | `reports/enablement/artifacts/discord-attachment-1772680587764-1772680587442-tab-1.png` |
| P4 workflow route closure | `test/e2e/api/friday-api-workflows-routes.test.ts` | run lifecycle + timeline/evidence endpoints | API consumer can fetch run state and evidence exports | JSON response envelopes with `requestId` |

## Failure Path Coverage (>=5)

| Failure scenario | Test file + case | Expected behavior | Evidence |
|---|---|---|---|
| Webchat run failure message | openclaw parity -> `G route closure: webchat failed run returns explicit user-facing failure message` | clear user-facing failure text | terminal status `failed` + outbound failure text |
| Scheduler failure surfaces error | openclaw parity -> `E route failure path: scheduler cron automation surfaces error state for failed runs` | failure state persisted and visible | test assertion on cron failure state |
| Provider detect missing key | openclaw parity -> `D/H failure path: setup provider detect returns code + readable error for missing api key` | readable error + code | structured error assertion |
| Feature not enabled | openclaw parity -> `F route unsupported path: observability API returns explicit not-enabled message` | explicit not-enabled message (not silent 404) | message contains `Observability API is not enabled` |
| Desktop disabled gate | openclaw parity -> `desktop disabled failure path...` | explicit enablement hint + tool error code | includes `FRIDAY_DESKTOP_ENABLED=true`, `AGENT_TOOL_ERROR` |
| Discord failed run | openclaw parity -> `G2 route failure path...` | user receives failure text | outbound failure message asserted |
| Discord primary delivery failure | openclaw parity -> `G2 delivery failure closure...` | fallback send with traceable error code | logs contain `E-CH-OUTBOUND-001` and fallback text |
| API auth/rbac rejection paths | `test/e2e/api/friday-api-auth-rbac-errors.test.ts` | uniform `{ok:false,error,requestId}` behavior | 12 tests (1 skipped), includes 401/403/404/429 contract checks |
| Marketplace install gate rejection | `test/integration/marketplace/friday-marketplace-install-closure.test.ts` | explicit install/entitlement codes | asserts `MARKETPLACE_INSTALL_REQUIRED` / `MARKETPLACE_ENTITLEMENT_REQUIRED` |
| Browser resilience failures | `test/integration/agent/friday-browser-resilience-integration.test.ts` | timeout/disconnect/unavailable handled | 6 tests passed |

## Evidence Paths

- Artifacts:
  - `reports/enablement/artifacts/browser-screenshot-1772680584314.png`
  - `reports/enablement/artifacts/desktop-session-info-1772680586722.json`
  - `reports/enablement/artifacts/desktop-disabled-tool-result-1772680586784.txt`
  - `reports/enablement/artifacts/mcp-list-servers-1772680586843.json`
  - `reports/enablement/artifacts/mcp-input-recovery-1772680586899.json`
  - `reports/enablement/artifacts/discord-attachment-1772680587764-1772680587442-tab-1.png`
