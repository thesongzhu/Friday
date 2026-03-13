# 🤖 Friday — Visual AI Automation Platform

<!-- Badges -->
<p>
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=for-the-badge" alt="Node ≥22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License">
  <img src="https://img.shields.io/badge/Tests-8900%2B-success?style=for-the-badge" alt="Tests">
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?style=for-the-badge" alt="TypeScript strict">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/release.yml/badge.svg" alt="Release">
</p>

**Friday** is a self-hosted platform for designing, orchestrating, and operating AI-powered workflows, and it now includes an Agent OS stack that is being packaged for cross-platform desktop and mobile download.

Bring your own API keys (BYOK), point-and-click skill creation, and a typed REST + realtime event API. Run it on your laptop, a VPS, or in Docker.

[Documentation Hub](docs/README.md) · [Download Matrix](#download--install) · [Quickstart](#quickstart) · [Reality & Expectations](#reality--expectations) · [Capability Matrix](docs/ops/friday-capability-matrix.md) · [OpenClaw Comparison](docs/ops/friday-vs-openclaw.md) · [Changelog](CHANGELOG.md)

For everything beyond the main product overview, use the [Documentation Hub](docs/README.md). It is the single navigation entrypoint for current truth, reference docs, reports, and archived material.

---

## Latest Updates (2026-02-24)

- **Agent chat workspace redesign**: larger conversation canvas, command buttons, task controls, and live run monitoring with trace/audit summary.
- **Local no-signin startup hardening**: setup/auth bootstrap and local bypass login flow are now more reliable for self-hosted local mode.
- **Scheduled automations (cron)**: agent automations now support `schedule` (`cron` + `timezone`) and are linked to the unified scheduler.
- **Automation UX upgrades**: create/edit/save flows now allow setting schedule and timezone directly in UI.
- **Self-healing surface**: incidents, diagnosis, risk-tiered auto-fix, approval, execution, rollback, and evidence are now exposed through `/v1/diagnosis/*` and `/v1/auto-fix/*`.
- **Beginner assistant**: a new `/assistant` web surface adds issue inbox, plain-language intent resolution, guided wizards, and fix approvals without workflow-builder vocabulary.
- **Skills direct generation closeout**: the skill generator now supports explicit draft self-test and evidence before approval/save.
- **Skills lifecycle closeout**: `/v1/skills/*`, `/v1/marketplace/sources*`, and `/skills` now cover catalog, install, update, delete, verification, source trust, and generated-skill handoff.
- **Creator support**: declarative marketplace `skill`, `workflow`, and `agent` assets can now expose creator profiles, direct support/tip actions, and reputation summaries without turning the primary public ecosystem into a purchase-first store.
- **Observability closeout**: `/v1/observability/*` is now wired into the steady-state hub with trace, audit, alerts, health overview, time-series, default SLOs, alert destinations, and an operator-facing `/observability` surface.
- **Workflow product closeout**: `/assistant` can now generate, deploy, export, and recover workflows, while `/workflows` provides graph, deploy status, runs, and evidence as the operator-facing control plane.
- **Quality and resilience closeout**: acceptance tests now support sandboxed custom checks plus version history, retry now includes provider-level circuit breakers and replay evidence, and rules expose simulation plus explainable audit trails.
- **Expert autonomy (opt-in)**: assistant, self-healing, workflows, skills, fleet, and observability now support an expert-mode policy for bounded context inference, safe probes, and stronger guided troubleshooting without removing final approval gates for destructive or production-sensitive actions.

---

## What Friday Is

Friday is an **open-source AI automation hub** that:

- Connects to **10 messaging platforms** (Discord, Slack, Telegram, WhatsApp, Signal, LINE, IRC, QQ, Lark/Feishu, Webchat) with auto-reconnect and health monitoring.
- Runs an **agent runtime** with 21+ built-in tools (browser, desktop, file I/O, image analysis, TTS, MCP bridge, sub-agents, and more).
- Discovers and runs **skills** (chat, workflow, system) in any runtime (Node, Python, shell, HTTP).
- Orchestrates multi-step **workflows** with approval gates, branching, and retry policies.
- Manages **LLM providers** via BYOK — store your own API keys, route models, track budgets.
- Stores **sessions** and **memories** with embedding-based search (requires a configured embedding provider; falls back to full-text search).
- Exposes everything through a typed REST API with JWT auth, RBAC, and rate limiting.
- Includes a beginner-first `/assistant` surface for issue inbox, plain-language task creation, direct skill generation, and safe fix approval.
- Can detect structured failures, produce diagnoses, propose fixes with risk tiers, execute supervised repairs, roll back, and archive lessons. Default executors write pipeline directives; inject hub-level executors for direct system operations.
- Is being productized as a **cross-platform Agent OS**: macOS desktop baseline first, then iOS and Android trusted-device remote consoles, with Windows desktop completion last.

No SaaS dependency. No per-seat pricing. Your keys, your data, your server.

## Reality & Expectations

Friday's non-platform core is now **validated and closed-loop**, but it is still a **supervised, bounded automation system**.

What Friday can do well today:

- operate an Agent OS control plane with `/v1/system/*`, `/assistant`, `/workflows`, `/skills`, `/fleet`, and `/observability`
- detect incidents, diagnose likely causes, propose fixes, auto-execute low-risk fixes, verify outcomes, roll back, and pause after repeated failures
- generate skills and workflows, explicitly self-test them, and hand them into install, deploy, evidence, and recovery flows
- run a bounded distributed execution model with hub-driven satellite placement, explicit offline blocking, and operator-visible recovery
- expose trace, audit, alerts, SLOs, acceptance evidence, retry replay, and rules explanations to operators

What Friday only does under supervision:

- higher-risk fixes still stop at approval gates
- fixes without rollback, verification, or evidence must not auto-execute
- fleet remediation, workflow recovery, and rules or quality actions remain bounded by policy, not unconstrained autonomy
- expert mode is opt-in and bounded; it can infer context, ask fewer but more decisive questions, and run safe probes, but destructive or sensitive actions still stop at final approval

What Friday does **not** reliably claim today:

- unrestricted long-horizon autonomous troubleshooting
- arbitrary cross-system recovery without policy gates
- richer offline plan generation beyond already-dispatched work recovery
- full federation, cross-hub placement, or richer mesh discovery beyond the current fleet baseline
- ML-heavy anomaly detection, natural-language rule authoring, or marketplace-style expansion for acceptance/rules
- platform-complete desktop and mobile rollout; that work remains separate
- perfect human-level judgment in every ambiguous environment

Detailed boundary docs:

- [Capability Matrix](docs/ops/friday-capability-matrix.md)
- [Friday vs OpenClaw](docs/ops/friday-vs-openclaw.md)
- [Current Source Of Truth](docs/current-source-of-truth.md)

---

## Why Friday

| Pain point | Friday's answer |
|---|---|
| Locked into one AI vendor | **BYOK** — register any OpenAI / Anthropic / Google / Ollama endpoint |
| AI tool sprawl | **Skill registry** — one manifest format, any runtime |
| Fragile glue scripts | **Workflow engine** — DAG execution with retries, approvals, and webhooks |
| Scattered messaging bots | **10 channel bridges** — one agent, any platform (Discord, Slack, Telegram, etc.) |
| Expensive hosted platforms | **Self-hosted** — MIT licensed, runs anywhere Node 22+ runs |

---

## Key Features

- **Skills** — Discover, validate, and execute skills from directories or archives. Shell, Node, Python, HTTP.
- **Skills Lifecycle** — Catalog, install, update, verify, delete, and manage marketplace sources from `/skills`.
- **Skills-First Marketplace Backbone** — Friday's marketplace direction continues to build on the skills lifecycle first. Workflow and agent assets may join the public ecosystem, but they extend the same trust, verification, install, and enable backbone rather than replacing it.
- **Declarative Public Marketplace** — Public marketplace assets are moving to a declarative-first model with explicit permission previews, signature/hash checks, and framework-owned execution instead of arbitrary executable packages.
- **Agent Tools (21+)** — Browser, desktop control, file I/O, exec, image analysis, TTS, canvas, cron, MCP bridge, web fetch, sub-agents, and more.
- **Channels (10 platforms)** — Discord, Slack, Telegram, WhatsApp, Signal, LINE, IRC, QQ, Lark/Feishu, Webchat. See [Channel Bridges](#channel-bridges) below.
- **Browser Automation** — Headless Playwright tool (see [Browser Automation](#browser-automation) below).
- **XHS Automation** — `xhs` tool for Xiaohongshu (see [XHS Automation](#xhs-automation) below).
- **Skill Generator** — AI-generated skills from natural-language descriptions with validation, explicit self-test, evidence, and save flow.
- **Skill Converter** — Import from 7 formats: Clawdbot SKILL.md, n8n nodes, OpenAI GPT Actions, code repos, recordings, native packages, undocumented APIs.
- **Skills-First Marketplace** — Discover declarative `skill`, `workflow`, and `agent` assets, preview permissions, install safely, and support creators while staying anchored to the skills lifecycle backbone.
- **Plugin Marketplace & Commerce** — Plugin browsing, install, entitlement, and commerce flows exist, but they are bounded operator/admin surfaces and should not be confused with the primary skills-first marketplace backbone. Legacy executable assets remain available for operator/dev use, not as the default public marketplace story.
- **Workflows** — Draft/publish builder, one-click deploy/export orchestration, shared graph visualization, run timelines, and evidence export across `/assistant` and `/workflows`.
- **Fleet & Distributed Execution** — Register satellites, pair and sync them, place workflow nodes on `hub`, explicit satellites, or capability-matched nodes, and operate the fleet from `/fleet`.
- **Memory** — Per-session memory with PII guarding, embedding search, and quota limits.
- **Sessions** — Multi-turn conversation state with memory extraction.
- **Fleet** — Dashboard for satellite health, trust scoring, and security revocation.
- **Self-Healing** — Incidents, diagnosis, risk-tiered auto-fix plans, approvals, execution, rollback, lessons, and evidence.
- **Assistant** — Beginner-first `/assistant` surface for templates, guided wizards, issue inbox, direct skill generation, and fix approvals.
- **Expert Mode** — Opt-in bounded autonomy for assumption-aware planning, safe probes, and stronger guided troubleshooting across `/assistant`, self-healing, workflows, skills, fleet, and observability.
- **Observability** — Operator-facing `/observability` surface for traces, audit, alerts, default SLOs, alert destinations, health summaries, and time-series tied to self-healing and assistant flows.
- **Acceptance / Retry / Rules** — Sandboxed acceptance checks with version history, provider-level retry circuit breakers with replay evidence, and explainable rules simulation and audit.
- **Providers (BYOK)** — Register, validate, and route to any LLM provider with usage tracking.
- **Rules Engine** — Rule-based automation alongside workflows.
- **Daemon & TUI** — Long-running daemon mode with terminal UI for interactive operation.

---

## Download & Install

### Current download matrix

| Platform | Current download path | Runtime | Status |
| --- | --- | --- | --- |
| `macOS` | source install, npm | `Swift/AppKit` | Implemented; pending first published release. Sparkle and Homebrew completion in progress |
| `iOS` | TestFlight beta planned | mobile remote console planned | Planned for the current milestone |
| `Android` | Play internal or closed beta planned | mobile remote console planned | Planned for the current milestone |
| `Windows` | source install, npm | `.NET` scaffold | Planned after the mobile betas |

Cross-platform release details: [docs/ops/friday-cross-platform-downloads.md](docs/ops/friday-cross-platform-downloads.md)

### Source install (current desktop developer fallback)

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm install
npm run build
npm link   # makes 'friday' available globally
friday --help
```

> If npm package publish is enabled for your release, use `npm install -g friday`.

### macOS native companion release path

The current native desktop packaging flow is available on macOS:

- `DMG` and `zip` release artifacts from `bash scripts/ops/build-friday-companion-dmg.sh`
- release record from `bash scripts/ops/release-friday-companion-app.sh`
- release manifest from `node scripts/ops/write-friday-release-manifest.mjs`

Required release channels for the current milestone:

- `Sparkle auto-update`
- `Homebrew`
- `npm`

Related docs:

- [docs/ops/friday-companion-release-macos.md](docs/ops/friday-companion-release-macos.md)
- [docs/ops/friday-autostart-macos.md](docs/ops/friday-autostart-macos.md)
- [docs/ops/friday-cross-platform-downloads.md](docs/ops/friday-cross-platform-downloads.md)

Runtime: **Node ≥ 22**.

---

## Quickstart

```bash
# 1. Start the hub (loads skills from ./skills)
friday start

# 2. Health check
curl http://localhost:3141/v1/health

# 3. List loaded skills
friday list

# 4. Generate a new skill via AI
curl -X POST http://localhost:3141/v1/skills/generator/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"goal":"A skill that fetches weather for a city","userId":"me","channel":"cli"}'

# 5. Import an external skill
friday import ./path/to/skill-package.tgz

# 6. Check available converters
friday converters
```

> **Note:** Skills are user-created — use the skill generator (`friday` CLI or API) or import from supported formats. See [docs/getting-started.md](docs/getting-started.md) for a full walkthrough.

## Validation Model

Friday uses three explicit readiness levels:

- `Repo Ready` — source tree, package output, and release gates are green
- `Product Ready (Local)` — the real public product surface is green on an isolated local runtime
- `Cloud Ready` — an optional thin smoke against a specific deployed cloud instance

Normal development and release work should treat these as:

- `Repo Ready`: required
- `Product Ready (Local)`: required
- `Cloud Ready`: only required when claiming a deployed cloud environment is ready

Canonical commands:

```bash
# Required release gate
npm run verify:repo-ready

# Required local product-surface gate
npm run verify:product-local

# Optional post-deploy cloud smoke
npm run verify:cloud-smoke

# Optional Docker runtime smoke
npm run verify:docker-smoke

# Explicit combined closure run (local + cloud)
npm run test:e2e:closure:all
```

Notes:

- `npm run test:e2e:closure` now defaults to the local-only product gate.
- `npm run verify:cloud-smoke` remains intentionally separate; missing cloud env contract must not block normal repo release readiness.

## Auto-Start on macOS

If you want Friday to start automatically after reboot/login and stay alive for channel traffic, use launchd. On macOS Agent OS installs this manages both the Node hub and the native Friday companion:

```bash
bash scripts/ops/install-friday-launchagent.sh
```

Status:

```bash
bash scripts/ops/friday-launchagent-status.sh
```

Uninstall:

```bash
bash scripts/ops/uninstall-friday-launchagent.sh
```

Details: [docs/ops/friday-autostart-macos.md](docs/ops/friday-autostart-macos.md)

Native companion release packaging, signing, notarization, DMG creation, and release-manifest flow:
[docs/ops/friday-companion-release-macos.md](docs/ops/friday-companion-release-macos.md)

Trusted-device remote control now uses passkey registration and assertion on top of the private-network guard exposed through `/v1/system/remote/auth/*`.

---

## One-command Demo Workflow

Run an end-to-end local demo (start hub -> login -> create workflow -> publish -> run -> verify):

```bash
npm run demo
```

What this uses:

- Workflow sample: `examples/workflows/minimal-demo.workflow.json`
- Script: `scripts/demo/minimal-workflow-demo.mjs`
- Isolated state: `.friday/demo-state`

Expected result:

- Terminal prints `✅ Friday one-command demo completed`
- Includes `workflowId` and `runId` for verification

---

## Authentication

Friday uses JWT-based authentication with role-based access control (RBAC).

### Development mode (passwordless)

When `FRIDAY_TOKEN_SECRET` is not set (or using the dev default), you can log in without credentials:

```bash
# Obtain tokens (dev mode — no password required)
curl -X POST http://localhost:3141/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"local": true}'

# Response includes accessToken and refreshToken
# Use the accessToken in subsequent requests:
curl http://localhost:3141/v1/providers \
  -H "Authorization: Bearer <accessToken>"
```

### Production setup

Set `FRIDAY_TOKEN_SECRET` to a strong random string:

```bash
export FRIDAY_TOKEN_SECRET=$(openssl rand -hex 32)
```

### OAuth (Anthropic)

Friday supports OAuth for Anthropic provider registration:

```bash
# Via CLI
friday auth login anthropic

# Via API
POST /v1/auth/oauth/anthropic/initiate   # Start OAuth flow
POST /v1/auth/oauth/anthropic/callback    # Complete OAuth flow
```

### Token refresh

Access tokens expire. Use the refresh endpoint to get new ones:

```bash
curl -X POST http://localhost:3141/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "<refreshToken>"}'
```

---

## CLI Commands

| Command | Description |
|---|---|
| `friday start` | Boot the hub, start the API server |
| `friday list` | List loaded skills |
| `friday run <id>` | Execute a skill by ID |
| `friday status` | Show hub/CLI status |
| `friday import <src>` | Detect, convert, install a skill source |
| `friday convert <src>` | Convert a skill without installing |
| `friday converters` | List available skill converters |
| `friday pack <dir>` | Package a skill directory into `.friday.tgz` |
| `friday auth login <provider>` | Authenticate with an OAuth provider (e.g., `anthropic`) |
| `friday --help` | Show usage |

### Channel auto-connect on startup

`friday start` will auto-load channel config at boot and connect all enabled channels:

1. `FRIDAY_CHANNELS_JSON` (preferred override)
2. `~/.friday/friday.json` (`channels` block, legacy-compatible)

If a channel entry is enabled but missing required credentials, Friday will skip that channel and print a startup warning.

### One-click runtime convergence

To converge to a single runtime (`com.friday.hub`) and a single startup config source (`friday_setup_state` in Friday DB), run:

```bash
npm run ops:converge-runtime -- --model openai/gpt-4o-mini
```

What it does:
1. Stops/disables competing OpenClaw launch agents by default.
2. Migrates legacy `~/.friday/friday.json` channels into `friday_setup_state.channels_json` when setup state is empty.
3. Removes legacy `channels` block from `~/.friday/friday.json` so startup no longer has a second channel source.
4. Pins `llm.routing.v1` default provider/model to your selected `--model`.
5. Restarts `com.friday.hub` and prints verification output.

### Common flags

```
--skills-dir <path>       Skill discovery directory (repeatable)
--port <n>                API server port (default: 3141)
--input key=value         Skill input parameter (repeatable)
--from <format>           Source format hint (auto, clawdbot-skill-md, n8n-node, openai-gpt-action, code-repo, recording, native-skill-package, undocumented-api)
--target <path>           Install target (managed | workspace | custom path)
--replace                 Overwrite existing skill on collision
--dry-run                 Preview without side effects
--split-operations        Split multi-operation sources into separate skills
--no-split-operations     Keep multi-operation sources as a single skill
--skill-id-prefix <str>   Prefix for generated skill IDs
--no-refresh              Skip registry refresh after import
--provider-id <id>        Target provider ID (for auth/OAuth commands)
--code <code>             Authorization code (for OAuth callback)
--no-browser              Disable automatic browser open during OAuth
```

---

## API Routes

All routes are prefixed with `/v1`. Auth uses JWT Bearer tokens unless marked **public**.

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/health` | public | Liveness probe |
| `GET` | `/v1/version` | public | Lightweight server version probe |

### Runtime Admin

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/config` | token | Get active runtime configuration snapshot and current revision |
| `PATCH` | `/v1/config` | token | Apply a validated config patch |
| `GET` | `/v1/config/revisions` | token | List config revisions |
| `POST` | `/v1/config/revert` | token | Revert runtime config to a prior revision |
| `GET` | `/v1/audit/logs` | token | Search audit log entries from the admin/security surface |
| `GET` | `/v1/secrets` | token | List stored encrypted secret metadata |
| `POST` | `/v1/secrets` | token | Create a stored encrypted secret |
| `GET` | `/v1/secrets/:secretId` | token | Get one stored secret metadata record |
| `PATCH` | `/v1/secrets/:secretId` | token | Rotate or retarget a stored secret |
| `DELETE` | `/v1/secrets/:secretId` | token | Delete a stored secret |

### Setup

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/setup/status` | token | Read setup progress/status |
| `POST` | `/v1/setup/complete` | token | Mark setup flow as completed |
| `POST` | `/v1/setup/channels` | token | Save selected channel configuration |

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/auth/login` | public | Obtain tokens (dev: `{"local":true}`) |
| `POST` | `/v1/auth/refresh` | public | Refresh access token |
| `POST` | `/v1/auth/logout` | token | Revoke tokens |
| `GET` | `/v1/auth/me` | token | Current principal info |
| `POST` | `/v1/auth/oauth/anthropic/initiate` | token | Start Anthropic OAuth flow |
| `POST` | `/v1/auth/oauth/anthropic/callback` | token | Complete Anthropic OAuth callback |

### Providers (BYOK)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/providers` | token | List providers |
| `POST` | `/v1/providers` | token | Register a provider |
| `GET` | `/v1/providers/:providerId` | token | Get provider details |
| `PATCH` | `/v1/providers/:providerId` | token | Update a provider |
| `DELETE` | `/v1/providers/:providerId` | token | Delete a provider |
| `POST` | `/v1/providers/:providerId/validate` | token | Test provider connectivity |
| `GET` | `/v1/providers/usage` | token | Get usage summary (with date/groupBy query) |
| `GET` | `/v1/providers/budget` | token | Get budget status |
| `PUT` | `/v1/providers/budget` | token | Set budget config |
| `GET` | `/v1/model-routing` | token | Get model routing config |
| `PUT` | `/v1/model-routing` | token | Set model routing config |

### Workflows

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/workflows` | token | List workflows |
| `POST` | `/v1/workflows` | token | Create a workflow |
| `GET` | `/v1/workflows/:workflowId` | token | Get workflow details |
| `PATCH` | `/v1/workflows/:workflowId` | token | Update a workflow |
| `DELETE` | `/v1/workflows/:workflowId` | token | Archive a workflow |
| `POST` | `/v1/workflows/:workflowId/publish` | token | Publish a workflow version |
| `GET` | `/v1/workflows/:workflowId/versions` | token | List workflow versions |
| `GET` | `/v1/workflow-versions/:versionId` | token | Fetch one workflow version directly by ID |
| `GET` | `/v1/workflows/:workflowId/drafts` | token | List drafts |
| `POST` | `/v1/workflows/:workflowId/drafts` | token | Create a draft |
| `GET` | `/v1/workflows/:workflowId/drafts/:draftId` | token | Get draft details |
| `PATCH` | `/v1/workflows/:workflowId/drafts/:draftId` | token | Save a draft |
| `POST` | `/v1/workflows/:workflowId/drafts/:draftId/autosave` | token | Autosave a draft |
| `POST` | `/v1/workflows/:workflowId/drafts/:draftId/compile` | token | Compile a draft |
| `POST` | `/v1/workflows/:workflowId/drafts/:draftId/publish` | token | Publish a draft |
| `POST` | `/v1/workflows/:workflowId/drafts/:draftId/deploy` | token | Compile, publish, optionally run, and optionally export a draft in one request |
| `GET` | `/v1/workflows/:workflowId/overview` | token | Get workflow operator summary across drafts, published versions, runs, and evidence |
| `GET` | `/v1/workflows/:workflowId/visualization` | token | Get the workflow visual graph and latest failure path |
| `POST` | `/v1/workflows/:workflowId/locks/acquire` | token | Acquire edit lock |
| `POST` | `/v1/workflows/:workflowId/locks/renew` | token | Renew edit lock |
| `POST` | `/v1/workflows/:workflowId/locks/release` | token | Release edit lock |
| `GET` | `/v1/workflows/:workflowId/conflicts` | token | List merge conflicts |
| `POST` | `/v1/workflows/:workflowId/conflicts/:conflictId/resolve` | token | Resolve a conflict |

### Workflow Runs

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/workflow-runs` | token | Start a workflow run |
| `GET` | `/v1/workflow-runs/:runId` | token | Get run status |
| `GET` | `/v1/workflow-runs/:runId/nodes` | token | List run nodes |
| `GET` | `/v1/workflow-runs/:runId/timeline` | token | Get run timeline |
| `POST` | `/v1/workflow-runs/:runId/cancel` | token | Cancel a run |
| `POST` | `/v1/workflow-runs/:runId/retry` | token | Retry a failed run |
| `POST` | `/v1/workflow-runs/:runId/resume` | token | Resume a paused run |

### Agent Runtime and Automations

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/agent/runs` | token | Start an agent run |
| `GET` | `/v1/agent/runs` | token | List agent runs |
| `GET` | `/v1/agent/runs/:runId` | token | Get agent run detail |
| `POST` | `/v1/agent/runs/:runId/cancel` | token | Cancel a running agent run |
| `GET` | `/v1/agent/runs/:runId/events` | token | Stream run events (SSE) |
| `POST` | `/v1/agent/automations` | token | Create an automation from task template |
| `GET` | `/v1/agent/automations` | token | List automations |
| `GET` | `/v1/agent/automations/:automationId` | token | Get automation detail |
| `PATCH` | `/v1/agent/automations/:automationId` | token | Update automation (name/template/enabled/schedule) |
| `DELETE` | `/v1/agent/automations/:automationId` | token | Delete automation |
| `POST` | `/v1/agent/automations/:automationId/run` | token | Execute automation once |

Automation schedule payload example:

```json
{
  "name": "Daily Health Check",
  "taskTemplate": "Run a health check and summarize risks",
  "schedule": {
    "type": "cron",
    "cron": "0 9 * * 1-5",
    "timezone": "America/New_York"
  },
  "enabled": true
}
```

### Workflow Generator

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/workflows/generator/sessions` | token | Start a generator session |
| `GET` | `/v1/workflows/generator/sessions/:sessionId` | token | Get generator session |
| `POST` | `/v1/workflows/generator/sessions/:sessionId/messages` | token | Submit a message |
| `POST` | `/v1/workflows/generator/sessions/:sessionId/generate` | token | Generate workflow draft |
| `POST` | `/v1/workflows/generator/sessions/:sessionId/approve` | token | Approve and save |
| `DELETE` | `/v1/workflows/generator/sessions/:sessionId` | token | Cancel session |

### Workflow Approvals

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/workflow-approvals` | token | Canonical list of pending workflow approvals |
| `GET` | `/v1/workflow-approvals/:approvalId` | token | Canonical fetch for one workflow approval |
| `POST` | `/v1/workflow-approvals/:approvalId/approve` | token | Canonical approve action |
| `POST` | `/v1/workflow-approvals/:approvalId/reject` | token | Canonical reject action |
| `GET` | `/v1/approvals` | token | Compatibility alias for approval listing |
| `GET` | `/v1/approvals/:approvalId` | token | Compatibility alias for approval detail |
| `POST` | `/v1/approvals/:approvalId/approve` | token | Compatibility alias for approval accept |
| `POST` | `/v1/approvals/:approvalId/reject` | token | Compatibility alias for approval reject |

### Sessions

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/sessions` | token | List sessions |
| `POST` | `/v1/sessions` | token | Create a session |
| `GET` | `/v1/sessions/:sessionKey` | token | Get session details |
| `POST` | `/v1/sessions/:sessionKey/archive` | token | Archive a session |
| `POST` | `/v1/sessions/prune` | token | Prune old sessions |
| `POST` | `/v1/sessions/sweep` | token | Lifecycle sweep |
| `GET` | `/v1/sessions/:sessionKey/messages` | token | List messages |
| `POST` | `/v1/sessions/:sessionKey/messages` | token | Create a message |
| `GET` | `/v1/sessions/:sessionKey/memory-namespace` | token | Get memory namespace |
| `POST` | `/v1/sessions/:sessionKey/fork` | token | Fork a session |
| `GET` | `/v1/sessions/:sessionKey/forks` | token | List session forks |
| `POST` | `/v1/sessions/:sessionKey/merge` | token | Merge fork summary |
| `POST` | `/v1/sessions/:sessionKey/memory/extract` | token | Trigger memory extraction |
| `POST` | `/v1/sessions/:sessionKey/memory/remember` | token | Remember specific messages |
| `GET` | `/v1/sessions/:sessionKey/memory/extraction` | token | Get extraction status |
| `POST` | `/v1/sessions/memory/extraction/retry` | token | Retry failed extractions |

`sessionKey` is the canonical session path token. `sessionId` still exists in narrower generator, workflow, and system payloads, but it is not the primary route key for `/v1/sessions`.

### Memory

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/memory/store` | token | Store a memory item |
| `POST` | `/v1/memory/search` | token | Search memories (embedding + FTS) |
| `GET` | `/v1/memory/items` | token | List memory items |
| `GET` | `/v1/memory/items/:id` | token | Get a memory item |
| `DELETE` | `/v1/memory/items/:id` | token | Delete a memory item |
| `POST` | `/v1/memory/prune` | token | Prune memory items |

### Skills

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/skills` | token | List installed and managed skill lifecycle state |
| `GET` | `/v1/skills/catalog` | token | List catalog entries with install/update state |
| `GET` | `/v1/skills/:skillId` | token | Get one skill lifecycle detail |
| `POST` | `/v1/skills/install` | token | Install a skill from the catalog or a managed source |
| `POST` | `/v1/skills/:skillId/update` | token | Update an installed skill to a newer tracked version |
| `DELETE` | `/v1/skills/:skillId` | token | Remove a managed skill |
| `POST` | `/v1/skills/validate-manifest` | token | Validate a skill manifest before install or publish |
| `POST` | `/v1/skills/:skillId/verify` | token | Produce structured verification evidence for a skill |
| `GET` | `/v1/skills/converters` | token | List available converters |
| `POST` | `/v1/skills/convert` | token | Convert source to skill drafts |
| `POST` | `/v1/skills/import` | token | Convert + install + refresh registry |
| `POST` | `/v1/skills/pack` | token | Pack a skill directory into `.friday.tgz` |
| `GET` | `/v1/skills/:skillId/ui` | token | Get skill UI schema |

### Marketplace Sources

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/marketplace/sources` | token | List configured skill marketplace sources |
| `POST` | `/v1/marketplace/sources` | token | Add a skill marketplace source |
| `PATCH` | `/v1/marketplace/sources/:id` | token | Update a marketplace source |
| `POST` | `/v1/marketplace/sources/:id/enable` | token | Enable a marketplace source |
| `POST` | `/v1/marketplace/sources/:id/disable` | token | Disable a marketplace source |
| `DELETE` | `/v1/marketplace/sources/:id` | token | Remove a marketplace source |

### Skill Generator

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/skills/generator/sessions` | token | Start a skill generator session |
| `GET` | `/v1/skills/generator/sessions/:sessionId` | token | Get generator session |
| `POST` | `/v1/skills/generator/sessions/:sessionId/messages` | token | Submit a conversation turn |
| `POST` | `/v1/skills/generator/sessions/:sessionId/generate` | token | Force draft generation |
| `POST` | `/v1/skills/generator/sessions/:sessionId/test` | token | Run explicit draft validation and self-test |
| `GET` | `/v1/skills/generator/sessions/:sessionId/evidence` | token | Get generation evidence summary |
| `POST` | `/v1/skills/generator/sessions/:sessionId/approve` | token | Approve and save skill |
| `DELETE` | `/v1/skills/generator/sessions/:sessionId` | token | Cancel generator session |

### Diagnosis

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/diagnosis/incidents` | token | List visible incidents |
| `GET` | `/v1/diagnosis/incidents/:incidentId` | token | Get incident detail |
| `GET` | `/v1/diagnosis/incidents/:incidentId/diagnosis` | token | Get latest diagnosis and related records |

### Auto-Fix

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/auto-fix/actions` | token | List visible fix actions |
| `GET` | `/v1/auto-fix/actions/:actionId` | token | Get fix action detail and evidence |
| `POST` | `/v1/auto-fix/actions/:actionId/approve` | token | Approve a supervised fix |
| `POST` | `/v1/auto-fix/actions/:actionId/deny` | token | Deny a supervised fix |
| `POST` | `/v1/auto-fix/actions/:actionId/execute` | token | Execute a fix action |
| `POST` | `/v1/auto-fix/actions/:actionId/rollback` | token | Roll back a fix action |
| `GET` | `/v1/auto-fix/metrics` | token | Get self-healing metrics |

### Assistant UIX

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/uix/intents/resolve` | token | Resolve a beginner-friendly goal into a next step |
| `GET` | `/v1/uix/templates` | token | List beginner-safe one-click templates |
| `POST` | `/v1/uix/templates/:templateId/execute` | token | Execute a template from the assistant surface |
| `POST` | `/v1/uix/wizards/:wizardId/start` | token | Start a guided wizard |
| `POST` | `/v1/uix/wizards/:wizardId/continue` | token | Continue a guided wizard |
| `GET` | `/v1/uix/issues` | token | List assistant-visible issues and fix cards |

### Plugins

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/plugins` | token | List installed plugins |
| `GET` | `/v1/plugins/:id` | token | Get plugin details |
| `GET` | `/v1/plugins/:id/versions` | token | List plugin versions |
| `POST` | `/v1/plugins/:id/install` | token | Install plugin (local) |
| `POST` | `/v1/plugins/:id/enable` | token | Enable a plugin |
| `POST` | `/v1/plugins/:id/disable` | token | Disable a plugin |
| `DELETE` | `/v1/plugins/:id` | token | Uninstall a plugin |
| `GET` | `/v1/marketplace/plugins` | token | Search marketplace |
| `GET` | `/v1/marketplace/plugins/:id` | token | Get marketplace plugin detail |
| `GET` | `/v1/marketplace/plugins/:id/versions` | token | List marketplace plugin versions |
| `POST` | `/v1/marketplace/plugins/:id/install` | token | Install from marketplace |

### Realtime

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/realtime/subscriptions` | token | Subscribe to event streams |
| `POST` | `/v1/realtime/pull` | token | Pull events from a stream |
| `POST` | `/v1/realtime/ack` | token | Acknowledge received events |
| `WS` | `/v1/realtime/ws` | token | Canonical websocket bridge for realtime subscriptions |
| `WS` | `/v1/ws` | token | Compatibility websocket alias for SSD-era clients |

### Canonical Contract Notes

- `/v1/realtime/*` is the canonical realtime surface. `/v1/ws` is compatibility-only and points at the same websocket bridge as `/v1/realtime/ws`.
- `/v1/workflow-approvals*` is the canonical approvals surface. `/v1/approvals*` remains a compatibility alias for older SSD-shaped clients.
- `sessionKey` is the canonical session route shape. `/v1/sessions/:sessionKey` is the active top-level session path, while `sessionId` still appears only inside narrower generator, workflow, and system payloads.
- `/v1/diagnosis/*` and `/v1/auto-fix/*` are the canonical self-healing route families. Historical `/v1/ai/*` diagnosis wording is not an active public API.
- `/v1/health` is the public liveness surface. Rich operator health lives under system and observability surfaces.
- Current validation failures use the runtime error taxonomy, with `400 VALIDATION_ERROR` as the default schema/input failure contract unless a route explicitly documents otherwise.
- Current auth and security scopes follow the runtime auth model, including `security.read` / `security.write`, `fleet.read`, workflow scopes, diagnosis scopes, session scopes, skill scopes, and plugin scopes.
- `/v1/plugins*` and `/v1/marketplace/plugins*` are active plugin distribution surfaces, but plugin marketplace and commerce remain bounded operator/admin flows rather than the primary beginner product story.
- Public marketplace evolution is now **creator-support-first**: declarative `skill`, `workflow`, and `agent` assets remain free-first, users can support creators directly, and the platform does not take a commission or provide escrow, guarantees, or after-sales support.
- Friday's marketplace backbone remains the skills lifecycle. Any future public `workflow` or `agent` asset story extends the same trust, verification, install, and enable path instead of replacing `/v1/skills/*` and `/v1/marketplace/sources*` as the primary product contract.
- `/v1/marketplace/assets*` is the canonical public catalog and detail read surface for marketplace `skill`, `workflow`, and `agent` assets. It does not replace `/v1/skills/*`; skills remain the primary install, verify, enable, update, and delete backbone.
- `/v1/marketplace/requests*` is the connector-only request board for personal `skill`, `workflow`, and `agent` requests. Friday matches requesters and creators, but does not provide guarantees, escrow, arbitration, or after-sales support.
- Marketplace closeout evidence for the current creator-support direction is archived in [docs/reports/closeout/marketplace-creator-ecosystem/latest.md](docs/reports/closeout/marketplace-creator-ecosystem/latest.md).

### Fleet

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/fleet/overview` | token | Fleet overview (aggregate stats) |
| `GET` | `/v1/fleet/satellites` | token | List satellites |
| `GET` | `/v1/fleet/satellites/:satelliteId` | token | Get satellite detail |
| `POST` | `/v1/satellites/register` | public | Register a satellite and start pairing |
| `POST` | `/v1/satellites/:satelliteId/heartbeat` | satellite token | Publish runtime heartbeat and queue metrics |
| `POST` | `/v1/satellites/:satelliteId/capabilities` | satellite token | Publish current capability directory |
| `POST` | `/v1/satellites/:satelliteId/sync/pull` | satellite token | Pull queued control-plane messages |
| `POST` | `/v1/satellites/:satelliteId/sync/push` | satellite token | Push acks and local satellite events |
| `POST` | `/v1/satellites/:satelliteId/commands/poll` | satellite token | Lease workflow commands for remote execution |
| `POST` | `/v1/satellites/:satelliteId/commands/:commandId/ack` | satellite token | Ack command delivery and optional node result |
| `POST` | `/v1/satellites/:satelliteId/events/poll` | satellite token | Pull realtime fleet event envelopes |

### Security

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/security/center` | token | Security center dashboard |
| `POST` | `/v1/security/tokens/revoke` | token | Revoke a token |
| `POST` | `/v1/security/satellites/:satelliteId/revoke` | token | Revoke a satellite |

---

## Docker

### Quick start

```bash
cp .env.example .env
# Edit .env — set FRIDAY_TOKEN_SECRET at minimum

docker compose up -d
```

### Build from source

```bash
docker build -t friday:local .
docker run -d \
  -p 3141:3141 \
  -e FRIDAY_TOKEN_SECRET=my-production-secret \
  -v ./data:/data \
  -v ./skills:/skills \
  friday:local
```

### Health check

```bash
curl http://localhost:3141/v1/health
# → {"ok":true,"data":{"status":"ok","version":"0.3.1","uptime":42},...}
```

See [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml) for full configuration.

---

## Browser Automation

Friday ships a headless Playwright-based browser tool accessible by the agent runtime.

- **Supported actions:** open, navigate, snapshot (accessibility tree), screenshot, act (click/type/press), tabs (list/new/switch/close), close
- **Safety controls:** origin allowlist (`allowedOrigins`), per-session and per-tab limits, global page cap (`maxTotalPages`), artifact path sanitization
- **Config:** `FRIDAY_BROWSER_HEADLESS` (default `true`), browser artifact directory at `.friday/artifacts/browser/<sessionId>/`
- **Accessibility:** `snapshotAria()` provides ARIA-based page snapshots for structured agent reasoning

## Desktop Runtime

Desktop control is opt-in and disabled by default.

- Enable with `FRIDAY_DESKTOP_ENABLED=true`
- Configure sandbox roots with `FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS`
- Run dependency checks with `npm run check:desktop-runtime`
- Full setup guide: [docs/desktop.md](docs/desktop.md)
- Runtime hardening guide: [docs/enablement-hardening.md](docs/enablement-hardening.md)

## Channel Bridges

Friday supports 10 messaging platforms out of the box. All channels share a unified adapter architecture with inbound/outbound messaging, allowlist filtering, auto-reconnect, and health monitoring.

| Channel | Transport | Auth | DMs | Groups | Typing | Webhook |
|---------|-----------|------|-----|--------|--------|---------|
| **Discord** | Gateway WebSocket + REST | Bot token | yes | yes | yes | -- |
| **Slack** | Socket Mode + REST | Bot token + app token | yes | yes | -- | -- |
| **Telegram** | Polling or Webhook | Bot token | yes | yes | -- | yes |
| **WhatsApp** | Webhook + REST | Phone + API token | yes | -- | -- | yes |
| **Signal** | SSE + RPC | Phone + PIN | yes | yes | -- | -- |
| **LINE** | Webhook + REST | Channel token + secret | yes | yes | -- | yes |
| **IRC** | TCP socket | Nickname + password | yes | yes | -- | -- |
| **QQ** | WebSocket + REST | appId + appSecret | yes | yes | -- | -- |
| **Lark/Feishu** | WebSocket or Webhook | appId + appSecret | yes | yes | -- | yes |
| **Webchat** | WebSocket (RFC 6455) | Client ID | yes | yes | -- | -- |

### Common channel features

- **Inbound routing:** messages keyed as `channel:{kind}:{chatId}` and forwarded to `agentRuntime.executeRun()`
- **Allowlists:** per-channel `allowedUsers` / `allowedChats` filtering before messages reach the agent
- **Message sanitization:** control characters and zero-width characters stripped before processing
- **Auto-reconnect:** Discord uses in-closure exponential backoff (5s-60s); QQ uses epoch-guarded reconnect; Lark uses stale-socket-safe close handling
- **Health monitor:** registry-level 30s health check auto-restarts any channel that drops
- **Operational limits:** message length cap (`FRIDAY_CHANNEL_MAX_MESSAGE_LENGTH`)

### Channel configuration

Channels are configured via `FRIDAY_CHANNELS_JSON` env var or the `channels` block in `~/.friday/friday.json`:

```json
{
  "channels": [
    { "kind": "discord", "token": "$DISCORD_BOT_TOKEN" },
    { "kind": "telegram", "token": "$TELEGRAM_BOT_TOKEN" },
    { "kind": "slack", "botToken": "$SLACK_BOT_TOKEN", "appToken": "$SLACK_APP_TOKEN" },
    { "kind": "qq", "appId": "$QQ_APP_ID", "appSecret": "$QQ_APP_SECRET" }
  ]
}
```

Credentials can reference environment variables (`$VAR`) or secure secret references (`secret://channel/...`).
For production and stable local runtime, set `FRIDAY_CHANNEL_SECRET_POLICY=strict` to block plaintext secrets.

## XHS Automation

The `xhs` tool provides Xiaohongshu automation capabilities.

- **Login flow:** QR-based login via Playwright; QR screenshot saved to artifact directory; poll-based login detection
- **Session persistence:** cookie-based sessions stored in SQLite with AES-256 encryption at rest
- **Capabilities:** search (keyword-based), create posts (title/content/images/tags), extract comments, check login state
- **Browser dependencies:** requires Playwright with Chromium; stealth scripts injected to avoid detection
- **Caveats:** selectors depend on XHS page structure and may need updates; login sessions expire after 7 days of inactivity

## Agent Tools

The agent runtime ships with 21+ built-in tools:

| Tool | Description |
|------|-------------|
| `browser` | Headless Playwright browser automation (navigate, click, type, screenshot, accessibility tree) |
| `desktop` | Desktop control (mouse, keyboard, screen capture) |
| `exec` | Shell command execution with workspace sandboxing |
| `read` / `write` / `edit` | File I/O with symlink protection and workspace containment |
| `web_fetch` | HTTP fetching with SSRF guards |
| `image_analysis` | Vision-based image understanding |
| `tts` | Text-to-speech synthesis (requires OpenAI-compatible TTS provider) |
| `canvas` | Canvas rendering and image generation |
| `cron` | Schedule recurring tasks |
| `mcp` | Model Context Protocol bridge to external tool servers |
| `skill` | Execute skills from the registry |
| `workflow` | Trigger and manage workflow runs |
| `memory` / `memory_extract` | Store, search, and extract memories |
| `sessions` | Manage conversation sessions |
| `subagent` | Spawn and coordinate sub-agents |
| `agents_list` | List available agent configurations |
| `gateway` | API gateway calls with validation |
| `nodes` | Workflow node observation and control |
| `message` | Send messages through channels |
| `xhs` | Xiaohongshu automation |

Tools are registered via the tool registry and can be enabled/disabled per agent configuration. All tools enforce workspace sandboxing and SSRF protection.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Friday Hub                            │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │
│  │ Agent    │  │ Skills   │  │ Workflow  │  │ Provider    │  │
│  │ Runtime  │  │ Registry │  │ Engine    │  │ Service     │  │
│  │ (21+     │  │          │  │          │  │ (BYOK)      │  │
│  │  tools)  │  │          │  │          │  │             │  │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └──────┬──────┘  │
│        │             │             │              │          │
│  ┌─────┴─────────────┴─────────────┴──────────────┴───────┐  │
│  │                   API Runtime                           │  │
│  │  Routes · Auth · RBAC · Rate Limits · Realtime Events   │  │
│  └─────────────────────┬───────────────────────────────────┘  │
│                        │                                      │
│  ┌─────────────────────┴───────────────────────────────────┐  │
│  │            HTTP Server (CORS + HSTS + Logging)          │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                Channel Registry (10 platforms)           │  │
│  │  Discord · Slack · Telegram · WhatsApp · Signal · LINE  │  │
│  │  IRC · QQ · Lark/Feishu · Webchat                       │  │
│  └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
         │                     │                    │
    REST API (:3141)     WebSocket (/ws/chat)    Channels
```

### Key modules

| Module | Purpose |
|---|---|
| `src/hub/` | Composition root — wires everything together |
| `src/api/` | HTTP routes, auth, RBAC, rate limiting, realtime events |
| `src/agent/` | Agent runtime, 21+ built-in tools, sub-agent orchestration |
| `src/channels/` | 11-platform channel registry with adapters, health monitor, allowlists |
| `src/skills/` | Skill registry, manifest loading, validation, execution, 7 converters |
| `src/workflows/` | DAG-based workflow engine with triggers and approvals |
| `src/providers/` | BYOK provider management and routing |
| `src/memory/` | Embedding-based memory with PII guarding |
| `src/sessions/` | Multi-turn conversation state |
| `src/rules/` | Rule-based automation engine |
| `src/learning/` | Self-learning: error diagnosis, auto-fix, preferences |
| `src/plugins/` | Plugin discovery, loading, and dependency resolution |
| `src/marketplace/` | Plugin marketplace with billing and commerce |
| `src/packaging/` | Package lifecycle: build, validate, install, version |
| `src/security/` | Security center: token revocation, satellite revocation, dashboard |
| `src/satellites/` | Distributed fleet: satellite management, trust scoring |
| `src/daemon/` | Long-running daemon mode with PID management |
| `src/tui/` | Terminal UI for interactive CLI operation |
| `src/state/` | SQLite persistence layer with migrations |

---

## Provider Kinds

Friday now includes an expanded OpenClaw-compatible provider kind catalog:

`openai`, `openai-codex`, `anthropic`, `google`, `google-vertex`, `google-antigravity`, `google-gemini-cli`, `openrouter`, `xai`, `mistral`, `groq`, `cerebras`, `github-copilot`, `huggingface`, `opencode`, `vercel-ai-gateway`, `kilocode`, `moonshot`, `kimi-coding`, `qwen`, `qwen-portal`, `volcengine`, `byteplus`, `synthetic`, `minimax`, `ollama`, `vllm`, `litellm`, `together`, `nvidia`, `qianfan`, `venice`, `xiaomi`, `zai`, `glm`, `bedrock`, `cloudflare-ai-gateway`, `openai-compatible`.

Note:
- Transport compatibility is driven by `api` (`openai-responses`, `openai-completions`, `anthropic-messages`, `google-generative-ai`, `ollama`).
- Some providers require custom `baseUrl` / gateway configuration.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Node environment (`development`, `production`, `test`) |
| `FRIDAY_PORT` | `3141` | HTTP server port |
| `FRIDAY_STATE_DIR` | `./data` | SQLite + state storage directory |
| `FRIDAY_SKILLS_DIR` | `skills` | Comma-separated skill directories |
| `FRIDAY_TOKEN_SECRET` | *(dev default)* | JWT signing secret — **change in production** |
| `FRIDAY_MASTER_KEY` | *(auto-generated)* | AES-256 key for encrypting provider API keys at rest. Auto-generated to `~/.friday/master.key` if not set. |
| `FRIDAY_CORS_ORIGINS` | `[]` (disabled) | Comma-separated allowed origins. Set to `*` or specific origins to enable CORS. |
| `FRIDAY_LOG_REQUESTS` | `true` | Enable `[FRIDAY] GET /path 200 3ms` request logging |
| `FRIDAY_ENABLE_HSTS` | `true` | HTTP Strict Transport Security header (default on in production). Disable if not behind TLS. |
| `FRIDAY_BROWSER_HEADLESS` | `true` | Browser tool headless mode (`false` for visible browser) |
| `FRIDAY_BROWSER_USE_HOST_CHROME` | `false` | Connect/launch host Chrome via CDP for browser tool |
| `FRIDAY_DESKTOP_ENABLED` | `false` | Enable desktop runtime and register `desktop` tool |
| `FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS` | workspace root | Comma-separated allowed roots for desktop file operations |
| `FRIDAY_CHANNEL_SECRET_POLICY` | `strict` | Channel secret policy (`strict` blocks plaintext secrets, `compat` allows with warnings) |
| `FRIDAY_CHANNELS_JSON` | *(unset)* | Channel bridge config (Discord/Slack/Telegram/etc.) |
| `FRIDAY_MCP_SERVERS` | *(unset)* | JSON array of MCP stdio server configs. Enables the `mcp` agent tool bridge. |

Precedence: explicit CLI flags > environment variables > defaults.

MCP config example:

```bash
export FRIDAY_MCP_SERVERS='[
  {
    "id": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
  }
]'
```

---

## Production Notes

1. **Set `FRIDAY_TOKEN_SECRET`** — the default is for development only. Use a strong random string.
2. **Use HTTPS** — put Friday behind a reverse proxy (nginx, Caddy, Traefik) for TLS.
3. **Restrict CORS** — set `FRIDAY_CORS_ORIGINS` to your frontend domain(s) in production.
4. **Persistent state** — mount `/data` as a Docker volume to preserve SQLite databases across restarts.
5. **Non-root container** — the Dockerfile runs as `node` (uid 1000) by default.
6. **Health checks** — `GET /v1/health` returns `200` when the hub is ready. Use it for load balancer probes.
7. **Run enablement hardening** — `npm run ops:harden-local-enablement` to migrate local runtime to strict channel policy + token secret + MCP + desktop defaults.
8. **Verify enablement gaps** — `npm run check:enablement-gaps` to fail fast on insecure/missing runtime toggles.

---

## Development

```bash
# Type check
npx tsc --noEmit

# Run tests
npx vitest run

# Watch mode
npx vitest

# Lint
npm run lint
```

Style guide: `docs/friday-style-guide.md`

- All public types use `Friday*` prefix
- All constants use `FRIDAY_*` prefix
- All factories use `createFriday*` naming
- Zero `as any` — strict TypeScript throughout

Release process: `docs/RELEASING.md`  
Security policy: `SECURITY.md`
Troubleshooting / self-recovery: `docs/TROUBLESHOOTING.md`  
Extending (plugins/skills/workflows): `docs/EXTENDING.md`  
Closed-loop blueprint: `docs/BLUEPRINT-CLOSED-LOOP.md`

---

## Acknowledgments

Inspired by and built upon patterns from [OpenClaw](https://github.com/openclaw/openclaw) (MIT licensed).

---

MIT License · See [LICENSE](LICENSE) for details.
