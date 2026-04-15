# CX Diagnosis: LLM E2E Test Hang After 422

**Date:** 2026-02-19  
**Test file:** `test/e2e/friday-real-scenarios-e2e.test.ts`  
**Symptom:** Scenario 2 (Workflow Gen) hangs forever after Scenario 1 (Skill Gen) returns 422. 0% CPU, no TCP connections, sleeping state.

---

## Executive Summary

The primary root cause is the **OAuth token manager's single-flight refresh mechanism** (`inflightRefreshes` map) combined with **no fetch timeout on LLM inference calls**. When the OAuth access token expires between scenarios (especially with the `REFRESH_TOKEN` path), the refresh call can hang or a stale in-flight promise can block all subsequent LLM calls. A secondary defense-in-depth issue is that the inference client performs `fetch()` calls to Anthropic with **no AbortSignal timeout**, meaning any network stall becomes an infinite hang.

---

## Root Cause Analysis (most likely → least likely)

### 1. 🔴 OAuth Token Expiry + Stale `inflightRefreshes` Promise (MOST LIKELY)

**Code path:**
```
Scenario 2 request
  → workflowGenerator.startSession()
  → runRequirementsAnalyzer()
  → llm.infer()
  → providerService.runWithFallback()
  → resolveCredential()
  → oauthTokenManager.getValidAccessToken()
  → TOKEN EXPIRED → refreshAccessToken() → hangs or returns stale promise
```

**File:** `src/providers/oauth/friday-oauth-token-manager.ts` (lines 85–120)

**Mechanism:**
- The test seeds OAuth credentials in `seedOAuthCredentials()`. When using `REFRESH_TOKEN`, the expiry is:
  ```typescript
  expiresAt: new Date(Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000).toISOString()
  ```
- If Anthropic returns `expires_in: 600` (10 min), the effective expiry is `now + 5 min`.
- Scenario 1 makes 5-9+ LLM calls (requirements analyzer + clarification + generation pipeline with repairs). This easily takes 3-5 minutes.
- By Scenario 2, the token may have expired.
- When expired, `getValidAccessToken()` enters the refresh path:
  ```typescript
  const existing = inflightRefreshes.get(flightKey);
  if (existing) return existing; // Returns same stuck promise!
  ```
- If the refresh `fetch()` to `console.anthropic.com/v1/oauth/token` hangs (network issue, DNS resolution, TLS), the promise never resolves, and `inflightRefreshes` retains it forever.
- All subsequent calls to `getValidAccessToken()` for the same provider return the same stuck promise.
- The `finally { inflightRefreshes.delete(flightKey) }` never runs because the promise never settles.

**Evidence supporting:**
- 0% CPU + no TCP connections = process is awaiting a Promise that never resolves
- The hang is BEFORE the Anthropic API fetch (no TCP connections to `api.anthropic.com`)
- `refreshAccessToken()` calls `fetchFn()` with NO AbortSignal timeout
- The single-flight pattern means a stuck refresh poisons ALL subsequent calls

**Evidence against:**
- If using `ACCESS_TOKEN_DIRECT`, expiry is 8 hours (won't expire). This hypothesis only applies to the `REFRESH_TOKEN` path.
- If the refresh succeeded during Scenario 1, the new token should be valid for Scenario 2.

**Fix:**
1. Add `AbortSignal.timeout()` to the refresh `fetch()` call
2. Add a timeout wrapper around the single-flight promise
3. Clear stale entries from `inflightRefreshes` on subsequent access attempts

---

### 2. 🟠 No Fetch Timeout on LLM Inference Calls (CONTRIBUTING FACTOR)

**File:** `src/skills/generator/llm/friday-provider-inference-client.ts` (lines 330–340, 455–465)

**Mechanism:**
The inference client's `fetch()` calls to Anthropic have no `signal: AbortSignal.timeout(...)`:
```typescript
const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
  // NO signal/timeout!
});
```

If the Anthropic API connection stalls (TCP connection established but no response), the fetch waits forever. This is independent of the OAuth issue — even with a valid token, a stalled Anthropic API connection would cause the same hang symptoms.

**Evidence supporting:**
- No AbortSignal/timeout anywhere in the inference client code
- Node.js `fetch()` (undici) has no default request timeout
- Provider validator DOES use AbortController (`src/providers/validation/friday-provider-validator.ts:34`)— showing the pattern exists but wasn't applied to inference

**Evidence against:**
- The bug report says "no TCP connections", which means the hang is BEFORE the fetch to Anthropic, not during it
- If the hang were during a fetch, there would be TCP connections visible

**Fix:**
Add `signal: AbortSignal.timeout(120_000)` to all `fetch()` calls in the inference client (both main inference and compaction summary).

---

### 3. 🟡 Node.js Undici Connection Pool Stall (POSSIBLE)

**Mechanism:**
Node.js v22's global `fetch()` uses undici internally. Known issues:
- Connections to `api.anthropic.com` from Scenario 1 may be kept alive in the pool
- If a kept-alive connection enters a bad state (half-closed, RST received), the next `fetch()` attempt through that connection hangs
- undici's retry/reconnect logic may not work correctly in all edge cases (see nodejs/undici#3492)

Scenario 1 makes 5-9+ fetch calls to `api.anthropic.com`. After the generation pipeline completes, some connections may be in the pool in a bad state. When Scenario 2 tries to use a pooled connection, it hangs.

**Evidence supporting:**
- Node.js v22 undici has known connection reuse bugs
- High number of sequential requests in Scenario 1 increases likelihood of stale connections
- No TCP connections visible = connection attempt fails silently or hangs before establishment

**Evidence against:**
- undici should handle connection errors and retry transparently
- The fetch is to Anthropic's API (not localhost), so this would show TCP connections, not 0 connections

**Fix:**
Set `keepAlive: false` on fetch calls, or configure a custom undici `Agent` with `connections: 1, pipelining: 0`.

---

### 4. 🟢 SQLite WAL Visibility After External Seed (UNLIKELY)

**File:** `test/e2e/friday-real-scenarios-e2e.test.ts` (line 1678)

**Mechanism:**
The `seedOAuthCredentials()` function opens a separate `better-sqlite3` Database connection to the same file the hub is using. It writes OAuth credentials, runs `wal_checkpoint(FULL)`, and closes. The hub's read pool connections may not immediately see the new data if they have a cached WAL index.

However, in SQLite WAL mode with `better-sqlite3`:
- The `wal_checkpoint(FULL)` moves WAL content to the main DB file
- Subsequent reads from the hub's read pool will see the checkpointed data
- `better-sqlite3` properly coordinates via the WAL shared-memory file

**Evidence supporting:**
- If credentials are invisible, `getByProviderProfileId()` returns null, `getValidAccessToken()` returns null, `resolveCredential()` throws `PROVIDER_AUTH_INVALID`, which the fallback catches and throws `PROVIDER_ERROR` — this would NOT cause a hang, it would return a 502 error.

**Evidence against:**
- Scenario 1 succeeds with multiple LLM calls, proving the credentials ARE visible to the hub
- `wal_checkpoint(FULL)` ensures data is flushed to main DB

**Fix:**
No fix needed. The current approach is correct.

---

### 5. 🟢 Provider Fallback Cooldown (NOT THE CAUSE)

**File:** `src/providers/routing/friday-provider-fallback.ts`

**Mechanism:**
The fallback puts providers in 120-second cooldown after transient errors (429, timeout, etc.). If the Anthropic provider were in cooldown, it would still be attempted (just placed last in the list).

**Evidence against:**
- Scenario 1's 422 is thrown by Friday's validation layer AFTER successful Anthropic API calls. The provider HTTP calls succeed (200 from Anthropic). The error is not transient (no "429", "rate_limit", "timeout" patterns).
- `isTransientError()` would return false for PARSE_ERROR/VALIDATION_ERROR/GENERATION_FAILED messages
- Even if in cooldown, the provider is still attempted (moved to end of list, but with 1 provider, it's the only candidate)
- Cooldown providers are tried, not skipped — they just get lower priority

**Fix:**
No fix needed.

---

## Fix Plan

### Priority 1: Add timeout to OAuth token refresh (root cause)

**File:** `src/providers/oauth/friday-oauth-token-manager.ts`

```typescript
// In getValidAccessToken(), wrap the refresh promise with a timeout:
const REFRESH_TIMEOUT_MS = 15_000; // 15 seconds

const refreshPromise = (async (): Promise<string | null> => {
  try {
    // ... existing refresh logic ...
    
    // Add timeout to the actual refresh call
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), REFRESH_TIMEOUT_MS);
    try {
      const newTokenSet = await adapter.refreshAccessToken(tokenToRefresh);
      clearTimeout(timeoutId);
      // ... rest of existing logic
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  } finally {
    inflightRefreshes.delete(flightKey);
  }
})();
```

**Also add a stale-entry cleanup:**
```typescript
// Before checking inflightRefreshes, clean up entries that have been pending too long
// (This is defense-in-depth against leaked promises)
```

**File:** `src/providers/oauth/friday-anthropic-oauth.ts`

```typescript
// In refreshAccessToken(), add AbortSignal.timeout to the fetch call:
async refreshAccessToken(refreshToken): Promise<FridayOAuthTokenSet> {
  const response = await fetchFn(FRIDAY_ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({...}),
    signal: AbortSignal.timeout(15_000), // ADD THIS
  });
  // ... rest unchanged
}
```

### Priority 2: Add timeout to all LLM inference fetch calls (defense in depth)

**File:** `src/skills/generator/llm/friday-provider-inference-client.ts`

Add `signal: AbortSignal.timeout(120_000)` to both fetch calls:

1. **Main inference fetch** (~line 340):
```typescript
const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120_000), // 2 min timeout
});
```

2. **Compaction summary fetch** (~line 285):
```typescript
const resp = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120_000), // 2 min timeout
});
```

### Priority 3: Add inflight refresh timeout/cleanup in token manager

**File:** `src/providers/oauth/friday-oauth-token-manager.ts`

Add a staleness check for `inflightRefreshes` entries:

```typescript
const INFLIGHT_REFRESH_MAX_AGE_MS = 30_000; // 30 seconds
const inflightRefreshes = new Map<string, { promise: Promise<string | null>; startedAt: number }>();

// In getValidAccessToken:
const existing = inflightRefreshes.get(flightKey);
if (existing) {
  // If the inflight refresh has been pending too long, discard it and retry
  if (nowMs() - existing.startedAt > INFLIGHT_REFRESH_MAX_AGE_MS) {
    inflightRefreshes.delete(flightKey);
  } else {
    return existing.promise;
  }
}
```

---

## Clawdbot Comparison

Clawdbot's provider infrastructure (`/opt/homebrew/lib/node_modules/clawdbot/src/infra/`) focuses on usage tracking and monitoring, not on the fallback/retry pattern that Friday uses. Key differences:

1. **No OAuth token refresh**: Clawdbot uses API keys directly, not OAuth tokens. No single-flight refresh mechanism.
2. **No fallback chain**: Clawdbot routes directly to a provider without a fallback/retry chain.
3. **No relevant timeout pattern**: Clawdbot's provider code doesn't show a fetch timeout pattern worth porting.

The relevant lesson from Clawdbot is **simplicity** — by using direct API keys, it avoids the entire class of OAuth token refresh bugs.

---

## Summary of Changes Needed

| File | Change | Priority |
|------|--------|----------|
| `src/providers/oauth/friday-oauth-token-manager.ts` | Add timeout + stale cleanup to inflight refresh | P1 |
| `src/providers/oauth/friday-anthropic-oauth.ts` | Add `AbortSignal.timeout(15_000)` to `refreshAccessToken()` fetch | P1 |
| `src/skills/generator/llm/friday-provider-inference-client.ts` | Add `AbortSignal.timeout(120_000)` to both `fetch()` calls | P2 |
| `src/providers/validation/friday-provider-validator.ts` | Already has AbortController — no change needed | — |

### Test File Improvement (optional)

**File:** `test/e2e/friday-real-scenarios-e2e.test.ts`

In `seedOAuthCredentials()`, ensure `expiresAt` uses a minimum of 1 hour regardless of `expires_in` from the token response:
```typescript
const minExpiryMs = Math.max(tokenData.expires_in * 1000 - 5 * 60 * 1000, 60 * 60 * 1000);
expiresAt: new Date(Date.now() + minExpiryMs).toISOString(),
```

---

## Verification Steps

1. After fixes, run the LLM E2E tests:
   ```bash
   FRIDAY_LLM_E2E=1 FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN=... npx vitest test/e2e/friday-real-scenarios-e2e.test.ts
   ```
2. Verify Scenario 2 starts within 60 seconds (test timeout)
3. If it still hangs, add debug logging to `getValidAccessToken()` to trace token expiry and refresh behavior
