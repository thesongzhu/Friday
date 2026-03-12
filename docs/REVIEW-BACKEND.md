> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Backend Code Review — CX (gpt-5.3-codex)
> Date: 2026-02-19 | Scope: src/ (66k LOC, 435 files)

## 1. Critical (3)

### C1: Default Admin Auth Bypass
**Files:** `hub/friday-hub-bootstrap.ts:348-389`, `api/auth/friday-auth-service.ts:203-229`, `cli/friday-cli.ts:328`
Default admin seeded with NULL password, passwordless local login enabled, server binds 0.0.0.0. Remote admin-auth bypass on misconfigured hosts.
**Fix:** Force first-run password setup, disable passwordless login by default, default bind to 127.0.0.1.

### C2: Agent Exec Tool — Unrestricted RCE
**Files:** `api/http/routes/friday-agent-routes.ts:72-73`, `agent/tools/friday-agent-exec-tool.ts:59-64`, `agent/tools/friday-agent-file-tools.ts:49-50`
Agent routes gated by broad `workflow.run` scope can access `exec` (shell: true) and unrestricted file tools. Host-level RCE/file exfiltration risk.
**Fix:** Split scopes (agent.run, agent.exec, agent.fs), disable dangerous tools by default, sandbox to allowlisted workspace root.

### C3: Refresh Token Replay Window
**Files:** `api/auth/friday-auth-service.ts:275-299`, `api/persistence/friday-auth-session-repository.ts:102-105`
Refresh-token rotation is non-atomic (read-then-write). Concurrent refresh requests can both succeed.
**Fix:** Atomic compare-and-swap update (WHERE id=? AND refresh_hash=?), fail second request.

## 2. Major (6)

### M1: Workflow AI Node Returns Metadata Not Output
`workflows/engine/friday-workflow-node-executor.ts:194-201`, `skills/executor/friday-skill-executor.ts:51-69`
**Fix:** Route through provider inference service, return normalized completion payload.

### M2: Agent Runtime Ignores providerId/model
`api/http/routes/friday-agent-routes.ts:83-99`, `agent/runtime/friday-agent-llm-client.ts:51-57`
API accepts providerId/model but runtime ignores them; LLM client is Anthropic-specific.
**Fix:** Thread providerId/model through run context, use provider-agnostic adapter.

### M3: Job Scheduler Not Wired at Startup
`jobs/workflows/friday-workflow-timeout-job.ts:22-39`, `cli/friday-cli-run-loop.ts:28-78`
Timeout/cron logic exists but scheduler wiring missing in startup path.
**Fix:** Register periodic job runner at bootstrap with health metrics and graceful shutdown.

### M4: Webhook Handler No Signature Verification
`state/sqlite/migrations/v009-...:29-32`, `workflows/services/friday-workflow-trigger-service.ts:375-396`
Webhook secret fields exist but handler doesn't verify signatures.
**Fix:** Enforce HMAC verification, return 401/403 for invalid signatures.

### M5: Unsafe Graph JSON Cast
`workflows/model/friday-workflow-graph.types.ts:14-15`, `workflows/services/friday-workflow-crud-service.ts:168-176`
Raw non-compiled graphs can be persisted; execution assumes compiled shape.
**Fix:** Validate with runtime schema (Zod/TypeBox), persist only validated compiled graphs.

### M6: Module-Level Circular Dependencies
`skills/registry → hub → api → agent → skills`
**Fix:** Define stable interface boundaries (ports/adapters), move shared contracts to neutral modules.

## 3. Minor (3)

- **m1:** AbortController map leak — never deleted on completion (`api/runtime/friday-api-runtime.ts:786-799`)
- **m2:** WebSocket route unimplemented but exposed (`api/http/friday-http-server.ts:577-596`)
- **m3:** Scope semantics inconsistent — `workflow.run` used for agent operations

## 4. Strengths
- Secret encryption (AES-256-GCM) well implemented
- Migration system robust with ordering/checksum protections
- Workflow engine state machine well-structured (run/node states, retries, leases, artifacts)
- Error mapping clean and consistent

## 5. Missing for Vision
- Plugin APIs all 501 stubs → blocks ecosystem tools
- Satellites/self-learning runtimes not wired → blocks self-improving execution
- Realtime WebSocket incomplete → weak live observability
- No first-run password setup endpoint → security gap
