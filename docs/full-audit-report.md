> Superseded: use `docs/current-source-of-truth.md` for current runtime authority and contract status. This audit is retained as a historical point-in-time review from 2026-02-17.

# Friday Full Codebase Audit Report

> CX (Codex/gpt-5.3-codex) — 2026-02-17
> Scope: 233 src files + 128 test files

Audit scope completed: all `233` files under `src/` plus `128` TypeScript files under `test/` were scanned.

**CRITICAL**
1. Files: `src/api/runtime/friday-api-runtime.ts:134`, `src/api/runtime/friday-api-runtime.ts:157`, `src/api/runtime/friday-api-runtime.ts:180`, `src/workflows/runtime/friday-workflow-runtime.ts:43`  
What’s wrong: API workflow, builder, and run routes are wired with stub handlers and `as any` placeholders instead of real workflow services. This is a runtime behavior break, not just style.  
Fix: Compose `createFridayWorkflowRuntime(...)` (and builder runtime where needed) inside API runtime and pass real handlers into route factories; remove all `as any` stubs in API runtime.

**HIGH**
1. Files: `src/api/http/friday-http-context.types.ts`, `src/api/model/friday-api-conflict.types.ts`, `src/api/model/friday-api-route.types.ts`, `src/api/persistence/friday-auth-session-repository.ts`, `src/api/persistence/friday-rate-limit-counter-repository.ts`, `src/api/persistence/friday-user-repository.ts`, `src/jobs/learning/friday-approval-expiry-job.ts`, `src/skills/marketplace-index.ts`, `src/skills/runtime/friday-skill-marketplace-runtime.ts`, `src/state/mirror/friday-compatibility-mirror.ts`, `src/workflows/builder/runtime/friday-workflow-builder-runtime.ts`  
What’s wrong: 11 source files are not imported by any `src` file (some only used by tests), so production graph has unwired code paths/features.  
Fix: Either wire them into module runtime/index exports or delete/archive them if intentionally dormant.

2. Files: cross-module imports are all deep imports (133/133), example `src/api/conflicts/friday-workflow-conflict-service.ts:1`, `src/learning/services/friday-auto-fix-execution-service.ts:1`, `src/satellites/runtime/friday-satellite-runtime.ts:1`  
What’s wrong: No cross-module import goes through `src/<module>/index.ts`; module boundaries are bypassed everywhere.  
Fix: Define stable public APIs per module and import only via module root indexes.

3. Files: 78 filename violations across `src`, examples `src/state/paths/resolve-state-dir.ts`, `src/state/sqlite/migrations/v001-initial.ts`, `src/state/sqlite/migrations/v002-phase8-api-foundation.ts`, `src/skills/marketplace-index.ts`  
What’s wrong: Strict `friday-[module]-[name].ts` naming contract is not followed (`index.ts`, `.types.ts`, `.schema.ts`, and non-`friday-` names).  
Fix: Either rename to the strict convention or formally relax the convention to allow `index.ts`, `.types.ts`, `.schema.ts`, and migration version files.

4. Files: type declarations across modules, examples `src/api/model/friday-api-auth.types.ts:6`, `src/learning/services/friday-auto-fix-execution-service.ts:23`, `src/skills/model/friday-skill-lifecycle.types.ts:1`  
What’s wrong: Type naming contract `Friday[Module][Name]` is widely inconsistent (486 mismatches: non-`Friday*` names and module-token mismatches).  
Fix: Standardize all exported type/interface/class/enum names or codify exceptions (primitives/helpers/DTO aliases) in a naming policy.

5. Files: factory functions across modules, examples `src/api/auth/friday-auth-service.ts:67`, `src/jobs/learning/friday-learning-metrics-job.ts:13`, `src/workflows/builder/templates/friday-workflow-builder-builtin-templates.ts:25`  
What’s wrong: Factory naming contract `createFriday[Module][Name]` is not consistently enforced (71/131 create* functions mismatch strict module tokening; plus non-`createFriday*` factory helpers).  
Fix: Rename factories to include module token consistently, or narrow the rule to `createFriday*` only and enforce with lint.

6. Files: `src/api/http/friday-http-error-mapper.ts:8`, `src/workflows/services/friday-workflow-execution-service.ts:552`, `src/workflows/builder/services/friday-workflow-builder-draft-service.ts:98` and many others  
What’s wrong: Error handling is inconsistent: only 3 custom error classes, but 116 `throw new Error(...)` sites (many code-like strings such as `WORKFLOW_*`, `DRAFT_*`). This weakens typed handling and status mapping consistency.  
Fix: Introduce shared typed domain errors/result types and map by structured codes, not generic `Error` messages.

**MEDIUM**
1. Files: `src/config` (no `index.ts`), `src/hub` (no root `index.ts`), `src/jobs/index.ts:1`, `src/state/index.ts:1`  
What’s wrong: Barrel strategy is inconsistent across modules (some modules full barrel, some partial, some none, some composition entrypoint).  
Fix: Choose one module contract style per layer (public barrel vs runtime entrypoint) and apply uniformly.

2. Files: `.types.ts` pattern across repo, examples `src/api/auth/friday-auth-service.ts` + `src/api/auth/friday-auth-service.types.ts` vs `src/learning/services/friday-preference-fact-service.ts`  
What’s wrong: Type-placement pattern is mixed (61 `.types.ts` files, but 137 non-`.types.ts` files still declare interfaces; service sidecars used in only 4/47 service files).  
Fix: Standardize where contracts live (always sidecar or always colocated by rule).

3. Files: import style examples `src/config/friday-config-path.ts:2`, `src/skills/manifest/friday-skill-manifest.schema.ts:1`, `src/skills/registry/friday-skill-registry.ts:16`, `src/skills/validation/friday-skill-schema-compiler.ts:3`  
What’s wrong: Import formatting is mostly consistent, but mixed type-import styles are still present; import ordering is non-uniform in many files.  
Fix: Enforce `consistent-type-imports` + import ordering via ESLint/formatter.

4. Files: duplicate import-specifier files, examples `src/api/auth/friday-auth-middleware.ts`, `src/config/friday-config.schema.ts`, `src/workflows/builder/runtime/friday-workflow-builder-runtime.ts`  
What’s wrong: 18 files import the same module multiple times in separate declarations, increasing noise and merge churn.  
Fix: Merge repeated imports per specifier into single statements.

5. Files: `src/api/model/friday-api-auth.types.ts:2`, `src/api/model/friday-api-common.types.ts:2`  
What’s wrong: One circular dependency exists (type-only). Not a runtime cycle today, but it adds fragility.  
Fix: Extract shared auth/common primitives into a third file and make dependency one-directional.

**LOW**
1. Files: project root (`tests/` missing; `test/` exists)  
What’s wrong: Requested/expected `tests/` path and actual `test/` path differ, which can break tooling assumptions.  
Fix: Standardize on one path (`tests/` or `test/`) and update scripts/config.

2. Files: `test/unit/satellites/_helpers/create-test-db.ts`, `test/unit/skills/_helpers/make-manifest.ts`, `test/unit/skills/marketplace/_helpers.ts`, `test/unit/workflows/_helpers/create-test-db.ts`, `test/unit/workflows/builder/_helpers/create-test-spec.ts`  
What’s wrong: Test tree naming is mostly consistent, but helper files are mixed into test folders without `.test.ts` suffix.  
Fix: Move helpers to dedicated `test/helpers/` or suffix with `.helper.ts` consistently.

3. Files: `src/api/persistence/friday-api-token-repository.ts`, `src/satellites/persistence/friday-api-token-repository.ts`  
What’s wrong: Duplicate basename across modules can cause ambiguity in logs/search and accidental wrong imports during refactors.  
Fix: Rename with module qualifier (for example `friday-satellites-api-token-repository.ts`) or enforce aliasing conventions.

**SUMMARY**
1. Total issues by severity: `CRITICAL 1`, `HIGH 6`, `MEDIUM 5`, `LOW 3`.
2. Cleanest modules: `ledger`, `learning`, `satellites` (fewest architectural/naming boundary breaks relative to size).
3. Modules needing most work: `api`, `workflows`, `skills` (stubbed runtime wiring, naming rule drift, deep coupling, and error-model inconsistency).
4. Overall consistency score: `5/10` (strong baseline structure and test volume, but major contract drift and runtime integration gaps).
