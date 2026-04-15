> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Audit Fix Plan

> Designed by CX (Codex/gpt-5.3-codex) — 2026-02-17
> Extracted from CX v3 transcript (sandbox write denied)
> Scope: ALL audit issues
> Source of truth: `docs/full-audit-report.md` (no rescan baseline).  
Manual corrections applied:
- `src/workflows/builder/runtime/friday-workflow-builder-runtime.ts` is wired; skip orphan action.
- `src/skills/runtime/friday-skill-marketplace-runtime.ts` is wired via marketplace barrel; skip orphan action.

## 1. DELETE dead files

Files:
- `src/api/http/friday-http-context.types.ts`
- `src/api/model/friday-api-conflict.types.ts`
- `src/api/model/friday-api-route.types.ts`

What to do:
- Delete all three files.
- Run `rg -n "friday-http-context.types|friday-api-conflict.types|friday-api-route.types" src test` and confirm zero matches before commit.

## 2. FIX CRITICAL: API runtime stubs

Files:
- `src/api/runtime/friday-api-runtime.ts`
- `src/api/runtime/friday-api-runtime.types.ts`
- `src/api/http/routes/friday-workflow-routes.ts`
- `src/api/http/routes/friday-workflow-builder-routes.ts`
- `src/api/http/routes/friday-workflow-run-routes.ts`

What to do:
- In `src/api/runtime/friday-api-runtime.ts`, remove all workflow/builder/run stub handlers and every `as any` placeholder.
- Compose real runtimes inside API runtime:
  - `createFridayWorkflowRuntime(...)`
  - `createFridayWorkflowBuilderRuntime(...)` with `crudService: workflowRuntime.crud`
- Extend `CreateFridayApiRuntimeDeps` in `src/api/runtime/friday-api-runtime.types.ts` to include workflow runtime deps needed by `createFridayWorkflowRuntime`:
  - `computeChecksum(content: string): string`
  - `resolveSkill(...)`
  - `invokeSkill(...)`
- Wire workflow routes to real services:
  - `listWorkflows` -> `workflowRuntime.crud.listWorkflows(query)`
  - `createWorkflow` -> create workflow + create initial version from `input.graph`
  - `getWorkflow` -> `getWorkflow`, latest version, published version
  - `updateWorkflow` -> update metadata; if graph present create new version
  - `archiveWorkflow` -> `workflowRuntime.crud.archiveWorkflow(...)`
  - `publishWorkflow` -> `workflowRuntime.crud.publishVersion(...)`
  - `listVersions` -> `workflowRuntime.crud.listVersions(...)`
- Wire builder routes to real services:
  - `createDraft/listDrafts/getDraft/saveDraft/autosaveDraft` -> `builderRuntime.drafts`
  - `compileDraft/publishDraft` -> `builderRuntime.compositor`
  - `acquireLock/renewLock/releaseLock` -> `builderRuntime.collaboration`
- Wire run routes to real services:
  - `startRun/getRun/listRunNodes/cancelRun/retryRun` -> `workflowRuntime.execution`
  - `getRunTimeline` -> read from `eventRepo` (`run:${runId}` stream), map to API timeline DTO
- Keep pagination contract by returning `{ items, nextCursor? }` instead of untyped arrays.
- Optional but recommended: add `workflow` and `builder` runtime handles onto `FridayApiRuntime` return surface for testability.

## 3. WIRE orphaned files

Files:
- `src/api/persistence/friday-auth-session-repository.ts`
- `src/api/persistence/friday-rate-limit-counter-repository.ts`
- `src/api/persistence/friday-user-repository.ts`
- `src/jobs/learning/friday-approval-expiry-job.ts`
- `src/state/mirror/friday-compatibility-mirror.ts`
- `src/skills/marketplace-index.ts`

What to do:
- `src/api/auth/friday-auth-service.ts`:
  - Replace inline SQL user/session read paths with `createFridayUserRepository()` and `createFridayAuthSessionRepository()`.
  - Add missing repository methods as needed (`revokeByRefreshHash`, `touchLastLogin`) to avoid split SQL logic.
- `src/api/auth/friday-rate-limit-service.ts`:
  - Replace inline counter SQL with `createFridayRateLimitCounterRepository()`.
- `src/jobs/index.ts`:
  - Export `createFridayApprovalExpiryJob` and `FridayApprovalExpiryJobResult` so `friday-approval-expiry-job.ts` is in production graph.
- `src/state/index.ts`:
  - Export mirror functions/types (`friday-compatibility-mirror.ts`, `friday-consistency-checks.ts`).
- `src/state/mirror/friday-compatibility-mirror.ts`:
  - Remove direct API-layer dependency on `isFridayLegacyWriteFrozen` by injecting freeze-check function via options/deps.
- `src/skills/index.ts`:
  - Add `export * from "./marketplace-index.js";` so marketplace barrel is wired.

## 4. FIX HIGH: cross-module deep imports (133)

Files:
- Add/expand module root APIs:
  - `src/config/index.ts` (new)
  - `src/hub/index.ts` (new)
  - `src/state/index.ts`
  - `src/skills/index.ts`
  - `src/satellites/index.ts`
  - `src/jobs/index.ts`
  - `src/ledger/index.ts`

What to export:
- `config`: config types/schema/io/path.
- `hub`: all `src/hub/services/*` exports through root index.
- `state`: sqlite layer/types, telemetry writer/types, mirror exports.
- `skills`: marketplace exports via `marketplace-index`.
- `satellites`: repository interfaces/types in addition to factories.
- `jobs`: learning + marketplace jobs/types.
- `ledger`: runtime interfaces (`FridayLearningEventLedger`, `FridaySkillRunStore`) plus existing factories/types.

Rewrite pattern for CC:
- Detection:
  - `rg -n -P "from ['\"](?:\\.\\./)+(api|config|hub|jobs|learning|ledger|satellites|skills|state|workflows)/[^'\"]+['\"]" src`
- Rewrite:
  - `rg -l -P "from ['\"](?:\\.\\./)+(api|config|hub|jobs|learning|ledger|satellites|skills|state|workflows)/[^'\"]+['\"]" src | xargs perl -pi -e 's#from ([\"\\\'])((?:\\.\\./)+)(api|config|hub|jobs|learning|ledger|satellites|skills|state|workflows)/[^\"\\\']+([\"\\\'])#from $1$2$3/index.js$4#g'`
- Then run `pnpm build` and add any missing root exports until green.

## 5. FIX HIGH: naming standardization

Convention (adopted):
- Filenames:
  - Required: `friday-*.ts`
  - Allowed exceptions: `index.ts`, `*.types.ts`, `*.schema.ts`, `src/**/migrations/vNNN-*.ts`
- Types/classes/enums:
  - Exported domain contracts use `Friday*`
  - Allowed exceptions: primitives (`UUID`, `ISODateTime`, `Json*`), protocol DTOs (`*Request`, `*Response`, `*Query`), dependency bags (`Create*Deps`)
- Factories:
  - Exported constructors use `createFriday*`
  - Allowed exceptions: `build*` defaults and `getFriday*` constant/template providers

Renames needed:
- File renames:
  - `src/state/paths/resolve-state-dir.ts` -> `src/state/paths/friday-state-dir-resolver.ts`
  - `src/skills/marketplace-index.ts` -> `src/skills/friday-skill-marketplace-index.ts`
- Type/class renames:
  - `AuthError` -> `FridayAuthError`
  - `TokenValidationError` -> `FridayTokenValidationError`
  - `ConflictServiceError` -> `FridayConflictServiceError`
- Factory renames:
  - None required after adopting `createFriday*` rule (current exported factories already conform).

## 6. FIX HIGH: error handling

Files:
- `src/api/http/friday-http-error-mapper.ts`
- New shared error module (recommended): `src/errors/friday-domain-error.ts`
- First replacement wave:
  - `src/workflows/services/friday-workflow-execution-service.ts`
  - `src/workflows/services/friday-workflow-crud-service.ts`
  - `src/workflows/builder/services/friday-workflow-builder-draft-service.ts`
  - `src/workflows/builder/services/friday-workflow-builder-collaboration-service.ts`
  - `src/workflows/builder/services/friday-workflow-builder-compositor-service.ts`
  - `src/api/http/friday-http-route-registry.ts`

What to do:
- Introduce `FridayDomainError` base class with structured fields:
  - `code`, `httpStatus`, `message`, `retryable`, `details`, optional `cause`
- Replace string-based throws (`throw new Error("WORKFLOW_*")`, `DRAFT_*`, etc.) with typed domain errors.
- Update error mapper:
  - If `instanceof FridayDomainError`, map directly from structured fields.
  - Keep old custom classes as adapters during migration, then collapse into domain subclasses.
- Stop deriving HTTP semantics from free-form `Error.message`.

## 7. FIX MEDIUM: quick architecture hygiene

### 7.1 Barrel strategy
Files:
- `src/config/index.ts` (new), `src/hub/index.ts` (new), and expanded indexes in Step 4.
What to do:
- Standardize on “root index is public module API” for all top-level modules.

### 7.2 Type placement
Files:
- `src/api/auth/friday-auth-service.ts`
- `src/api/auth/friday-rate-limit-service.ts`
- `src/api/fleet/friday-fleet-dashboard-service.ts`
- `src/api/conflicts/friday-workflow-conflict-service.ts`
- Sidecars: corresponding `*.service.types.ts`
What to do:
- Move sidecar service contracts into implementation files (colocated rule), or keep sidecars but enforce one rule repo-wide; pick one and apply consistently.
- If colocating, delete/convert sidecars to re-export shims in same PR.

### 7.3 Import style/order
Files:
- `package.json`
- Add `eslint.config.mjs` (or existing eslint config file)
What to do:
- Enforce `consistent-type-imports` and import ordering.
- Add lint script and CI check; run autofix once.

### 7.4 Duplicate import specifiers
Files:
- Known examples: `src/api/auth/friday-auth-middleware.ts`, `src/config/friday-config.schema.ts`, `src/workflows/builder/runtime/friday-workflow-builder-runtime.ts`
What to do:
- Merge split imports from same module into single statements across all 18 flagged files.

### 7.5 Circular dependency
Files:
- `src/api/model/friday-api-auth.types.ts`
- `src/api/model/friday-api-common.types.ts`
- New `src/api/model/friday-api-principal.types.ts`
- `src/api/auth/friday-token-validator.ts`
What to do:
- Move `FridayPrincipalType` into new principal-types file.
- Update imports so `auth.types` no longer imports from `common.types`.
- Keep dependency direction one-way (`common` can import auth; auth should not import common).

## 8. FIX LOW: tests + helper naming + duplicate basename

### 8.1 Test directory standard
Files:
- `vitest.config.ts`
- `tsconfig.json`
- root test folder
What to do:
- Standardize on one path. Recommended: rename `test/` -> `tests/`.
- Update Vitest include and TS exclude accordingly.

### 8.2 Helper naming
Files:
- `test/unit/satellites/_helpers/create-test-db.ts`
- `test/unit/skills/_helpers/make-manifest.ts`
- `test/unit/skills/marketplace/_helpers.ts`
- `test/unit/workflows/_helpers/create-test-db.ts`
- `test/unit/workflows/builder/_helpers/create-test-spec.ts`
What to do:
- Rename to `*.helper.ts` (or move to `tests/helpers/`).
- Update all import paths (use `rg -l "_helpers/|_helpers\\.ts" test` then replace).

### 8.3 Duplicate basename
Files:
- `src/satellites/persistence/friday-api-token-repository.ts`
- `src/satellites/runtime/friday-satellite-runtime.ts`
- `src/satellites/services/friday-satellite-pairing-service.ts`
- `src/satellites/index.ts`
What to do:
- Rename satellites file to `src/satellites/persistence/friday-satellite-api-token-repository.ts`.
- Update imports/exports in satellites module.
- Keep API module file name as-is to avoid broader churn.

## Suggested execution checkpoints

- After Steps 1-3: `pnpm build` must pass; all orphan targets imported by `src/**`.
- After Step 4: cross-module deep imports reduced to zero (`133 -> 0`).
- After Steps 5-6: no `throw new Error("CODE_*")` in API/workflow paths.
- After Steps 7-8: lint/build/test green and path conventions documented.
