> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Marketplace MVP Runtime Runbook

**Date:** 2026-03-01  
**Scope:** Marketplace commerce + install-before-run enforcement (`skill|workflow|agent`, `free|one_time`)

---

## 1. Feature Flags

1. `FRIDAY_MARKETPLACE_COMMERCE_ENABLED`
   - Default behavior: enabled unless explicitly set to `false`.
   - Purpose: enable/disable marketplace commerce runtime and routes.

2. `FRIDAY_MARKETPLACE_INSTALL_REQUIRED`
   - Default behavior: enabled unless explicitly set to `false`.
   - Purpose: require successful install record before workflow/agent run for marketplace listings.

3. `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED`
   - Default behavior: enabled unless explicitly set to `false`.
   - Purpose: allow/block installation of `agent` asset type.

---

## 2. Expected Error Codes

1. `MARKETPLACE_ENTITLEMENT_REQUIRED`
   - Meaning: principal has no active/grace entitlement for listing.
   - Typical HTTP status: `403`.
   - Typical paths:
     - `POST /v1/marketplace/listings/:id/install`
     - workflow/agent runs with `marketplaceListingId`.

2. `MARKETPLACE_INSTALL_REQUIRED`
   - Meaning: entitlement exists but listing was not installed for this tenant.
   - Typical HTTP status: `403`.
   - Typical paths:
     - workflow/agent runs with `marketplaceListingId`.

3. `INSTALL_LISTING_NOT_INSTALLABLE`
   - Meaning: install attempted against non-installable listing status/version.
   - Typical HTTP status: `409` in install route.

4. `INSTALL_VERSION_NOT_APPROVED` / `INSTALL_VERSION_LISTING_MISMATCH` / `INSTALL_UNSUPPORTED_ASSET_TYPE` / `INSTALL_AGENT_ASSET_DISABLED`
   - Meaning: install validation failed.
   - Typical HTTP status: `400` in install route.

---

## 3. Production Triage Sequence

1. Confirm route and runtime flags:
   - verify `FRIDAY_MARKETPLACE_COMMERCE_ENABLED`;
   - verify `FRIDAY_MARKETPLACE_INSTALL_REQUIRED`;
   - verify `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED` when asset type is `agent`.

2. Confirm entitlement state:
   - check `marketplace_entitlements` for `(tenant_id, listing_id)` with status `active|grace`.

3. Confirm installation state:
   - check `marketplace_installations` for `(tenant_id, listing_id)` with status `installed`.

4. Confirm tenant identity consistency:
   - principal tenant in token must match entitlement/install tenant.

---

## 4. Emergency Rollback Playbook

1. **Scope-only rollback (fastest, safest):**
   - set `FRIDAY_MARKETPLACE_INSTALL_REQUIRED=false` to bypass install gate while keeping entitlement checks.
   - use only for temporary mitigation.

2. **Commerce runtime rollback (broad):**
   - set `FRIDAY_MARKETPLACE_COMMERCE_ENABLED=false`.
   - impact: marketplace commerce routes are disabled.

3. **Agent-only install rollback:**
   - set `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED=false`.
   - impact: blocks new agent asset installs; workflow/skill unaffected.

4. Keep schema migrations (`v038`, `v039`) intact during runtime rollback; use behavior flags first.

---

## 5. Operational Verification Commands

1. `npm run -s check:migrations`
2. `npm run -s typecheck`
3. `npm run -s test -- test/integration/marketplace/friday-marketplace-install-closure.test.ts test/integration/marketplace/friday-marketplace-workflow-one-time-run-gate.test.ts test/integration/marketplace/friday-marketplace-duplicate-checkout-callback.test.ts`
4. `bash scripts/ops/marketplace-staging-rollback-drill.sh`

---

## 6. Rollback Drill Artifacts

1. Script:
   - `scripts/ops/marketplace-staging-rollback-drill.sh`
   - Purpose: run automated rollback-validation checks and generate an evidence markdown file.

2. Record template:
   - `docs/task/marketplace-staging-rollback-drill-record-template.md`
   - Purpose: capture operator-observed results for staging manual rollback scenarios.
