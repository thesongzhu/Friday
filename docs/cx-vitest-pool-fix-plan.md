> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Fix Plan: Vitest Pool Configuration for LLM E2E Tests

**Date:** 2026-02-19  
**Author:** CX  
**Status:** Ready to implement

---

## Problem

LLM E2E tests hang indefinitely when run through vitest (`pool: "forks"`) but work perfectly when the same code runs in a normal `node -e` process. The hang occurs specifically when forked child_process workers make external HTTPS requests (hub → api.anthropic.com).

### Root Cause

Vitest `pool: "forks"` spawns test files in `child_process.fork()` workers. On Node.js 22, the forked process has IPC channels and inherited file descriptors that interfere with undici's (the native `fetch()` implementation) connection lifecycle. External HTTPS requests to `api.anthropic.com` hang with 0% CPU and no TCP connections — the request never actually leaves the fork worker.

This is the inverse of the documented vitest issue (#3077) where `pool: "threads"` caused `fetch()` to leave zombie processes. In our case, `forks` is the problematic pool for external outbound HTTPS, while `threads` works fine because `worker_threads` share the parent's networking stack more transparently.

### Evidence

| Scenario | Result |
|----------|--------|
| `node -e` with same hub + OAuth + skill generator | ✅ 200 in 23s |
| vitest fork worker → hub → Anthropic API | ❌ Hangs forever |
| vitest fork worker → local HTTP to hub (no external calls) | ✅ All pass |
| `curl` to Anthropic API | ✅ Works |
| Node.js `fetch()` to Anthropic outside vitest | ✅ Works |

**Affected file:** `test/e2e/friday-llm-e2e.test.ts` (the only file that makes real external HTTPS calls through the hub during test execution)

**Not affected:**
- `test/e2e/friday-full-e2e.test.ts` — Batch 1 is all CRUD, no LLM calls
- `test/e2e/friday-real-scenarios-e2e.test.ts` — NON-LLM scenarios (CRUD/engine only)
- `test/e2e/api/*.test.ts`, `test/e2e/cli/*.test.ts`, etc. — all local HTTP
- `test/unit/**`, `test/integration/**` — no external calls

---

## Solution: Vitest `projects` with Per-Pool Configuration

Vitest 4.0.18 has **removed** `poolMatchGlobs` (deprecated since v3, removed in v4). The replacement is **`projects`** — inline project configurations that can specify different `pool` settings per test subset.

### Strategy

1. **Default pool stays `forks`** — safe for unit tests, integration tests, and non-LLM E2E tests (which may use `process.chdir()`, native modules like `better-sqlite3`, etc.)
2. **LLM E2E tests get `pool: "threads"`** — `worker_threads` share the parent process's networking stack, so outbound HTTPS via undici/`fetch()` works correctly
3. Use `projects` inline configuration to split the two pools

### Why `threads` and not `vmThreads` or `vmForks`?

| Pool | Fetch works? | Native modules? | Notes |
|------|-------------|-----------------|-------|
| `forks` | ❌ hangs for external HTTPS | ✅ | Current default — the bug |
| `threads` | ✅ | ⚠️ some native libs segfault | `better-sqlite3` is used in LLM tests — need to verify, but SQLite in-process should be OK since each test creates its own DB |
| `vmThreads` | ✅ | ❌ globals mismatch | `Error` constructor issues, memory leaks |
| `vmForks` | ❌ same fork issue | ✅ | Same `child_process` problem as `forks` |

**`threads` is the correct choice.** The LLM E2E test creates a fresh `better-sqlite3` DB per test run (no concurrent access), so thread safety of the native module isn't a concern.

---

## Exact Config Change

### Current `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "#utilities": resolve(__dirname, "src/utilities/index.ts"),
      // ... other aliases ...
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 10_000,
  },
});
```

### New `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const pathAliases = {
  "#utilities": resolve(__dirname, "src/utilities/index.ts"),
  "#api": resolve(__dirname, "src/api/index.ts"),
  "#config": resolve(__dirname, "src/config/index.ts"),
  "#errors": resolve(__dirname, "src/errors/index.ts"),
  "#hub": resolve(__dirname, "src/hub/index.ts"),
  "#jobs": resolve(__dirname, "src/jobs/index.ts"),
  "#learning": resolve(__dirname, "src/learning/index.ts"),
  "#ledger": resolve(__dirname, "src/ledger/index.ts"),
  "#satellites": resolve(__dirname, "src/satellites/index.ts"),
  "#skills/converter": resolve(__dirname, "src/skills/converter/index.ts"),
  "#skills/generator": resolve(__dirname, "src/skills/generator/index.ts"),
  "#memory": resolve(__dirname, "src/memory/index.ts"),
  "#sessions": resolve(__dirname, "src/sessions/index.ts"),
  "#skills": resolve(__dirname, "src/skills/index.ts"),
  "#state": resolve(__dirname, "src/state/index.ts"),
  "#providers": resolve(__dirname, "src/providers/index.ts"),
  "#workflows": resolve(__dirname, "src/workflows/index.ts"),
  "#plugins": resolve(__dirname, "src/plugins/index.ts"),
  "#cli": resolve(__dirname, "src/cli/index.ts"),
};

export default defineConfig({
  resolve: {
    alias: pathAliases,
  },
  test: {
    pool: "forks",
    testTimeout: 10_000,
    projects: [
      {
        // Unit, integration, and non-LLM E2E tests — use forks (safe for native modules)
        extends: true,
        test: {
          name: "default",
          include: [
            "test/unit/**/*.test.ts",
            "test/integration/**/*.test.ts",
            "test/helpers/**/*.test.ts",
            "test/e2e/api/**/*.test.ts",
            "test/e2e/cli/**/*.test.ts",
            "test/e2e/plugins/**/*.test.ts",
            "test/e2e/skills/**/*.test.ts",
            "test/e2e/workflows/**/*.test.ts",
            "test/e2e/friday-full-e2e.test.ts",
            "test/e2e/friday-real-scenarios-e2e.test.ts",
          ],
          pool: "forks",
        },
      },
      {
        // LLM E2E tests — use threads (fetch/undici works correctly in worker_threads)
        extends: true,
        test: {
          name: "llm-e2e",
          include: ["test/e2e/friday-llm-e2e.test.ts"],
          pool: "threads",
          testTimeout: 120_000,
        },
      },
    ],
  },
});
```

### Key decisions in this config:

1. **`extends: true`** on both projects — inherits `resolve.alias` from root config (critical for `#hub`, `#providers`, etc.)
2. **Explicit `include` lists** rather than glob exclusions — clearer about what goes where, no ambiguity
3. **`testTimeout: 120_000`** on the LLM project — LLM calls can take 30-90s per test
4. **Root `pool: "forks"` is kept** as the base default (inherited by `extends: true`) but the default project overrides it explicitly for clarity
5. **Named projects** (`default` and `llm-e2e`) — allows running subsets: `vitest run --project llm-e2e`

---

## Alternative: Simpler Approach (If Only One LLM Test File)

If we want a minimal change and are confident that only `friday-llm-e2e.test.ts` will ever need `threads`:

```ts
export default defineConfig({
  resolve: { alias: pathAliases },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/friday-llm-e2e.test.ts"],
    pool: "forks",
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "llm-e2e",
          include: ["test/e2e/friday-llm-e2e.test.ts"],
          pool: "threads",
          testTimeout: 120_000,
        },
      },
    ],
  },
});
```

⚠️ **Caveat:** When `projects` is defined, vitest ignores root-level `include`/`exclude` for test file resolution — each project must define its own `include`. The root `include` only applies if there are no projects. So the "simpler" version may not work as expected. **Recommend the explicit two-project approach.**

---

## Verification Plan

1. **Run non-LLM tests (should still pass with forks):**
   ```bash
   vitest run --project default
   ```

2. **Run LLM E2E tests (should now complete instead of hanging):**
   ```bash
   FRIDAY_LLM_E2E=1 FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN=<token> vitest run --project llm-e2e
   ```

3. **Run all tests together:**
   ```bash
   FRIDAY_LLM_E2E=1 FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN=<token> vitest run
   ```

4. **Verify `better-sqlite3` works in threads pool:**
   The LLM test creates a fresh temp DB per run. Since there's no concurrent write access from multiple threads, `better-sqlite3` should work fine in `worker_threads`. If segfaults occur, add `poolOptions.threads.isolate: true` (which is the default).

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `better-sqlite3` segfault in threads | Low — single-writer, isolated DB per test | Fall back to running LLM tests via `node --test` or separate vitest config file |
| Future E2E tests with external calls also hang | Medium | Document that LLM/external-HTTPS tests must use `llm-e2e` project; add include glob |
| Project config breaks alias resolution | Low — `extends: true` inherits aliases | Verified: vitest docs confirm `extends: true` merges parent config |

---

## Notes

- **No `// @vitest-environment` or pool annotations** exist in any of the three E2E test files — they all rely on the global vitest config
- **`poolMatchGlobs` is removed in vitest 4** — cannot use it (we're on vitest 4.0.18)
- **`environmentMatchGlobs` is also removed in vitest 4** — same story
- The vitest `projects` feature (formerly "workspace") is the official v4 replacement for per-file pool/environment overrides
