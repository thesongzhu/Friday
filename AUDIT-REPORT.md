# Friday Full Code Audit Report

**Date:** 2026-04-15
**Auditor:** Claude Opus 4.6 (automated)
**Branch:** audit/full-code-review (based on 3a4e130)
**Method:** Line-by-line source code review + live API testing with real credentials
**Test Results:** 742 test files, 10,016 tests passing, 122 skipped

---

## Executive Summary

Friday is a large AI automation platform (~47 modules under `src/`, ~5,658 lines in hub bootstrap alone). The core agent runtime, provider system, workflow engine, and session management are **functionally wired and operational**. However, there are **significant gaps** where features are defined in code but not connected, routes exist but aren't registered, and subsystems are partially implemented.

---

## Category 1: API Routes Defined but NOT Registered (Dead Routes)

These route files exist in `src/api/http/routes/` and are imported, but many endpoints within them return `NOT_FOUND` at runtime, indicating conditional registration that doesn't fire or missing dependency injection.

| Endpoint | Status | Root Cause |
|----------|--------|------------|
| `GET /v1/agent/capabilities` | NOT_FOUND | Route not registered |
| `POST /v1/agent/self-test` | NOT_FOUND | Route not registered |
| `POST /v1/skills/generate` | NOT_FOUND | Skill generator routes not registered |
| `POST /v1/workflows/generate` | NOT_FOUND | Workflow generator routes conditional, not fired |
| `GET /v1/observability/metrics` | NOT_FOUND | Only overview + alerts registered, not metrics |
| `GET /v1/diagnosis/self-healing/incidents` | NOT_FOUND | Self-healing routes conditional |
| `GET /v1/diagnosis/preferences` | NOT_FOUND | Not registered |
| `GET /v1/desktop/status` | NOT_FOUND | Desktop routes conditional on `deps.desktop` |
| `POST /v1/auth/webauthn/register/options` | NOT_FOUND | WebAuthn routes never registered |
| `GET /v1/fleet` | NOT_FOUND | Fleet routes conditional |
| `GET /v1/scan-migrate/status` | NOT_FOUND | Scan-migrate routes not registered |
| `GET /v1/uix/guided-flow` | NOT_FOUND | UIX guided flow route missing |
| `GET /v1/uix/onboarding/status` | NOT_FOUND | Onboarding route missing |
| `GET /v1/uix/communication-persona` | NOT_FOUND | Communication persona route missing |
| `POST /v1/setup/assistant/ask` | NOT_FOUND | Setup assistant route missing |
| `POST /v1/providers/:id/test-connection` | NOT_FOUND | Provider test-connection route missing |
| `GET /v1/marketplace/request-board` | NOT_FOUND | Marketplace request board not registered |
| `GET /v1/heartbeat/status` | NOT_FOUND | Heartbeat status route missing |
| `GET /v1/browser/status` | NOT_FOUND | Browser status route missing |
| `GET /v1/jobs` | NOT_FOUND | Job scheduler routes not exposed |
| `GET /v1/satellites` | NOT_FOUND | Satellite list route missing |
| `POST /v1/workflows/:id/run` | NOT_FOUND | Workflow direct run route missing |
| `GET /v1/workflow-runs` | NOT_FOUND | Workflow run listing route missing |
| `GET /v1/system/status` | NOT_FOUND | System status route missing |
| `GET /v1/mcp` | NOT_FOUND | MCP route missing |
| `GET /v1/converters` | NOT_FOUND | Converter routes not registered |
| `GET /v1/xhs/status` | NOT_FOUND | XHS routes not registered |
| `GET /v1/realtime/info` | NOT_FOUND | Realtime info route missing |
| `GET /v1/uix/cross-channel/identity` | NOT_FOUND | Cross-channel identity route missing |
| `GET /v1/packs/cross-border/workflow-presets` | NOT_FOUND | Workflow presets GET missing (only POST) |

**Impact:** UI pages that reference these endpoints will show errors or empty states. Many features advertised in the UI sidebar have no functional backend.

### Additional Route Collision Bugs (Critical)
Three endpoints suffer from **route collision** where sub-resource paths are swallowed by `/:id` parameter routes:
- `GET /v1/providers/routing` - "routing" interpreted as a provider ID, returns PROVIDER_NOT_FOUND
- `GET /v1/plugins/marketplace` - "marketplace" interpreted as a plugin ID, returns PLUGIN_NOT_FOUND
- `GET /v1/channels/installed` - "installed" interpreted as a channel ID, returns CHANNEL_NOT_FOUND

### Additional Missing Endpoints (Confirmed by Live Testing)
- `POST /v1/auth/logout` - Cannot invalidate tokens
- `DELETE /v1/sessions/:id` - Cannot delete sessions
- `POST /v1/memory/items` - Cannot create memory items via API (only auto-extracted)
- `GET /v1/rules` - Entire rules API missing despite `rules.read`/`rules.write` scopes in auth tokens
- `POST /v1/agent/stream` - No SSE streaming endpoint (events only available via `GET /v1/agent/runs/:id/events` after completion)

### Auth Token Scope Mismatch
Auth tokens include scopes for non-existent endpoints: `rules.read`, `rules.write`, `fleet.read`, `security.read`, `security.write`, `diagnosis.read`, `diagnosis.write`, `retry.read`, `playbook.read`, `playbook.write`, `acceptance.read`

---

## Category 2: Subsystems with Partial/Shallow Implementation

### 2.1 Desktop Runtime
- **Status:** Enabled but non-functional for screenshots
- **Evidence:** Agent runs with `desktop` tool complete, but screenshot operations fail
- **Root Cause:** Desktop adapter reports "23 capabilities, 1/4 permissions granted" - only partial macOS accessibility permissions
- **File:** `src/desktop/engine/` - platform adapter is real code but requires system-level permissions that aren't guided by setup

### 2.2 XHS (XiaoHongShu) Integration
- **Status:** Code exists (`src/xhs/`), imported in hub bootstrap, but no API routes registered
- **Evidence:** `GET /v1/xhs/status` returns NOT_FOUND
- **Root Cause:** XHS session manager and page interactions are created in bootstrap but no routes expose them
- **Files:** `src/xhs/friday-xhs-session-manager.ts`, `src/xhs/friday-xhs-page-interactions.ts`

### 2.3 Skill Generator
- **Status:** Service exists (`src/skills/generator/`), imported in hub bootstrap, but routes not always registered
- **Evidence:** `POST /v1/skills/generate` returns NOT_FOUND
- **Root Cause:** `createFridaySkillGeneratorRoutes` is imported but registration is conditional on deps

### 2.4 Workflow Generator
- **Status:** Service + routes exist (`src/api/http/routes/friday-workflow-generator-routes.ts`), but only session-based routes work
- **Evidence:** `POST /v1/workflows/generate` returns NOT_FOUND
- **Root Cause:** The route path is `/v1/workflows/generator/sessions` not `/v1/workflows/generate`

### 2.5 Heartbeat System
- **Status:** Code exists (`src/heartbeat/`), heartbeat job created in bootstrap
- **Evidence:** No API endpoint to check heartbeat status
- **Root Cause:** Heartbeat runs as a background job but has no observability surface

### 2.6 WebAuthn/FIDO2 Security
- **Status:** Security code exists (`src/security/`) with full WebAuthn implementation
- **Evidence:** WebAuthn routes return NOT_FOUND
- **Root Cause:** WebAuthn routes are never registered in the API runtime

### 2.7 Cross-Channel Identity
- **Status:** Configuration exists (`FRIDAY_CROSS_CHANNEL_IDENTITY_ENABLED`, identity map parsing)
- **Evidence:** No API endpoint to manage cross-channel identity
- **Root Cause:** Identity map is parsed in bootstrap but no routes expose the mapping management

### 2.8 Onboarding Engine
- **Status:** `createOnboardingEngine` called in bootstrap
- **Evidence:** No onboarding status/flow API endpoints
- **Root Cause:** Onboarding engine is created but never exposed via API routes

### 2.9 Communication Persona
- **Status:** `resolveFridayCommunicationPersona` and `buildFridayCommunicationPromptFragment` called in bootstrap
- **Evidence:** No API endpoint to get/set persona
- **Root Cause:** Persona is computed internally but not exposed

### 2.10 Scan-Migrate Routes
- **Status:** `createFridayScanMigrateRoutes` imported
- **Evidence:** Routes return NOT_FOUND
- **Root Cause:** Import exists but registration may be conditional or missing

---

## Category 3: Configuration & Environment Issues

### 3.1 Missing/Unused Environment Variables
| Env Var | Status |
|---------|--------|
| `FRIDAY_SEARCH_PROVIDER` | Documented but not set - falls back to DuckDuckGo HTML scraping |
| `FRIDAY_SERPER_API_KEY` | Documented but unused without search provider config |
| `FRIDAY_TAVILY_API_KEY` | Documented but unused without search provider config |
| `FRIDAY_HEARTBEAT_INTERVAL_MS` | Documented, used in code |
| `FRIDAY_HEARTBEAT_COOLDOWN_MS` | Documented, used in code |
| `FRIDAY_PLUGIN_MARKETPLACE_BASE_URL` | Documented but marketplace is local-only |
| `FRIDAY_CROSS_CHANNEL_IDENTITY_ENABLED` | Documented but mechanism is shallow |
| `FRIDAY_CHANNEL_IDENTITY_MAP` | Documented but no API to manage |
| `FRIDAY_AGENT_REVIEW_MODE` | Documented, wired, functional |

### 3.2 Security Warning at Startup
- Server creates default admin user with **NO password** (password_hash = NULL)
- Warning logged but setup wizard may not enforce password creation
- `FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN` defaults to true in non-production mode

---

## Category 4: Provider & Routing Issues

### 4.1 Provider Routing Fragility
- **Issue:** Default provider has no fallback providers configured
- **Warning:** `W-PROVIDER-ROUTING-001` logged at startup
- **Impact:** If default provider fails, all agent runs fail
- **Evidence:** Server log: "Live runs may fail hard if the default provider is temporarily unavailable"

### 4.2 Provider Routing API Mismatch
- `PUT /v1/providers/routing` returns NOT_FOUND (expects PATCH)
- `GET /v1/providers/routing` returns PROVIDER_NOT_FOUND when provider UUID doesn't match
- No route for `POST /v1/providers/:id/test-connection`

### 4.3 Auto-Detection but No Validation
- Auto-detect from env vars creates providers with `validateOnSave: false`
- Broken API keys are silently registered
- Provider validation status field exists but isn't surfaced prominently

---

## Category 5: Skills System Issues

### 5.1 No Skill Execution API
- Skills can be listed via `GET /v1/skills`
- No route exists to run a skill directly via API (`POST /v1/skills/:id/run` or `/execute`)
- Skills are only runnable through agent runs or CLI
- **Impact:** 96 skills loaded but only accessible indirectly

### 5.2 Community Skills
- `GET /v1/skills/community` returns SKILL_NOT_FOUND
- Community skill catalog exists in code (`friday-community-skill-catalog.ts`)
- Route not registered or differently pathed

### 5.3 Skill Content Route
- `GET /v1/skills/:id/content` - route defined but may not be functional for all skill types

---

## Category 6: Workflow Engine Issues

### 6.1 No Direct Workflow Run API
- `POST /v1/workflows/:id/run` returns NOT_FOUND
- Workflows can be created and versioned but direct API execution is missing
- Workflow runs happen through triggers (cron, webhook) or agent orchestration

### 6.2 Workflow Trigger Routes
- Trigger enable/disable routes are registered inline (not via route file)
- Cron trigger job exists but trigger management API is partially exposed

---

## Category 7: UI vs Backend Mismatches

Based on the UI build output, these pages exist in the UI but their backend support is limited:

| UI Page | Backend Support |
|---------|----------------|
| `fleet-page` | Fleet routes conditional, may not be registered |
| `guided-flow-page` | No guided flow API endpoints |
| `marketplace-page` | Commerce routes exist but request board missing |
| `observability-page` | Only overview + alerts, no metrics |
| `settings-page` | Settings work through UIX preferences |
| `setup-page` | Setup status works, but assistant route missing |
| `channels-page` | Channel list works but returns empty (no channels configured) |
| `cross-border-pack-setup-page` | Profile endpoint works, but workflow presets GET missing |

---

## Category 8: Companion Apps (Dead Code)

### 8.1 macOS Companion (`apps/macos/FridayCompanion/`)
- Full Swift package with hotkey, notification, and Unix socket server
- **Status:** Never connected to main system at runtime
- No build automation completes the loop from code to installed app
- Bridge code in `src/system/` creates companion bridges but connection requires manual setup

### 8.2 Linux Companion (`apps/linux/FridayCompanion/`)
- Rust project with `Cargo.toml`
- **Status:** Minimal implementation, likely a placeholder

### 8.3 Windows Companion (`apps/windows/FridayCompanion/`)
- C# project
- **Status:** Minimal implementation, likely a placeholder

---

## Category 9: Test Coverage Gaps

- 742 test files, 10,016 tests (all passing)
- 100 E2E tests + 10 real journey tests + 4 cloud journey tests are **skipped**
- No integration tests for:
  - Desktop automation
  - XHS integration
  - Channel bridges (Discord, Telegram, etc.)
  - Plugin marketplace
  - WebAuthn flow
  - Companion app connectivity

---

## Category 10: Other Issues Found

### 10.1 Stub Services in Production
- `configManager` uses `createStubConfigManager()` - config mutations are silently no-ops
- `memoryState` uses `createStubMemoryState()` - planned for multi-node milestone
- These are documented as intentional for v0.4.x standalone mode

### 10.2 Plugin Marketplace Not Connected
- `FRIDAY_PLUGIN_MARKETPLACE_BASE_URL` exists but marketplace is local
- Plugin marketplace search (`/v1/plugins/marketplace?q=hello`) returns PLUGIN_NOT_FOUND
- Plugin signature verifier exists but no external marketplace to verify against

### 10.3 Satellite System Partial
- Satellite pairing routes exist in code
- `GET /v1/satellites` returns NOT_FOUND
- Satellite runtime exists but pairing API not registered

### 10.4 Daemon System
- Daemon start/stop/restart works via CLI
- No API endpoint to manage daemon remotely

### 10.5 Memory Service
- Memory items API works and returns real data
- Memory extraction from sessions is wired
- Pattern extraction functional (temporal patterns detected)

### 10.6 Learning System
- Learning overview API works
- Patterns are being extracted
- But `diagnosis/self-healing/incidents` route missing

---

## Working Features (Confirmed via Live Testing)

| Feature | Status | Notes |
|---------|--------|-------|
| Auth (login/refresh/me) | Working | Local bypass + JWT |
| Provider management | Working | CRUD, 10 providers registered |
| Agent runs | Working | Task execution with LLM |
| Agent streaming (SSE) | Working | Event replay functional |
| Agent web_search tool | Working | Falls back to DuckDuckGo |
| Agent browser tool | Working | Opens pages, extracts content |
| Agent automations | Working | CRUD for automations |
| Agent subagents | Working | List endpoint functional |
| Workflow CRUD | Working | Create/list/version/publish |
| Workflow builder | Working | Templates, drafts, locks |
| Session management | Working | Create/list/messages |
| Memory items | Working | Store/retrieve memory |
| Learning/patterns | Working | Temporal pattern extraction |
| Skills listing | Working | 96 skills loaded |
| Plugin listing | Working | Returns empty (none installed) |
| Marketplace listings | Working | Commerce routes functional |
| Observability overview | Working | Health + alert status |
| UiX preferences | Working | Get/set user preferences |
| UiX home snapshot | Working | Dashboard data |
| Cross-border packs | Working | Profile + snapshot |
| Setup status | Working | Setup completion tracking |
| Security center | Working | Token revocation |
| Health endpoint | Working | System health check |

---

## Recommendations (Priority Order)

1. **P0:** Register missing API routes for advertised UI features (fleet, guided-flow, onboarding, etc.)
2. **P0:** Add skill execution API (`POST /v1/skills/:id/run`)
3. **P0:** Add workflow run API (`POST /v1/workflows/:id/run`)
4. **P1:** Wire WebAuthn routes for security hardening
5. **P1:** Register desktop status/capability routes
6. **P1:** Connect skill generator and workflow generator routes
7. **P1:** Add provider test-connection endpoint
8. **P2:** Wire XHS routes if feature is intended for release
9. **P2:** Connect heartbeat status API
10. **P2:** Add observability metrics endpoint
11. **P3:** Complete companion app integration
12. **P3:** Connect external plugin marketplace
13. **P3:** Add satellite pairing API routes

---

## Category 11: Skills & Managed-Skills Issues (Deep Audit)

### 11.1 Broken Module Imports (Will Crash at Runtime)
| Skill | Import | Issue |
|-------|--------|-------|
| `managed-skills/chinese-investor-research-digest/index.mjs` | `friday-runtime-context` | Module does not exist anywhere |
| `managed-skills/convert-notes-to-brief/index.mjs` | `friday-runtime-context` | Module does not exist; calls nonexistent `runtimeContext.callAIService()` |
| `managed-skills/summarize-shop-performance/index.mjs` | `friday-runtime` | Module does not exist; calls nonexistent `ctx.ai.complete()` |

### 11.2 Placeholder/Stub Skill Implementations (10 skills)
- `convert-notes-to-dashboard/index.mjs` - Returns hardcoded `"..."` template
- `operations-brief-generator/index.mjs` - Returns static string "Analyzed metrics for anomalies"
- `weekly-content-calendar-creator/index.mjs` - Echoes input back in formatted string
- 7 cross-border skills (`customer-service-brief`, `listing-image-layout-audit`, `price-match-review`, `product-scout`, `spike-detector`, `top-category-watch`, `weekly-growth-review`) - All echo stubs with static Chinese headers

### 11.3 Dead Asset References (Templates Never Loaded)
- `incident-brief-generator/assets/incident-brief-template.md` - SKILL.md says to load it but code constructs output inline
- `engineering-retro/assets/retro-template.md` - Same pattern
- `design-plan-review/references/design-checklist.md` - Never loaded by code
- `security-review/references/security-checklist.md` - Never loaded by code
- `workspace-diff-review/references/diff-review-checklist.md` - Never loaded by code

### 11.4 E2E Test Artifact Accumulation
- **28 test directories** left in `managed-skills/`: 25 `e2e-date-skill-*` directories + `c18-setup-test-skill` + `hello-converter-e2e` + `real-e2e-import-test`
- All functionally identical (run `echo '{"date": "'$(date)'"}'`)
- Pollute skill discovery and add unnecessary load

### 11.5 All Managed-Skills Have Empty Triggers
- Every managed skill has `"triggers": {"intents": [], "phrases": [], "channels": ["*"]}`
- Cannot be matched by intent or phrase - only by explicit ID
- Makes natural-language skill discovery non-functional for managed skills

### 11.6 Placeholder Author Names in Manifests
- 8 skills use `"Your Company Name"`, `"Your Name"`, or `"Your Company"` as author

### 11.7 Malformed gstack Skill
- Description is an HTML comment `<!-- AUTO-GENERATED from SKILL.md.tmpl -->`
- Input enum contains documentation fragments instead of valid command names
- `run.sh` case labels don't match enum values
- Requires external `~/.claude/skills/gstack/` toolchain not included in project

### 11.8 Skills with Missing Metadata
- `compound-interest-calculator` has empty `inputs: [], outputs: []` but code expects `{principal, rate, time, frequency}`
- `extract-action-items` uses fragile regex that only matches an extremely specific format
- 5 channel status skills missing `skill.ui.json`

---

## Category 12: Marketplace Deep Audit

### 12.0 Overall Status
The marketplace is **genuinely functional** with real SQLite-backed persistence, full CRUD, and a sophisticated commerce model. Routes are properly registered. However:

### 12.0.1 No Billing Provider Adapters Exist (Critical Gap)
- `BillingAdapterRegistry` interface defined in `src/marketplace/billing/friday-billing-adapter.ts`
- `createFridayBillingAdapterRegistry()` is **never called** in the bootstrap
- No Stripe/PayPal/any concrete adapter implementation exists anywhere
- **Impact:** Paid purchases (one_time, subscription, usage_based) create `pending` records but can never complete payment
- Free plans work end-to-end (immediate entitlement grant)

### 12.0.2 "Support Creator" Is Fake Financial Action
- UI sends hardcoded `{ amount: 500, currency: "USD" }` ($5.00)
- No user input for amount, no actual payment processing
- Records a support event in SQLite -- essentially a "like" button masquerading as financial support

### 12.0.3 Billing Webhook Handler & Reconciliation Job Never Instantiated
- `friday-billing-webhook-handler.ts` and `friday-billing-reconciliation-job.ts` exist as dead code
- Bootstrap never creates these services

### 12.0.4 "0% Commission" Claim is Vacuously True
- `DEFAULT_PLATFORM_FEE_BPS = 0` in `publisher-manager.ts`
- No payment processing exists, making the commission rate irrelevant

### 12.0.5 FRIDAY_PLUGIN_MARKETPLACE_BASE_URL Confusion
- This env var is for the **legacy plugin marketplace**, not the commerce marketplace
- Users expecting it to configure the new marketplace will be confused

---

## Category 12.5: Channels Deep Audit

All 10 channel types are **fully implemented** (none are stubs). Each has factory, Zod config, normalizer, and real service layer. However:

### 12.5.1 QQ send() Always Uses Group Endpoint for All Messages
- `src/channels/qq/friday-qq-channel.ts:445` - always constructs `/v2/groups/${chatId}/messages`
- No fallback to C2C endpoint (`/v2/users/${chatId}/messages`) for direct messages
- **Impact:** Direct messages to QQ users will fail

### 12.5.2 QQ and Lark Lack Lifecycle Adapters
- Both provide `inbound`, `outbound`, `status` adapters but no `lifecycle` adapter
- Registry falls back to legacy `start()/stop()` methods
- Architectural inconsistency -- every other channel uses the adapter pattern

### 12.5.3 WhatsApp Bridge Mode Outbound is a Stub
- `src/channels/whatsapp/friday-whatsapp-channel.ts:147` - bridge mode returns `bridge-stub-${Date.now()}`
- Messages sent through bridge-configured WhatsApp are silently dropped

### 12.5.4 Webchat Capability Matrix Contradiction
- Plugin contract says `groupMessages: false`, capability matrix says `supportsGroupMessages: true`
- Plugin contract is correct (each client = own chat), matrix is wrong

### 12.5.5 Telegram & Slack Missing Typing Indicators
- Both platforms support typing but capability matrix marks `supportsTyping: false`
- Typing controller infrastructure exists and works for Discord, just not wired for these

### 12.5.6 IRC Capability Matrix Contradicts Implementation
- Matrix says `supportsDirectMessages: false` but normalizer explicitly handles DMs
- Implementation supports DMs, matrix is wrong

### 12.5.7 Signal Has No Secret Descriptors
- `getFridayChannelSecretFieldDescriptors("signal")` returns empty array
- Signal daemon may require auth but no secret fields are managed

### 12.5.8 QQ/Lark Config Schema Duplication
- QQ and Lark schemas defined in two places (channel config file + per-module schema)
- Discriminated union uses local copy, not the module schemas
- Changes to module schemas won't affect validation pipeline

---

## Category 12.8: Desktop, Browser, XHS, System, Media/Link Understanding Deep Audit

### Desktop Runtime - Real but Partially Stubbed

All three platform adapters (macOS/Windows/Linux) have real implementations, not stubs. **However:**

| Operation | macOS | Windows | Linux |
|-----------|-------|---------|-------|
| click/type/keypress | Real (AppleScript) | Real (PowerShell) | Real (xdotool) |
| screenshot | Real (screencapture) | **FAKE** (returns `"[base64-data]"`) | Real (import/scrot) |
| inspectElement | **Stub** (fabricated zeros) | **FAKE** (fabricated element) | **Stub** |
| read_element | **Stub** (fabricated data) | **Stub** | **Stub** |
| drag | **Stub** (no-op) | Real | **Stub** (no-op) |
| clipboard | Real (pbcopy/pbpaste) | Real (Get-Clipboard) | Real (xclip/xsel) |

### Browser Runtime - Real, Functional
- Genuine Playwright integration (~930 lines), multi-session management
- Host Chrome auto-discovery is **macOS-only** (Windows/Linux fall back to headless)
- Properly wired into agent tools and skill executor

### XHS (XiaoHongShu) - Real, Wired, but Fragile
- Genuine browser automation: QR login, search, post creation, comment extraction
- **Wired** into agent tools and tool registry
- **Fragile CSS selectors** (e.g. `[class*="note-item"]`) will break on DOM changes
- No error recovery for partial post creation

### System Companion - Real but macOS-Only in Practice
- Full JSON-RPC Unix socket/named pipe infrastructure
- macOS: Real window management, app launch, focus, URL opening via AppleScript
- **Linux/Windows: All platform operations return empty arrays** (silently non-functional)
- ~95% code duplication between Unix socket bridge and named pipe bridge

### Agent Runtime - All 37 Tools Functional, but 6 Tools Not Registered
All tools in `src/agent/tools/` have real implementations (none are stubs). **However, 6 tool files exist but are NOT registered in `friday-agent-tool-registry.ts`:**
- `friday-agent-autonomous-tool.ts`
- `friday-agent-setup-tool.ts`
- `friday-agent-setup-assistant-tool.ts`
- `friday-agent-skill-generator-tool.ts`
- `friday-agent-skill-import-tool.ts`
- `friday-agent-workflow-generator-tool.ts`

These may be wired via separate surfaces, but they are not available to standard agent runs.

### Agent LLM Client - Handles All Provider Types
Supports Anthropic Messages API (with SSE streaming, prompt caching), OpenAI Completions/Responses, Ollama, and CLI backend. Fully functional.

### Autonomous Engine - In-Memory Only
Autonomous engine state is kept in-memory (Map). No persistence -- state is lost on restart.

### Agent Review Gate - No Human Review Mode
`FRIDAY_AGENT_REVIEW_MODE` env var is wired, but only `"off"` and `"high_risk"` modes have real behavior. The `"always"` mode exists but no UI surface actually presents approval requests to users -- it would block indefinitely.

### Learning System - Real but Auto-Fix is Symbolic
- Learning event collection, lesson extraction, pattern detection all functional
- Self-healing pipeline exists with incident tracking, diagnosis, auto-fix actions
- **Auto-fix executors are symbolic** -- they record the action as "executed" but don't actually perform remediation

### Heartbeat System - Functional Background Job
- Runs as a scheduled job with configurable interval/cooldown
- Monitors provider health, system resources, skill registry
- No API endpoint to check heartbeat status (already noted)

### Media Understanding - FULLY ORPHANED (Critical)
- Complete implementation exists: attachment processing, MIME detection, provider chain
- **NOT imported or used anywhere** - not in hub bootstrap, agent runtime, or any tool
- **Zero concrete providers exist** - the provider interface is defined but no implementations
- This is a complete shell with no integration point

### Link Understanding - PARTIALLY ORPHANED
- Full pipeline: URL detection, SSRF-safe fetch, Readability summarization, in-memory cache
- **Only `summarizeContent` is used** (by the web_fetch agent tool)
- The full auto-detect-links-in-messages pipeline is dead code
- Cache repository, link detection service, and orchestration are unused

---

## Category 13: CI/CD & Build Pipeline Issues (Critical)

### 12.1 release-check.mjs Will Always Fail
- `scripts/quality/release-check.mjs:55` checks `pkg.files.includes("dist/**")`
- `package.json` `files` field has `"dist/**/*.js"`, `"dist/**/*.d.ts"`, `"dist/ui/**"` -- NOT `"dist/**"`
- **Impact:** `npm run release:check` always fails. Blocks release pipeline.

### 12.2 Docker E2E Smoke References Wrong Dockerfile
- `scripts/ci/docker-e2e-smoke.sh:49` references `${ROOT_DIR}/Dockerfile`
- Actual Dockerfile is at `docker/Dockerfile` (no root-level Dockerfile exists)
- **Impact:** Docker E2E smoke tests fail

### 12.3 docker-compose.yml Build Context Wrong
- `docker/docker-compose.yml:2` uses `build: .` (docker/ dir as context)
- Dockerfile COPY commands for `src/`, `packages/`, `ui/` will fail since they're not in `docker/`
- Should be `build: context: .. dockerfile: Dockerfile`

### 12.4 Deb Package Stale Version
- `packaging/linux/deb/DEBIAN/control` hardcodes `Version: 0.4.2` (project is `1.0.0`)
- Also requires `nodejs (>= 18)` but project requires `>= 22`

---

## Category 13: Orphaned Scripts & Dead Files

### 13.1 11+ Ops Scripts Unreferenced
`marketplace-staging-rollback-drill.sh`, `friday-launchagent-status.sh`, `friday-open-ui-on-login.sh`, `install-friday-launchagent.sh`, `uninstall-friday-launchagent.sh`, `friday-companion-run.sh`, `write-friday-artifact-metadata.mjs`, `write-friday-channel-metadata.mjs`, `notarize-friday-companion-app.sh`, `write-friday-companion-release-record.sh`, `friday-service-run.sh` -- none referenced in package.json or CI workflows.

### 13.2 6 E2E Audit Scripts Orphaned
`run-self-evolution-live-audit.mjs`, `run-tier1-china-live-audit.mjs`, `run-tier1-global-live-audit.mjs`, `run-tier1-live-matrix-summary.mjs`, `run-tier1-local-live-audit.mjs`, `tier1-live-audit-lib.mjs` -- none referenced in package.json or CI.

### 13.3 Shell Contract Tests Disconnected
`tests/contract/` contains 10 contract test pairs (P1-P10) -- completely orphaned from CI and package.json scripts.

### 13.4 Linux Packaging Script Orphaned
`scripts/ops/build-friday-linux-packages.sh` exists but no `build:linux` script in package.json.

### 13.5 Winget MSI Template Without MSI Pipeline
`packaging/winget/templates/friday.installer.yaml.template` references `InstallerType: msi` but no MSI build pipeline exists.

---

## Category 14: Undocumented Environment Variables

These env vars are read in source code but missing from `.env.example`:
- `FRIDAY_MARKETPLACE_COMMERCE_ENABLED`
- `FRIDAY_MARKETPLACE_INSTALL_REQUIRED`
- `FRIDAY_MARKETPLACE_AGENT_ASSET_ENABLED`
- `FRIDAY_AUTO_SETUP` (referenced in docker-compose.yml but nothing reads it)
- `FRIDAY_SESSION_HISTORY_LIMIT`

---

## Category 15: Companion App Status

| Platform | Status | Detail |
|----------|--------|--------|
| macOS | **Real implementation** | Full Swift app: Unix socket server, hotkeys, notifications, window management |
| Linux | **Scaffold only** | Rust binary prints JSON payload and exits. No dependencies, no networking. |
| Windows | **Scaffold only** | C# program prints JSON payload and exits. No actual connection to Friday. |

---

## Category 16: Dead Aliases & Missing Test Coverage

### 16.1 Dead Vitest Alias
`vitest.config.ts:34` defines `#routing` alias pointing to `src/routing/index.ts` -- directory does not exist.

### 16.2 Source Modules Without Unit Tests
- `src/cross-program/` -- no tests
- `src/harness/` -- no tests
- `src/lib/` -- no tests
- `src/media/` (contains `friday-tts-service.ts`) -- no tests

---

## Category 17: Entire Unwired Modules (Dead Code)

### 17.0.1 Packaging System -- 5,900 Lines of Dead Code (Critical)
- `src/packaging/` (13 files, 5,585 lines) - Complete package management system: installer, validator, builder, manifest parser, registry manager, dependency resolver
- `src/api/http/routes/friday-packaging-routes.ts` (318 lines) - REST routes defined
- **Never imported anywhere.** Hub bootstrap has zero references to packaging. Routes never registered. CLI command handler exported but never called.

### 17.0.2 Multi-Tenant Security -- 8,900 Lines Unwired (Critical)
- `src/security/multi-tenant/` (18 files, 8,234 lines) - Complete multi-tenant system: RBAC engine, policy engine, tenant manager, secret manager, migration manager
- `src/api/http/routes/friday-multi-tenant-security-routes.ts` (659 lines) - Routes defined
- Routes conditionally registered (`if (deps.multiTenantSecurity)`) but **hub bootstrap never provides this dependency**

### 17.0.3 TUI Module -- Built but Inaccessible
- `src/tui/` - Full TUI client, renderer, controller
- Comment: "This module is intentionally not wired into the public CLI parser"
- `runFridayCliTui()` exported but never called

### 17.0.4 TTS and Nodes Services -- Defined but Never Instantiated
- `src/media/friday-tts-service.ts` - `createFridayTtsService()` never called in bootstrap
- `src/nodes/friday-nodes-service.ts` - `createFridayNodesService()` never called
- `FRIDAY_NODES_ENABLED` env var referenced in comment but never actually read by code

### 17.0.5 Gemini CLI Backend Throws at Runtime
- `src/providers/cli/friday-provider-cli-backend.ts:362` - `gemini-cli` is a valid backend ID in the type system but immediately throws `"Gemini CLI backend is not wired for non-interactive inference yet"` (501)

### 17.0.6 Code Quality Notes
- **50+ `.catch(() => {})` silent error patterns** across the codebase (browser cleanup, companion bridge calls)
- **616 `console.log/warn/error` calls** across 153 files instead of structured logging
- All production channel error paths use `console.warn` to stdout, not observability pipeline

---

## Category 17.1: Workflows, Plugins, Rules, Packs, Observability, Security Deep Audit

### Workflows - Fully Functional Production-Grade Engine
- Runtime, compiler, triggers (cron/webhook/event), builder, satellite dispatch, generator all real
- **Node type constant mismatch:** `FRIDAY_WORKFLOW_NODE_TYPES.TRANSFORM` = `"transform"` but compiled runtime type is `"data"`
- **"ai" and "data" node types** handled by executor but absent from constants file

### Plugins - Fully Functional with Real Signing
- Dynamic `import()` loading with activate/deactivate lifecycle
- Ed25519 signature verification for marketplace plugins, SHA-256 fingerprinting for local
- Dependency resolver with topological sort and semver range checking
- **Marketplace requires external server** -- no default URL, gracefully degrades to empty results

### Rules - Functional but Scope-Limited
- Production-grade policy engine: 12 operators, regex cache, ReDoS detection, HMAC-signed bundles
- **Only wired into workflow execution** -- NOT evaluated during agent pipeline or standalone skill execution
- If rules should gate agent actions outside workflows, that wiring is missing

### Packs - 15 of 16 Are Catalog-Only
- 16 built-in packs defined (industry + task types)
- **Only `industry-cross-border-ecommerce` has implementation files**
- Other 15 packs are catalog entries with no backing code
- No pack manager/registry service exists -- activation mechanism unclear

### Observability - Real but In-Memory Only
- Metrics collector (counter/gauge/histogram), alert engine (4 condition types), health checks all real
- **All data in-memory** -- no Prometheus, OpenTelemetry, or external export
- Data lost on process restart
- Runbook automation with escalation tiers is functional

### Security - No WebAuthn Exists
- Multi-tenant RBAC, policy engine, tenant manager, secret manager all functional
- **Zero WebAuthn/FIDO2 code exists** anywhere in `src/security/`
- Despite being referenced in route files, the implementation was never written
- Secret encryption properly delegated to providers subsystem

---

## Category 18: Documentation & Cross-Reference Issues

### 18.1 Broken Links
- `docs/VISION.md:86` - `./docs/reports/...` should be `./reports/...` (double-nesting)
- `docs/reference/CODE_INDEX.md:9-18` - 5 links to `./src/...` resolve to `docs/reference/src/...` (wrong)
- `docs/getting-started.md:483` - anchor `#production-notes` doesn't exist in README.md
- `docs/getting-started.md:482` - links to `docs/CHANGELOG.md` (old) instead of root `CHANGELOG.md`

### 18.2 Outdated Content
- `docs/getting-started.md:243` - shows version `0.3.0`, project is `1.0.0`
- `docs/getting-started.md:43` - shows `npm install -g friday` (wrong package, should be `@thesongzhu/friday`)
- `CHANGELOG.md` 1.0.0 release date is `2026-04-18` (future date, today is 04-15)
- Duplicate changelog: `docs/CHANGELOG.md` (old format) vs root `CHANGELOG.md`

### 18.3 Placeholder URLs
- Both READMEs: Discord badge uses placeholder server ID `1234567890`
- `docs/friday-visual-design-spec.md` - URL typo `mattstromawn.com` (likely `matthewstrom.com`)

### 18.4 Orphaned Documentation
- **105+ docs files** not linked from any hub, index, or source-of-truth
- `docs/getting-started.md` - KEY file NOT linked from `docs/README.md` (Documentation Hub)
- 14 architecture RFCs in `docs/architecture/` not linked from anywhere
- 90+ historical plan/review/audit docs should be archived per stated policy
- `docs/images/screenshot-*.png` not referenced from any doc
- `context/BELIEFS.md` exists but not documented as a workspace context file

### 18.5 Missing Documentation
- No built-in skill catalog/reference (README claims "52+ skills" but no list exists)
- No documentation for 14 architecture RFCs
- `docs/RELEASING.md`, `docs/friday-style-guide.md` not linked from docs hub

---

## Appendix: Source File Count by Module

```
src/acceptance/     - Acceptance testing framework
src/agent/          - AI agent runtime (tools, LLM client, autonomous engine)
src/api/            - HTTP API (routes, middleware, auth)
src/automation/     - OpenClaw adoption automation
src/browser/        - Playwright browser automation
src/channels/       - Multi-channel messaging (Discord, Telegram, Slack, etc.)
src/cli/            - CLI entry point
src/config/         - Configuration management
src/cross-program/  - Cross-program integration
src/daemon/         - Background daemon
src/deeplink/       - Deep link handling
src/desktop/        - Desktop automation (macOS/Linux/Windows)
src/engine/         - Orchestration engine
src/errors/         - Error types
src/harness/        - Test harness
src/heartbeat/      - Heartbeat monitoring
src/hub/            - Hub bootstrap (composition root)
src/jobs/           - Job scheduler
src/learning/       - Self-learning/self-healing
src/ledger/         - Run ledger/store
src/lib/            - Shared utilities
src/link-understanding/ - URL analysis
src/marketplace/    - Skill/plugin marketplace
src/media/          - Media handling
src/media-understanding/ - Media analysis
src/memory/         - Memory service
src/node-runner/    - Node execution runtime
src/nodes/          - Workflow node types
src/observability/  - Observability/monitoring
src/packaging/      - Package management
src/packs/          - Cross-border packs
src/playbook/       - Playbook engine
src/plugins/        - Plugin system
src/providers/      - LLM provider management
src/retry/          - Retry engine
src/rules/          - Rule/policy engine
src/satellites/     - Satellite/remote node system
src/security/       - Security (WebAuthn, auth)
src/sessions/       - Session management
src/setup/          - First-run setup
src/skills/         - Skill registry/executor/converter
src/state/          - SQLite state management
src/system/         - System companion bridge
src/tui/            - Terminal UI
src/uix/            - User experience layer
src/utilities/      - Shared utilities
src/workflows/      - Workflow engine
src/xhs/            - XiaoHongShu integration
```
