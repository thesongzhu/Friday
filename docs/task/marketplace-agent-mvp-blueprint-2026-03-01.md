> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Marketplace Agent MVP Blueprint (Free + One-Time)

**Status:** MVP core loop complete (hardening complete for current scope)
**Date:** 2026-03-01
**Owner:** Platform
**Scope lock:** Minimal-change MVP

---

## 1. Product Decision Lock

This blueprint locks the product scope to avoid drift and reduce bug surface:

1. Marketplace listing types: `skill`, `workflow`, `agent`.
2. Pricing types: `free`, `one_time` only.
3. Delivery model: install package into buyer tenant, then use locally.
4. Ownership model: buyer owns runtime data/secrets/logs; seller has zero data-plane access post-install.
5. No subscription, no usage metering, no rental lifecycle in this MVP.

Out-of-scope paths must be explicitly rejected at validation time.

---

## 2. Closed-Loop User Journey (MVP)

### Seller loop

1. Create publisher profile.
2. Create listing with `assetType` (`skill|workflow|agent`).
3. Attach package reference and pricing (`free|one_time`).
4. Submit review and publish.

### Buyer loop

1. Discover listing.
2. Acquire listing (`free` direct or `one_time` paid).
3. Receive entitlement.
4. Install into own tenant workspace.
5. Run workflow/agent/skill with entitlement guard.

### Runtime guard loop

1. Run request arrives (`agent` or `workflow`).
2. Resolve required entitlement by listing/package mapping.
3. Deny if not entitled.
4. Allow run if entitled.
5. Emit audit event (allow/deny).

This produces full commercial + installation + runtime authorization closure.

---

## 3. Minimal-Change Architecture Strategy

Do not rewrite core runtimes. Add thin modules and adapters around existing paths.

1. Keep existing marketplace engine/model files and constrain behavior by policy guards.
2. Keep existing route registration pattern and inject `marketplaceCommerce` from hub bootstrap.
3. Add entitlement check hook at API route deps layer before runtime execution.
4. Keep billing abstraction but only execute `free` + `one_time` branches.
5. Defer all `subscription`/`usage_based` logic by rejecting inputs early.

---

## 4. File-Level Change Plan

### 4.1 Marketplace domain and API contracts

1. Update [./src/marketplace/model/friday-marketplace.types.ts](./src/marketplace/model/friday-marketplace.types.ts)
- Add `FridayMarketplaceAssetType = "skill" | "workflow" | "agent"`.
- Add `assetType` field to listing version snapshot (or listing metadata envelope).
- Keep existing pricing union, but add explicit MVP guard constants:
  - `FRIDAY_MVP_ALLOWED_PRICING_TYPES = ["free", "one_time"]`.

2. Update [./src/marketplace/api/friday-marketplace-api.types.ts](./src/marketplace/api/friday-marketplace-api.types.ts)
- Surface `assetType` in create/update/list/get DTOs.
- Restrict request validation DTO docs to `free|one_time` for MVP.

### 4.2 Marketplace engines

1. Update [./src/marketplace/engine/listing-manager.ts](./src/marketplace/engine/listing-manager.ts)
- Validate asset type required and supported.
- Enforce immutable `assetType` once first publish occurs (prevents runtime ambiguity).

2. Update [./src/marketplace/engine/pricing-engine.ts](./src/marketplace/engine/pricing-engine.ts)
- Reject non-MVP pricing types with deterministic domain error code (`PRICING_TYPE_NOT_ALLOWED_IN_MVP`).
- Keep current computation helpers unchanged for allowed plans.

3. Update [./src/marketplace/engine/purchase-manager.ts](./src/marketplace/engine/purchase-manager.ts)
- Branch only:
  - `free` -> complete purchase + grant entitlement.
  - `one_time` -> complete payment + grant entitlement.
- Return explicit error for subscription/usage input.
- Ensure idempotency key handling prevents duplicate entitlements.

### 4.3 HTTP route wiring

1. Update [./src/api/http/routes/friday-marketplace-commerce-routes.ts](./src/api/http/routes/friday-marketplace-commerce-routes.ts)
- Validate `assetType` and pricing type at boundary.
- Ensure route-level errors map to 4xx (not 5xx) for scope violations.

2. Update [./src/api/runtime/friday-api-runtime.types.ts](./src/api/runtime/friday-api-runtime.types.ts)
- Keep optional deps type, but add explicit comment that hub enables it in MVP profile.

3. Update [./src/hub/friday-hub-bootstrap.ts](./src/hub/friday-hub-bootstrap.ts)
- Instantiate `marketplaceCommerce` deps (repositories/services) and pass into `createFridayApiRuntime`.
- Keep feature-flag fallback to disable quickly.

### 4.4 Entitlement enforcement (runtime safety)

1. Update [./src/api/http/routes/friday-agent-routes.ts](./src/api/http/routes/friday-agent-routes.ts)
- Add dependency `assertAgentEntitled(principal, agentRef)` before `startRun`.

2. Update [./src/api/http/routes/friday-workflow-run-routes.ts](./src/api/http/routes/friday-workflow-run-routes.ts)
- Add dependency `assertWorkflowEntitled(principal, workflowId)` before `startRun`.

3. Add a small shared service (new file):
- `./src/marketplace/engine/entitlement-guard.ts`
- Purpose: stateless check facade for route layer.

### 4.5 Persistence and migrations

1. Add migration `v038-marketplace-commerce-mvp.ts` under [./src/state/sqlite/migrations](./src/state/sqlite/migrations)
- Core tables (minimal set):
  - `marketplace_publishers`
  - `marketplace_listings`
  - `marketplace_listing_versions`
  - `marketplace_pricing_plans`
  - `marketplace_purchases`
  - `marketplace_entitlements`
- Add necessary unique + lookup indexes only.

2. Update [./src/state/sqlite/migrations/index.ts](./src/state/sqlite/migrations/index.ts)
- Register v038 in order.

3. Add repository adapters (thin, explicit SQL) under a new folder:
- `./src/marketplace/persistence/*`

### 4.6 Installation dispatch by asset type

1. Add installer dispatch service:
- `./src/marketplace/engine/install-dispatcher.ts`

2. Routing behavior:
- `skill` -> existing skill import/install path.
- `workflow` -> existing workflow import/publish path.
- `agent` -> install bundle manifest that references workflow + skills; resolve dependencies then register runnable agent metadata.

3. Keep installation transactionally safe:
- Stage -> validate -> commit -> mark installed.
- On failure: rollback filesystem + DB marker.

---

## 5. Security and Data Isolation Blueprint

Hard requirements (must pass before release):

1. Tenant-scoped ownership checks on every read/write in marketplace repos.
2. Entitlement lookup key includes tenant identity; never global-only key.
3. Installation path includes tenant boundary (directory and DB record).
4. Secrets are never accepted from listing metadata.
5. Agent/workflow runtime cannot execute if entitlement missing or tenant mismatch.
6. Audit log for publish/acquire/install/run-deny events.

Threats handled in MVP:

1. Cross-tenant entitlement replay.
2. Duplicate purchase event granting duplicate entitlement.
3. Installing package from tampered source.
4. Seller trying to embed executable secret exfiltration defaults.
5. Unauthorized runtime execution via direct run endpoint.

---

## 6. Bug-Prevention Test Matrix (must-have)

### 6.1 Unit tests

1. Listing manager: assetType validation and immutability.
2. Pricing engine: reject non-MVP types.
3. Purchase manager: `free` and `one_time` only, idempotent grant.
4. Entitlement guard: allow/deny matrix by tenant and status.
5. Install dispatcher: assetType route correctness.

### 6.2 Integration tests (SQLite + HTTP)

1. Publish `agent` listing (`free`) -> acquire -> install -> start agent run success.
2. Publish `workflow` listing (`one_time`) -> acquire payment success -> install -> start workflow run success.
3. Attempt run without entitlement -> 403.
4. Cross-tenant run with foreign entitlement -> 403.
5. Invalid pricing type submit -> 400.
6. Duplicate checkout callback -> one purchase, one entitlement.

### 6.3 Migration tests

1. Fresh DB: v001 -> v038 full apply.
2. Existing DB snapshot: migrate to v038 without data loss.
3. Rollback simulation (if migration runner supports down test harness) or backup/restore rehearsal.

### 6.4 E2E smoke tests

1. Seller/B buyer real-flow script (happy path free).
2. Seller/B buyer real-flow script (happy path one-time).
3. Install failure injection (network/package corruption) verifies rollback and user-visible error.

### 6.5 Non-functional gates

1. Entitlement check p99 latency target < 10 ms local SQLite.
2. Acquire/install API idempotency success under retry storm.
3. No unhandled promise rejection in install and checkout flows.

---

## 7. Execution Phases (small safe increments)

### Phase A - Contract lock (1-2 days)

1. Model + DTO + error-code updates.
2. RFC/docs updates.
3. Unit tests for validation-only changes.

Exit criteria:
1. No runtime behavior change yet.
2. Type and validation tests green.

### Phase B - Persistence + route enablement (2-3 days)

1. v038 migration and repositories.
2. Hub bootstrap injects marketplaceCommerce deps.
3. CRUD + acquire endpoints wired.

Exit criteria:
1. Local API can publish and acquire.
2. Integration tests for CRUD/acquire pass.

### Phase C - Install and entitlement guard (3-4 days)

1. Install dispatcher (skill/workflow/agent).
2. Entitlement guard on agent/workflow run endpoints.
3. Audit events and denial telemetry.

Exit criteria:
1. End-to-end install-then-run closure complete.
2. Unauthorized runs consistently blocked.

### Phase D - Hardening and release gate (2-3 days)

1. Failure injection tests.
2. Concurrency/idempotency tests.
3. Runbook and rollback playbook.

Exit criteria:
1. Full matrix green.
2. No P0/P1 open issues.

---

## 8. Feature Flags and Rollout Safety

1. `FRIDAY_MARKETPLACE_COMMERCE_ENABLED` (default enabled unless explicitly set to `false`).
2. `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED` (default enabled unless explicitly set to `false`).
3. `FRIDAY_MARKETPLACE_MVP_STRICT_PRICING` (default true; rejects subscription/usage).

Rollout steps:

1. Enable in dev only.
2. Run full smoke + integration.
3. Canary tenant enable.
4. Full enable after 48h clean telemetry window.

---

## 9. Definition of Done (DoD)

All items must be true:

1. Marketplace supports listing types `skill|workflow|agent`.
2. Only `free|one_time` accepted end-to-end.
3. Buyer can install then run with zero manual code edits.
4. Tenant isolation verified by automated tests.
5. Seller has no post-install data access path.
6. All required unit/integration/e2e tests pass in CI.
7. Migration v038 validated on fresh and existing DB.
8. Rollback runbook executed once in staging.

---

## 10. Explicitly Deferred (do not sneak into MVP)

1. Subscription lifecycle and billing webhooks.
2. Usage metering.
3. Complex payout and tax workflows.
4. Recommendation/ranking engine.
5. Marketplace chat, reviews, social features.

Keeping these out is required to hit stable closed-loop delivery with minimal change footprint.

---

## 11. Immediate Next Implementation Slice

Recommended first coding slice (smallest shippable technical increment):

1. Add `assetType` + pricing guard constants in marketplace model.
2. Add validation in listing/pricing/purchase engines.
3. Add unit tests for those three modules.

This slice de-risks all downstream work and does not require DB migration yet.

---

## 12. Execution Progress (2026-03-01)

Completed:

1. **Contract lock (Phase A)**
   - `assetType` required (`skill|workflow|agent`) in listing creation.
   - Pricing locked to `free|one_time`; non-MVP types rejected in routes + engines.
   - Unit coverage for listing/pricing/purchase validation.

2. **Persistence + enablement (Phase B)**
   - `v038` marketplace commerce schema + persistence adapters wired in hub bootstrap.
   - Commerce routes enabled by default (`FRIDAY_MARKETPLACE_COMMERCE_ENABLED !== "false"`).
   - Entitlement checks injected into workflow/agent run route dependencies.

3. **Install closure + run gate (Phase C core)**
   - `v039` installation schema (`marketplace_installations`) added.
   - Install dispatcher and route added: `POST /v1/marketplace/listings/:id/install`.
   - Idempotent install semantics for same tenant/listing/package version.
   - Runtime execution guard now enforces:
     - active entitlement;
     - installed asset when `FRIDAY_MARKETPLACE_INSTALL_REQUIRED !== "false"`.

4. **API contract completion**
   - Installation DTO/request/response contracts added for marketplace API typing.

Remaining hardening:

1. Negative integration test for duplicate checkout callback added:
   - `test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts`.
2. Staging rollback drill automation/template added:
   - `scripts/ops/marketplace-staging-rollback-drill.sh`
   - `docs/task/marketplace-staging-rollback-drill-record-template.md`
