# Phase 3 — Refined Acceptance Criteria (Module-Specific)

> Generated 2026-02-24. Each XX6 (Security) and XX7 (Migration) task has module-specific checklist items.
> These replace the generic CSV AC for Phase 3 execution.

---

## Module 1: Rules Engine (FRI-PLAT-006, FRI-PLAT-007)

### FRI-PLAT-006 — Security & Permissions
1. RBAC enforcement on all policy evaluation APIs — callers must hold `rules:evaluate` scope
2. Rule DSL parser rejects injection patterns (no arbitrary code execution in conditions)
3. Policy bundle loading validates bundle signature before evaluation
4. Decision audit trail: every evaluate() call logs actor, rule IDs matched, decision, timestamp
5. Context redactor strips sensitive fields from audit/log output per configurable redaction rules
6. Denied operations return structured error with audit reference ID

### FRI-PLAT-007 — Migration & Compatibility
1. Schema migration script for rules engine tables (up + down)
2. Phase 2 rule format backward-compatible — old rules load without modification
3. Policy bundle version field added; bundles without version default to "1.0.0"
4. Backfill job for existing rule indexes to include new audit fields
5. Dry-run mode: migration can execute without committing (preview changes)
6. Rollback tested: down migration restores Phase 2 schema exactly

---

## Module 2: NodeRunner (FRI-PLAT-016, FRI-PLAT-017)

### FRI-PLAT-016 — Security & Permissions
1. Execution context carries caller principal + tenant — all 6 pipeline steps respect it
2. Pre-rules step enforces permission check before execute step runs
3. Adapter registry rejects unregistered/unsigned adapters at load time
4. Execution state machine transitions are audit-logged (from/to/actor/timestamp)
5. Timeout kill emits audit event with reason "timeout_exceeded"
6. Post-validate step cannot be bypassed — failed validation always blocks completion

### FRI-PLAT-017 — Migration & Compatibility
1. Schema migration for execution context tables (up + down)
2. Phase 2 adapter interface backward-compatible — existing adapters work without changes
3. New execution context fields (principal, tenant) nullable for Phase 2 data
4. Backfill job populates tenant field from workspace mapping
5. Dry-run mode for migration preview
6. Rollback restores Phase 2 schema and drops new columns cleanly

---

## Module 3: Acceptance Testing (FRI-PLAT-026, FRI-PLAT-027)

### FRI-PLAT-026 — Security & Permissions
1. Test suite execution requires `acceptance:run` scope
2. Fixture manager restricts file access to designated fixture directories only
3. Snapshot comparison rejects snapshots from different tenants
4. Result reporter redacts sensitive assertion values in output
5. Coverage tracker audit: who ran what, when, pass/fail, with tenant isolation
6. Failed acceptance gates cannot be overridden without `acceptance:override` scope + audit

### FRI-PLAT-027 — Migration & Compatibility
1. Schema migration for acceptance result/snapshot tables (up + down)
2. Phase 2 test format backward-compatible — existing suites run without modification
3. Snapshot format versioned — old snapshots auto-upgraded on read
4. Backfill job for coverage history records
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 4: Retry Engine (FRI-PLAT-036, FRI-PLAT-037)

### FRI-PLAT-036 — Security & Permissions
1. Retry policy DSL rejects policies with unlimited retries (must have max bound)
2. Retry budget enforcement: tenant-scoped cost accounting prevents runaway retries
3. Circuit breaker state changes are audit-logged (actor, reason, timestamp)
4. Dead-letter queue access is scoped per-tenant — no cross-tenant DLQ reads
5. Manual retry trigger requires `retry:manual` scope + audit trail
6. Failure classifier rejects unknown failure types (fail-closed, not fail-open)

### FRI-PLAT-037 — Migration & Compatibility
1. Schema migration for retry traces/DLQ tables (up + down)
2. Phase 2 retry policy format backward-compatible
3. New tenant-scoped budget fields nullable for Phase 2 data
4. Backfill job for existing retry traces to include tenant + cost fields
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 5: Playbook Learning (FRI-PLAT-046, FRI-PLAT-047)

### FRI-PLAT-046 — Security & Permissions
1. Playbook promotion requires `playbook:promote` scope — no auto-promote without authorization
2. Playbook store is tenant-isolated — queries never return cross-tenant playbooks
3. Feedback loop rejects scores from unauthorized principals
4. Version rollback emits audit event with reason + actor
5. Learning engine training data is scoped per-tenant (no cross-tenant learning)
6. Step executor validates playbook signature before execution

### FRI-PLAT-047 — Migration & Compatibility
1. Schema migration for playbook store/version tables (up + down)
2. Phase 2 playbook format backward-compatible — existing playbooks loadable
3. New tenant/signature fields nullable for Phase 2 data
4. Backfill job for playbook fingerprints and tenant associations
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 6: Agent Packaging (FRI-PLAT-056, FRI-PLAT-057)

### FRI-PLAT-056 — Security & Permissions
1. Package install requires `package:install` scope — unsigned packages rejected
2. Signature verification covers all package types (agent, skill, tool)
3. Dependency resolver rejects packages with known vulnerabilities (allowlist/blocklist)
4. Registry manager enforces publish authorization per tenant
5. Package builder strips secrets/credentials from manifest before build
6. Install/upgrade/rollback all emit audit events with actor + version + result

### FRI-PLAT-057 — Migration & Compatibility
1. Schema migration for package registry tables (up + down)
2. Phase 2 manifest format v1 backward-compatible — v1 packages installable
3. Manifest version field: v1 auto-upgraded to v2 on re-publish
4. Backfill job for existing packages to include signature + tenant fields
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 7: Multi-Tenant Security (FRI-PLAT-066, FRI-PLAT-067)

### FRI-PLAT-066 — Security & Permissions
1. RBAC engine enforces role hierarchy — child roles cannot exceed parent permissions
2. Tenant deactivation immediately revokes all active sessions (fail-closed)
3. Secret manager: secrets encrypted at rest, decryption requires `secret:read` scope
4. Policy engine deny rules take absolute precedence over allow rules
5. Audit logger: all permission checks logged with principal + resource + decision + timestamp
6. Cross-tenant API calls return 403 with audit trail (never leak data in error messages)

### FRI-PLAT-067 — Migration & Compatibility
1. Schema migration for RBAC/tenant/secret tables (up + down)
2. Phase 2 policy format backward-compatible
3. New encryption-at-rest fields: existing secrets backfilled with encryption on first access
4. Rotation history preserved during migration (no history loss)
5. Dry-run migration mode
6. Rollback tested — down migration decrypts secrets back to Phase 2 format

---

## Module 8: Desktop Control (FRI-PLAT-076, FRI-PLAT-077)

### FRI-PLAT-076 — Security & Permissions
1. Permission guard enforces per-action allowlist — unlisted actions blocked by default
2. Recording engine redacts sensitive screen regions (password fields, credit cards)
3. Session manager: sessions are tenant-isolated, no cross-tenant session access
4. Action executor: elevated/admin actions require explicit `desktop:admin` scope + user confirmation
5. Adapter manager: only signed adapters loadable (unsigned rejected at registration)
6. All desktop actions audit-logged with actor + action type + target app + result

### FRI-PLAT-077 — Migration & Compatibility
1. Schema migration for session/recording tables (up + down)
2. Phase 2 recording format backward-compatible — old recordings replayable
3. New permission/redaction fields nullable for Phase 2 data
4. Backfill job for session records to include tenant association
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 9: Universal Converter (FRI-PLAT-086, FRI-PLAT-087)

### FRI-PLAT-086 — Security & Permissions
1. Source detector: local path access restricted to allowlisted directories (symlink-safe)
2. Import wizard: session isolation per-tenant — no cross-tenant session access
3. Parser registry: only registered parsers executable (no dynamic code loading from source)
4. Quality assurance: QA results cannot be overridden without `converter:override` scope
5. Conversion pipeline: all state transitions audit-logged with actor + pipeline ID
6. IR transformer: output sanitized — no source secrets/tokens in converted skill output

### FRI-PLAT-087 — Migration & Compatibility
1. Schema migration for conversion pipeline/session tables (up + down)
2. Phase 2 pipeline format backward-compatible
3. New tenant/audit fields nullable for Phase 2 data
4. Backfill job for existing pipelines to include tenant + audit trail
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 10: Marketplace (FRI-PLAT-096, FRI-PLAT-097)

### FRI-PLAT-096 — Security & Permissions
1. Listing publish requires `marketplace:publish` scope — publisher must be verified
2. Purchase flow: entitlement grant validates buyer principal + listing ownership chain
3. Payout engine: payout initiation requires `marketplace:payout` scope + dual approval for amounts > threshold
4. Pricing engine: plan creation/update restricted to listing owner
5. Search/discovery: unlisted/suspended listings excluded from all query results
6. All marketplace state changes emit audit events with actor + entity + from/to state

### FRI-PLAT-097 — Migration & Compatibility
1. Schema migration for marketplace tables (up + down)
2. Phase 2 listing/purchase format backward-compatible
3. New audit/scope fields nullable for Phase 2 data
4. Backfill job for existing purchases to include audit trail
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 11: UX Runtime (FRI-PLAT-106, FRI-PLAT-107)

### FRI-PLAT-106 — Security & Permissions
1. Command palette: commands filtered by user scopes — unauthorized commands hidden
2. Navigation manager: routes enforce scope requirements — unauthorized routes return 403
3. Onboarding engine: flow definitions are tenant-scoped — no cross-tenant flow access
4. Help system: tour/tooltip content filtered by user role
5. Notification center: notifications are principal-scoped — no cross-user notification reads
6. All UX state transitions emit audit events (navigation, command execution, onboarding progress)

### FRI-PLAT-107 — Migration & Compatibility
1. Schema migration for UX state/preference tables (up + down)
2. Phase 2 theme/onboarding format backward-compatible
3. New scope/audit fields nullable for Phase 2 data
4. Backfill job for existing preferences to include tenant association
5. Dry-run migration mode
6. Rollback tested and documented

---

## Module 12: Observability (FRI-PLAT-116, FRI-PLAT-117)

### FRI-PLAT-116 — Security & Permissions
1. Audit trail: immutable append-only — no delete/update API exposed
2. Trace manager: traces are tenant-isolated — cross-tenant trace queries return empty
3. Alert engine: alert rule creation requires `observability:admin` scope
4. Dashboard data provider: data queries respect tenant boundaries
5. Health check manager: health endpoints do not leak internal state to unauthenticated callers
6. Metrics collector: metric labels cannot contain PII — label sanitization enforced

### FRI-PLAT-117 — Migration & Compatibility
1. Schema migration for audit/trace/alert tables (up + down)
2. Phase 2 audit format backward-compatible — old audit records queryable
3. New tenant isolation fields: existing records backfilled with default tenant
4. Trace retention policy applied during migration (configurable TTL)
5. Dry-run migration mode
6. Rollback tested and documented

---

_These ACs replace the generic CSV entries for Phase 3 execution._
_Each item is a PASS/FAIL gate during CX review._
