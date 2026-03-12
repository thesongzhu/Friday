> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Security Audit — Pre-Release (2026-02-18)

**VERDICT: FAIL — 2 critical (P0) + 5 high (P1) + 3 medium (P2)**

---

## P0 — Critical

### FRI-SEC-001: Login Auth Bypass When No Credentials Are Provided
- **File:** `src/api/auth/friday-auth-service.ts:121`
- **Description:** `login()` falls back to `findLocalUser()` when neither `localPassphrase` nor `email` is provided, and then issues tokens without password/passphrase verification.
- **Impact:** Unauthenticated callers can obtain valid access/refresh tokens (often owner/admin) by sending `{}` to `/v1/auth/login` if a local user exists.
- **Fix:** Remove fallback login without credentials; require an explicit auth method and enforce passphrase/password checks for all interactive logins.

### FRI-SEC-002: Predictable Default Token Signing Secret
- **File:** `src/hub/friday-hub-bootstrap.ts:54`
- **Description:** A hardcoded default token secret (`friday-dev-secret-change-me`) is used when `FRIDAY_TOKEN_SECRET` is unset.
- **Impact:** Attackers can forge valid HMAC access tokens (including admin scopes) on misconfigured deployments.
- **Fix:** Fail startup unless a strong secret is explicitly configured; enforce minimum entropy/length and rotate existing tokens when changed.

---

## P1 — High

### FRI-SEC-003: AuthZ Enforcement Is Fail-Open If Middleware Is Omitted
- **File:** `src/api/http/friday-http-server.ts:293`
- **Description:** Auth/scope/role/rate-limit checks are skipped entirely when `middleware` is not passed.
- **Impact:** A custom embedding or regression can expose all protected routes without authentication.
- **Fix:** Make middleware mandatory for servers with non-public routes, or hard-fail startup if private routes are registered without middleware.

### FRI-SEC-004: Password Verification Uses Fast Unsalted SHA-256
- **File:** `src/api/auth/friday-auth-service.ts:29`
- **Description:** Password/passphrase verification is based on plain SHA-256 hashing, not a password KDF.
- **Impact:** Offline cracking is significantly easier if the user table is leaked.
- **Fix:** Use Argon2id (preferred), scrypt, or bcrypt with per-user salt and calibrated cost parameters; migrate existing hashes.

### FRI-SEC-005: Access Token Revocation Path Is Ineffective
- **File:** `src/api/auth/friday-auth-service.ts:76`, `src/api/auth/friday-token-validator.ts:67`
- **Description:** Access tokens are minted with `tokenId`, but issued user access tokens are not persisted in a revocation-tracked store; validator relies on revocation lookup by `tokenId`.
- **Impact:** Emergency revocation is unreliable; stolen access tokens typically remain usable until expiry.
- **Fix:** Persist issued access token JTIs (or session/token version state) and enforce revocation/session checks during validation.

### FRI-SEC-006: PKCE Flow Misuses `state` and `code_verifier`
- **File:** `src/providers/oauth/friday-anthropic-oauth.ts:165`
- **Description:** `state` is set equal to the PKCE verifier, and exchange falls back to `state` as `code_verifier`.
- **Impact:** PKCE secret separation is broken, weakening authorization code exchange integrity.
- **Fix:** Generate independent random `state` and `code_verifier`, persist state→verifier with TTL, and reject exchange when state is missing/unrecognized.

### FRI-SEC-007: Permissive Default CORS (`*`) for API
- **File:** `src/hub/friday-hub-bootstrap.ts:157`, `src/api/http/friday-http-server.ts:172`
- **Description:** Default CORS origin is `*`, and server allows `Authorization` header in CORS requests.
- **Impact:** Browser-origin protections are overly broad by default.
- **Fix:** Default to explicit allowlist (or disabled CORS), require operators to opt in.

---

## P2 — Medium

### FRI-SEC-008: Internal Error Messages Are Returned to Clients
- **File:** `src/api/http/friday-http-error-mapper.ts:23`
- **Description:** Generic `Error` responses return raw `error.message`.
- **Impact:** Internal implementation details can leak.
- **Fix:** Return generic message for 5xx errors; log detailed errors server-side only.

### FRI-SEC-009: Missing Baseline Security Headers
- **File:** `src/api/http/friday-http-server.ts:145`
- **Description:** No `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`.
- **Fix:** Add security header middleware.

### FRI-SEC-010: Unbounded `limit` Parameters on Session Endpoints
- **File:** `src/api/http/routes/friday-session-routes.ts:316`
- **Description:** Session list/messages/forks limits validate positive integer but no upper bounds.
- **Fix:** Enforce capped limits (e.g., 100/200 max).
