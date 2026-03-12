# Friday Test Gap Analysis — CX
> Date: 2026-02-20 | Reference: OpenClaw test patterns

## Section A: Test Gaps

### 1. Provider Fallback Error Classification

1. **Transient pattern matrix triggers cooldown** (Effort: M)  
What: Add a table-driven test covering transient strings currently hardcoded in `src/providers/routing/friday-provider-fallback.ts:38` (`429`, `rate_limit`, `quota`, `capacity`, `throttl`, `timeout`, `ETIMEDOUT`, `ECONNRESET`, `socket hang up`).  
Why: Prevents repeated retries against a degraded provider and mirrors OpenClaw’s classification breadth (`openclaw-dev/src/agents/model-fallback.e2e.test.ts:62`, `:434`, `:479`).  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts` (extend `describe("runWithFallback")` starting near `:211`).  
How: `p1` throws transient message, `p2` succeeds; assert fallback route is `p2` and `fb.isInCooldown("p1") === true`.

2. **Permanent/auth errors do not set cooldown** (Effort: S)  
What: Add a test where `p1` fails with non-transient message (for example `401 invalid_api_key`) and `p2` succeeds.  
Why: Avoids suppressing usable providers due to misconfiguration errors.  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts`, covering classifier use at `src/providers/routing/friday-provider-fallback.ts:176`.  
How: Run once and assert `fb.isInCooldown("p1") === false`.

3. **Structured non-Error transient failures are classified correctly** (Effort: M)  
What: Add test for thrown object (`{ status: 429, code: "ETIMEDOUT", message: "too many requests" }`) treated as transient.  
Why: Real client libraries sometimes throw non-`Error` objects; current `String(err)` path at `src/providers/routing/friday-provider-fallback.ts:175` can miss transient signals.  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts`.  
How: Throw plain object from `run`, assert cooldown set (requires Section B code change).

4. **Transient attempt logging still redacts secrets** (Effort: S)  
What: Add test for error text containing key-like token and transient phrase.  
Why: Prevents secret leakage in provider attempt summaries.  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts`, covering redaction at `src/providers/routing/friday-provider-fallback.ts:22` and attempt recording at `:180`.  
How: Throw `Error("429 sk-test-abc123...")`, catch final failure, assert attempt/error text contains `[REDACTED]`.

---

### 2. Cooldown Behavior

1. **Cooldown is set immediately after transient failure** (Effort: S)  
What: Explicit test for `isInCooldown()` immediately after transient failure.  
Why: Validates cooldown write path at `src/providers/routing/friday-provider-fallback.ts:105`.  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts`.  
How: Fail `p1` with timeout text, then check `isInCooldown("p1")`.

2. **Cooled provider is deprioritized on next run** (Effort: M)  
What: Two sequential runs verify candidate partitioning (`ready` before `cooledDown`) at `src/providers/routing/friday-provider-fallback.ts:157`.  
Why: Prevents hot-looping a failing primary provider.  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts`.  
How: First run marks `p1` cooldown; second run asserts call order starts with `p2`.

3. **Cooled provider still used as last resort** (Effort: S)  
What: Verify cooled provider is appended and attempted if non-cooled providers fail (`src/providers/routing/friday-provider-fallback.ts:167`).  
Why: Prevents hard dead-end when only cooled provider can recover.  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts`.  
How: Mark `p1` cooled, force `p2` fail, assert `p1` is eventually attempted.

4. **Cooldown expiry removes stale entry and restores priority** (Effort: M)  
What: Test expiry logic at `src/providers/routing/friday-provider-fallback.ts:98` with fake time.  
Why: Prevents permanent starvation due to stale cooldown state.  
Where: `test/unit/providers/routing/friday-provider-fallback.test.ts`.  
How: Use `vi.useFakeTimers()`/`vi.setSystemTime()`, advance beyond 120s, assert `isInCooldown("p1") === false` and next run tries `p1` first.

---

### 3. Memory Hybrid Search

1. **Semantic-only hits respect `tagsAll` filtering** (Effort: M)  
What: Add search test where FTS misses, semantic returns multiple items, and only full `tagsAll` match survives (`src/memory/services/friday-memory-service.ts:175`).  
Why: Prevents semantic false positives leaking across tag constraints.  
Where: `test/unit/memory/services/friday-memory-service.test.ts` (search block begins near `:192`).  
How: Store two items same namespace with different tag sets; query unmatched term; assert only item with all required tags is returned.

2. **Semantic-only result metadata is correct** (Effort: S)  
What: Validate semantic-only path yields `matchedBy` containing `"semantic"` and snippet fallback from item content (`src/memory/search/friday-memory-hybrid.ts:88`).  
Why: Keeps result explainability and UI behavior consistent.  
Where: `test/unit/memory/services/friday-memory-service.test.ts`.  
How: Force FTS miss, semantic hit; assert `matchedBy`, `snippet`, and non-zero semantic score.

3. **Namespace substring fallback activates when FTS+semantic are empty** (Effort: M)  
What: Test fallback scan branch at `src/memory/services/friday-memory-service.ts:198`.  
Why: Prevents empty results for partial-token queries in production.  
Where: `test/unit/memory/services/friday-memory-service.test.ts`.  
How: Use embedding-fail mock, query substring not tokenized by FTS, pass `namespace`, assert result score `0.1` and item match.

4. **Substring fallback honors `minScore` cutoff** (Effort: S)  
What: Add case for `minScore > 0.1` blocking fallback result (`src/memory/services/friday-memory-service.ts:227`).  
Why: Prevents low-confidence matches when callers request stricter relevance.  
Where: `test/unit/memory/services/friday-memory-service.test.ts`.  
How: Same setup as above with `minScore: 0.2`; assert empty results.

5. **Hybrid merge unions IDs and applies weighted scoring** (Effort: S)  
What: Add helper-level test modeled on OpenClaw `hybrid.test.ts:18` for `mergeHybridResults()` at `src/memory/search/friday-memory-hybrid.ts:28`.  
Why: Protects rank math from regressions independent of DB/embedding plumbing.  
Where: **new file** `test/unit/memory/search/friday-memory-hybrid.test.ts`.  
How: Provide overlapping/non-overlapping FTS+semantic hits and deterministic `resolveItem`; assert combined score math and ordering.

6. **Hybrid merge snippet preference on overlap** (Effort: S)  
What: Add test modeled on OpenClaw `hybrid.test.ts:53` to verify overlap keeps FTS snippet (Friday’s keyword-equivalent) and includes both match sources.  
Why: Prevents degraded snippets when both retrieval modes hit same item.  
Where: `test/unit/memory/search/friday-memory-hybrid.test.ts`.  
How: Overlap same `itemId` with FTS snippet + semantic hit; assert snippet and combined score.

---

### 4. Agent Exec Security

1. **Metachar blocking matrix when `allowShell=false`** (Effort: M)  
What: Add parameterized test for commands containing `; | & \` $ ( ) { } < >` checked by `SHELL_META_RE` at `src/agent/tools/friday-agent-exec-tool.ts:32`.  
Why: Prevents command chaining/redirection injection.  
Where: `test/unit/agent/tools/friday-agent-exec-tool.test.ts` (extend after current cases near `:105`).  
How: Execute each command, assert `isError === true` and message mentions disallowed metacharacters (`:68`).

2. **Rejects workdir outside workspace root** (Effort: S)  
What: Validate root boundary enforcement at `src/agent/tools/friday-agent-exec-tool.ts:91`.  
Why: Prevents tool from executing in unintended filesystem scope.  
Where: `test/unit/agent/tools/friday-agent-exec-tool.test.ts`.  
How: Construct tool with temp `workspaceRoot`; pass external `workdir`; assert error text includes “outside the allowed workspace root”.

3. **Blocks symlink escape from inside workspace** (Effort: M)  
What: Add symlink traversal test for `realpathSync` check at `src/agent/tools/friday-agent-exec-tool.ts:79`.  
Why: Prevents bypassing workspace boundary through symlinked directories.  
Where: `test/unit/agent/tools/friday-agent-exec-tool.test.ts`.  
How: Temp root + symlink inside root pointing outside; run command with symlink workdir; assert rejection.

4. **Behavioral shell:false enforcement (no wildcard expansion)** (Effort: M)  
What: Add test proving no shell expansion when `allowShell=false` path uses `spawn(..., { shell: false })` at `src/agent/tools/friday-agent-exec-tool.ts:115`.  
Why: Confirms shell parser is not invoked in default mode.  
Where: `test/unit/agent/tools/friday-agent-exec-tool.test.ts`.  
How: In temp dir with `a.ts`, run `echo *.ts`; assert output is literal `*.ts`, not expanded filename.

5. **Explicit `allowShell=true` enables shell features** (Effort: S)  
What: Add positive control for shell mode branch at `src/agent/tools/friday-agent-exec-tool.ts:103`.  
Why: Ensures security defaults are strict but opt-in behavior still works predictably.  
Where: `test/unit/agent/tools/friday-agent-exec-tool.test.ts`.  
How: Create tool with `allowShell: true`; run `echo *.ts` in dir with `a.ts`; assert expanded output includes `a.ts`.

---

## Section B: Code Changes

1. **Improve fallback error normalization for classification** (Effort: M)  
File: `src/providers/routing/friday-provider-fallback.ts` (`runWithFallback` around `:175`, `isTransientError` around `:52`).  
Change: Add helper to extract text/status/code from unknown errors (not only `Error.message`), then classify transient using both message patterns and status/code.  
Reason: Required for robust tests and production correctness on structured non-`Error` throws.

2. **Add injectable clock/cooldown options to fallback factory** (Effort: S)  
File: `src/providers/routing/friday-provider-fallback.ts` (`createFridayProviderFallback` at `:91`).  
Change: Optional options like `nowMs` and `cooldownMs` with current defaults.  
Reason: Makes cooldown tests deterministic and avoids global timer coupling.

3. **Add injectable process/path dependencies for exec tool tests** (Effort: M)  
File: `src/agent/tools/friday-agent-exec-tool.ts` (`createFridayAgentExecTool` at `:36`).  
Change: Optional injected `spawnImpl` and `realpathSyncImpl` in options, defaulting to current Node APIs.  
Reason: Enables precise assertion of `shell:false` and path checks without OS-dependent behavior.

4. **No mandatory memory source refactor required** (Effort: S)  
Files unchanged unless desired: `src/memory/services/friday-memory-service.ts`, `src/memory/search/friday-memory-hybrid.ts`.  
Note: Current APIs are sufficient to add proposed tests directly.

## Summary
- Total new tests: 19
- Files to create: 1  
- Files to modify: 5
- Estimated effort: 7-9 hours