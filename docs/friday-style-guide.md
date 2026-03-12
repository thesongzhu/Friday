## Section 1: Current State Audit

### A. File Naming
**Current pattern:** `src/` is strongly standardized to kebab-case with `friday-` prefix, plus `index.ts` and migration `vNNN-...` files.

**Inconsistencies found:**
1. Internal underscore naming appears in source: `src/ledger/_internal-types.ts`.
2. One module-level barrel uses a custom name instead of `index.ts`: `src/skills/friday-skill-marketplace-index.ts`.
3. Test naming has outliers not matching `friday-*.test.ts`: `test/unit/state/state-index.test.ts`, `test/unit/state/sqlite/v001-schema.test.ts`, `test/unit/state/sqlite/v002-phase8-api-foundation-schema.test.ts`, `test/unit/state/sqlite/v004-memory-core-schema.test.ts`.
4. A test filename implies a source file that does not exist (`friday-memory-guard-routes`), but imports `friday-memory-routes`: `test/unit/api/http/routes/friday-memory-guard-routes.test.ts:2`.

**Severity:** `SHOULD FIX`

---

### B. Import Style
**Current pattern:** `.js` extensions are consistently used for TS imports; `import type` is widely used; both `#` aliases and relative imports are used.

**Inconsistencies found:**
1. Mixed alias + relative imports in the same files, reducing predictability: `src/api/auth/friday-auth-service.ts:2`, `src/api/auth/friday-auth-service.ts:14`, `src/api/auth/friday-auth-service.ts:21`; `src/api/runtime/friday-api-runtime.ts:1`, `src/api/runtime/friday-api-runtime.ts:29`.
2. Imports appear after exports in one file (style break): `src/state/index.ts:31`.
3. Tests use deep relative imports instead of configured aliases: `test/unit/api/http/routes/friday-auth-routes.test.ts:2`, `test/unit/skills/generator/services/friday-skill-generator-service.test.ts:3`; alias support exists in `vitest.config.ts:7`.

**Severity:** `MUST FIX`

---

### C. Export Style
**Current pattern:** Source modules are mostly named exports; no normal module-level default exports.

**Inconsistencies found:**
1. Barrel strategy is mixed: wildcard re-exports in `src/config/index.ts:1`, `src/skills/index.ts:1` vs explicit curated exports in `src/providers/index.ts:4`.
2. Mixed type re-export styles: `export type *` in `src/api/index.ts:4`, `src/providers/index.ts:4` vs explicit `export type { ... }` elsewhere.
3. `export default` exists only inside generated template strings, not module API, e.g. `src/skills/converter/converters/friday-openai-gpt-action-converter.ts:848`, `src/skills/converter/converters/friday-n8n-node-converter.ts:543`.

**Severity:** `SHOULD FIX`

---

### D. Naming Conventions
**Current pattern:** Many public symbols are `Friday*`, constants are often `FRIDAY_*`, and factories are usually `createFriday*`.

**Inconsistencies found:**
1. Skills/workflows core types are unprefixed: `src/skills/model/friday-skill-manifest-v2.types.ts:36`, `src/skills/model/friday-skill-runtime.types.ts:3`, `src/workflows/model/friday-workflow.types.ts:13`.
2. `Create*Deps` naming is mixed: `CreateFridayAuthServiceDeps` in `src/api/auth/friday-auth-service.types.ts:20` vs `CreateMarketplaceSyncJobDeps` in `src/jobs/marketplace/friday-marketplace-sync-job.ts:23`.
3. Factory naming exceptions: `createN8nNodeConverter` in `src/skills/converter/converters/friday-n8n-node-converter.ts:59`, `createOpenAiGptActionConverter` in `src/skills/converter/converters/friday-openai-gpt-action-converter.ts:97`.
4. Constants not consistently `FRIDAY_*`: `DEPRECATED_CONFIG_KEYS` in `src/config/friday-config.types.ts:32`, `SKILL_ORIGIN_PRECEDENCE` in `src/skills/model/friday-skill-source.types.ts:11`, `SkillManifestV2Schema` in `src/skills/manifest/friday-skill-manifest.schema.ts:98`.
5. Error code naming is mixed domain-specific and generic: generic `"NOT_FOUND"` in `src/skills/converter/services/friday-skill-converter-service.ts:87`.

**Severity:** `SHOULD FIX`

---

### E. Type Patterns
**Current pattern:** strict TS with no `as any` found; heavy interface/type modeling.

**Inconsistencies found:**
1. `as unknown as` appears in production code (19 uses), e.g. `src/skills/services/friday-marketplace-discovery-service.ts:35`, `src/workflows/services/friday-workflow-execution-service.ts:556`, `src/learning/services/friday-learning-pattern-recognition-service.ts:89`.
2. Route handlers rely on casts instead of centralized schema typing: `src/api/http/routes/friday-auth-routes.ts:24`, `src/api/http/routes/friday-workflow-routes.ts:38`.
3. Foundational primitives are duplicated across domains: `src/learning/model/friday-learning.types.ts:6`, `src/workflows/model/friday-workflow.types.ts:3`.

**Severity:** `SHOULD FIX`

---

### F. Function Patterns
**Current pattern:** factory construction is dominant and dependency-injected.

**Inconsistencies found:**
1. Interface/deps co-location is inconsistent: dedicated types file in `src/api/auth/friday-auth-service.types.ts:13` vs inline contracts in `src/workflows/services/friday-workflow-crud-service.ts:17`, `src/jobs/marketplace/friday-marketplace-sync-job.ts:10`.
2. Error model is inconsistent: many functions throw `Error` (91) alongside `FridayDomainError` (177). Example raw `Error` throws: `src/satellites/services/friday-satellite-pairing-service.ts:136`, `src/workflows/builder/services/friday-workflow-builder-template-service.ts:199`, `src/config/friday-config-io.ts:49`.
3. Some helpers use plain `Error` where domain-level codes are expected (path safety/security boundaries): `src/utilities/friday-path-safety.ts:20`.

**Severity:** `MUST FIX`

---

### G. API Conventions
**Current pattern:** routes are uniformly versioned under `/v1/...`; scopes use dotted notation.

**Inconsistencies found:**
1. `operationId` naming mixes plain verbs and camelCase segments: `fleet.listSatellites` in `src/api/http/routes/friday-fleet-routes.ts:29`, `workflows.listVersions` in `src/api/http/routes/friday-workflow-routes.ts:92`, vs `memory.list` in `src/api/http/routes/friday-memory-routes.ts:216`.
2. Success envelope type exists but is not used in route contracts/mapper: `src/api/model/friday-api-common.types.ts:50`.
3. Error mapper drops structured `details` from `FridayDomainError`: domain supports details in `src/errors/friday-domain-error.ts:35`, mapper omits it in `src/api/http/friday-http-error-mapper.ts:17`.

**Severity:** `SHOULD FIX`

---

### H. Test Conventions
**Current pattern:** `test/unit/**`, `describe/it`, `expect`, `vi` usage is consistent; no `.only`/`.skip` found.

**Inconsistencies found:**
1. Naming drift in tests (`-fixes`, `-cx-review-fixes`) makes intent/history coupling explicit: `test/unit/skills/marketplace/friday-phase4-cx-fixes.test.ts`, `test/unit/workflows/friday-workflow-execution-service-fixes.test.ts`, `test/unit/memory/guard/services/friday-memory-guard-service-cx-review-fixes.test.ts`.
2. Test imports are mostly deep relative paths instead of aliases: `test/unit/api/http/routes/friday-memory-routes.test.ts:2`.
3. `as unknown as` is common in tests (33 uses), including broad service mocking: `test/unit/api/runtime/friday-api-runtime-memory-registration.test.ts:37`.

**Severity:** `NICE TO FIX`

---

### I. Documentation
**Current pattern:** many files use section comments (`// ─── ... ───`) and selective JSDoc.

**Inconsistencies found:**
1. JSDoc coverage is partial (85/325 `src` files have file-level JSDoc starts).
2. Comment style is mixed (`// ───` in many files, boxed unicode separators in tests), e.g. `src/hub/friday-hub-bootstrap.ts:37`, `test/unit/workflows/friday-workflow-execution-service-fixes.test.ts:20`.
3. Root README is stale vs actual codebase size/scope: `README.md:5`.

**Severity:** `SHOULD FIX`

---

### J. Clawdbot Comparison
**Note:** requested path `/opt/homebrew/lib/node_modules/@anthropic-ai/openclaw/dist/` was not present; comparison was done against installed `clawdbot` dist at `/opt/homebrew/lib/node_modules/clawdbot/dist`.

**Current Clawdbot dist patterns observed:**
1. Bundled hashed artifact naming (`agent-D8jFJh5X.js`, etc) in `/opt/homebrew/lib/node_modules/clawdbot/dist`.
2. Bundler-style alias imports and symbol renaming: `/opt/homebrew/lib/node_modules/clawdbot/dist/index.js:3`.
3. Generic, unprefixed type names in public d.ts: `/opt/homebrew/lib/node_modules/clawdbot/dist/plugin-sdk/runtime.d.ts:1`, `/opt/homebrew/lib/node_modules/clawdbot/dist/plugin-sdk/infra/retry.d.ts:1`.
4. Default exports in handlers: `/opt/homebrew/lib/node_modules/clawdbot/dist/bundled/command-logger/handler.js:55`.

**Severity:** `SHOULD FIX` (for adaptation boundaries, not Friday runtime correctness)

---

## Section 2: Friday Style Guide (The Standard)

### A. File Naming
**RULE:** Use `friday-<domain>-<subject>.ts` for source, `index.ts` only for barrels, `vNNN-...ts` only for migrations, and `friday-<source>.test.ts` for tests.  
**EXAMPLE:** `src/memory/services/friday-memory-service.ts`, `test/unit/memory/services/friday-memory-service.test.ts`  
**ANTI-PATTERN:** `test/unit/workflows/friday-workflow-execution-service-fixes.test.ts`, `src/skills/friday-skill-marketplace-index.ts`

### B. Import Style
**RULE:** Imports must be top-of-file only, grouped in order: `node:` builtins, external, `#` aliases, relative; always use `.js` extension; prefer aliases over deep relatives in tests.  
**EXAMPLE:**
```ts
import { randomUUID } from "node:crypto";
import type { FridayDomainError } from "#errors";
import { createFridayMemoryService } from "#memory";
import type { FridayMemoryRoutesDeps } from "../routes/friday-memory-routes.js";
```
**ANTI-PATTERN:** `src/state/index.ts:31` (imports after exports), `test/unit/api/http/routes/friday-auth-routes.test.ts:2` (deep relative to `src`)

### C. Export Style
**RULE:** Use named exports for source APIs; no default exports in framework code; barrels should prefer explicit re-exports over broad `export *`.  
**EXAMPLE:**
```ts
export type { FridayProviderService } from "./services/friday-provider-service.types.js";
export { createFridayProviderService } from "./services/friday-provider-service.js";
```
**ANTI-PATTERN:** `src/skills/index.ts:1` broad wildcard surface for many mixed concerns

### D. Naming Conventions
**RULE:** Public domain symbols must be `Friday*`; factory/deps pairs are `createFridayX` + `CreateFridayXDeps`; constants are `FRIDAY_<DOMAIN>_<NAME>`; errors are `<DOMAIN>_<REASON>`.  
**EXAMPLE:**
```ts
export interface CreateFridayMemoryServiceDeps {}
export function createFridayMemoryService(...) {}
export const FRIDAY_MEMORY_MAX_LIMIT = 100;
throw new FridayDomainError("MEMORY_NOT_FOUND", "...");
```
**ANTI-PATTERN:** `createN8nNodeConverter` (`src/skills/converter/converters/friday-n8n-node-converter.ts:59`), `SKILL_ORIGIN_PRECEDENCE` (`src/skills/model/friday-skill-source.types.ts:11`), `"NOT_FOUND"` (`src/skills/converter/services/friday-skill-converter-service.ts:87`)

### E. Type Patterns
**RULE:** `as any` is forbidden; `as unknown as` requires explicit justification and should be replaced by guards/parsers; shared primitives (`UUID`, `JsonValue`, `ISODateTime`) should come from a single module.  
**EXAMPLE:**
```ts
function assertStoreBody(v: unknown): asserts v is FridayMemoryStoreRequest { ... }
```
**ANTI-PATTERN:** `version.graphJson as unknown as FridayCompiledWorkflowGraphV2` (`src/workflows/services/friday-workflow-execution-service.ts:556`)

### F. Function Patterns
**RULE:** Service contracts live in `.types.ts`; implementation in `.ts`; boundary errors must be `FridayDomainError` with code/status/details.  
**EXAMPLE:**
```ts
export function createFridaySatellitePairingService(
  deps: CreateFridaySatellitePairingServiceDeps,
): FridaySatellitePairingService { ... }
```
**ANTI-PATTERN:** raw `throw new Error("TEMPLATE_NOT_FOUND")` in service layer (`src/workflows/builder/services/friday-workflow-builder-template-service.ts:199`)

### G. API Conventions
**RULE:** Keep `/v1/...` paths; `operationId` segments are lowercase dot-separated verbs/nouns (no camelCase); success responses use one envelope contract; mapper must preserve structured error details.  
**EXAMPLE:**
```ts
operationId: "workflows.list_versions"
path: "/v1/workflows/:workflowId/versions"
```
**ANTI-PATTERN:** `operationId: "fleet.listSatellites"` (`src/api/http/routes/friday-fleet-routes.ts:29`)

### H. Test Conventions
**RULE:** Tests mirror source paths, use stable behavior-focused names, and avoid historical suffixes (`-fixes`, `-cx-review-fixes`) in permanent suites.  
**EXAMPLE:** `test/unit/providers/services/friday-provider-service.test.ts`  
**ANTI-PATTERN:** `test/unit/memory/guard/services/friday-memory-guard-service-cx-review-fixes.test.ts`

### I. Documentation
**RULE:** Public modules require concise JSDoc; use one section comment style (ASCII); keep root README current with implemented scope.  
**EXAMPLE:** `/** Creates provider service with BYOK validation and routing support. */`  
**ANTI-PATTERN:** stale high-level status in `README.md:5`

### J. Clawdbot Adaptation Standard
**RULE:** Treat Clawdbot dist as behavior reference only; map everything into Friday source conventions at adapter boundaries.  
**EXAMPLE:** wrap Clawdbot-style `RetryConfig` into `FridayRetryPolicy` inside adapter module.  
**ANTI-PATTERN:** copying dist-era default export + generic error + generic type naming directly into Friday modules.

---

## When Adapting Clawdbot Code To Friday: Transformation Checklist
1. Replace default exports with named `createFriday*` APIs.
2. Rename public types to `Friday*` (keep Clawdbot names only inside adapters).
3. Replace generic `Error` throws with `FridayDomainError` at service/API boundaries.
4. Normalize imports to `node:` + `#` aliases + `.js` suffix.
5. Convert broad wildcard barrels to explicit exports.
6. Convert operation IDs to lowercase dot segments.
7. Move contracts into `.types.ts` when adding new services.
8. Remove `as unknown as` by adding schema/guard parsing.
9. Ensure tests mirror source path/naming and avoid historical suffix names.
10. Keep generated-code templates isolated if they must emit `export default`.

---

## File Templates

### 1) Constants file
```ts
// src/<domain>/friday-<domain>.constants.ts
export const FRIDAY_<DOMAIN>_DEFAULT_LIMIT = 100;
export const FRIDAY_<DOMAIN>_ERROR_CODES = {
  NOT_FOUND: "<DOMAIN>_NOT_FOUND",
  VALIDATION_ERROR: "<DOMAIN>_VALIDATION_ERROR",
} as const;
```

### 2) Types file
```ts
// src/<domain>/services/friday-<domain>-service.types.ts
export interface Friday<Domain>Service {
  get(id: string): Promise<unknown>;
}

export interface CreateFriday<Domain>ServiceDeps {
  nowIso: () => string;
}
```

### 3) Service file
```ts
// src/<domain>/services/friday-<domain>-service.ts
import { FridayDomainError } from "#errors";
import type {
  CreateFriday<Domain>ServiceDeps,
  Friday<Domain>Service,
} from "./friday-<domain>-service.types.js";

export function createFriday<Domain>Service(
  deps: CreateFriday<Domain>ServiceDeps,
): Friday<Domain>Service {
  return {
    async get(id) {
      if (!id) {
        throw new FridayDomainError("<DOMAIN>_VALIDATION_ERROR", "id is required", { httpStatus: 400 });
      }
      return { id, ts: deps.nowIso() };
    },
  };
}
```

### 4) Route file
```ts
// src/api/http/routes/friday-<domain>-routes.ts
import type { FridayRouteDefinition } from "../../model/friday-api-common.types.js";
import type { Friday<Domain>Service } from "#<domain>";

export interface Friday<Domain>RoutesDeps {
  service: Friday<Domain>Service;
}

export function createFriday<Domain>Routes(
  deps: Friday<Domain>RoutesDeps,
): FridayRouteDefinition<unknown, unknown, unknown, unknown>[] {
  return [
    {
      operationId: "<domain>.get",
      method: "GET",
      path: "/v1/<domain>/:id",
      auth: { public: false, anyOfScopes: ["<domain>.read"] },
      async handler(ctx) {
        const { id } = ctx.params as { id: string };
        return deps.service.get(id);
      },
    },
  ];
}
```

### 5) Test file
```ts
// test/unit/<domain>/services/friday-<domain>-service.test.ts
import { describe, it, expect } from "vitest";
import { createFriday<Domain>Service } from "#<domain>";

describe("Friday<Domain>Service", () => {
  it("returns entity by id", async () => {
    const svc = createFriday<Domain>Service({ nowIso: () => "2026-01-01T00:00:00.000Z" });
    await expect(svc.get("x")).resolves.toMatchObject({ id: "x" });
  });
});
```
