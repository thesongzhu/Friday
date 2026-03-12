> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX BYOK Review R1 — NOT APPROVED

## Findings

### 1. Validation runs after persistence (validate-before-commit violated)
**Files:** `src/providers/services/friday-provider-service.ts:198,203,217,282,293,307`
Failed validation can leave invalid providers committed to DB.

### 2. GET /v1/providers/:providerId not-found throws plain Error → 500
**Files:** `src/api/http/routes/friday-provider-routes.ts:53`
Should return 404/PROVIDER_NOT_FOUND, not 500/INTERNAL_ERROR.

### 3. Hub bootstrap never injects providerService into skill executor
**Files:** `src/hub/friday-hub-bootstrap.ts:137,149`, `src/skills/executor/friday-skill-executor.ts:32`
ai-inference BYOK path is not active in hub runtime.

### 4. updateProvider skips revalidation when authMode or api changes
**Files:** `src/providers/services/friday-provider-service.ts:287,289`
Design says auth/baseUrl/model changes should revalidate by default.

### 5. Switching key source doesn't delete old secret row
**Files:** `src/providers/services/friday-provider-service.ts:255,341`
Stale credential material left in secrets table.

### 6. Random master key makes secrets undecryptable across restarts
**File:** `src/providers/security/friday-secret-crypto.ts:84`
Design requires explicit FRIDAY_MASTER_KEY.

### 7. Fallback error messages can leak key-like data
**Files:** `src/providers/routing/friday-provider-fallback.ts:96,105,112`
Raw downstream errors stored/rethrown without redaction.

### 8. API routes have no request body validation
**Files:** `src/api/http/routes/friday-provider-routes.ts:69,86,144`
Malformed input bypasses 4xx contract.
