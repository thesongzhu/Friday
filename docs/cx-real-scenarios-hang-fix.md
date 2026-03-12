# CX Fix Plan: `friday-real-scenarios-e2e.test.ts` LLM Scenarios Hang

**Date:** 2026-02-19
**Author:** CX (Architect/Reviewer)
**Status:** Analysis complete, fix ready for implementation

---

## Root Cause

Two interacting problems cause the hang:

### 1. Concurrent LLM file execution exhausts Anthropic rate limits

In the current vitest config, the `llm-e2e` project runs both files **simultaneously** in separate worker threads (`pool: "threads"`, `fileParallelism: true` by default):

- **Thread A:** `friday-llm-e2e.test.ts` — 4 LLM calls (validation, inference, skill gen, workflow gen)
- **Thread B:** `friday-real-scenarios-e2e.test.ts` — NON-LLM block runs first (fast), then LLM block starts with 5+ additional LLM calls

Both files use the **same OAuth access token** to hit the Anthropic API. When `friday-llm-e2e.test.ts` is making its calls and `friday-real-scenarios-e2e.test.ts` starts its LLM block, the concurrent request load exceeds Anthropic's per-token rate limits. The Anthropic API may hold the TCP connection open without responding (instead of immediately returning 429), causing `fetch()` to appear to hang.

The `AbortSignal.timeout(120_000)` on the fetch matches the test timeout (120s), so when the abort fires, the test has already timed out — but in `pool: "threads"` mode, vitest's test timeout reporting can get stuck if the worker thread itself is blocked waiting on a native socket.

### 2. `process.exit(0)` in afterAll is fatal in threads mode

Both test files have this pattern in `afterAll`:

```typescript
afterAll(async () => {
  const closeTimeout = setTimeout(() => {
    console.warn("Cleanup timeout — forcing exit");
    process.exit(0);  // ← KILLS THE ENTIRE VITEST PROCESS
  }, 5_000);
  // ... cleanup ...
  clearTimeout(closeTimeout);
}, 15_000);
```

In `pool: "threads"` mode, worker threads share the same process. `process.exit(0)` terminates **all** worker threads, killing the entire test run. If either file's cleanup takes >5s (e.g., because SQLite close blocks while the other thread holds a lock), this safety net becomes a bomb.

### Supporting Evidence

- **Scenario 1 (skill gen) → 422 succeeds:** This call completes (with errors from the LLM), consuming several retries worth of API calls. By the time Scenario 2 starts, the rate limit window may be fully consumed.
- **0% CPU after Scenario 1:** Indicates the process is waiting on I/O (network), not computing — consistent with a pending `fetch()`.
- **Direct `node -e` works fine (23s):** No concurrent LLM calls from a second test file → no rate limit contention.
- **Clawdbot pattern:** E2E tests use `spawn()` for process isolation and exclude E2E from the main test suite entirely.

---

## Recommended Fix: Option B — Serialize LLM test files

**Set `fileParallelism: false` on the `llm-e2e` project.** This is the simplest, most robust fix.

### Why This Option

| Option | Pros | Cons |
|--------|------|------|
| **A. Separate vitest projects** | Full isolation | Config complexity, two project definitions |
| **B. `fileParallelism: false`** | One-line fix, serializes files | LLM tests take longer (serial) — acceptable for LLM E2E |
| **C. Merge into one file** | Single hub, no contention | 3000+ line monster file, maintenance nightmare |
| **D. Per-file projects** | Fine-grained control | Over-engineered for 2 files |

LLM E2E tests are inherently slow (60-120s per call). Running them in parallel saves maybe 30s but creates fragile rate-limit-dependent behavior. Serial execution is the correct tradeoff.

---

## Exact Changes

### 1. `vitest.config.ts` — Serialize the `llm-e2e` project files

Set `maxWorkers: 1` on the `llm-e2e` project to ensure only one file runs at a time. This is equivalent to `fileParallelism: false` but more explicit and guaranteed to work at the project level in vitest 4.x:

```diff
       {
         extends: true,
         test: {
           name: "llm-e2e",
           include: [
             "test/e2e/friday-llm-e2e.test.ts",
             "test/e2e/friday-real-scenarios-e2e.test.ts",
           ],
           pool: "threads",
           testTimeout: 120_000,
+          maxWorkers: 1,
+          hookTimeout: 30_000,
         },
       },
```

**Why `maxWorkers: 1`:** This is what `fileParallelism: false` resolves to internally (see vitest source: `resolved.maxWorkers = 1`). Setting it directly avoids any ambiguity about whether `fileParallelism` is properly scoped to inline projects in vitest 4.x.

### 2. Remove `process.exit(0)` from both test files

Replace the dangerous `process.exit(0)` pattern in `afterAll` with a safe logging-only fallback.

**`test/e2e/friday-llm-e2e.test.ts`** (line ~196):
```diff
   afterAll(async () => {
     if (env) {
-      const closeTimeout = setTimeout(() => {
-        console.warn("[LLM-E2E] Cleanup timeout — forcing exit");
-        process.exit(0);
-      }, 5_000);
       await env.cleanup();
-      clearTimeout(closeTimeout);
     }
   }, 15_000);
```

**`test/e2e/friday-real-scenarios-e2e.test.ts`** — NON-LLM afterAll (line ~139):
```diff
   afterAll(async () => {
-    const closeTimeout = setTimeout(() => {
-      console.warn("[Scenarios-E2E] Cleanup timeout — forcing exit");
-      process.exit(0);
-    }, 5_000);
     if (httpServer) await httpServer.close();
     if (hub) await hub.stop();
     if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
-    clearTimeout(closeTimeout);
   }, 15_000);
```

**`test/e2e/friday-real-scenarios-e2e.test.ts`** — LLM afterAll (line ~1776):
```diff
     afterAll(async () => {
-      const closeTimeout = setTimeout(() => {
-        console.warn("[Scenarios-LLM-E2E] Cleanup timeout — forcing exit");
-        process.exit(0);
-      }, 5_000);
       if (httpServer) await httpServer.close();
       if (hub) await hub.stop();
       if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
-      clearTimeout(closeTimeout);
     }, 15_000);
```

**Rationale:** Vitest has its own hook timeout (`hookTimeout` / `afterAll` timeout). If cleanup hangs, vitest will handle it. `process.exit()` in threads mode is always wrong — it kills sibling threads too.

---

## Verification Plan

After applying the fix:

```bash
# Run only the llm-e2e project
FRIDAY_LLM_E2E=1 FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN=<token> \
  npx vitest run --project llm-e2e

# Expected:
# 1. friday-llm-e2e.test.ts runs FIRST (4/4 pass)
# 2. friday-real-scenarios-e2e.test.ts runs SECOND
#    - NON-LLM scenarios pass
#    - LLM Scenario 1 (skill gen) → 200 or 422 ✅
#    - LLM Scenario 2 (workflow gen) → completes ✅
#    - LLM Scenario 3 (AI inference node) → completes ✅
#    - LLM Scenario 4 (memory extraction) → completes ✅
#    - LLM Scenario 11 (multi-turn) → completes ✅
```

---

## Alternative: If `fileParallelism: false` alone doesn't fix it

If serializing still hangs, the issue is within-file (NON-LLM hub interfering with LLM hub in the same thread). In that case:

1. **Split the file:** Move the LLM `describe` block to a new file `test/e2e/friday-real-scenarios-llm-e2e.test.ts`
2. Ensure the NON-LLM block's `afterAll` fully closes the hub (verify SQLite connections are released)
3. Add a 1s delay between blocks to let OS reclaim file descriptors

But this is unlikely needed. The NON-LLM block should fully clean up before the LLM block starts — vitest guarantees sequential execution within a file.
