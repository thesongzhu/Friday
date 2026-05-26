# B0 Slice A — UI E2E Failure Triage

Generated: 2026-05-23
Slice: `B0_security_approval_secrets_system_boundary` Slice A (public-mutation gate)
Worktree: `/Users/example/Projects/Friday-b0-public-mutation-gate`
Base SHA: `dd3686c9600a55b602f4b2fc611f58e13844272d`

## Context

Slice A introduces a server-level public-mutation safety floor (`src/api/http/friday-http-server.ts`) that rejects POST/PUT/PATCH/DELETE on `auth:{public:true}` routes when the request resolves to the synthetic default-public principal, unless the route declares `allowUnauthenticatedMutation: true` AND its handler enforces an alternative trust boundary.

After applying 13 verified carve-outs and flipping 6 server-mechanic unit tests, the full test suite shrinks from **40 → 20 failures**. All 20 remaining failures are Playwright browser tests under `test/e2e/ui/*` that share `_helpers/browser-env-mock.ts`. None are unit, contract, mock-API, or non-browser e2e failures.

## Why these still fail

`_helpers/browser-env-mock.ts:80-117` mints a Bearer access token via `createMockHubEnv` and uses it in:

- `completeSetup()` (line 56-78) — Authorization Bearer ✓
- `apiFetch()` (line 107-117) — Authorization Bearer ✓

BUT the Playwright-driven browser page (`newPage()` line 118+) loads the built UI bundle from `dist/ui`. The UI app code does not currently read the test fixture's accessToken from any storage and does not send `Authorization` on its API calls — production posture is "no Authorization header required". With Slice A's gate active, the UI's unauthenticated POST/PUT/PATCH/DELETE calls now return 401 `OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED`.

This is **real product gap**, not test-fixture noise: production UI relied on the synthetic-public-principal bypass for mutating API calls, and the gate correctly closes that bypass.

## Per-test classification

Per the user's strict criteria: classify each as **UI auth-token wiring follow-up** (authenticated app route — UI must learn to send Authorization; do NOT broad-carve-out), **legit pre-auth route** (route must satisfy verifier/boundary + negative test before opting in; carve-out is a separate slice), or **shared test fixture only** (UI fixture missing bound-principal mock, prod actually sends token; fix shared fixture).

| Test | Hits API route(s) | Classification | Follow-up slice |
|---|---|---|---|
| `friday-agent-os-browser-journeys.test.ts` (×7) | agent.runs.start (POST), agent.runs.cancel (POST), uix.intents.resolve (POST), uix.templates.execute (POST) | UI auth-token wiring follow-up | Slice A2: UI auth-token wiring |
| `friday-cross-border-pack-setup.e2e.test.ts` | packs.cross.border.profile.put (PUT), packs.cross.border.workflow.presets.apply (POST) | UI auth-token wiring follow-up | Slice A2 |
| `friday-deep-link-import.e2e.test.ts` (×2) | skills.list (GET — unaffected) and POST routes during render | UI auth-token wiring follow-up (cascade from setup or initial render) | Slice A2 |
| `friday-full-onboarding.e2e.test.ts` (×2) | setup.network.save / setup.channels.* / setup.complete (POST) | Legit pre-auth route — needs carve-out + negative tests | Slice A3: setup-route carve-outs |
| `friday-mobile-viewport.e2e.test.ts` (×2) | initial render hits sessions.create or memory.search (POST) via app boot | UI auth-token wiring follow-up | Slice A2 |
| `friday-real-browser-onboarding.e2e.test.ts` | auth.bootstrap.local.passphrase (POST — already carved out in Slice A) + setup.network.save | Legit pre-auth route — partial; setup.* still needs carve-out | Slice A3 |
| `friday-settings-supervisor-mode-default.e2e.test.ts` | reflex.preferences.update (PATCH), uix.preferences.update (PUT) | UI auth-token wiring follow-up | Slice A2 |
| `friday-starter-skills-closeout.test.ts` (×2) | uix.templates.execute (POST), skills.run (POST) | UI auth-token wiring follow-up | Slice A2 |
| `friday-surface-interaction-benchmark.test.ts` | navigation across home/packs/assistant/builder (mixed POSTs) | UI auth-token wiring follow-up | Slice A2 |
| `friday-workflow-builder-performance.test.ts` | workflows.create / drafts.create (POST) | UI auth-token wiring follow-up | Slice A2 |

**Tally:** 17 routes blocked on Slice A2 (UI auth-token wiring) · 3 tests partially blocked on Slice A3 (setup-route carve-outs).

## CI required-test status

Per the user's instruction: "如果 CI 必跑这些 UI E2E，必须先做最小 shared auth fixture fix 或开 immediate Slice A2 before merge，不能用 skip".

The browser tests gate on `CHROMIUM_AVAILABLE` (each test file's top-level IIFE checks `playwright.chromium.executablePath()`). On environments without chromium, they skip silently. Whether the PR CI installs chromium determines whether these are merge-blocking — that is a runtime fact about the CI runners, not a code property.

**Recommendation:** Hold Slice A merge until the operator confirms one of:
- CI does NOT install chromium → UI E2E auto-skip in CI → Slice A may merge with this artifact documenting the deferred Slice A2/A3 work
- CI DOES install chromium → Slice A2 (UI auth-token wiring fixture fix) must land first or alongside Slice A in the same PR

No tests have been skipped, suppressed, or weakened to bypass the failures.

## Slice A2 sketch (UI auth-token wiring follow-up)

Minimum shared fixture fix (estimated ~30 lines):

1. In `_helpers/browser-env-mock.ts:newPage()`, after `context.newPage()` but before any navigation, call `context.addInitScript()` to inject the hub's `accessToken` into `localStorage` under whatever key the UI app reads (TBD: grep `localStorage` in `ui/src/`).
2. Verify in the UI app that all `fetch()` / API client paths read that storage key and attach `Authorization: Bearer <token>` to outgoing requests. If they don't yet, add a minimal API-client wrapper that does (likely already exists for the operator-facing surfaces).
3. Re-run UI E2E suite; expected pass after this single fixture change.

Alternative: extend `createFridayMockBrowserE2eEnv()` to set a cookie via `context.addCookies()` and add cookie-based auth read in the UI bootstrap. Either approach is one PR's worth of work.

## Slice A3 sketch (setup-route carve-outs)

The 11 mutating routes in `friday-setup-routes.ts` (providers.detect, setup.network.save, setup.channels.*, setup.complete) must remain reachable pre-auth (first-boot wizard). Per Slice A bar:

1. Decide a per-route alternative trust boundary (likely a `setup-session-token` minted by `auth.bootstrap.status` and consumed by each setup mutation, OR a strict first-boot-only check like the existing `auth.bootstrap.local.passphrase` localhost gate).
2. Write per-route negative tests that prove bad/missing session-token / non-first-boot rejection without side effect.
3. Apply `allowUnauthenticatedMutation: true` to each setup mutating route with file:line citation in the PR body.

This is meaningful work (~11 negative tests, plus the session-token mechanism or first-boot gate plumbing) and must NOT be folded into Slice A.

## Reviewer-A flow-impact observation (additional GATE_CLOSE breakage)

Beyond the 20 UI E2E failures, Stage 5 security review surfaced one more concrete flow concern outside the test suite: 7 `system.remote.*` mutating routes in `friday-system-routes.ts` are now gated by default and were NOT carved out in Slice A because the audit correctly classified them as having no in-handler verifier:

- `system.remote.devices.register` (POST)
- `system.remote.devices.delete` (DELETE)
- `system.remote.devices.passkey.delete` (DELETE)
- `system.remote.sessions.heartbeat` (POST)
- `system.remote.sessions.delete` (DELETE)
- `system.remote.auth.register.options` (POST) — issues WebAuthn registration challenge
- `system.remote.auth.assert.options` (POST) — issues WebAuthn assertion challenge

The `auth.register.options` and `auth.assert.options` pair are upstream of the two `.verify` routes that ARE carved out in Slice A. Gating `.options` may break the WebAuthn enrollment flow because the browser cannot fetch a challenge to sign. The protocol-level trust boundary is the single-use challenge consumed at `.verify` — but per the user's strict criteria (`handler 在任何 side effect 前验证 ...`), the `.options` handler has no in-process verifier and therefore correctly defaulted to GATE_CLOSE. Promoting these to carve-outs requires Slice A4 (WebAuthn flow review): either accept that challenge-issuance has no per-request trust boundary and carve out with that explicit rationale (with new tests confirming challenges are bound to a single device and time-limited), or wire a device-bootstrap-token boundary above `.options`.

Similarly, `system.remote.sessions.heartbeat` and `.delete` operate on existing session IDs minted by `system.remote.sessions.create` (which IS carved out). The session ID itself functions as the trust handle but is not currently verified by the handlers; an authenticated bearer flow (the natural posture) would not hit the gate at all. These are best deferred to the same Slice A4.

**Recommendation:** Hold these 7 in a B0-A4 slice with the same per-route rigor as Slice A's 13 carve-outs. Do not bundle into Slice A.

## What this triage does NOT do

- Does NOT skip, suppress, or weaken any test (HR12).
- Does NOT broad-carve-out by route family.
- Does NOT defer-by-classification ("UI tests don't count") — each failure is enumerated with the specific API surface it blocks on.
- Does NOT speak to whether the deferred Slice A2/A3 is high or low priority; that's a product decision recorded in the ledger.
