> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Plugin Batch 2 Review — R1

**Date:** 2026-02-18
**Reviewer:** CX (gpt-5.3-codex)
**Scope:** Plugin Batch 2: signatures, marketplace, channel interface, API routes, plugin service

---

## Findings

1. **[Critical] Marketplace signature verification is bypassed.**
   `src/plugins/services/friday-plugin-service.ts:103` sets `signatureVerified = true` for marketplace installs without calling Ed25519 verification. `src/plugins/services/friday-plugin-service.ts:273` only checks checksum, then `src/plugins/services/friday-plugin-service.ts:285` installs. `verifyMarketplacePackage` is never invoked.

2. **[High] Trust-on-install is bypassable and fingerprint re-check is missing.**
   `src/plugins/services/friday-plugin-service.ts:104` only evaluates trust-on-install when `packageBytes` is provided; API local install does not provide bytes, so no approval/fingerprint enforcement. There is no fingerprint mismatch check on load path (`src/plugins/services/friday-plugin-loader.ts:116`).

3. **[High] Local install route does not load/validate real manifest.**
   `src/api/http/routes/friday-plugin-routes.ts:103` builds a synthetic manifest (`version: "0.0.0"`, empty `kinds`, empty `entrypoints`) instead of reading from `installPath`. `validateFridayPluginManifest` is imported but unused (`src/api/http/routes/friday-plugin-routes.ts:20`).

4. **[Medium] Required versions endpoints are missing vs design.**
   `src/api/http/routes/friday-plugin-routes.ts:50` defines 9 routes only; no `/v1/plugins/:id/versions` and no `/v1/marketplace/plugins/:id/versions`.

5. **[Medium] Plugin service is not orchestrating loader lifecycle.**
   `loader` is injected but unused (`src/plugins/services/friday-plugin-service.ts:30`). `enablePlugin`/`disablePlugin`/`uninstallPlugin` only mutate registry state (`src/plugins/services/friday-plugin-service.ts:165`, `src/plugins/services/friday-plugin-service.ts:192`, `src/plugins/services/friday-plugin-service.ts:225`), so runtime load state can drift.

6. **[Medium] Core channel disable behavior conflicts with design note ("non-uninstallable, but can be enabled/disabled").**
   `src/plugins/services/friday-plugin-service.ts:172` blocks disabling core plugins.

7. **[Medium] Marketplace client lacks timeout and robust JSON parse handling.**
   No timeout/abort wiring (`src/plugins/services/friday-plugin-marketplace-client.ts:82`, `src/plugins/services/friday-plugin-marketplace-client.ts:106`). `response.json()` parse failures are not wrapped (`src/plugins/services/friday-plugin-marketplace-client.ts:99`).

8. **[Low] Route query validation is weak.**
   Enum fields are cast, not validated (`src/api/http/routes/friday-plugin-routes.ts:60`). `limit/offset` accept `NaN` (`src/api/http/routes/friday-plugin-routes.ts:175`).

## Passed

- Plugin scopes are present in RBAC (`src/api/auth/friday-rbac-policy.ts:23`)
- Zero `as any` in reviewed files

## Verdict

**NOT APPROVED** — 1 Critical + 2 High issues must be fixed before R2.
