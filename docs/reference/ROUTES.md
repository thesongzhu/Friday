> Status: Current reference. For active product truth and operational boundaries, start with [`docs/current-source-of-truth.md`](../current-source-of-truth.md).

# Friday Route Map (Function-Level)

每条 route 都包含：Trigger / Pipeline / Tool Boundary / State / Output Boundary / Observability / Failure Points。

## R1. Agent Run (API) -> LLM Loop -> Tool Execution -> User Response

- Trigger
  - `POST /v1/agent/runs` (`createFridayAgentRoutes`, `src/api/http/routes/friday-agent-routes.ts:75`)
- Pipeline
  1. Route validation + `deps.startRun(...)` (`friday-agent-routes.ts:85-160`)
  2. API runtime `startRun` bridges to runtime (`src/api/runtime/friday-api-runtime.ts:1346-1360`)
  3. Runtime core loop `executeRun` (`src/agent/runtime/friday-agent-runtime.ts:148`)
  4. For each model `tool_use`, dispatch `executeToolCall` (`friday-agent-runtime.ts:655-664`, `1507-1631`)
  5. Persist terminal state + return response/images (`friday-agent-runtime.ts:822-958`)
- Tool Boundary
  - Enters at `executeToolCall` (`friday-agent-runtime.ts:1507`)
- State
  - Run record create/update in agent run repository (`friday-agent-runtime.ts:167-179` and updates in same file)
  - Session-linked history via `sessionKey`
- Output Boundary
  - API JSON envelope includes run result
- Observability
  - `agent.run.*` events (`emitRunEvent` path in runtime)
- Failure Points
  - invalid input -> `VALIDATION_ERROR`
  - run timeout/abort
  - unknown/blocked tool, tool runtime error

## R2. No-Tool Guard Route (External task must use evidence tools)

- Trigger
  - LLM returns `toolUseBlocks.length === 0` in runtime loop
- Pipeline
  1. `enforceToolEvidenceForCompletionClaim(...)` (`src/agent/runtime/friday-agent-runtime.ts:1112-1122`)
  2. `enforceFeedbackPersistenceEvidence(...)` (`1124-1134`)
  3. `shouldEnforceToolEvidenceForTask(...)` decides re-prompt (`1186-1204`)
  4. inject "System verification" message and continue loop (`471-505`)
- Tool Boundary
  - No external tool call in first turn; route forces a second attempt with tools
- State
  - same runId/sessionKey; extra user verification turn appended to in-memory message list
- Output Boundary
  - Either tool-backed response, or explicit unverified note
- Observability
  - same run event stream; additional iteration events visible
- Failure Points
  - if tools unavailable/disabled, guard degrades to explicit unverified text

## R3. `web_fetch` Failure -> Auto Browser Fallback (recoverable only)

- Trigger
  - Tool call `web_fetch` returns error
- Pipeline
  1. `executeToolCall` executes `web_fetch` (`src/agent/runtime/friday-agent-runtime.ts:1570-1576`)
  2. On error result, call `maybeFallbackWebFetchWithBrowser(...)` (`1576-1586`, `1643-1781`)
  3. Fallback steps: browser `open` then `snapshot` with `agent.run.tool_start/tool_end` events (`1659-1764`)
  4. Security gating in `shouldAttemptWebFetchBrowserFallback(...)` (`1783-1797`)
- Tool Boundary
  - `web_fetch` (`src/agent/tools/friday-agent-web-fetch-tool.ts:64`) and `browser` tool boundary
- State
  - Same tool call record for primary `web_fetch`; fallback events use derived call ids
- Output Boundary
  - Caller gets merged result text (includes fallback tag + snapshot output)
- Observability
  - explicit fallback tool start/end events
- Failure Points
  - no browser tool available
  - browser open/snapshot error
  - SSRF/security block (fallback intentionally skipped)

## R4. SSRF-Safe Web Fetch

- Trigger
  - `web_fetch` tool invocation with URL
- Pipeline
  1. Parse/validate args in `createFridayAgentWebFetchTool.execute` (`src/agent/tools/friday-agent-web-fetch-tool.ts:92-105`)
  2. Use `fetchWithFridayAgentSsrfGuard(...)` when guard configured (`133-137`)
  3. Redirect-by-redirect DNS revalidation (`src/agent/security/friday-agent-fetch-guard.ts:41-109`)
  4. Protocol/hostname/private-IP checks (`src/agent/security/friday-agent-ssrf-guard.ts:492-567`)
- Tool Boundary
  - DNS + HTTP fetch
- State
  - Stateless per call; failure returned as tool result
- Output Boundary
  - Tool result text includes HTTP summary or explicit blocked reason
- Observability
  - Tool result captured in run history + `tool_end` summary
- Failure Points
  - blocked protocol/hostname/private IP
  - DNS failure / redirect loop / too many redirects

## R5. Workflow Run -> Timeline

- Trigger
  - `POST /v1/workflow-runs`, then `GET /v1/workflow-runs/:runId/timeline`
- Pipeline
  1. Route validation (`src/api/http/routes/friday-workflow-run-routes.ts:98-124`)
  2. API runtime bridge to execution service `startRun(...)` (`src/api/runtime/friday-api-runtime.ts:688-713`)
  3. Execution service creates run and non-blocking `executeRun(plan).catch(...)` (`src/workflows/services/friday-workflow-execution-service.ts:819-963`)
  4. Timeline route reads event envelopes (`src/api/runtime/friday-api-runtime.ts:726-748`)
- Tool Boundary
  - Workflow nodes may call external integrations/tools
- State
  - run/node/event persisted in workflow repositories
- Output Boundary
  - timeline JSON entries (`seq/event/status/payload`)
- Observability
  - async crash codes `E-WF-RUN-ASYNC-001..004`
- Failure Points
  - workflow/version missing, permission denied, async execution error

## R6. Workflow Evidence Export/Download

- Trigger
  - `POST /v1/workflow-runs/:runId/evidence/exports`
  - `GET /v1/workflow-runs/:runId/evidence/exports/:exportId/download`
- Pipeline
  1. Run route definitions (`src/api/http/routes/friday-workflow-run-routes.ts:167-208`)
  2. API runtime bridge (`src/api/runtime/friday-api-runtime.ts:756-789`)
  3. Runtime export writes artifact row + export row + JSON file (`src/workflows/runtime/friday-workflow-runtime.ts:1610-1672`)
  4. Download prefers file, falls back to JSON body (`1733-1762`)
- Tool Boundary
  - File system write/read (`.friday/artifacts/workflow-evidence/...`)
- State
  - DB tables for artifacts/evidence exports + optional file URI
- Output Boundary
  - download response includes `content` + `file.exists/path/sizeBytes`
- Observability
  - checksums + export metadata
- Failure Points
  - missing export -> `WORKFLOW_RUN_EVIDENCE_EXPORT_NOT_FOUND`
  - persistence failure -> fallback URI/content

## R7. Scheduler -> Automation -> Agent Run

- Trigger
  - automation with cron schedule
- Pipeline
  1. Hub attaches scheduler bridge (`src/hub/friday-hub-bootstrap.ts:1691-1751`)
  2. Scheduler registers dynamic job (`1727-1749`)
  3. Job run calls `automationService.run` and validates terminal status (`1739-1746`)
  4. scheduler core handles timeout/backoff/catch-up (`src/jobs/scheduler/friday-job-scheduler-service.ts:154-308`)
- Tool Boundary
  - timer scheduler + agent runtime call
- State
  - scheduler repo `last_status/last_error/next_run_at`
- Output Boundary
  - visible through automation/run APIs and scheduler persisted state
- Observability
  - explicit error token `[E-SCHED-AUTOMATION-RUN-FAILED]`
- Failure Points
  - cron parse invalid, job timeout, run non-completed terminal

## R8. Webchat/Discord Inbound -> Agent -> Outbound Delivery

- Trigger
  - webchat WS `message` frame or discord `MESSAGE_CREATE`
- Pipeline
  1. WS upgrade routing (`src/api/http/friday-http-server.ts:854-877`)
  2. webchat frame parsing + normalize (`src/channels/webchat/webchat-service.ts:201-367`, `src/channels/webchat/friday-webchat-channel.ts:31-47`)
  3. discord normalize + outbound adapter (`src/channels/discord/friday-discord-channel.ts:81-125`, `194-248`)
  4. hub channel handler executes run and composes terminal text/images (`src/hub/friday-hub-bootstrap.ts:1992-2166`)
  5. outbound primary send to channel adapter (`2160-2167`)
  6. if primary send fails: structured audit log + session fallback persistence + outbound retry (`2168-2206`)
- Tool Boundary
  - channel transport APIs + optional file reads for attachments
- State
  - session mirror/history + run state + audit jsonl
- Output Boundary
  - user sees channel message (success/failure/cancel) and attachments; on send failure sees fallback text carrying error code + run query path
- Observability
  - warning/error codes: `W-CH-SESSION-MIRROR-001`, `W-CH-HISTORY-001`, `E-CH-RUN-001`, `E-CH-OUTBOUND-001`, `E-CH-OUTBOUND-RETRY-001`
  - `audit.jsonl` details include `routeId/toolName?/runId?/correlationId/channelCorrelationId`
- Failure Points
  - session mirror/history errors
  - run execution errors
  - outbound transport primary failure (retry path)
  - outbound transport retry failure (falls back to persisted session message + audit)

## R9. Setup Provider Detect + Observability Fallback Message

- Trigger
  - `POST /v1/providers/detect`
  - `GET /v1/observability/*` (when not wired)
- Pipeline
  1. Provider detect validation and probing (`src/api/http/routes/friday-setup-routes.ts:440-599`)
  2. observability routes optional registration (`src/api/runtime/friday-api-runtime.ts:1021-1026`)
  3. unmatched observability path fallback message (`src/api/http/friday-http-server.ts:458-467`)
- Tool Boundary
  - provider HTTP endpoints
- State
  - setup/provider config state in DB
- Output Boundary
  - detect result JSON or explicit validation/unreachable error
  - explicit not-enabled message instead of generic 404
- Observability
  - error code + requestId in envelope
- Failure Points
  - missing api key/kind/baseUrl, provider unreachable, observability not enabled

## R10. Skills Discovery -> /v1/skills

- Trigger
  - startup initialize and `GET /v1/skills`
- Pipeline
  1. registry init/refresh (`src/skills/registry/friday-skill-registry.ts:27-30,153-233`)
  2. root resolution and candidate scan (`src/skills/registry/friday-skill-discovery.ts:19-123`)
  3. route output (`src/api/http/routes/friday-skill-routes.ts:18-38`)
- Tool Boundary
  - filesystem scan and manifest loading
- State
  - registry memory + discovered snapshot persistence
- Output Boundary
  - skills list JSON to user
- Observability
  - reload failure audit log (`SKILL_RELOAD_FAILED`)
- Failure Points
  - invalid manifest/trust rejection/permissions on directories
