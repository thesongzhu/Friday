> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 7 Code Review — Round 1: NOT APPROVED

## Issues to Fix (9 total: 1 CRITICAL, 4 HIGH, 4 MEDIUM)

### 1. CRITICAL — Approval bypass in dispatcher
**File**: `src/learning/services/friday-auto-fix-dispatcher-service.ts:48`
**Problem**: `runApprovedAction` executes any `planned` action without validating that an approval request exists and is `approved`. Tier 2 actions can run without enforced approval.
**Fix**: Require approval request context, validate `approval_requests.status='approved'` transactionally before execute, reject otherwise.

### 2. HIGH — Rollback escalation uses wrong window
**Files**: `src/learning/services/friday-auto-fix-risk-assessment-service.ts:71`, `src/learning/persistence/friday-auto-fix-action-repository.ts:186`
**Problem**: Uses same-day counts, not rolling 24h window. Missing 1h error-spike (>3x baseline) rule entirely.
**Fix**: Implement rolling-window queries (24h and 1h), calculate rollback rate from executed actions (`applied + rolled_back`), add spike escalation rule.

### 3. HIGH — Verification hardcoded to pass
**File**: `src/learning/services/friday-auto-fix-execution-service.ts:56`
**Problem**: Verification always passes (`verificationPassed = true`), so rollback flow is unreachable.
**Fix**: Add real executor/verification handlers per step kind, route verification failures through rollback logic.

### 4. HIGH — Rollback without plan corrupts state
**File**: `src/learning/services/friday-auto-fix-rollback-service.ts:38`
**Problem**: No rollback plan → still calls `markRolledBack`, setting `rolled_back` status while returning `rollbackSucceeded: false`. Corrupted semantics.
**Fix**: Do NOT transition to `rolled_back` unless rollback steps actually succeed. Preserve `applied` state or fail explicitly.

### 5. HIGH — Lesson extraction timing is wrong
**Files**: `src/learning/services/friday-self-learning-pipeline-service.ts:214`, `src/learning/services/friday-auto-fix-execution-service.ts:69`
**Problem**: Lessons created during incident ingestion (pre-fix), not after successful auto-fix. Execution doesn't invoke lesson extraction.
**Fix**: Remove lesson upsert from Phase 7 ingestion path. Invoke `FridayAutoFixLessonExtractionService` on successful apply in the resolution transaction.

### 6. MEDIUM — Tier 1 plans missing rollback plans
**File**: `src/learning/services/friday-auto-fix-plan-service.ts:37`
**Problem**: Fallback plans can generate Tier 1 `apply_config_patch` steps without rollback plans. Execution rejects these.
**Fix**: Ensure fallback Tier 1 plans always include rollback plans.

### 7. MEDIUM — Severity always "medium"
**File**: `src/learning/services/friday-self-learning-pipeline-service.ts:125`
**Problem**: Incident severity hardcoded to `"medium"`, so high-severity escalation never triggers.
**Fix**: Derive severity from event/signal context with validation and fallback.

### 8. MEDIUM — Approve doesn't trigger execution
**File**: `src/learning/services/friday-approval-workflow-service.ts:74`
**Problem**: `approve()` only changes request state, doesn't execute the linked action. No integrated path to guarantee `approve -> runApprovedAction`.
**Fix**: Wire execution into approval flow so approve lifecycle is complete.

### 9. MEDIUM — Missing test coverage
**Files**: Multiple test files
**Problem**: Critical scenarios untested: rollback-rate escalation, 1h spike escalation, verification-fail rollback path, full Phase 7 pipeline actions/approvals + approval-to-execution linkage.
**Fix**: Add tests covering those paths.
