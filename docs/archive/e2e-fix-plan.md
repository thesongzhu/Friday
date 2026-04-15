> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# E2E Bug Fix Plan — CX Architect Review

Generated: 2026-02-18T22:12 PST
Status: READY FOR CC

---

## BUG-001 [CRITICAL]: No admin user seed on fresh database

**Root Cause:** Migration `v001-initial.ts` creates the `users` table but never inserts a default admin row. The auth service's `login()` method calls `findLocalUser()` which returns null → throws `USER_NOT_FOUND`.

**Files:**
- `src/hub/friday-hub-bootstrap.ts` (line ~198, inside `createFridayHub`, after `stateRuntime = initializeFridayState(...)`)

**Changes:**

Add a `seedAdminUserIfEmpty()` function and call it immediately after `initializeFridayState()` succeeds. This runs inside the same factory function, before any services are wired.

```typescript
// Add after line ~198 (after stateRuntime = initializeFridayState(stateOpts);)

// ── Seed default admin user on first run ──
function seedAdminUserIfEmpty(db: FridaySqliteLayer): void {
  db.withWriteTransaction((conn) => {
    const count = conn.prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number };
    if (count.cnt > 0) return; // Already has users — skip

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    conn.prepare(
      `INSERT INTO users (id, email, display_name, role, password_hash, is_local_only, created_at, updated_at)
       VALUES (?, NULL, ?, ?, NULL, 1, ?, ?)`,
    ).run(userId, "Admin", "admin", now, now);

    console.log("[friday] Seeded default local admin user (passwordless dev login enabled).");
  });
}

seedAdminUserIfEmpty(stateRuntime.sqlite);
```

Key design decisions:
1. **Only seeds when users table is empty** — safe for existing DBs
2. **No password_hash** — works with dev-mode passwordless `{ local: true }` login flow
3. **is_local_only = 1** — matches the `findLocalUser()` query in `friday-user-repository.ts` (line 44)
4. **role = "admin"** — gets full `hub.admin` scopes via `getScopesForRole("admin")`
5. Uses `crypto.randomUUID()` already imported at top of file

**Tests:**
1. Fresh DB → `POST /v1/auth/login { "local": true }` → 200 with tokens
2. Existing DB with users → seed does NOT insert duplicate
3. `GET /v1/auth/me` after login returns `role: "admin"` with full scopes

---

## BUG-002 [CRITICAL]: Workflow create 500 — transaction + version numbering

**Root Cause:** Two bugs in `friday-api-runtime.ts` lines ~142-155:

1. **No transaction:** `createWorkflow()` and `createVersion()` run as separate transactions. If `createVersion()` fails, an orphan workflow row remains.
2. **Version number mismatch:** `insertWorkflow()` hardcodes `latest_version_number = 1`, then `createVersion()` calls `incrementVersionNumber()` which bumps it to 2. The first version gets number 2, and no version row exists for version 1.

The fix already exists: `createWorkflowWithVersion()` on the CRUD service does both in a single transaction with correct version numbering.

**Files:**
- `src/api/runtime/friday-api-runtime.ts` (lines ~142-155, the `createWorkflow` wiring lambda)

**Changes:**

Replace the `createWorkflow` lambda in the workflow route wiring:

```typescript
// BEFORE (lines ~142-155):
createWorkflow: (input) => {
  const workflow = workflowRuntime.crud.createWorkflow({
    slug: input.slug,
    name: input.name,
    description: input.description,
    tags: input.tags,
  });
  const version = workflowRuntime.crud.createVersion(
    workflow.id,
    input.graph,
  );
  return { workflow, version };
},

// AFTER:
createWorkflow: (input) => {
  return workflowRuntime.crud.createWorkflowWithVersion(
    {
      slug: input.slug,
      name: input.name,
      description: input.description,
      tags: input.tags,
    },
    input.graph ?? { nodes: [], edges: [] },
  );
},
```

This uses the existing `createWorkflowWithVersion()` method (defined at `friday-workflow-crud-service.ts` line 28) which:
- Runs in a single `withWriteTransaction` (line ~138)
- Uses `versionNumber = 1` directly instead of `incrementVersionNumber()` (line ~149)
- Correctly validates only compiled graphs (`schemaVersion === "2.0"`) and passes raw graphs through (line ~127)
- Returns `{ workflow, version }` matching the expected return type

Also add a null/undefined guard for `input.graph` since the E2E test shows `graph` is provided but could theoretically be omitted.

**Tests:**
1. `POST /v1/workflows { slug: "test", name: "Test", graph: { nodes: [], edges: [] } }` → 200 with `version.versionNumber === 1`
2. `POST /v1/workflows { slug: "test2", name: "Test2" }` (no graph) → 200 with empty graph stored
3. Verify no orphan workflow rows after a failed create (e.g., duplicate slug)
4. Created version's `graphJson` should equal the raw graph input verbatim

---

## BUG-003 [MEDIUM]: Plugin/marketplace routes never registered

**Root Cause:** In `friday-api-runtime.ts` lines ~356-363, plugin routes are gated by:
```typescript
if (deps.pluginService && deps.pluginManifestLoader) { ... }
```

But in `friday-hub-bootstrap.ts`, `createFridayApiRuntime()` is never passed `pluginService` or `pluginManifestLoader` — those deps are simply omitted. The conditional gate silently skips route registration → `GET /v1/plugins` → 404.

**Files:**
- `src/hub/friday-hub-bootstrap.ts` (lines ~260-280, the `createFridayApiRuntime({...})` call)
- `src/api/runtime/friday-api-runtime.ts` (lines ~356-363, the plugin route registration block)

**Changes — Option A (Recommended): Register stub plugin routes when deps are absent:**

In `friday-api-runtime.ts`, after the existing plugin routes conditional block (line ~363), add an else clause:

```typescript
// BEFORE (line ~356):
if (deps.pluginService && deps.pluginManifestLoader) {
  for (const route of createFridayPluginRoutes({
    pluginService: deps.pluginService,
    manifestLoader: deps.pluginManifestLoader,
  })) {
    routes.register(route);
  }
}

// AFTER:
if (deps.pluginService && deps.pluginManifestLoader) {
  for (const route of createFridayPluginRoutes({
    pluginService: deps.pluginService,
    manifestLoader: deps.pluginManifestLoader,
  })) {
    routes.register(route);
  }
} else {
  // Register stub routes so clients get empty arrays instead of 404
  routes.register({
    operationId: "plugins.list",
    method: "GET",
    path: "/v1/plugins",
    auth: { public: false, anyOfScopes: ["plugin.read"] },
    async handler() {
      return { items: [] };
    },
  });
  routes.register({
    operationId: "marketplace.plugins.list",
    method: "GET",
    path: "/v1/marketplace/plugins",
    auth: { public: false, anyOfScopes: ["plugin.read"] },
    async handler() {
      return { items: [], total: 0 };
    },
  });
}
```

**Why stubs instead of full wiring:** The plugin service has heavy dependencies (registry, resolver, loader, marketplace client, signature verifier) that the standalone hub doesn't yet create. Creating all of them for v0.1 is over-engineering. Stub routes communicate "this feature exists but has no data yet" — much better UX than 404.

**Tests:**
1. `GET /v1/plugins` → 200 `{ ok: true, data: { items: [] } }`
2. `GET /v1/marketplace/plugins` → 200 `{ ok: true, data: { items: [], total: 0 } }`
3. When pluginService IS provided in deps, real routes take priority (unchanged)

---

## BUG-004 [LOW]: DELETE workflow returns 200 for non-existent IDs

**Root Cause:** `archiveWorkflow()` in `friday-workflow-crud-service.ts` (line 117) calls `workflowRepo.archiveWorkflow()` which runs:
```sql
UPDATE workflows SET is_archived = 1 ... WHERE id = ? AND deleted_at IS NULL
```
This returns `changes === 0` when the ID doesn't exist, but the code ignores the return value and always returns successfully.

**Files:**
- `src/workflows/persistence/friday-workflow-repository.ts` (line ~136, `archiveWorkflow` method)
- `src/workflows/services/friday-workflow-crud-service.ts` (line ~117, `archiveWorkflow` method)

**Changes:**

**Step 1:** In `friday-workflow-repository.ts`, change `archiveWorkflow` to return the number of affected rows:

```typescript
// BEFORE (line ~136):
archiveWorkflow(db, id, deletedBy, nowIso) {
  db.prepare(
    `UPDATE workflows SET is_archived = 1, deleted_at = ?, deleted_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(nowIso, deletedBy, nowIso, id);
},

// AFTER:
archiveWorkflow(db, id, deletedBy, nowIso) {
  const result = db.prepare(
    `UPDATE workflows SET is_archived = 1, deleted_at = ?, deleted_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(nowIso, deletedBy, nowIso, id);
  return result.changes;
},
```

**Step 2:** Update the repository interface return type:

```typescript
// BEFORE (line ~27):
archiveWorkflow(
  db: Database.Database,
  id: UUID,
  deletedBy: string,
  nowIso: string,
): void;

// AFTER:
archiveWorkflow(
  db: Database.Database,
  id: UUID,
  deletedBy: string,
  nowIso: string,
): number;
```

**Step 3:** In `friday-workflow-crud-service.ts`, throw 404 when no rows affected:

```typescript
// BEFORE (line ~117):
archiveWorkflow(id, deletedBy) {
  const nowIso = deps.nowIso();
  deps.db.withWriteTransaction((db) => {
    deps.workflowRepo.archiveWorkflow(db, id, deletedBy, nowIso);
  });
},

// AFTER:
archiveWorkflow(id, deletedBy) {
  const nowIso = deps.nowIso();
  const changes = deps.db.withWriteTransaction((db) => {
    return deps.workflowRepo.archiveWorkflow(db, id, deletedBy, nowIso);
  });
  if (changes === 0) {
    throw new FridayDomainError("WORKFLOW_NOT_FOUND", "Workflow not found", { httpStatus: 404 });
  }
},
```

**Tests:**
1. `DELETE /v1/workflows/<valid-id>` → 200 `{ archived: true }`
2. `DELETE /v1/workflows/<non-existent-uuid>` → 404 `{ error: { code: "WORKFLOW_NOT_FOUND" } }`
3. `DELETE /v1/workflows/<already-archived-id>` → 404 (deleted_at IS NOT NULL → no match)

---

## BUG-005 [LOW]: HEAD requests return 404

**Root Cause:** `findRoute()` in `friday-http-route-registry.ts` (line 46) does exact method matching:
```typescript
return routes.find((r) => r.method === method && matchPath(r.path, path));
```
The `FridayHttpMethod` type (defined in `friday-api-common.types.ts` line 6) only includes `GET | POST | PUT | PATCH | DELETE` — no `HEAD`. So HEAD requests fail route matching → 404.

**Files:**
- `src/api/http/friday-http-server.ts` (line ~131, in the request handler, before route matching)

**Changes:**

In the HTTP server's request handler, map HEAD to GET before route matching. This follows the HTTP spec where HEAD should return the same headers as GET but with no body.

```typescript
// BEFORE (line ~131, after rawMethod is set):
const method = rawMethod as FridayHttpMethod;

// AFTER:
// HEAD → GET for route matching (RFC 9110 §9.3.2)
const routeMethod = rawMethod === "HEAD" ? "GET" : rawMethod;
const method = routeMethod as FridayHttpMethod;
const isHeadRequest = rawMethod === "HEAD";
```

Then at the response send point (line ~224), suppress the body for HEAD:

```typescript
// BEFORE (line ~224):
res.writeHead(200, responseHeaders);
res.end(successBody);

// AFTER:
res.writeHead(200, responseHeaders);
if (isHeadRequest) {
  res.end();
} else {
  res.end(successBody);
}
```

Also update the error response paths. Change the `sendJsonWithHeaders` function (line ~91):

```typescript
// BEFORE:
function sendJsonWithHeaders(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    ...FRIDAY_SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(json);
}

// AFTER: Add optional headOnly parameter
function sendJsonWithHeaders(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  headOnly = false,
): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    ...FRIDAY_SECURITY_HEADERS,
    ...extraHeaders,
  });
  if (headOnly) {
    res.end();
  } else {
    res.end(json);
  }
}
```

And pass `isHeadRequest` to all `sendJsonWithHeaders` calls within the request handler.

**Tests:**
1. `HEAD /v1/health` → 200 with `Content-Type` and `Content-Length` headers, empty body
2. `HEAD /v1/workflows` (authenticated) → 200 with headers, empty body
3. `GET /v1/health` → 200 with full body (unchanged behavior)

---

## DX-001: Provider create/get field shape inconsistency

**Root Cause:** POST `/v1/providers` expects flat fields (`kind`, `baseUrl`, `authMode`, `apiKey` etc.) but GET returns them nested under `config` (because the provider service stores/returns them in a `config` envelope). This is confusing for API consumers who expect round-trip fidelity.

**Files:**
- `src/api/http/routes/friday-provider-routes.ts` (lines 73-76, the create handler response)

**Changes:**

This is a documentation/response normalization issue. The simplest fix without breaking the internal model: ensure the GET response shape is documented clearly AND add the flat fields as top-level aliases in the GET response.

Actually, the better approach: leave the internal model unchanged but add a note to the API docs and ensure the create response includes the same nested shape as GET. Look at the create handler:

```typescript
// Current create handler returns:
return {
  provider,
  validation: provider.config.validation,
};
```

The `provider` object already contains the `config` nesting — the issue is purely documentation. Add inline JSDoc to the API types file and include a brief note in the response:

**Files:** `src/api/model/friday-api-provider.types.ts` — add JSDoc comments explaining the shape.

**Actual fix needed:** None code-wise if the shapes already match (provider entity has config nesting in both create and get). But verify the create request body maps correctly:

The real discrepancy is likely that POST takes `baseUrl`, `authMode` etc. at the top level, but the stored/returned entity nests them under `provider.config.baseUrl` etc. This is **by design** (flat input → structured output). Document it:

```typescript
// In friday-api-provider.types.ts, add JSDoc:
/**
 * Create provider request — flat structure for convenience.
 * The response wraps these in `provider.config.*`.
 * Round-trip: POST flat fields → GET nested under provider.config.
 */
export interface FridayCreateProviderRequest { ... }
```

**Tests:** Document in API reference; no behavior change needed.

---

## DX-002: Session key requires undocumented 3-segment format

**Root Cause:** `parseFridaySessionKey()` in `friday-session-key.ts` (line 91) requires exactly 3 colon-separated segments (`channel:accountId:chatId`). Simple keys like `"test-session"` fail with `SESSION_INVALID_KEY`.

**Files:**
- `src/sessions/services/friday-session-key.ts` (line ~91, `parseFridaySessionKey`)

**Changes:**

Add a convenience fallback: if a key has only 1 segment (no colons, not a subagent key), treat it as `unknown:default:<key>`. This makes the API more forgiving for quick testing.

```typescript
// BEFORE (line ~91, in parseFridaySessionKey):
// Conversation key: `<channel>:<accountId>:<chatId>`
const segments = key.split(":");
if (segments.length !== 3) {
  throw new FridayDomainError(
    FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
    `Session key must have exactly 3 segments (channel:accountId:chatId), got ${segments.length}: '${key}'`,
    { httpStatus: 400 },
  );
}

// AFTER:
// Conversation key: `<channel>:<accountId>:<chatId>`
const segments = key.split(":");

// Convenience: single-segment keys are expanded to `api:default:<key>`
if (segments.length === 1) {
  const normalized = normalizeSegment(segments[0]);
  validateSegment(normalized, "chatId");
  return {
    kind: "conversation",
    channel: "api",
    accountId: FRIDAY_SESSION_DEFAULT_ACCOUNT_ID,
    chatId: normalized,
    canonicalKey: `api:${FRIDAY_SESSION_DEFAULT_ACCOUNT_ID}:${normalized}`,
  };
}

if (segments.length !== 3) {
  throw new FridayDomainError(
    FRIDAY_SESSION_ERROR_CODES.INVALID_KEY,
    `Session key must have 1 or 3 segments (shorthand or channel:accountId:chatId), got ${segments.length}: '${key}'`,
    { httpStatus: 400 },
  );
}
```

**Tests:**
1. `"test-session"` → parses to `{ channel: "api", accountId: "default", chatId: "test-session" }`
2. `"discord:12345:67890"` → unchanged behavior
3. `"a:b"` (2 segments) → still throws INVALID_KEY
4. Subagent keys → unchanged behavior

---

## DX-003: Memory store requires namespace field (undocumented)

**Root Cause:** The memory service requires a `namespace` field but the API docs/error messages don't make this clear.

**Files:**
- `src/api/http/routes/friday-memory-routes.ts` — add a better validation error message

**Changes:**

Add a clear validation check at the top of memory write endpoints:

```typescript
// In the memory write handler, before calling memoryService:
if (!body.namespace || typeof body.namespace !== "string") {
  throw new FridayDomainError(
    "VALIDATION_ERROR",
    "namespace is required and must be a non-empty string. Use a descriptive namespace like 'user:preferences' or 'session:context'.",
    { httpStatus: 400 },
  );
}
```

**Tests:**
1. `POST /v1/memory` without `namespace` → 400 with descriptive error
2. `POST /v1/memory` with `namespace` → 200 (unchanged)

---

## DX-004: Usage endpoint requires from/to query params (no defaults)

**Root Cause:** The provider usage endpoint requires explicit `from` and `to` date range parameters with no defaults, returning an error if they're missing.

**Files:**
- `src/api/http/routes/friday-provider-usage-routes.ts` — add default values

**Changes:**

Add sensible defaults in the usage route handler:

```typescript
// When parsing query params:
const now = new Date();
const from = query.from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
const to = query.to ?? now.toISOString(); // now
```

**Tests:**
1. `GET /v1/providers/usage` (no params) → 200 with last 30 days of data
2. `GET /v1/providers/usage?from=2026-01-01&to=2026-02-01` → 200 (unchanged)

---

## Implementation Order (for CC)

1. **BUG-001** — Admin user seed (critical, unblocks all authenticated tests)
2. **BUG-002** — Workflow create transaction fix (critical, one-line change to use existing method)
3. **BUG-003** — Plugin stub routes (medium, unblocks client discovery)
4. **BUG-005** — HEAD support (low, clean HTTP compliance)
5. **BUG-004** — DELETE 404 (low, three-file change)
6. **DX-002** — Session key convenience (DX, one-file change)
7. **DX-003** — Memory namespace validation message (DX, one-line)
8. **DX-004** — Usage defaults (DX, one-line)
9. **DX-001** — Provider shape docs (DX, documentation only)

## Estimated Effort

| Bug | Effort | Risk |
|---------|--------|------|
| BUG-001 | 10 min | Low — additive only, no behavior change for existing DBs |
| BUG-002 | 5 min | Low — uses existing tested method |
| BUG-003 | 10 min | Low — additive stub routes |
| BUG-004 | 10 min | Low — return type change in repo interface |
| BUG-005 | 15 min | Medium — touches request handler hot path |
| DX-001 | 5 min | None — docs only |
| DX-002 | 10 min | Low — backward-compatible expansion |
| DX-003 | 5 min | None — better error message |
| DX-004 | 5 min | Low — additive default |

**Total: ~75 min**

---

PLAN_COMPLETE
