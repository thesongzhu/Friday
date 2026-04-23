<p align="right">
  <a href="README.zh-CN.md">中文</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Your AI that grows with you.</strong><br>
  Self-hosted. Skill-driven. Memory-aware. Approval-first.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node >=22">
  <img src="https://img.shields.io/badge/License-GPL--3.0--only-blue?style=flat-square" alt="GPL-3.0-only">
  <img src="https://img.shields.io/badge/npm-%40thesongzhu%2Ffriday-red?style=flat-square" alt="@thesongzhu/friday">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

## What Is Friday?

Friday is a self-hosted Agent OS for people who want an AI assistant that can do real work on their own machine without pretending to be magic.

It can chat, use installed skills, generate missing skills through a reviewable flow, run workflows, remember durable context, diagnose failures, propose repairs, and ask for approval before high-risk actions. You bring your own model/API keys. Friday runs locally by default, and sensitive credentials should stay in environment variables or managed secret refs.

The long-term vision is an **AI automation employee**: not a passive chatbot, but a bounded operator that learns your context, turns repeated work into reusable skills or workflows, and gets more useful over time while staying inspectable.

## Why Now?

Recent agent discussions around [Hermes Agent](https://hermes-agent.ai/), [agent memory](https://hermes.xaapi.ai/features/memory), [skills](https://docs.openclaw.ai/skills), and [agent security](https://docs.openclaw.ai/security) keep converging on the same problems:

- Memory needs structure, retrieval, and human visibility, not just a longer context window.
- Skills make agents powerful, but untrusted skills are a supply-chain and local-execution risk.
- Self-improvement is useful only when it produces reusable artifacts, tests, evidence, and rollback paths.
- Self-healing must stay supervised for destructive, credentialed, or production-sensitive actions.
- Context compaction and vague instructions can erase important boundaries, so approvals and audit trails matter.

Friday's answer is a practical one: make memory, skills, workflows, observability, and approval gates part of the product instead of relying on one endless chat thread.

## What Friday Can Do Today

### Skills And Tools

- Discover installed and bundled skills, including skills you have not used before.
- Prefer the right installed skill for review, QA, release, workflow, security, writing, diagramming, and automation-style requests when skill routing is enabled.
- Scan local AI skill locations such as `~/.claude`, `~/.cursor`, `~/.codex`, local project skill folders, workflow folders, and managed Friday skills.
- Import or convert supported sources into Friday skills, then validate, install, refresh the registry, and run them by ID or intent.
- Convert supported `SKILL.md` style skills, ADK-style skills, n8n nodes, OpenAPI/GPT Actions, code repositories, archives, Git URLs, and desktop recordings when the converter can detect a clear capability.
- Generate a new skill when no existing skill fits, including clarification questions, draft files, safety checks, explicit self-test evidence, approval, save, and immediate registry refresh.
- Ask you first when a new skill is not defined clearly enough. Friday is not an infinite auto-complete system and should not invent unclear tools silently.

### Memory And Context

- Load workspace context from `context/AGENTS.md`, `context/SOUL.md`, `context/USER.md`, `context/MEMORY.md`, and daily notes under `memory/`.
- Store learned preferences with confidence and decay so tone, directness, and guidance can adapt over time.
- Search memory and session history through runtime APIs when configured.
- Keep memory human-readable and editable instead of hiding it only in opaque embeddings.

### Workflows And Automation

- Build visual workflows with skills, conditions, rules, and evidence.
- Deploy workflow drafts through product APIs instead of manually chaining compile, publish, run, export, and trace steps.
- Run automations, retry failures, expose evidence, and pause when repeated failures suggest the system should stop.
- Place work across hub and registered satellites when the fleet surface is configured.

### Self-Healing And Observability

- Detect incidents, diagnose likely causes, propose fixes, run low-risk repairs, verify results, and roll back or pause when needed.
- Require approval for high-risk or destructive changes.
- Expose traces, audit logs, health, costs, SLOs, alerts, retry evidence, and rule decisions to operators.
- Keep expert autonomy opt-in and bounded by policy, approvals, and runtime permissions.

### Channels And Desktop

- Connect Discord, Slack, Telegram, WhatsApp, Signal, LINE, IRC, QQ, Lark, and webchat when credentials and channel wiring are configured.
- Use desktop automation for click, type, screenshot, scroll, drag, and app/window actions when the native companion and OS permissions are ready.
- Treat unavailable integrations as explicit blocked states, not silent fallbacks.

## What Friday Is Not

- It is not an unrestricted autonomous hacker or sysadmin.
- It does not safely run arbitrary third-party skills without review.
- It does not guarantee that every GitHub repo, document, or vague idea can be converted into a working skill automatically.
- It does not bypass model limits. Small or weak tool-calling models will have limited agent behavior.
- It does not remove your responsibility to secure the host machine, API keys, network exposure, and installed extensions.

## Quick Start

**Option 1 - npm package**

```bash
npm install -g @thesongzhu/friday
friday start
# Open http://localhost:3141
```

**Option 2 - from source**

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm install
npm run build
npm start
# Open http://localhost:3141
```

**Option 3 - Docker from source**

```bash
docker compose -f docker/docker-compose.yml up --build
# Open http://localhost:3141
```

First run setup depends on your provider keys, local permissions, and which optional surfaces you enable.

## Download And Distribution

| Platform | Method | Current status |
| --- | --- | --- |
| macOS / Linux / Windows | `npm install -g @thesongzhu/friday` | Published on npm as `1.0.0` |
| Source | `git clone` + `npm install` + `npm run build` | Available |
| Docker | `docker compose -f docker/docker-compose.yml up --build` | Available from this repo |
| macOS native app | DMG/Homebrew packaging scripts | Pipeline exists, public signed artifact not yet published |
| Linux packages | `.deb` / `.AppImage` packaging scripts | Pipeline exists, public artifacts not yet published |
| Windows native installer | MSI/native shell | Planned |
| iOS / Android | Mobile/remote console | Planned |

The official npm package is `@thesongzhu/friday`. The unscoped `friday` package on npm is unrelated.

## Skill Lifecycle

```bash
friday list
friday import ./my-skill.friday.tgz
friday import ./path/to/SKILL.md
friday import https://github.com/example/skill-repo.git
```

Supported import paths are deliberately bounded. Friday can detect, convert, validate, and install supported skill-like sources, but unclear sources should go through clarification or manual review before execution.

## Security Posture

- Use environment variables or `secret://...` references for credentials.
- Review third-party skills before installing them.
- Keep Friday behind local/private network boundaries unless you have configured auth, CORS, TLS/proxying, and least-privilege access.
- Treat desktop, shell, browser, file, channel, and network tools as powerful capabilities that need explicit policy.
- Run release checks before publishing or deploying: `npm run release:verify:repo` for repo health, and `npm run release:verify` for real runtime proof.
- See [Security](.github/SECURITY.md) for vulnerability reporting.

## Open Source Readiness

Friday is open-source software under the license in [LICENSE](LICENSE). Before publishing a public source snapshot, review [Open Source Release Review](docs/open-source-release-review.md). The current repo contains generated audit/proof artifacts that should be pruned or redacted before a clean public launch.

---

<p align="center">
  <a href="docs/README.md">Documentation</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href=".github/CONTRIBUTING.md">Contributing</a> ·
  <a href=".github/SECURITY.md">Security</a> ·
  <a href="LICENSE">GPL-3.0-only License</a>
</p>

<p align="center">
  <sub>Built to grow with you, without losing the boundary.</sub>
</p>
