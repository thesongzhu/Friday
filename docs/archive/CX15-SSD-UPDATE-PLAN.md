> Archived and superseded: this historical update plan is no longer an active contract source. Use `docs/current-source-of-truth.md` for the current canonical API/runtime baseline and `docs/SSD-GAP-REPORT.md` for the remaining deferred gaps.

### UPDATE-1: Add Implementation Status Markers
**SSD Section**: `§0` (add new `§0.3`)
**Action**: add  
**Current text**: `"Status: Proposed architecture for implementation..."` (no per-item implementation markers)  
**New text**:
```md
## 0.3 Implementation Status Markers

This SSD uses explicit implementation markers:

- `[Implemented]` — behavior exists in the current codebase.
- `[Partial]` — some behavior exists, but not the full design intent.
- `[Planned / Not Yet Implemented]` — intentionally documented target behavior that is not currently implemented.

Rule: all endpoint rows in §11 and all major subsystem bullets in §2–§10 must include one of these markers.
```
**Reason**: LIST 1 global requirement (mark unimplemented features), plus consistency for LIST 1/2/3 reconciliation.

---

### UPDATE-2: Correct API Transport Model (REST-first, WS planned)
**SSD Section**: `§2.3 API Layer Design (REST + WebSocket)`  
**Action**: replace  
**Current text**: `"WebSocket API (/v1/ws) handles real-time..."`  
**New text**:
```md
### 2.3 API Layer Design (REST + Realtime Pull/Ack)

[Implemented] REST API (`/v1/*`) is the active transport for CRUD, orchestration, and realtime pull/ack flows.

[Implemented] Realtime delivery currently uses:
- `POST /v1/realtime/subscriptions`
- `POST /v1/realtime/pull`
- `POST /v1/realtime/ack`
- `GET /v1/agent/runs/:runId/events` (SSE stream for agent runs)

[Planned / Not Yet Implemented] WebSocket transport at `/v1/ws`.

[Planned / Not Yet Implemented] Active `req/res/event` gateway transport at runtime. Frame types exist in types/contracts, but the HTTP server currently rejects upgrades with `501 WEBSOCKET_NOT_IMPLEMENTED`.
```
**Reason**: LIST 1.3, LIST 3.4, LIST 3.17, LIST 2.13.

---

### UPDATE-3: Align Session Key Canonical Format
**SSD Section**: `§2.5 Session Management Across Satellites`  
**Action**: replace  
**Current text**: `"Canonical: agent:<agentId>:<channel>:<kind>:<targetId>..."`  
**New text**:
```md
### 2.5 Session Management Across Satellites

**Session key format (canonical):** `[Implemented]`

- Conversation session key: `<channel>:<accountId>:<chatId>`
- Subagent session key: `subagent:<parentKey>:<taskId>`

Examples:
- `telegram:default:123456`
- `discord:acct-1:889977`
- `subagent:discord:acct-1:889977:task-abc`

Normalization rules:
- Keys are lowercased and segment-sanitized.
- DM collapsing is supported by mapping DM user identity into `chatId` when `chatKind=dm`.
```
**Reason**: LIST 3.1.

---

### UPDATE-4: Align Scope Taxonomy with Auth Model
**SSD Section**: `§2.6 Authentication and Authorization Model`  
**Action**: replace scopes list  
**Current text**: includes `secrets.read`, `secrets.write` and omits `fleet.*`, `security.*`, `plugin.*`  
**New text**:
```md
**Scopes:** `[Implemented]`

- `hub.admin`
- `workflow.read`, `workflow.write`, `workflow.run`, `workflow.conflict.resolve`
- `satellite.read`, `satellite.write`
- `fleet.read`
- `security.read`, `security.write`
- `session.read`, `session.write`
- `diagnosis.read`, `diagnosis.write`
- `skill.read`, `skill.write`
- `plugin.read`, `plugin.write`, `plugin.install`

[Planned / Not Yet Implemented] dedicated `secrets.*` scopes.
```
**Reason**: LIST 3.11.

---

### UPDATE-5: Mark Discovery Protocols as Planned, Keep Current Pairing Reality
**SSD Section**: `§3.2 Registration and Discovery Protocol`  
**Action**: modify  
**Current text**: mDNS/Tailscale/relay described as active behavior  
**New text**:
```md
### 3.2 Registration and Discovery Protocol

[Implemented] Satellite pairing/handshake services exist in runtime services (pairing request, approval/rejection, token issuance, handshake algorithm negotiation).

[Planned / Not Yet Implemented] API-exposed satellite registration/discovery endpoints (`/v1/satellites/register`, pairing REST surface) in the HTTP route set.

[Planned / Not Yet Implemented] mDNS, Tailscale/private mesh discovery, and relay rendezvous patterns.

[Implemented] Fleet read APIs exist at `/v1/fleet/*` for dashboard/inspection.
```
**Reason**: LIST 1.2, LIST 1.8, LIST 2.16.

---

### UPDATE-6: Correct Satellite Local Engine and Offline Claims
**SSD Section**: `§3.3 Local Execution Engine` and `§3.5 Offline Autonomy`  
**Action**: replace  
**Current text**: task runner/capability adapter/queue worker/sync/security/telemetry agents and offline workflow continuation treated as implemented  
**New text**:
```md
### 3.3 Local Execution Engine

[Implemented] Current satellite runtime covers:
- pairing lifecycle
- capability reporting
- heartbeat recording/status computation
- outbox leasing/ack checkpointing
- sync pull/push services

[Planned / Not Yet Implemented]:
- full satellite-side workflow task runner
- dedicated security agent/telemetry agent modules as described in earlier target architecture

### 3.5 Offline Autonomy

[Planned / Not Yet Implemented] Autonomous satellite workflow execution while disconnected (`offline_allowed` run continuation) is documented target behavior, but not currently wired as an end-to-end execution pipeline.
```
**Reason**: LIST 1.9, LIST 1.10.

---

### UPDATE-7: Align Sync Payload Semantics + Heartbeat Default + Encryption Envelope
**SSD Section**: `§3.6`, `§4.4`, `§4.5`  
**Action**: modify  
**Current text**: pull returns events+config diff; push handles node results/conflicts; per-frame encrypted envelope; heartbeat default 10s  
**New text**:
```md
### 3.6 Reconnection and State Sync

[Implemented] Sync pull currently returns:
- `epoch`
- `streamId`
- `events` (currently empty array in service)
- `queueItems` (leased outbox items)
- `nextCursor`
- `fullPullRequired` when resume/cursor validation fails

[Implemented] Sync push currently accepts:
- `acks[]`
- optional `localEvents[]`
and returns:
- `acceptedAcks[]`
- `conflicts[]`

[Planned / Not Yet Implemented] pull `configDiff` and push `nodeResults` conflict semantics from earlier SSD draft.

### 4.4 End-to-End Encryption Design

[Implemented] Handshake negotiates payload algorithm (`xchacha20-poly1305` preferred, fallback `aes-256-gcm`).

[Implemented] Outbox payload storage currently carries `payloadCiphertext`, `nonce`, and `keyId`.

[Planned / Not Yet Implemented] full per-frame SSD envelope contract with explicit `algorithm/nonce/aad` fields on every sync DTO plus documented key-rotation policy at transport-frame level.

### 4.5 Heartbeat and Health Monitoring

[Implemented] Default expected heartbeat interval is `15000ms` (15s), returned by heartbeat API/service responses.
```
**Reason**: LIST 3.12, LIST 3.13, LIST 3.14.

---

### UPDATE-8: Align Distributed Execution Placement to Current Hub-Only Behavior
**SSD Section**: `§5.4 Distributed Execution (Where Node Runs)`  
**Action**: replace  
**Current text**: scheduler chooses across hub/satellites by capability  
**New text**:
```md
### 5.4 Distributed Execution (Where Node Runs)

[Implemented] Node attempts are currently leased/executed by hub runtime (`lease_owner = "hub"`).

[Planned / Not Yet Implemented] satellite placement scheduling by capability/affinity/cost policy across hub+satellite executors.
```
**Reason**: LIST 1.11.

---

### UPDATE-9: Add Agent Runtime Architecture Section
**SSD Section**: add new `§2.7 Agent Runtime`  
**Action**: add  
**Current text**: no dedicated agent runtime section  
**New text**:
```md
### 2.7 Agent Runtime

[Implemented] `src/agent/*` provides a persisted agent execution runtime with phases:
`pending -> planning -> executing -> testing/fixing -> completed|failed|failed_tests|cancelled`.

[Implemented] Core capabilities:
- LLM streaming client integration
- tool orchestration (exec/filesystem/web-fetch/browser/skills/workflows/memory/xhs/subagent)
- review gate support
- self-test/self-fix services
- artifact writing to disk
- durable run/event persistence (`friday_agent_runs`, `friday_agent_run_events`)
- automation persistence/execution (`friday_agent_automations`)

[Implemented] API surface is under `/v1/agent/*`, with SSE stream at `/v1/agent/runs/:runId/events`.
```
**Reason**: LIST 2.1, LIST 2.3.

---

### UPDATE-10: Document Workflow Builder + Workflow Generator Runtime
**SSD Section**: `§5 Workflow Engine` (add `§5.7` and `§5.8`)  
**Action**: add  
**Current text**: no draft builder/generator runtime coverage  
**New text**:
```md
### 5.7 Workflow Builder Runtime

[Implemented] Draft-based workflow authoring runtime exists (`src/workflows/builder/*`) with:
- draft create/list/get/save
- autosave
- compile draft
- publish draft
- lock acquire/renew/release

API routes: `/v1/workflows/:workflowId/drafts*`, `/v1/workflows/:workflowId/locks/*`.

### 5.8 Workflow Generator Sessions

[Implemented] AI-assisted workflow generation sessions exist (`src/workflows/generator/*`) with:
- session start/get/cancel
- conversational turns
- draft generation
- approve-and-save
API routes: `/v1/workflows/generator/sessions*`.
```
**Reason**: LIST 2.4, LIST 2.5.

---

### UPDATE-11: Add Subagent Orchestration Section
**SSD Section**: add new `§5.9 Subagent Orchestration`  
**Action**: add  
**Current text**: no subagent orchestration section  
**New text**:
```md
### 5.9 Subagent Orchestration

[Implemented] Subagent registry (`src/agent/subagent/*`) supports child runtime spawning with guardrails:
- max depth: 3
- max concurrent per parent run: 5
- default timeout: 180000ms

[Implemented] Subagent persistence table: `friday_subagent_runs`.

[Implemented] API routes:
- `GET /v1/agent/subagents`
- `GET /v1/agent/subagents/:subagentId`
- `GET /v1/agent/runs/:runId/subagents`
```
**Reason**: LIST 2.2.

---

### UPDATE-12: Add Channel System Section
**SSD Section**: add new `§2.8 Channel System`  
**Action**: add  
**Current text**: channels only mentioned generically  
**New text**:
```md
### 2.8 Channel System

[Implemented] Channel registry/runtime exists in `src/channels/*`:
- plugin lifecycle register/start/stop/send
- allowlist filtering by user/chat
- inbound text sanitization (control char + zero-width stripping)

[Implemented] Channel adapters currently include:
- QQ
- Lark
- Feishu (Lark variant)

[Implemented] Hub bootstrap wires channel inbound messages to agent runtime and writes replies back through channel plugins.
```
**Reason**: LIST 2.16.

---

### UPDATE-13: Add Browser Automation Section
**SSD Section**: add new `§3.7 Browser Automation Runtime`  
**Action**: add  
**Current text**: no browser manager/runtime section  
**New text**:
```md
### 3.7 Browser Automation Runtime

[Implemented] Playwright browser manager exists in `src/browser/friday-browser-manager.ts`.

Capabilities:
- session/tab lifecycle management
- per-session and global page limits
- navigation/action timeouts
- origin allowlisting for URL safety checks
- artifact path sanitization for browser artifacts
```
**Reason**: LIST 2.17.

---

### UPDATE-14: Add XHS Automation Integration Section
**SSD Section**: add new `§6.7 XHS Automation`  
**Action**: add  
**Current text**: no Xiaohongshu integration section  
**New text**:
```md
### 6.7 XHS Automation

[Implemented] Xiaohongshu automation runtime exists in `src/xhs/*` and agent tooling:
- cookie-based session manager
- encrypted cookie-at-rest storage
- stealth/browser hardening helpers
- page interactions: login/search/post/comments/status

[Implemented] Schema support:
- `v015-xhs-sessions` (`xhs_sessions`)
- `v016-xhs-cookie-encryption` (`cookies_encrypted`, plaintext redaction)
```
**Reason**: LIST 2.18.

---

### UPDATE-15: Expand Skill System for Generator/Converter
**SSD Section**: `§6 Skill System` (add `§6.8`)  
**Action**: add  
**Current text**: lifecycle/marketplace only; no generator/converter runtime  
**New text**:
```md
### 6.8 Skill Authoring and Conversion Runtime

[Implemented] Skill generator sessions (`src/skills/generator/*`) with routes:
- `/v1/skills/generator/sessions*`
- `/v1/skills/:skillId/ui`

[Implemented] Skill converter/import/packaging (`src/skills/converter/*`) with routes:
- `GET /v1/skills/converters`
- `POST /v1/skills/convert`
- `POST /v1/skills/import`
- `POST /v1/skills/pack`

Supported conversion targets include clawdbot-style skill, n8n, OpenAI GPT action, and packaged skill artifacts.
```
**Reason**: LIST 2.6, LIST 2.7.

---

### UPDATE-16: Add Plugin System Section (Distinct from Skills)
**SSD Section**: add new `§6.9 Plugin System`  
**Action**: add  
**Current text**: only skill marketplace documented  
**New text**:
```md
### 6.9 Plugin System

[Implemented] A separate plugin runtime exists in `src/plugins/*` (distinct from skills).

Core features:
- manifest loading/validation
- dependency resolution
- signature verification + trust-on-install mode
- lifecycle transitions (`installed/configured/enabled/running/disabled/error/uninstalled`)
- marketplace search/detail/install support

[Implemented] API routes:
- `/v1/plugins*`
- `/v1/marketplace/plugins*`

[Implemented] Scopes:
- `plugin.read`
- `plugin.write`
- `plugin.install`
```
**Reason**: LIST 2.10.

---

### UPDATE-17: Align Provider Model, Cost Routing, OAuth
**SSD Section**: `§7.1` and `§7.2`  
**Action**: replace  
**Current text**: provider kind includes `"custom"`; routing decision uses `selectedProvider/fallbackChain/...`  
**New text**:
```md
### 7.1 Provider Abstraction

[Implemented] Provider kinds:
`"openai" | "anthropic" | "google" | "ollama" | "openai-compatible"`

[Implemented] Provider APIs include:
`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, `ollama`.

[Implemented] OAuth flow:
- `POST /v1/auth/oauth/anthropic/initiate`
- `POST /v1/auth/oauth/anthropic/callback`
with encrypted credential storage.

### 7.2 Model Routing (Cost-Aware)

[Implemented] Routing decision contract is `FridayCostRoutingDecision`:
- `strategy`
- `complexity`
- `budgetState`
- `estimatedInputTokens`
- `orderedCandidates`
- `reason`

[Implemented] Provider usage and budget APIs:
- `GET /v1/providers/usage`
- `GET /v1/providers/budget`
- `PUT /v1/providers/budget`
```
**Reason**: LIST 3.7, LIST 3.8, LIST 2.11, LIST 2.12, LIST 3.6.

---

### UPDATE-18: Document Memory Guard + Path Safety Utilities
**SSD Section**: `§7.3` and `§8`  
**Action**: modify  
**Current text**: generic context management/security text; no memory guard/path safety utility  
**New text**:
```md
### 7.3 Context Management Across Workflows

[Implemented] Memory access through API is guarded by tenant-scoped memory guard (`src/memory/guard/*`) with:
- namespace scoping and isolation
- quota enforcement
- per-namespace/global token-bucket rate limiting
- PII scan modes (`block`, `redact`, `tag`)
- guarded output filtering

### 8.x Path and Input Safety

[Implemented] Shared path traversal protection utility: `resolveSafePath(base, relativePath)`.

Rejected conditions:
- absolute path (`PATH_ABSOLUTE_REJECTED`)
- `..` traversal (`PATH_TRAVERSAL_REJECTED`)
- resolved escape outside base (`PATH_ESCAPE_REJECTED`)

Used by skill generator/converter and CLI packaging/import paths.
```
**Reason**: LIST 2.9, LIST 2.20.

---

### UPDATE-19: Mark Diagnosis/Learning Wiring Status Correctly
**SSD Section**: `§7.4` and `§7.5`  
**Action**: modify  
**Current text**: described as active integrated runtime behavior  
**New text**:
```md
### 7.4 AI-powered Error Diagnosis

[Partial] Domain models/services exist; runtime/API wiring is incomplete.

### 7.5 Self-learning System

[Planned / Not Yet Implemented] Self-learning runtime exists in codebase but is not currently wired into hub bootstrap/runtime execution path.
```
**Reason**: LIST 1.12.

---

### UPDATE-20: Extend Data Model Coverage for Plugin + v012–v022 Migrations
**SSD Section**: `§10.2 SQLite Schema (DDL)`  
**Action**: add subsection after current DDL block  
**Current text**: no plugin tables; no v012–v022 migration deltas  
**New text**:
```md
#### 10.2.A Post-v007 Migration Delta (Authoritative)

[Implemented] Additional schema evolution present in code migrations:

| Migration | Status | Schema delta |
| --- | --- | --- |
| `v008-plugin-system-foundation` | Implemented | `plugins`, `plugin_dependencies`, `plugin_versions`, `plugin_marketplace_sources`, `plugin_marketplace_cache` |
| `v012-agent-runtime` | Implemented | `friday_agent_runs`, `friday_agent_automations` |
| `v013-subagent-runs` | Implemented | `friday_subagent_runs` |
| `v014-setup-wizard` | Implemented | `friday_setup_state` |
| `v015-xhs-sessions` | Implemented | `xhs_sessions` |
| `v016-xhs-cookie-encryption` | Implemented | `xhs_sessions.cookies_encrypted` + plaintext cookie redaction |
| `v017-agent-run-plan-review` | Implemented | `friday_agent_runs.plan_review_json` |
| `v018-agent-run-actual-execution` | Implemented | `friday_agent_runs.actual_execution_json` |
| `v019-agent-run-events` | Implemented | `friday_agent_run_events` (+ run/seq index) |
| `v020-agent-run-constraints` | Implemented | `friday_agent_runs.constraints_json` |
| `v021-agent-run-response-text-summary` | Implemented | `friday_agent_runs.response_text`, `summary` |
| `v022-agent-run-artifact-dir` | Implemented | `friday_agent_runs.artifact_dir` |
```
**Reason**: LIST 2.10, LIST 2.19.

---

### UPDATE-21: Correct Migration Strategy: Mirror/Freeze Implemented, Adapters/Hooks Planned
**SSD Section**: `§10.3 Migration Strategy from Clawdbot Config`  
**Action**: modify existing adapter/hooks subsections  
**Current text**: adapter classes + hook shim described as active migration components  
**New text**:
```md
**Implemented migration compatibility controls:**

- Compatibility mirror writer (`src/state/mirror/*`) with strict/best-effort mismatch handling and telemetry.
- Legacy write-freeze guard (`src/api/legacy/friday-legacy-write-freeze-guard.ts`).
- Legacy decommission service controls (`src/api/legacy/friday-legacy-decommission-service.ts`).

**Planned / Not Yet Implemented migration adapters/shims:**

- `NodePairingImporter`
- `DevicePairingImporter`
- `MeshPairingImporter`
- legacy hooks compatibility shim (`beforeMessage` / `afterMessage` / `onError`)
```
**Reason**: LIST 1.13, LIST 2.14.

---

### UPDATE-22: Restructure API Reference to Implemented vs Planned (Path/Verb Accurate)
**SSD Section**: `§11.1 REST API Endpoints`  
**Action**: restructure/replace  
**Current text**: includes non-existent routes, wrong verbs, and outdated session/approval contracts  
**New text**:
```md
### 11.1 REST API Endpoints (Implementation Status)

All rows below include status markers.

#### 11.1.1 Auth
- `[Implemented]` `POST /v1/auth/login`
- `[Implemented]` `POST /v1/auth/refresh`
- `[Implemented]` `POST /v1/auth/logout`
- `[Implemented]` `GET /v1/auth/me`

#### 11.1.2 System, Health, Setup
- `[Implemented]` `GET /v1/health` -> `{status, version, uptime}` (public)
- `[Planned / Not Yet Implemented]` `GET /v1/version`
- `[Planned / Not Yet Implemented]` `/v1/config*`
- `[Planned / Not Yet Implemented]` `GET /v1/audit/logs`
- `[Implemented]` setup wizard:
  - `GET /v1/setup/status`
  - `POST /v1/providers/detect`
  - `GET|POST /v1/setup/network`
  - `POST /v1/setup/channels`
  - `POST /v1/setup/complete`

#### 11.1.3 Fleet and Satellites
- `[Implemented]` `GET /v1/fleet/overview`
- `[Implemented]` `GET /v1/fleet/satellites`
- `[Implemented]` `GET /v1/fleet/satellites/:satelliteId`
- `[Planned / Not Yet Implemented]` `/v1/satellites/register`, `/pair/*`, `/sync/*`, `/commands/*`, `/events/poll`

#### 11.1.4 Sessions
- `[Implemented]` `GET|POST /v1/sessions`
- `[Implemented]` `GET /v1/sessions/:sessionKey`
- `[Implemented]` `POST /v1/sessions/:sessionKey/archive`
- `[Implemented]` `POST /v1/sessions/prune`
- `[Implemented]` `POST /v1/sessions/sweep`
- `[Implemented]` `GET|POST /v1/sessions/:sessionKey/messages`
- `[Implemented]` `GET /v1/sessions/:sessionKey/memory-namespace`
- `[Implemented]` `POST /v1/sessions/:sessionKey/fork`
- `[Implemented]` `GET /v1/sessions/:sessionKey/forks`
- `[Implemented]` `POST /v1/sessions/:sessionKey/merge`
- `[Implemented]` `POST /v1/sessions/:sessionKey/memory/extract`
- `[Implemented]` `POST /v1/sessions/:sessionKey/memory/remember`
- `[Implemented]` `GET /v1/sessions/:sessionKey/memory/extraction`
- `[Implemented]` `POST /v1/sessions/memory/extraction/retry`
- `[Planned / Not Yet Implemented]` `PATCH /v1/sessions/:sessionId`, `POST /compact`

#### 11.1.5 Workflows
- `[Implemented]` workflow CRUD + publish + list versions
- `[Implemented]` workflow runs: start/get/nodes/timeline/cancel/retry/resume
- `[Implemented]` workflow builder drafts/locks routes
- `[Implemented]` workflow generator session routes
- `[Implemented]` workflow conflicts routes
- `[Implemented]` workflow trigger routes + webhook invoke route
- `[Planned / Not Yet Implemented]` `GET /v1/workflow-versions/:versionId`
- `[Implemented]` `POST /v1/workflow-runs` without published version => `404 WORKFLOW_NO_PUBLISHED_VERSION`

#### 11.1.6 Skills and Plugins
- `[Implemented]` `GET /v1/skills` (scope: `hub.admin`, minimal registry payload)
- `[Planned / Not Yet Implemented]` skill catalog/install/update/verify marketplace source routes from earlier draft
- `[Implemented]` skill generator session routes
- `[Implemented]` skill converter/import/pack routes
- `[Implemented]` plugin and plugin marketplace routes under `/v1/plugins*` and `/v1/marketplace/plugins*`

#### 11.1.7 Providers, Routing, Usage, OAuth
- `[Implemented]` provider CRUD (`GET/POST/PATCH/DELETE /v1/providers*`)
- `[Implemented]` `POST /v1/providers/:providerId/validate`
- `[Implemented]` `GET|PUT /v1/model-routing`
- `[Implemented]` usage/budget routes under `/v1/providers/usage` and `/v1/providers/budget`
- `[Implemented]` Anthropic OAuth initiate/callback routes
- `[Planned / Not Yet Implemented]` `/v1/models`, `/v1/ai/route`, `/v1/ai/diagnose`, `/v1/ai/lessons`

#### 11.1.8 Approvals
- `[Implemented]` `/v1/workflow-approvals*`
- `[Planned / Not Yet Implemented]` `/v1/approvals*` alias path

#### 11.1.9 Memory, Security, Realtime, Agent
- `[Implemented]` memory routes under `/v1/memory/*`
- `[Implemented]` security center/revoke routes under `/v1/security/*`
- `[Implemented]` realtime REST pull/ack routes under `/v1/realtime/*`
- `[Implemented]` agent run/automation routes under `/v1/agent/*`
- `[Implemented]` subagent inspection routes
- `[Planned / Not Yet Implemented]` secrets CRUD routes `/v1/secrets*`
```
**Reason**: LIST 1.1–1.7, LIST 2.1–2.8, 2.10–2.13, 2.15, LIST 3.2, 3.3, 3.5, 3.6, 3.10, 3.15, 3.16.

---

### UPDATE-23: Replace WS Event Catalog with Actual Realtime Transport Catalog
**SSD Section**: `§11.2 WebSocket Event Catalog`  
**Action**: replace  
**Current text**: WS catalog treated as active transport  
**New text**:
```md
### 11.2 Realtime Transport Catalog

#### REST Realtime (`/v1/realtime/*`) [Implemented]
- `POST /v1/realtime/subscriptions`
- `POST /v1/realtime/pull`
- `POST /v1/realtime/ack`

Event families currently modeled include:
- workflow (`workflow.updated`, `workflow.run.*`, `workflow.node.*`)
- workflow conflicts
- satellite/fleet
- security revocation

#### Agent SSE [Implemented]
- `GET /v1/agent/runs/:runId/events`
- emitted event types include:
  `agent.run.started`, `agent.run.planning`, `agent.run.executing`,
  `agent.run.tool_start`, `agent.run.tool_end`,
  `agent.run.completed`, `agent.run.failed`, `agent.run.cancelled`,
  `agent.subagent.spawned`, `agent.subagent.completed`

#### WebSocket [Planned / Not Yet Implemented]
- WS frame types are defined in contracts, but `/v1/ws` is not active in HTTP transport.
```
**Reason**: LIST 1.3, LIST 2.3, LIST 3.4.

---

### UPDATE-24: Align Error Code and Validation Contract to Actual Runtime
**SSD Section**: `§11.3 Error Codes and Handling` and validation notes in `§11.1.5`  
**Action**: replace/modify  
**Current text**: canonical `AUTH_UNAUTHORIZED`, `CONFIG_VALIDATION_FAILED`/422 as default  
**New text**:
```md
### 11.3 Error Codes and Handling

[Implemented] Common API-layer codes currently emitted:
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `RATE_LIMITED` (429)
- `VALIDATION_ERROR` (400)
- `NOT_FOUND` (404)
- `INTERNAL_ERROR` (500)
- route/domain specific codes (examples):
  `WORKFLOW_NOT_FOUND`, `WORKFLOW_NO_PUBLISHED_VERSION`,
  `PROVIDER_NOT_FOUND`, `STREAM_NOT_AUTHORIZED`,
  `CURSOR_INVALID`, `AGENT_RUN_NOT_FOUND`

Validation behavior:
- `[Implemented]` most schema/input validation failures return `400 VALIDATION_ERROR`.
- `[Planned / Not Yet Implemented]` strict config-specific `422 CONFIG_VALIDATION_FAILED` contract for all validation paths.
```
**Reason**: LIST 3.9, LIST 3.10.

---

### UPDATE-25: Replace Background Task Section with Actual Job Modules
**SSD Section**: `§13.4 Background Task Management`  
**Action**: replace  
**Current text**: generic workers (`queue redelivery`, `lease reaper`, etc.)  
**New text**:
```md
### 13.4 Background Task Management

[Implemented] Job modules currently present in `src/jobs/*`:
- retention cleanup job
- workflow timeout/reap job
- session lifecycle sweep job
- session memory extraction worker
- marketplace sync job
- approval expiry job
- learning metrics aggregation job

[Partial] Job orchestration/scheduling is module-based; full centralized scheduler wiring is not yet documented as a single runtime subsystem.
```
**Reason**: LIST 2.15.

---

If you want, next step can be a patch-ready edit script (section-by-section) to apply these updates directly to `docs/distributed-architecture.md` in order.
