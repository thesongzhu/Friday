# `bede50d` Release-Gate Review

Date: 2026-03-29

Scope:
- Reviewed target commit: `bede50d73b4c2777f24694d525598ae5f3c9d1fa`
- Validation was executed against a separate snapshot at `/tmp/friday-bede50d-clone`
- Verdict standard: full-product scope + release gate

## Verdict

`bede50d` does **not** meet the release gate for "Friday is stable and ready to use" under a full-product claim.

Reason:
- There is a real user-facing product-path break in the new home flow.
- The cross-platform release baseline is not backed by required release inputs or completed evidence.
- The public download documentation still contains at least one broken internal link while serving as release guidance.

## Findings

### 1. Blocker: Home page can send users into an unsupported guided flow

Severity: blocker

Evidence:
- [`ui/src/routes/home-page.tsx:131`](/tmp/friday-bede50d-clone/ui/src/routes/home-page.tsx:131) shows the "Show all goals" button navigating to `"/flow/browse"`.
- [`src/uix/services/friday-uix-surface-service.ts:2021`](/tmp/friday-bede50d-clone/src/uix/services/friday-uix-surface-service.ts:2021) defines the allowed wizard IDs, and `browse` is not present.
- [`src/uix/services/friday-uix-surface-service.ts:2036`](/tmp/friday-bede50d-clone/src/uix/services/friday-uix-surface-service.ts:2036) rejects unknown wizard IDs with `UIX_GUIDED_WORKFLOW_NOT_FOUND`.

Impact:
- A first-class CTA on the new home page leads to a route that renders, but cannot start its backend wizard contract.
- This is exactly the kind of logic/link gap that disqualifies a release-gate approval.

### 2. Blocker: Cross-platform release claims are ahead of actual release readiness

Severity: blocker

Evidence:
- [`docs/ops/friday-cross-platform-downloads.md:5`](/tmp/friday-bede50d-clone/docs/ops/friday-cross-platform-downloads.md:5) defines the current milestone as a phased cross-platform release baseline.
- [`docs/ops/friday-cross-platform-downloads.md:25`](/tmp/friday-bede50d-clone/docs/ops/friday-cross-platform-downloads.md:25) describes macOS as a "Shipping beta baseline".
- [`scripts/ops/check-friday-cross-platform-release-inputs.sh:111`](/tmp/friday-bede50d-clone/scripts/ops/check-friday-cross-platform-release-inputs.sh:111) treats signing, store credentials, smoke targets, and archived evidence as required inputs.
- Running `npm run check:cross-platform-release-inputs` failed with 29 missing required items.
- [`docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md:21`](/tmp/friday-bede50d-clone/docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md:21) is still `Status: pending`.
- [`docs/reports/ops/cross-platform-agent-os-beta-evidence/ios-latest-device-smoke.md:15`](/tmp/friday-bede50d-clone/docs/reports/ops/cross-platform-agent-os-beta-evidence/ios-latest-device-smoke.md:15) is still `Status: pending`.

Missing categories from the failed check:
- macOS signing/notary/Sparkle/Homebrew publication inputs
- iOS App Store Connect/TestFlight inputs
- Android keystore/Play publication inputs
- Windows `dotnet` + code-signing inputs
- recorded smoke targets for all four platforms
- complete archived evidence for macOS, iOS, Android, and Windows

Impact:
- Under a full-product release claim, this is a hard blocker.
- The repo can truthfully claim "work in progress" or "source/developer path available", but not that the cross-platform Agent OS baseline is release-ready.

### 3. Medium: Cross-platform download guide has a broken internal checklist link

Severity: medium

Evidence:
- [`docs/ops/friday-cross-platform-downloads.md:12`](/tmp/friday-bede50d-clone/docs/ops/friday-cross-platform-downloads.md:12) links to `./docs/ops/friday-cross-platform-agent-os-completion-checklist.md`.
- From that file's directory, the correct relative target is the sibling file, not `./docs/ops/...`.
- The nested target does not exist, while the direct sibling does:
  - missing: `/tmp/friday-bede50d-clone/docs/ops/docs/ops/friday-cross-platform-agent-os-completion-checklist.md`
  - present: `/tmp/friday-bede50d-clone/docs/ops/friday-cross-platform-agent-os-completion-checklist.md`

Impact:
- The document intended to justify release readiness points to a dead path.
- This does not create runtime breakage, but it weakens release evidence navigation and public trust.

## Verified Surfaces

These checks passed on `/tmp/friday-bede50d-clone`:

- `npm run typecheck`
- `npm run build`
- `npm run test:contracts:routes`
- `npm run test:e2e:ui`
- `npx vitest run test/e2e/setup-wizard.e2e.test.ts`
- `npx vitest run test/e2e/mock/friday-mock-security.e2e.test.ts`
- `npx vitest run test/e2e/mock/friday-mock-web-routing.e2e.test.ts`
- `npx vitest run test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts`
- `npm run release:check`

Behavior confirmed by code + test evidence:
- Setup, login, onboarding, and home routing chain is internally consistent:
  - [`ui/src/router.tsx:90`](/tmp/friday-bede50d-clone/ui/src/router.tsx:90)
  - [`ui/src/routes/login-page.tsx:24`](/tmp/friday-bede50d-clone/ui/src/routes/login-page.tsx:24)
  - [`ui/src/routes/onboarding-page.tsx:177`](/tmp/friday-bede50d-clone/ui/src/routes/onboarding-page.tsx:177)
  - [`ui/src/routes/setup-page.tsx:320`](/tmp/friday-bede50d-clone/ui/src/routes/setup-page.tsx:320)
- Setup failure states expose actionable remediation text rather than silent failure:
  - [`ui/src/lib/setup/setup-status-diagnostics.ts:21`](/tmp/friday-bede50d-clone/ui/src/lib/setup/setup-status-diagnostics.ts:21)
- The built UI artifact is present and complete enough to package locally:
  - `dist/ui` size after build: `5.9M`

## `7924091..bede50d` Change-Scope Coverage

Grouped review of the 11-commit diff:

| Surface | Representative files | Coverage status |
| --- | --- | --- |
| auth/setup | `src/api/http/routes/friday-auth-routes.ts`, `src/api/http/routes/friday-setup-routes.ts` | automated coverage present via setup E2E and browser E2E |
| provider detection/auth mode | `src/providers/services/friday-provider-service.ts` | automated coverage present via setup E2E fake-key and OAuth tests |
| HTTP runtime wiring | `src/api/http/friday-http-server.ts`, `src/api/runtime/friday-api-runtime.ts` | automated coverage present indirectly via route contracts, setup E2E, browser E2E, parity E2E |
| realtime/ws | `src/api/realtime/friday-realtime-ws-gateway.ts` | automated coverage present indirectly via browser journeys and parity closure; no isolated ws-only audit in this pass |
| agent runtime / hub bootstrap | `src/agent/runtime/*`, `src/hub/friday-hub-bootstrap.ts`, `src/hub/bootstrap/hub-helpers.ts` | mixed: strong behavior coverage from security/web-routing/parity E2E; exact internal branch coverage remains partly static |
| CLI loop | `src/cli/friday-cli.ts`, `src/cli/friday-cli-run-loop.ts` | static evidence only in this pass |
| release / packaging | `scripts/ops/publish-friday-homebrew-cask.sh`, release-input checks | automated coverage present for packaging manifest and release-input gate; real publication not verified |

## Uncovered Or Not Fully Covered

These areas were not treated as passed release evidence:

- `npm run release:verify` was not executed end-to-end in this pass.
- No real device or clean-machine install was executed for macOS, iOS, Android, or Windows.
- No real Sparkle, Homebrew, TestFlight, Play, or Windows signing/publishing flow was exercised.
- No cloud-ready claim was validated.
- No full manual click-through was performed for every query-param permutation inside assistant/workflows/skills/fleet/observability pages; this review focused on declared entrypoints and known high-risk paths.

## Priority

Before any "stable to use" release claim at full-product scope:

1. Remove or implement the `/flow/browse` path so every home-page CTA is real.
2. Downgrade cross-platform public claims or complete the missing 29 release inputs/evidence items.
3. Fix broken internal release-doc links, starting with the completion-checklist link in the download guide.

## Commands Run

Executed against `/tmp/friday-bede50d-clone`:

```bash
npm run typecheck
npm run build
npm run test:contracts:routes
npm run test:e2e:ui
npx vitest run test/e2e/setup-wizard.e2e.test.ts
npx vitest run test/e2e/mock/friday-mock-security.e2e.test.ts
npx vitest run test/e2e/mock/friday-mock-web-routing.e2e.test.ts
npx vitest run test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts
npm run release:check
npm run check:cross-platform-release-inputs
```

Result summary:
- 9 checks passed
- 1 release-input gate failed
