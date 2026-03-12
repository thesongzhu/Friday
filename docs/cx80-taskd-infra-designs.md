# Task D — 7 Infrastructure Module Designs (CX80)

## MODULE 1: HEARTBEAT
**OpenClaw ref:** `src/infra/heartbeat-runner.ts`, `heartbeat-wake.ts`, `heartbeat-events.ts`, `heartbeat-active-hours.ts`, `heartbeat-visibility.ts`
**Purpose:** Periodic proactive checks (idle-time pings, reminder checks, "anything urgent?" polling). Only notify when action needed.
**Key interfaces:** `FridayHeartbeatConfig`, `FridayHeartbeatRunner`, `FridayHeartbeatRunRecord`, `FridayHeartbeatStateRepository`, `FridayHeartbeatRunResult`
**Core logic:** Scheduler job triggers heartbeat → runner enforces active-hours/quiet-hours/cooldown → reads prompt (HEARTBEAT.md fallback) → runs agentRuntime.executeRun → HEARTBEAT_OK = no-op → routes actionable output → persists run outcome + emits diagnostics event
**Integration:** job scheduler, hub bootstrap, session service, agent runtime, realtime event bus, config
**New files:** `src/heartbeat/friday-heartbeat.types.ts`, `friday-heartbeat-active-hours.ts`, `friday-heartbeat-state-repository.ts`, `friday-heartbeat-runner.ts`, `friday-heartbeat-job.ts`, `index.ts`, migration `v029-heartbeat-runner-state.ts`
**Modified:** hub bootstrap, jobs index, config types/schema, realtime types, migrations index

## MODULE 2: DAEMON MODE
**OpenClaw ref:** `src/daemon/service.ts`, `service-runtime.ts`, `runtime-paths.ts`, `inspect.ts`, `launchd.ts`, `systemd.ts`
**Purpose:** Run Friday as background service with PID ownership, robust shutdown, operational commands (start/stop/restart/status)
**Key interfaces:** `FridayDaemonService`, `FridayDaemonStatus`, `FridayDaemonRuntimePaths`, `FridayDaemonPidRecord`
**Core logic:** `daemon start` spawns detached child, writes PID + log paths → signal handlers for graceful close + PID cleanup → `stop` sends SIGTERM then SIGKILL → `status` validates stale PID vs live process
**Integration:** CLI, run loop, state dir resolver, config
**New files:** `src/daemon/friday-daemon.types.ts`, `friday-daemon-paths.ts`, `friday-daemon-pidfile.ts`, `friday-daemon-service.ts`, `index.ts`, `src/cli/friday-cli-daemon.ts`
**Modified:** CLI, run loop, CLI index, config types/schema

## MODULE 3: MEDIA UNDERSTANDING
**OpenClaw ref:** `src/media-understanding/index.ts`, `types.ts`, `attachments.ts`, `resolve.ts`, `runner.ts`, `apply.ts`, `format.ts`, `providers/`
**Purpose:** Auto-extract context from inbound image/audio/video attachments before agent reasoning
**Key interfaces:** `FridayMediaAttachment`, `FridayMediaUnderstandingConfig`, `FridayMediaUnderstandingProvider`, `FridayMediaUnderstandingOutput`, `FridayMediaUnderstandingDecision`
**Core logic:** Build attachment list from channel message → apply scope/size/mime policy → resolve source → run provider chain (image/audio/video) with bounded concurrency → format enrichment block → append to task input → keep decision trace
**Integration:** inbound channel pipeline, provider routing, SSRF guard, channel normalizers
**New files:** `src/media-understanding/friday-media-understanding.types.ts`, `attachments.ts`, `providers.ts`, `format.ts`, `service.ts`, `index.ts`
**Modified:** hub bootstrap, channel types, channel index, discord/slack/telegram/whatsapp/signal channels, config types/schema

## MODULE 4: LINK UNDERSTANDING
**OpenClaw ref:** `src/link-understanding/index.ts`, `detect.ts`, `runner.ts`, `apply.ts`, `format.ts`, `defaults.ts`
**Purpose:** Detect links in inbound text, fetch safely, inject concise summaries into agent context
**Key interfaces:** `FridayLinkUnderstandingConfig`, `FridayLinkCandidate`, `FridayLinkSummary`, `FridayLinkUnderstandingService`, `FridayLinkCacheRepository`
**Core logic:** Extract/dedupe URLs → SSRF guard → fetch with redirect limits → parse title/body → summarize with model → cache → append to task text
**Integration:** inbound handling, SSRF utils, provider service, job scheduler (cache eviction)
**New files:** `src/link-understanding/friday-link-understanding.types.ts`, `detect.ts`, `fetch.ts`, `summarize.ts`, `cache-repository.ts`, `service.ts`, `index.ts`, migration `v030-link-understanding-cache.ts`
**Modified:** hub bootstrap, config types/schema, migrations index

## MODULE 5: PAIRING
**OpenClaw ref:** `src/pairing/pairing-store.ts`, `pairing-messages.ts`, `src/infra/device-pairing.ts`, `node-pairing.ts`, `pairing-token.ts`
**Purpose:** Complete device/node pairing + auth flow by wiring existing satellite services into runtime/API/ops
**Key interfaces:** `FridaySatelliteRegistrationService` (existing), `FridaySatellitePairingService` (existing), new API DTOs, route deps
**Core logic:** Wire satellite runtime in hub → expose registration/pending/approve/reject/handshake/revoke routes → token version checks → schedule offline sweep + pairing expiry maintenance
**Integration:** hub bootstrap, API runtime, security routes, satellite runtime, realtime event bus
**New files:** `src/api/model/friday-api-pairing.types.ts`, `src/api/http/routes/friday-satellite-pairing-routes.ts`, `src/jobs/satellites/friday-satellite-offline-sweep-job.ts`, `friday-satellite-pairing-expiry-job.ts`, `src/nodes/friday-satellite-nodes-service.ts`
**Modified:** hub bootstrap, API runtime types, API runtime, security routes, API security types, jobs index

## MODULE 6: CLI TUI
**OpenClaw ref:** `src/cli/tui-cli.ts`, `src/tui/tui.ts`, `tui-types.ts`, `gateway-chat.ts`, `tui-command-handlers.ts`, `tui-event-handlers.ts`
**Purpose:** Interactive terminal UI for operations (status, sessions, jobs, pairing, live events, quick actions)
**Key interfaces:** `FridayTuiState`, `FridayTuiApiClient`, `FridayTuiRenderer`, `FridayTuiController`, `FridayTuiCommandHandler`
**Core logic:** `friday tui` starts terminal app (readline/ANSI) → pulls hub status → subscribes to realtime events → screen switching → action commands (approve pairing, trigger heartbeat, inspect sessions/jobs, tail runs)
**Integration:** CLI, existing API routes (agent/session/fleet/security/realtime), daemon endpoints, heartbeat/pairing endpoints
**New files:** `src/tui/friday-tui.types.ts`, `friday-tui-api-client.ts`, `friday-tui-renderer.ts`, `friday-tui-controller.ts`, `index.ts`, `src/cli/friday-cli-tui.ts`
**Modified:** CLI, CLI index

## MODULE 7: AUTO-REPLY ROUTING
**OpenClaw ref:** `src/auto-reply/reply/route-reply.ts`, `dispatch-from-config.ts`, `followup-runner.ts`, `session.ts`, `reply-payloads.ts`, `queue/types.ts`, `queue/drain.ts`
**Purpose:** Ensure replies always reach correct originating channel/chat/thread, including async/follow-up flows
**Key interfaces:** `FridayReplyRouteContext`, `FridayReplyRoutingService`, `FridayReplyRouteRepository`, `FridayQueuedReply`, `FridayReplyDeliveryResult`
**Core logic:** Capture inbound route context per session → on outbound resolve best destination (explicit override > session route > fallback) → enforce session send policy (allow/block/queue) → queue undeliverable → scheduler drains retry queue
**Integration:** hub bootstrap inbound/outbound path, session service send-policy, channel registry delivery, scheduler for queue drain
**New files:** `src/routing/friday-reply-routing.types.ts`, `friday-reply-route-repository.ts`, `friday-reply-queue-repository.ts`, `friday-reply-routing-service.ts`, `friday-reply-queue-job.ts`, `index.ts`, migration `v031-session-reply-routing.ts`
**Modified:** hub bootstrap, session service types, session service, jobs index, migrations index
