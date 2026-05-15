# Phase 12 Release Claim Matrix

Last updated: 2026-05-15. Status: Stage 3 implementation only, proof_tier
not-proof. Same-SHA RGG artifact validation remains Stage 7/8 proof, not
Stage 3 proof.

This file is the repo-local Phase 12 claim → RGG scenario → local real
proof mapping. It is the no-mock-contamination reference: every Phase 12
user-visible release claim is enumerated and classified as either covered
by an additive Phase 12 scenario, already covered by an existing Phase 11
or earlier scenario, explicit Phase 14 debt, or explicit out-of-scope per
the `NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md` boundary.

This file is **not** itself release proof. Release proof requires the
same-SHA `real-green-gate-result.json` artifact to report
`status === "passed"`, `commit_sha` matching, `scenarios_run > 0`,
`scenarios_passed === scenarios_total`, and `blocked_reasons === []`.

## Phase 12 Module 19 — Fleet/satellite mesh and offline behavior

| Claim | RGG scenario | Local real proof | Same-SHA RGG status |
|---|---|---|---|
| satellite pair → trust/capabilities → placement | `l6-satellite-pairing-manual` (manual external) | `test/unit/satellites/services/friday-satellite-pairing-service.test.ts` | manual-external, blocked-by-env until L6 satellite pairing is operator-driven |
| placement preserves fail-closed no-fallback-to-hub | (L2 fleet overview contract + unit tests) `l2-fleet-overview-contract`; existing `test/unit/workflows/friday-workflow-satellite-dispatch-service.test.ts` "blocks explicit offline satellites without silently falling back to hub" | same | not-proof at Stage 3; awaiting same-SHA RGG |
| per-placement audit evidence for hub/dispatched/blocked decisions | new unit test `friday-workflow-satellite-dispatch-service.test.ts` "emits per-placement audit evidence" | same | not-proof at Stage 3; awaiting same-SHA RGG |
| offline → online resume signal with pending outbox count | new tests `friday-satellite-resume-coordinator.test.ts` + integration `friday-satellite-runtime-resume.test.ts` | same | not-proof at Stage 3; awaiting same-SHA RGG |
| visible fleet status & evidence | existing `l1-fleet-ui` + `l2-fleet-overview-contract` | UI/contract scenarios | not-proof at Stage 3; awaiting same-SHA RGG |
| richer multi-hub mesh / mDNS / relay / Tailscale-native discovery | none | none | explicit out-of-scope (deferred per current_real_state in master phase index) |

## Phase 12 Module 20 — External observability and alert delivery

| Claim | RGG scenario | Local real proof | Same-SHA RGG status |
|---|---|---|---|
| alert destination CRUD persists & list route honesty | new `l2-observability-alert-destinations-list-contract` | existing `test/unit/observability/services/friday-observability-api-service.test.ts` "creates, updates, and deletes alert destinations" | not-proof at Stage 3; awaiting same-SHA RGG |
| fail-closed when Slack webhook URL is empty/invalid (create-time validation) | new `l2-observability-alert-destination-create-invalid-fails-closed` | existing create-time validation rejects empty `webhookUrl` (validator at `friday-observability-api-service.ts:1121`) | not-proof at Stage 3; awaiting same-SHA RGG |
| fail-closed when Slack webhook upstream returns non-2xx (dispatch-time) and writes failure audit entry | (covered by unit test only at Stage 3; L6 manual-external `l6-observability-slack-alert-dispatch-manual` covers the real-send dispatch path) | new unit test `"fails closed when the Slack webhook returns a non-2xx response and writes failure audit entries"` in `friday-observability-api-service.test.ts` (uses a local 500-response HTTP server) | not-proof at Stage 3; awaiting same-SHA RGG |
| fail-closed when SMTP password secret is missing for a username-authenticated destination and writes failure audit entry | (covered by unit test only at Stage 3; L6 manual-external `l6-observability-smtp-alert-dispatch-manual` covers the real-send dispatch path) | new unit test `"fails closed when the SMTP password secret is missing for a username-authenticated destination"` in `friday-observability-api-service.test.ts` | not-proof at Stage 3; awaiting same-SHA RGG |
| fail-closed when test-dispatch references unknown alert | new `l2-observability-alert-test-dispatch-fails-closed` | existing service throws `OBS_ALERT_NOT_FOUND` | not-proof at Stage 3; awaiting same-SHA RGG |
| audit search exposes dispatch records without injecting fakes | new `l2-observability-audit-search-contract` | new fail-closed/disabled unit tests (`outcome=failure`/`status=skipped` audit assertions) | not-proof at Stage 3; awaiting same-SHA RGG |
| real Slack webhook dispatch | new `l6-observability-slack-alert-dispatch-manual` | existing integration "dispatches alerts to Slack destinations" | manual-external; blocked-by-env until `FRIDAY_REAL_WORLD_EXTERNAL_ALERTS_READY=true` and `FRIDAY_REAL_WORLD_ALERT_SLACK_WEBHOOK_URL` is set |
| real SMTP email dispatch | new `l6-observability-smtp-alert-dispatch-manual` | existing integration "dispatches alerts to email destinations over SMTP" | manual-external; blocked-by-env until `FRIDAY_REAL_WORLD_EXTERNAL_ALERTS_READY=true` and `FRIDAY_REAL_WORLD_ALERT_SMTP_*` env are set |
| disabled-destination rollback / dispatch skip | new `l6-observability-alert-disable-rollback-manual` + new unit test "skips dispatch to a disabled destination" | same | manual-external; blocked-by-env until external alerts ready |
| OTEL/Grafana external metrics/traces export | none | none | explicit out-of-scope per `NON_CLOUD_LOCAL_CLOSURE_GOAL_2026-05-11.md` (F-014); Phase 14 debt key: `module_20_otel_grafana_external_export` |

## Phase 12 Module 21 — Same-SHA release proof and RGG

| Claim | RGG scenario | Local real proof | Same-SHA RGG status |
|---|---|---|---|
| claim-to-RGG mapping is repo-tracked | this file | this file | not a runtime proof; release auditor reads this matrix |
| no-mock-contamination check | catalog `validateCatalog` invariants + the explicit `expectOkEnvelope: false` markers on fail-closed scenarios above | catalog import-time validation in `validation/real-world/catalog/scenarios.mjs` | not-proof at Stage 3 |
| same-SHA RGG artifact passes per claimed surface | (Stage 7 — `real-green-gate-result.json` for the PR head SHA) | n/a | Stage 7/8 proof; not Stage 3 proof |
| de-scope / revert path when RGG cannot pass | this matrix records explicit Phase 14 debt and out-of-scope items above | n/a | not-proof at Stage 3 |

## Honesty notes

- The new L6 manual-external scenarios stay `blocked_by_env` until the
  operator declares `FRIDAY_REAL_WORLD_EXTERNAL_ALERTS_READY=true` and
  the Slack/SMTP proof env is complete. `blocked_by_env` is **not** a
  pass.
- The new L2 scenarios are deterministic, additive, and exercise the
  existing fail-closed envelopes (validation 400 / not-found 404 / list
  ok-envelope). They do not initiate any external Slack/SMTP traffic.
- No mock-only or stub-only scenario added in Phase 12 may be treated as
  release-complete proof.
- OTEL/Grafana external export is recorded here only as named Phase 14
  debt; this Phase 12 work does not claim that surface is closed.
