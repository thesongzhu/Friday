> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Marketplace Agent MVP Execution Checklist

**Date:** 2026-03-01  
**Status:** Active  
**Goal:** Zero-surprise rollout for free/one-time marketplace assets (`skill|workflow|agent`) with install-before-run closure.

---

## 1. Scope Lock (must stay true)

1. Pricing types accepted by API: `free`, `one_time` only.
2. Asset types accepted by listing/install APIs: `skill`, `workflow`, `agent`.
3. Delivery model: acquire entitlement -> install into buyer tenant -> run in buyer tenant.
4. Seller has no runtime access to buyer data after install.
5. No subscription lifecycle or usage metering in MVP.

Release blocker:

1. Any request path accepting `subscription` or `usage_based`.
2. Any runtime path that executes a marketplace asset without entitlement.
3. Any cross-tenant data read/write in marketplace commerce tables.

---

## 2. Implemented Baseline

1. Marketplace contract lock and engine guards are in place.
2. Commerce persistence (`v038`) and installation persistence (`v039`) are in place.
3. Install endpoint is implemented: `POST /v1/marketplace/listings/:id/install`.
4. Runtime listing guard now checks:
   - active entitlement;
   - installed record (configurable via `FRIDAY_MARKETPLACE_INSTALL_REQUIRED`).
5. Installation API DTOs are defined for typed client integration.

---

## 3. Pre-Release Verification Matrix

### 3.1 Unit (required)

1. Listing/pricing/purchase validation tests green.
2. Install dispatcher tests green (valid/idempotent/disabled/error paths).
3. Entitlement guard tests green (allow/deny matrix).
4. Persistence tests green including installation round-trip.

### 3.2 Integration (required)

1. Publish `agent` (`free`) -> checkout -> install -> agent run success.
2. Publish `workflow` (`one_time`) -> checkout -> install -> workflow run success.
3. Run with entitlement but without install -> `403 MARKETPLACE_INSTALL_REQUIRED`.
4. Run without entitlement -> `403 MARKETPLACE_ENTITLEMENT_REQUIRED`.
5. Cross-tenant entitlement replay attempt -> denied.
6. Duplicate checkout callback -> no duplicate entitlement grant.

Current evidence:

1. `test/integration/marketplace/friday-marketplace-install-closure.test.ts` validates checkout -> entitlement -> install -> execution-ready closure, plus install-required and cross-tenant denial branches.
2. `test/integration/marketplace/friday-marketplace-workflow-one-time-run-gate.test.ts` validates one-time workflow path with simulated payment-complete entitlement, run denied before install, and run allowed after install.
3. `test/integration/marketplace/friday-marketplace-install-failure-rollback.test.ts` validates failure injection before install persist and verifies no installation row is committed.
4. `test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts` validates callback replay is rejected by purchase state and does not create duplicate entitlement grant.

### 3.3 Migration (required)

1. Fresh DB apply passes `v001` through `v039`.
2. Existing DB with historical data migrates cleanly to `v039`.
3. Migration integrity script passes (`check:migrations`).

---

## 4. Tenant Isolation Controls

1. All entitlement and installation reads filter by buyer tenant.
2. Run guard input uses authenticated principal tenant only.
3. Install route writes tenant/principal from authenticated context only.
4. No install route parameter allows overriding tenant identity.

Audit targets:

1. Purchase completion event.
2. Entitlement grant event.
3. Installation event.
4. Run denied due to entitlement/install guard.

---

## 5. Rollout Gates

1. Dev: enable `FRIDAY_MARKETPLACE_COMMERCE_ENABLED=true`.
2. Dev/QA: keep `FRIDAY_MARKETPLACE_INSTALL_REQUIRED=true`.
3. Canary tenant: enable and monitor 48 hours.
4. Full rollout only when no P0/P1 issues and denial telemetry is expected/clean.

Rollback toggles:

1. Set `FRIDAY_MARKETPLACE_COMMERCE_ENABLED=false` to disable commerce routes.
2. Set `FRIDAY_MARKETPLACE_INSTALL_REQUIRED=false` for emergency compatibility fallback.
3. Keep schema (`v038/v039`) intact; rollback at runtime behavior level first.

---

## 6. Release Command Checklist

1. `npm run -s check:migrations`
2. `npm run -s typecheck`
3. `npm run -s test -- test/unit/marketplace/engine/entitlement-guard.test.ts test/unit/marketplace/engine/install-dispatcher.test.ts test/unit/api/routes/friday-marketplace-commerce-routes.test.ts test/unit/marketplace/persistence/friday-marketplace-commerce-persistence.test.ts`
4. Run integration matrix in CI/staging before production enablement.
5. Run rollback drill script and archive report:
   - `bash scripts/ops/marketplace-staging-rollback-drill.sh`
   - Fill `docs/task/marketplace-staging-rollback-drill-record-template.md`

---

## 7. Open Work Items

1. None for MVP closure scope; remaining work is post-MVP expansion.
