> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Security P0 Fix Plan (2026-02-18)

## FRI-SEC-001: Login Auth Bypass

**Files to modify:**
- `src/api/auth/friday-auth-service.ts:96, :121`
- `src/api/auth/friday-auth-service.types.ts:20`
- `src/api/runtime/friday-api-runtime.ts:73`
- `src/api/runtime/friday-api-runtime.types.ts:48`
- `src/hub/friday-hub-bootstrap.ts:81, :398`

**Changes:**
1. Add `allowPasswordlessLocalLogin` (default `false`) + optional `warn` to auth service deps.
2. In `login()`:
   - Treat credentials as explicit only when non-empty (`localPassphrase`, or `email`+`password`).
   - Remove unconditional `{}` fallback to `findLocalUser()`.
   - If no explicit credentials and `allowPasswordlessLocalLogin === false`, throw `FridayAuthError("AUTH_METHOD_REQUIRED", ...)`.
   - If `allowPasswordlessLocalLogin === true`, allow local user fallback but log warning.
3. Thread auth policy from hub/runtime into auth service:
   - Add runtime deps field for local-login policy.
   - Pass through from `createFridayApiRuntime()` to `createFridayAuthService()`.
   - Compute policy in hub from `FRIDAY_REQUIRE_AUTH`, `NODE_ENV==="production"`, and whether `FRIDAY_TOKEN_SECRET` was explicitly set.

**Tests:**
- empty `{}` login rejected in strict mode (`AUTH_METHOD_REQUIRED`)
- `localPassphrase` login succeeds
- dev fallback mode allows `{}` and warns
- login route/e2e flows use `localPassphrase` instead of implicit fallback

---

## FRI-SEC-002: Predictable Default Token Secret

**Files to modify:**
- `src/hub/friday-hub-bootstrap.ts:12, :53, :114, :137, :272`
- `.env.example:15`

**Changes:**
1. Remove hardcoded fallback secret (`friday-dev-secret-change-me`).
2. Add token-secret resolver:
   - Precedence: explicit config → `FRIDAY_TOKEN_SECRET` env → `~/.friday/token.secret` → generate random.
   - On generate: create `~/.friday` with `0700`, write `token.secret` with `0600`.
   - Use `crypto.randomBytes(32).toString("hex")`.
3. Warn on startup when using generated/persisted local secret.
4. Return metadata about token-secret source for SEC-001 auth policy.

**Tests:**
- explicit config secret wins
- env secret wins when config absent
- existing `~/.friday/token.secret` is loaded
- first-run generates and persists secret
- persist failure still returns generated secret and warns

---

## FRI-SEC-003: Fail-Open Middleware

**Files to modify:**
- `src/api/http/friday-http-server.ts:20, :183, :293`

**Changes:**
1. Make `middleware` required in `FridayHttpServerDeps`.
2. Add startup guard that throws if middleware missing.
3. Remove fail-open conditional; always run auth enforcement.

**Tests:**
- server creation throws if middleware omitted
- private route without auth token returns 401
