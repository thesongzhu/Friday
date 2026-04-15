> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 8 Code Review R1: NOT APPROVED — 10 Issues

## 1. CRITICAL — Auth: email login without password
**File**: `src/api/auth/friday-auth-service.ts:131`
**Fix**: Require password for email-based auth. Fail when password missing or hash mismatch.

## 2. CRITICAL — Realtime: subscription/stream authz bypass
**Files**: `friday-realtime-subscription-service.ts:71`, `friday-realtime-ws-gateway.ts:216`, `friday-realtime-routes.ts:43`
**Fix**: Enforce deterministic stream/topic binding, principal-aware stream auth for pull/ack/resume, reject replay when stream unauthorized, implement cursor verification (HMAC + stream binding + range).

## 3. HIGH — Conflicts: resolution ignores lockToken and strategy
**File**: `src/api/conflicts/friday-workflow-conflict-service.ts:76`
**Fix**: Validate lock ownership + expected revision, apply accept_local|accept_remote|manual_merge to persisted draft state, return actual updated entities.

## 4. HIGH — Legacy: freeze doesn't activate write-freeze guard
**Files**: `friday-legacy-decommission-service.ts:59`, `friday-compatibility-mirror.ts:22`
**Fix**: Wire freezeLegacyWrites() to activateFridayLegacyWriteFreeze() and make compatibility mirror short-circuit with LEGACY_WRITE_FROZEN.

## 5. HIGH — Config: deprecated mirror fields not removed, state-dir still prefers legacy
**Files**: `friday-config.types.ts:11`, `friday-config.schema.ts:10`, `resolve-state-dir.ts:37`
**Fix**: Remove deprecated mirror config fields, add migration-on-load, switch resolver to platform-first.

## 6. HIGH — Routes: incomplete wiring in runtime
**Files**: `friday-api-runtime.ts:122`, fleet/realtime routes
**Fix**: Register ALL Phase 8 contract routes, add missing endpoints.

## 7. HIGH — Realtime: seq numbers process-local, restart collision
**Files**: `friday-realtime-event-bus.ts:16`, `friday-realtime-event-repository.ts:74`
**Fix**: Source next seq from DB (max seq per stream) in publish transaction.

## 8. MEDIUM — Fleet: calculations use placeholders/hardcoded values
**File**: `friday-fleet-dashboard-service.ts`
**Fix**: Feed calculators with real repo-derived inputs, compute actual restricted/trusted aggregates.

## 9. MEDIUM — Auth: rate limiting ignores policy keyBy, no X-RateLimit headers
**File**: `friday-auth-middleware.ts:57`
**Fix**: Implement policy-aware keys, return limit headers.

## 10. MEDIUM — Tests: incomplete route + realtime authz coverage
**Fix**: Add contract tests for all routes, negative tests for realtime authz, cursor validation, legacy freeze integration.
