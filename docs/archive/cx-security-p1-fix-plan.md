> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Security P1+P2 Fix Plan (2026-02-18)

## FRI-SEC-004: SHA-256 Password Hashing → scrypt
**Files:** `src/api/auth/friday-auth-service.ts:29-39, :101-122, :147-163`
**Changes:**
- Replace password verification with `crypto.scrypt`/`crypto.scryptSync`
- Versioned hash format: `scrypt$<salt>$<derivedKey>`
- Legacy SHA-256 compatibility for existing 64-hex hashes, auto-upgrade on login
- Length checks before `timingSafeEqual`
**Tests:**
- scrypt hash fixtures, legacy SHA-256 upgrade test, wrong password rejection

## FRI-SEC-005: Token Revocation → short-lived + in-memory revocation
**Files:** `src/api/auth/friday-auth-service.ts:215-237`, `src/api/auth/friday-auth-service.types.ts:20-30`, `src/api/runtime/friday-api-runtime.ts:45-63, :73-81`
**Changes:**
- Cap access token TTL at 900s (15 min)
- In-memory revocation map (`Map<tokenId, expEpochSec>`) with lazy cleanup
- `markAccessTokenRevoked` callback in auth service deps, invoked on logout
- Token validator checks in-memory map
**Tests:**
- logout triggers revocation, token returns 401 after logout, TTL clamping

## FRI-SEC-006: PKCE state=verifier → separate values
**Files:** `src/providers/oauth/friday-anthropic-oauth.ts:147-176, :181-187`
**Changes:**
- Generate independent random `state` and `verifier`
- Store `pendingVerifiers.set(state, verifier)`
- Remove `codeVerifier ?? state` fallback
- Require valid state + matching stored verifier
**Tests:**
- `state !== codeVerifier` assertion, unknown state rejection, distinct values in token request

## FRI-SEC-007: CORS Default * → [] (disabled)
**Files:** `src/hub/friday-hub-bootstrap.ts:186, :224-232`, `src/api/http/friday-http-server.ts:184`
**Changes:**
- Default CORS from `["*"]` to `[]` (disabled)
- Wildcard only as explicit opt-in
**Tests:**
- env test expects `[]`, server test with omitted corsOrigins returns no CORS headers

## FRI-SEC-008: Error Message Leakage → generic 5xx
**Files:** `src/api/http/friday-http-error-mapper.ts:15-35, :39-50`
**Changes:**
- 5xx responses: generic "Internal Server Error" message
- 4xx: preserve original message
**Tests:**
- New mapper unit tests: 4xx preserves message, 500 returns generic, 5xx domain error generic

## FRI-SEC-009: Security Headers
**Files:** `src/api/http/friday-http-server.ts:106-132, :138-150, :210-214, :351-357`
**Changes:**
- Add to all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
- Apply to success, rejection, error, and OPTIONS paths
**Tests:**
- Assert headers on 200, 404, 500, OPTIONS responses

## FRI-SEC-010: Unbounded Limits → cap at 100
**Files:** `src/api/http/routes/friday-session-routes.ts:316-327, :447-458, :541-552`
**Changes:**
- Route-level max limit constant `100`
- `Math.min(parsed, 100)` for sessions list, messages, forks
**Tests:**
- 3 tests: limit > 100 capped to 100
