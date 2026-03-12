> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Full E2E Smoke Test Plan

> **Goal:** A single vitest file (`test/e2e/friday-full-e2e.test.ts`) that exercises every major subsystem end-to-end against a real running Friday hub + HTTP server, with a real Anthropic Claude API for LLM-dependent tests.
>
> **Status:** Plan document — no code yet.
>
> **Gating:** `FRIDAY_LLM_E2E` env var (same as existing `friday-llm-e2e.test.ts`). All tests run when enabled; LLM-dependent tests are clearly marked so we know which ones cost money.

---

## Table of Contents

1. [Test Infrastructure](#1-test-infrastructure)
2. [Test Groups](#2-test-groups)
   - [A. Health](#a-health)
   - [B. Auth](#b-auth)
   - [C. Providers & Routing](#c-providers--routing)
   - [D. Provider Usage & Budget](#d-provider-usage--budget)
   - [E. Memory](#e-memory)
   - [F. Sessions](#f-sessions)
   - [G. Workflows — CRUD](#g-workflows--crud)
   - [H. Workflows — Builder (Drafts & Locks)](#h-workflows--builder-drafts--locks)
   - [I. Workflows — Execution (Runs)](#i-workflows--execution-runs)
   - [J. Workflows — Triggers & Webhooks](#j-workflows--triggers--webhooks)
   - [K. Workflows — Approvals](#k-workflows--approvals)
   - [L. Workflows — Conflicts](#l-workflows--conflicts)
   - [M. Skill Converter](#m-skill-converter)
   - [N. Skill Generator (LLM)](#n-skill-generator-llm)
   - [O. Workflow Generator (LLM)](#o-workflow-generator-llm)
   - [P. Plugins](#p-plugins)
   - [Q. Fleet](#q-fleet)
   - [R. Security](#r-security)
   - [S. Realtime (HTTP polling)](#s-realtime-http-polling)
   - [T. Realtime (WebSocket)](#t-realtime-websocket)
3. [Dependency Order](#3-dependency-order)
4. [Special Setup Notes](#4-special-setup-notes)

---

## 1. Test Infrastructure

### Setup Pattern (mirrors existing `friday-llm-e2e.test.ts`)

```
beforeAll:
  1. createFridayHub({ stateDir: tmpDir, skillDirs: [testSkillDir], port: 0 })
  2. hub.start()
  3. createFridayHttpServer({ routes, wsGateway, middleware, port: freePort })
  4. httpServer.listen()
  5. POST /v1/auth/login { local: true } → save accessToken + refreshToken
  6. Create Anthropic provider (oauth mode, validateOnSave: false)
  7. PUT /v1/model-routing → set default provider
  8. Seed OAuth credentials via credential store (same as existing test)

afterAll:
  httpServer.close(), hub.stop(), rm tmpDir
```

### Shared State Across Tests

Tests within the file share one hub instance. Tests are ordered so that create operations run before dependent read/update/delete operations. Each `describe` block focuses on one subsystem.

### Conventions

- **`[CRUD]`** = Pure CRUD, no LLM call, fast (<1s)
- **`[LLM]`** = Requires real Anthropic API call, expensive (5-60s)
- **`[SETUP]`** = Creates state that later tests depend on
- **`[NEEDS: X]`** = Depends on test X having run first

### Auth Helper

```ts
function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
```

---

## 2. Test Groups

### A. Health

| # | Test | Method | Path | Body | Status | Response Shape | Cost |
|---|------|--------|------|------|--------|----------------|------|
| A1 | Health check (no auth) | `GET` | `/v1/health` | — | 200 | `{ status: "ok", version: string, uptime: number }` | CRUD |

**What this catches:** Server boots, routes registered, public endpoints work without auth.

---

### B. Auth

| # | Test | Method | Path | Body | Status | Response Shape | Cost |
|---|------|--------|------|------|--------|----------------|------|
| B1 | Login (local dev mode) | `POST` | `/v1/auth/login` | `{ local: true }` | 200 | `{ ok: true, data: { accessToken, refreshToken } }` | CRUD |
| B2 | Get current user (me) | `GET` | `/v1/auth/me` | — | 200 | `{ ok: true, data: { userId, role, scopes } }` | CRUD |
| B3 | Refresh token | `POST` | `/v1/auth/refresh` | `{ refreshToken: <from B1> }` | 200 | `{ ok: true, data: { accessToken, refreshToken } }` | CRUD |
| B4 | Reject missing auth | `GET` | `/v1/auth/me` | — (no auth header) | 401 | `{ ok: false }` | CRUD |
| B5 | Reject invalid token | `GET` | `/v1/auth/me` | — (Bearer garbage) | 401 | `{ ok: false }` | CRUD |
| B6 | Logout | `POST` | `/v1/auth/logout` | `{ refreshToken: <from B3> }` | 200 | `{ ok: true }` | CRUD |
| B7 | Refreshed token revoked after logout | `POST` | `/v1/auth/refresh` | `{ refreshToken: <from B3> }` | 401 | `{ ok: false }` | CRUD |

**What this catches:** Token lifecycle, middleware chain, revocation propagation.

---

### C. Providers & Routing

> Provider is created in `beforeAll`. These tests verify the CRUD + routing config.

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| C1 | List providers | `GET` | `/v1/providers` | — | 200 | `{ ok: true, data: { items: [{ id, kind, name }] } }` | CRUD | |
| C2 | Get provider by ID | `GET` | `/v1/providers/:id` | — | 200 | `{ ok: true, data: { provider: { id, kind, name, config } } }` | CRUD | |
| C3 | Update provider name | `PATCH` | `/v1/providers/:id` | `{ name: "Renamed" }` | 200 | `{ ok: true, data: { provider: { name: "Renamed" } } }` | CRUD | |
| C4 | Get routing config | `GET` | `/v1/model-routing` | — | 200 | `{ ok: true, data: { routing: { defaultProviderId } } }` | CRUD | |
| C5 | Set routing config | `PUT` | `/v1/model-routing` | `{ defaultProviderId, fallbackProviderIds: [] }` | 200 | `{ ok: true }` | CRUD | |
| C6 | Validate provider (real API call) | `POST` | `/v1/providers/:id/validate` | — | 200 | `{ ok: true, data: { validation: { status: "ok" } } }` | LLM | |
| C7 | Create second provider (for delete test) | `POST` | `/v1/providers` | `{ kind: "ollama", name: "Temp", ... }` | 200 | `{ ok: true }` | CRUD | SETUP |
| C8 | Delete provider | `DELETE` | `/v1/providers/:tempId` | — | 200 | `{ ok: true, data: { deleted: true } }` | CRUD | NEEDS: C7 |
| C9 | Get deleted provider → 404 | `GET` | `/v1/providers/:tempId` | — | 404 | `{ ok: false }` | CRUD | NEEDS: C8 |

**What this catches:** Provider CRUD, routing config persistence, OAuth credential resolution.

---

### D. Provider Usage & Budget

| # | Test | Method | Path | Body | Status | Response Shape | Cost |
|---|------|--------|------|------|--------|----------------|------|
| D1 | Get usage summary (default dates) | `GET` | `/v1/providers/usage` | — | 200 | `{ ok: true, data: { summary: { ... } } }` | CRUD |
| D2 | Get budget status | `GET` | `/v1/providers/budget` | — | 200 | `{ ok: true, data: { budget: { ... } } }` | CRUD |
| D3 | Set budget config | `PUT` | `/v1/providers/budget` | `{ monthlyLimitUsd: 50 }` | 200 | `{ ok: true, data: { budget: { monthlyLimitUsd: 50 } } }` | CRUD |
| D4 | Get updated budget | `GET` | `/v1/providers/budget` | — | 200 | `{ data.budget.monthlyLimitUsd: 50 }` | CRUD |

**What this catches:** Usage tracking tables exist, budget persistence works.

---

### E. Memory

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| E1 | Store memory item | `POST` | `/v1/memory/store` | `{ namespace: "test", content: "The capital of France is Paris", source: "e2e", tags: ["geo"] }` | 200 | `{ ok: true, data: { item: { id, namespace, content } } }` | CRUD | SETUP |
| E2 | Store second item | `POST` | `/v1/memory/store` | `{ namespace: "test", content: "Berlin is the capital of Germany", source: "e2e", tags: ["geo"] }` | 200 | `{ ok: true }` | CRUD | SETUP |
| E3 | Get item by ID | `GET` | `/v1/memory/items/:id` | — | 200 | `{ ok: true, data: { item: { id, content } } }` | CRUD | NEEDS: E1 |
| E4 | List items | `GET` | `/v1/memory/items?namespace=test` | — | 200 | `{ ok: true, data: { items: Array(≥2) } }` | CRUD | NEEDS: E1,E2 |
| E5 | Search (FTS) | `POST` | `/v1/memory/search` | `{ query: "capital France", namespace: "test" }` | 200 | `{ ok: true, data: { items: [{ content: contains "Paris", score }] } }` | CRUD | NEEDS: E1 |
| E6 | Search with minScore filter | `POST` | `/v1/memory/search` | `{ query: "capital", namespace: "test", minScore: 0.01 }` | 200 | items have `score >= 0.01` | CRUD | |
| E7 | Delete item | `DELETE` | `/v1/memory/items/:id` | — | 200 | `{ ok: true, data: { deleted: true } }` | CRUD | NEEDS: E1 |
| E8 | Get deleted item → 404 | `GET` | `/v1/memory/items/:id` | — | 404 | `{ ok: false }` | CRUD | NEEDS: E7 |
| E9 | Store with TTL | `POST` | `/v1/memory/store` | `{ namespace: "test", content: "ephemeral", ttlSeconds: 3600 }` | 200 | `{ ok: true, data: { item: { expiresAt: string } } }` | CRUD | |
| E10 | Prune (dry run) | `POST` | `/v1/memory/prune` | `{ namespace: "test", dryRun: true }` | 200 | `{ ok: true, data: { result: { prunedCount: number } } }` | CRUD | |
| E11 | Namespace defaults to "default" | `POST` | `/v1/memory/store` | `{ content: "no namespace" }` | 200 | `item.namespace === "default"` | CRUD | DX-003 |

**What this catches:** FTS5 indexing, TTL support, prune, guard service authorization.

---

### F. Sessions

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| F1 | Create session | `POST` | `/v1/sessions` | `{ channel: "e2e", chatId: "smoke-test-1" }` | 200 | `{ ok: true, data: { session: { key, status: "active" } } }` | CRUD | SETUP |
| F2 | Get session | `GET` | `/v1/sessions/:key` | — | 200 | `{ ok: true, data: { session: { key, status } } }` | CRUD | NEEDS: F1 |
| F3 | List sessions | `GET` | `/v1/sessions?channel=e2e` | — | 200 | `{ ok: true, data: { items: Array(≥1) } }` | CRUD | NEEDS: F1 |
| F4 | Add message (user) | `POST` | `/v1/sessions/:key/messages` | `{ role: "user", content: "Hello Friday" }` | 200 | `{ ok: true, data: { message: { id, role, content } } }` | CRUD | NEEDS: F1, SETUP |
| F5 | Add message (assistant) | `POST` | `/v1/sessions/:key/messages` | `{ role: "assistant", content: "Hello! How can I help?" }` | 200 | `{ ok: true }` | CRUD | NEEDS: F1, SETUP |
| F6 | List messages | `GET` | `/v1/sessions/:key/messages` | — | 200 | `{ ok: true, data: { items: Array(≥2) } }` | CRUD | NEEDS: F4,F5 |
| F7 | List messages with limit | `GET` | `/v1/sessions/:key/messages?limit=1` | — | 200 | `items.length === 1` | CRUD | |
| F8 | Get memory namespace | `GET` | `/v1/sessions/:key/memory-namespace` | — | 200 | `{ ok: true, data: { namespace: string } }` | CRUD | NEEDS: F1 |
| F9 | Fork session | `POST` | `/v1/sessions/:key/fork` | `{ taskId: "sub-task-1" }` | 200 | `{ ok: true, data: { result: { forkSessionKey } } }` | CRUD | NEEDS: F4, SETUP |
| F10 | List forks | `GET` | `/v1/sessions/:key/forks` | — | 200 | `{ ok: true, data: { items: Array(≥1) } }` | CRUD | NEEDS: F9 |
| F11 | Add message to fork | `POST` | `/v1/sessions/:forkKey/messages` | `{ role: "assistant", content: "Fork result" }` | 200 | `{ ok: true }` | CRUD | NEEDS: F9 |
| F12 | Merge fork back | `POST` | `/v1/sessions/:key/merge` | `{ forkSessionKey: <forkKey>, summary: "completed sub-task" }` | 200 | `{ ok: true, data: { result } }` | CRUD | NEEDS: F9,F11 |
| F13 | Archive session | `POST` | `/v1/sessions/:key/archive` | — | 200 | `{ ok: true, data: { session: { status: "archived" } } }` | CRUD | |
| F14 | Sweep lifecycle | `POST` | `/v1/sessions/sweep` | — | 200 | `{ ok: true, data: { result } }` | CRUD | |
| F15 | Prune old sessions | `POST` | `/v1/sessions/prune` | `{ olderThan: "2020-01-01T00:00:00Z" }` | 200 | `{ ok: true, data: { result } }` | CRUD | |
| F16 | Short key auto-prefix (DX-002) | `GET` | `/v1/sessions/nonexistent` | — | 404 | auto-prefixes to `local:default:nonexistent` | CRUD | |
| F17 | Memory extraction status | `GET` | `/v1/sessions/:key/memory/extraction` | — | 200 | `{ ok: true, data: { status } }` | CRUD | NEEDS: F1 |

**What this catches:** Full session lifecycle, fork/merge, message CRUD, DX shortcuts.

---

### G. Workflows — CRUD

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| G1 | Create workflow | `POST` | `/v1/workflows` | `{ slug: "smoke-test", name: "Smoke Test WF", tags: ["e2e"], graph: <minimal> }` | 200 | `{ ok: true, data: { workflow: { id }, latestVersion: { ... } } }` | CRUD | SETUP |
| G2 | Get workflow | `GET` | `/v1/workflows/:id` | — | 200 | `{ ok: true, data: { workflow, latestVersion } }` | CRUD | NEEDS: G1 |
| G3 | List workflows | `GET` | `/v1/workflows` | — | 200 | `{ ok: true, data: { items: Array(≥1) } }` | CRUD | NEEDS: G1 |
| G4 | List workflows with tag filter | `GET` | `/v1/workflows?tag=e2e` | — | 200 | all items have tag "e2e" | CRUD | NEEDS: G1 |
| G5 | Update workflow | `PATCH` | `/v1/workflows/:id` | `{ name: "Smoke Test Updated" }` | 200 | `{ ok: true, data: { workflow: { name: "Smoke Test Updated" } } }` | CRUD | NEEDS: G1 |
| G6 | Publish version | `POST` | `/v1/workflows/:id/publish` | `{ versionNumber: 1 }` | 200 | `{ ok: true, data: { publishedVersion } }` | CRUD | NEEDS: G1, SETUP |
| G7 | List versions | `GET` | `/v1/workflows/:id/versions` | — | 200 | `{ ok: true, data: { items: Array(≥1) } }` | CRUD | NEEDS: G1 |
| G8 | Get workflow shows publishedVersion | `GET` | `/v1/workflows/:id` | — | 200 | `data.publishedVersion != null` | CRUD | NEEDS: G6 |

**Minimal graph for G1:** A graph with a single manual-trigger node + a log node. This should be a JSON object matching `FridayCompiledWorkflowGraphV2` schema. We can use the simplest valid graph:
```json
{
  "version": 2,
  "nodes": {
    "trigger": { "type": "manual-trigger", "config": {} },
    "log": { "type": "log", "config": { "message": "hello" } }
  },
  "edges": [{ "from": "trigger", "to": "log" }],
  "entryNodeId": "trigger"
}
```

**What this catches:** Workflow CRUD, version creation, publish flow, tag filtering.

---

### H. Workflows — Builder (Drafts & Locks)

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| H1 | Create draft | `POST` | `/v1/workflows/:wfId/drafts` | `{ title: "E2E Draft", spec: {...}, visual: {...} }` | 200 | `{ ok: true, data: { draft: { id, title, revision } } }` | CRUD | NEEDS: G1, SETUP |
| H2 | List drafts | `GET` | `/v1/workflows/:wfId/drafts` | — | 200 | `{ ok: true, data: { items: Array(≥1) } }` | CRUD | NEEDS: H1 |
| H3 | Get draft | `GET` | `/v1/workflows/:wfId/drafts/:draftId` | — | 200 | `{ ok: true, data: { draft: { id, title } } }` | CRUD | NEEDS: H1 |
| H4 | Save draft (increments revision) | `PATCH` | `/v1/workflows/:wfId/drafts/:draftId` | `{ title: "Updated Draft", spec: {...} }` | 200 | `draft.revision > 1` | CRUD | NEEDS: H1 |
| H5 | Autosave draft | `POST` | `/v1/workflows/:wfId/drafts/:draftId/autosave` | `{ spec: {...}, visual: {...} }` | 200 | `{ ok: true }` | CRUD | NEEDS: H1 |
| H6 | Compile draft | `POST` | `/v1/workflows/:wfId/drafts/:draftId/compile` | — | 200 | `{ ok: true, data: { compiledGraph or errors } }` | CRUD | NEEDS: H1 |
| H7 | Acquire lock | `POST` | `/v1/workflows/:wfId/locks/acquire` | `{ ownerUserId: "admin-001", ownerSessionId: "e2e" }` | 200 | `{ ok: true, data: { acquired: true, lock: { token } } }` | CRUD | NEEDS: G1, SETUP |
| H8 | Renew lock | `POST` | `/v1/workflows/:wfId/locks/renew` | `{ lockToken: <from H7> }` | 200 | `{ ok: true, data: { lock } }` | CRUD | NEEDS: H7 |
| H9 | Release lock | `POST` | `/v1/workflows/:wfId/locks/release` | `{ lockToken: <from H7> }` | 200 | `{ ok: true, data: { released: true } }` | CRUD | NEEDS: H7 |
| H10 | Publish draft | `POST` | `/v1/workflows/:wfId/drafts/:draftId/publish` | `{ publishNow: true }` | 200 | `{ ok: true }` | CRUD | NEEDS: H1 |

**Draft spec/visual:** Use minimal valid spec objects. The exact shape depends on the builder schema — use empty `{}` or `{ nodes: {}, edges: [] }` as needed.

**What this catches:** Draft lifecycle, optimistic locking, collaborative lock acquire/renew/release, draft compilation.

---

### I. Workflows — Execution (Runs)

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| I1 | Start run (manual trigger) | `POST` | `/v1/workflow-runs` | `{ workflowId: <from G1>, triggerType: "manual", triggerPayload: {} }` | 200 | `{ ok: true, data: { run: { id, status } } }` | CRUD | NEEDS: G6, SETUP |
| I2 | Get run | `GET` | `/v1/workflow-runs/:runId` | — | 200 | `{ ok: true, data: { run: { id, status, workflowId } } }` | CRUD | NEEDS: I1 |
| I3 | List run nodes | `GET` | `/v1/workflow-runs/:runId/nodes` | — | 200 | `{ ok: true, data: { items: Array } }` | CRUD | NEEDS: I1 |
| I4 | Get run timeline | `GET` | `/v1/workflow-runs/:runId/timeline` | — | 200 | `{ ok: true, data: { items: Array } }` | CRUD | NEEDS: I1 |
| I5 | Cancel run | `POST` | `/v1/workflow-runs/:runId/cancel` | `{ reason: "e2e test" }` | 200 | `{ ok: true, data: { run: { status } } }` | CRUD | Start a new run first |
| I6 | Retry run | `POST` | `/v1/workflow-runs/:runId/retry` | `{ nodeIds: [] }` | 200 | `{ ok: true }` or domain error | CRUD | Depends on run state |

**Note:** The run may complete near-instantly (simple log node) or the engine may process it async. Tests should allow for both `completed` and `running` statuses after `startRun`. For cancel/retry, start a separate run or use the existing one depending on state.

**What this catches:** Workflow engine boots, DAG scheduler works, run lifecycle (start → complete or start → cancel).

---

### J. Workflows — Triggers & Webhooks

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| J1 | List triggers | `GET` | `/v1/workflows/:wfId/triggers` | — | 200 | `{ ok: true, data: { items: Array } }` | CRUD | NEEDS: G6 |
| J2 | Resync triggers | `POST` | `/v1/workflows/:wfId/triggers/resync` | — | 200 | `{ ok: true, data: { synced: true } }` | CRUD | NEEDS: G6 |
| J3 | Webhook invoke (unknown token → 404) | `POST` | `/v1/workflow-webhooks/nonexistent` | `{}` | 404 | `{ ok: false }` | CRUD | |

**What this catches:** Trigger registration, webhook routing.

---

### K. Workflows — Approvals

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| K1 | List pending approvals (empty) | `GET` | `/v1/workflow-approvals` | — | 200 | `{ ok: true, data: { items: [] } }` | CRUD | |
| K2 | Get nonexistent approval → 404 | `GET` | `/v1/workflow-approvals/nonexistent` | — | 404 | `{ ok: false }` | CRUD | |

**Note:** Creating a real approval requires an approval node in a workflow graph. This is complex to set up for a smoke test. The CRUD list + 404 tests verify the routes are wired. A deeper approval test would require a workflow with an `approval` node type.

**What this catches:** Approval routes registered, service wired.

---

### L. Workflows — Conflicts

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| L1 | List conflicts (empty) | `GET` | `/v1/workflows/:wfId/conflicts` | — | 200 | `{ ok: true, data: { items: [] } }` | CRUD | NEEDS: G1 |

**What this catches:** Conflict service wired, table exists.

---

### M. Skill Converter

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| M1 | List converters | `GET` | `/v1/skills/converters` | — | 200 | `{ ok: true, data: { converters: Array(≥1) } }` | CRUD | |
| M2 | Convert from base64 (friday-package) | `POST` | `/v1/skills/convert` | `{ source: { contentBase64: <base64 of skill.md> }, formatHint: "auto", dryRun: true }` | 200 | `{ ok: true, data: { converterId, detectedFormat, drafts, validation } }` | CRUD | Special setup |

**Special setup for M2:** Create a minimal valid `skill.md` (ClawdBot format) or a minimal Friday package manifest, base64-encode it, and send as `contentBase64`. This verifies the converter pipeline end-to-end without touching the filesystem.

Example minimal ClawdBot skill.md:
```markdown
# echo-test

A test skill that echoes input.

## Runtime
kind: shell
command: echo "hello"
```

**What this catches:** Converter registry, format detection, draft generation.

---

### N. Skill Generator (LLM)

> Already covered by existing `friday-llm-e2e.test.ts` — **skip** per instructions.
> Include a reference test that verifies the route is registered (no LLM call):

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| N1 | Start session validation error | `POST` | `/v1/skills/generator/sessions` | `{ goal: "" }` | 400 | `{ ok: false, error: { code: "VALIDATION_ERROR" } }` | CRUD | |
| N2 | Get nonexistent session → 404 | `GET` | `/v1/skills/generator/sessions/nonexistent` | — | 404 | `{ ok: false }` | CRUD | |
| N3 | Get skill UI → 404 (no skills loaded) | `GET` | `/v1/skills/no-such-skill/ui` | — | 404 | `{ ok: false }` | CRUD | |

**What this catches:** Generator routes registered, validation works, 404s work.

---

### O. Workflow Generator (LLM)

> Already covered by existing `friday-llm-e2e.test.ts` — **skip** the LLM tests.
> Include route-wiring verification:

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| O1 | Start session validation error | `POST` | `/v1/workflows/generator/sessions` | `{ goal: "" }` | 400 | `{ ok: false }` | CRUD | |
| O2 | Get nonexistent session → 404 | `GET` | `/v1/workflows/generator/sessions/nonexistent` | — | 404 | `{ ok: false }` | CRUD | |

**What this catches:** Generator routes wired correctly.

---

### P. Plugins

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| P1 | List plugins (empty initially) | `GET` | `/v1/plugins` | — | 200 | `{ ok: true, data: { items: [] } }` | CRUD | |
| P2 | Get nonexistent plugin → 404 | `GET` | `/v1/plugins/nonexistent` | — | 404 | `{ ok: false }` | CRUD | |
| P3 | Search marketplace | `GET` | `/v1/marketplace/plugins` | — | 200 | `{ ok: true, data: { items, total } }` | CRUD | May return empty if no marketplace configured |

**Note:** Full plugin install requires a real plugin directory with a valid manifest on disk. The list/search tests verify the service is wired and responding.

**What this catches:** Plugin service registered, marketplace routes wired.

---

### Q. Fleet

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| Q1 | Fleet overview | `GET` | `/v1/fleet/overview` | — | 200 | `{ ok: true, data: { totalSatellites, ... } }` | CRUD | |
| Q2 | List satellites (empty) | `GET` | `/v1/fleet/satellites` | — | 200 | `{ ok: true, data: { items: [] } }` | CRUD | |
| Q3 | Get nonexistent satellite → 404 | `GET` | `/v1/fleet/satellites/nonexistent-id` | — | 404 | `{ ok: false }` | CRUD | |

**What this catches:** Fleet dashboard service wired, empty state is valid.

---

### R. Security

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| R1 | Security center | `GET` | `/v1/security/center` | — | 200 | `{ ok: true, data: { ... } }` | CRUD | |
| R2 | Revoke nonexistent token | `POST` | `/v1/security/tokens/revoke` | `{ tokenId: "fake-token-id" }` | 200 | `{ ok: true, data: { revoked: false } }` | CRUD | |

**What this catches:** Security center aggregation works, revocation path exists.

---

### S. Realtime (HTTP polling)

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| S1 | Subscribe to stream | `POST` | `/v1/realtime/subscriptions` | `{ subscriptions: [{ streamId: "run:*", events: ["*"] }] }` | 200 | `{ ok: true, data: { subscriptions, epoch } }` | CRUD | SETUP |
| S2 | Pull from stream (empty) | `POST` | `/v1/realtime/pull` | `{ streamId: "run:*", afterSeq: 0, limit: 10 }` | 200 or 403 | `{ ok: true, data: { items: [], streamId, epoch } }` | CRUD | NEEDS: S1 |
| S3 | Pull without subscription → 403 | `POST` | `/v1/realtime/pull` | `{ streamId: "unauthorized-stream" }` | 403 | error | CRUD | |
| S4 | Ack event | `POST` | `/v1/realtime/ack` | `{ streamId: "run:*", seq: 0, epoch: 1 }` | 200 or 409 | depends on state | CRUD | |

**Note:** The exact stream ID format and subscription validation depend on how `FridayRealtimeSubscriptionService.validateSubscriptions()` works. The tests should use a stream pattern that the admin principal is authorized for (based on scopes in the token). If `run:*` wildcards aren't accepted, use a concrete stream like `run:<runId>` from test I1.

**What this catches:** Realtime HTTP polling pipeline, subscription auth, epoch tracking.

---

### T. Realtime (WebSocket)

| # | Test | Method | Path | Body | Status | Response Shape | Cost | Notes |
|---|------|--------|------|------|--------|----------------|------|-------|
| T1 | WebSocket connect + auth handshake | WS | `/v1/realtime/ws` | auth message | connected | `{ type: "welcome", epoch, version }` | CRUD | |
| T2 | WebSocket subscribe + receive event | WS | — | subscribe message | — | subscription ack | CRUD | |

**Implementation note:** Use the `ws` library (or `undici` WebSocket) to connect to the WS gateway. Send an auth frame with the JWT token. Verify the welcome message. Then subscribe to a stream and verify ack.

**What this catches:** WS gateway boots, auth handshake, message routing.

---

## 3. Dependency Order

Tests must execute in this order within the file (vitest runs `describe` blocks in declaration order, and tests within a block sequentially):

```
A. Health                    (no deps)
B. Auth                      (no deps — uses fresh login)
C. Providers & Routing       (provider created in beforeAll)
D. Provider Usage & Budget   (no deps)
E. Memory                    (no deps)
F. Sessions                  (no deps)
G. Workflows — CRUD          (no deps → creates workflowId)
H. Workflows — Builder       (needs workflowId from G)
I. Workflows — Execution     (needs published version from G)
J. Workflows — Triggers      (needs published version from G)
K. Workflows — Approvals     (no deps)
L. Workflows — Conflicts     (needs workflowId from G)
M. Skill Converter           (no deps)
N. Skill Generator           (no deps — validation only)
O. Workflow Generator         (no deps — validation only)
P. Plugins                   (no deps)
Q. Fleet                     (no deps)
R. Security                  (no deps)
S. Realtime (HTTP)           (optionally needs runId from I)
T. Realtime (WebSocket)      (no deps)
```

**Cross-group dependencies:**
- `G1` → `G6` (publish) → `I1` (start run)
- `G1` → `H1` (create draft), `H7` (acquire lock)
- `G1` → `L1` (list conflicts)
- `F1` → `F4` → `F9` (fork) → `F12` (merge)
- `E1` → `E3`, `E5`, `E7`

---

## 4. Special Setup Notes

### Hub Configuration
```ts
createFridayHub({
  stateDir: tmpDir,
  skillDirs: [testSkillFixtureDir],  // optional: for skill UI test (N3)
  port: 0,
  logRequests: false,
})
```

### Test Skill Fixture (optional, for M2)
Create a temp directory with a minimal `skill.md` file for the converter test. Alternatively, use `contentBase64` to avoid filesystem dependency entirely.

### Workflow Graph Fixture
For G1, use the simplest valid compiled graph:
```json
{
  "version": 2,
  "nodes": {
    "trigger": { "type": "manual-trigger", "config": {} },
    "log": { "type": "log", "config": { "message": "smoke test" } }
  },
  "edges": [{ "from": "trigger", "to": "log" }],
  "entryNodeId": "trigger"
}
```
This must match whatever schema `createWorkflowWithVersion` expects. Check the actual type definitions if this doesn't work.

### Draft Spec/Visual Fixtures (for H1)
Use minimal objects that pass validation. The exact shape depends on the builder's spec schema. Start with:
```json
{
  "spec": { "nodes": {}, "edges": [] },
  "visual": { "nodes": {}, "viewport": { "x": 0, "y": 0, "zoom": 1 } }
}
```

### WebSocket Test Library
Use Node.js built-in `WebSocket` (Node 22+) or the `ws` package. The test should:
1. Connect to `ws://127.0.0.1:${port}/v1/realtime/ws`
2. Send auth frame: `{ type: "auth", token: jwt }`
3. Wait for welcome frame
4. Close cleanly

### OAuth Token Seeding
Identical to existing test — seed via `createFridayOAuthCredentialStore` + direct DB write + WAL checkpoint.

---

## 5. Expected Test Count Summary

| Category | CRUD Tests | LLM Tests | Total |
|----------|-----------|-----------|-------|
| A. Health | 1 | 0 | 1 |
| B. Auth | 7 | 0 | 7 |
| C. Providers | 8 | 1 | 9 |
| D. Usage/Budget | 4 | 0 | 4 |
| E. Memory | 11 | 0 | 11 |
| F. Sessions | 17 | 0 | 17 |
| G. Workflow CRUD | 8 | 0 | 8 |
| H. Builder | 10 | 0 | 10 |
| I. Runs | 6 | 0 | 6 |
| J. Triggers | 3 | 0 | 3 |
| K. Approvals | 2 | 0 | 2 |
| L. Conflicts | 1 | 0 | 1 |
| M. Converter | 2 | 0 | 2 |
| N. Skill Gen | 3 | 0 | 3 |
| O. Workflow Gen | 2 | 0 | 2 |
| P. Plugins | 3 | 0 | 3 |
| Q. Fleet | 3 | 0 | 3 |
| R. Security | 2 | 0 | 2 |
| S. Realtime HTTP | 4 | 0 | 4 |
| T. Realtime WS | 2 | 0 | 2 |
| **Total** | **99** | **1** | **100** |

- **99 CRUD tests** — fast, no API cost, verify full stack wiring
- **1 LLM test** — provider validation (already covered but included for completeness within this file's provider flow)
- Existing E2E tests already cover 4 LLM paths (direct inference, skill gen, workflow gen, validation) — no need to duplicate

---

## 6. What This Plan Does NOT Cover (Out of Scope)

1. **Rate limiting behavior** — would need to send many requests rapidly; flaky in CI
2. **Concurrent access / race conditions** — belongs in focused integration tests
3. **File system operations** (skill install to disk, pack to .tgz) — requires complex temp dir setup; lower priority
4. **CLI commands** (`friday start`, `friday list`, `friday run`) — these boot a full hub; test via subprocess spawn in a separate test file
5. **OAuth initiate/callback flow** — requires real browser redirect; tested manually
6. **Satellite pairing** — requires a real satellite agent connecting
7. **Memory extraction with LLM** — `POST /sessions/:key/memory/extract` with `mode: "inline"` would call the LLM; expensive and partially covered by unit tests

---

## 7. Implementation Notes

### Error Response Shape
All error responses should match:
```json
{
  "ok": false,
  "error": {
    "code": "SOME_ERROR_CODE",
    "message": "Human-readable message"
  }
}
```
Verify this shape in every error test (B4, B5, C9, E8, etc.).

### Timeout Strategy
- CRUD tests: 10s timeout
- LLM tests: 30s timeout
- WebSocket tests: 15s timeout (includes connection + handshake)
- `beforeAll`: 60s timeout (hub boot + OAuth token exchange)

### CI Integration
```bash
# Run full suite (CRUD only — no API cost)
FRIDAY_LLM_E2E=1 npx vitest run test/e2e/friday-full-e2e.test.ts

# With real Anthropic API
FRIDAY_LLM_E2E=1 FRIDAY_ANTHROPIC_OAUTH_ACCESS_TOKEN=xxx npx vitest run test/e2e/friday-full-e2e.test.ts
```

The `FRIDAY_LLM_E2E` gate applies to the entire file. Within the file, individual LLM tests can use `it.skipIf(!ACCESS_TOKEN)` for the one provider validation test.
