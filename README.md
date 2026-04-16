<p align="right">
  <a href="README.zh-CN.md">中文</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Your AI that grows with you.</strong><br>
  Self-hosted. Skill-driven. Always learning.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node ≥22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/Release%20Truth-evidence--driven-blue?style=flat-square" alt="Release Truth">
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square" alt="TypeScript">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
  <a href="https://discord.gg/x2rd4WsY"><img src="https://img.shields.io/discord/1234567890?style=flat-square&logo=discord&label=Discord&color=5865F2" alt="Discord"></a>
</p>

---

## What is Friday?

Friday is not just another AI tool — it's a self-hosted AI companion that **learns your habits, remembers your preferences, and gets better the more you use it**.

Bring your own API keys. Install skills like apps. Connect your favorite messaging platforms. Friday runs on your machine, your data stays with you.

> Think of Friday as your personal AI that starts as a helpful assistant and gradually becomes an indispensable partner in everything you do.

## Runtime Snapshot

This README is a **runtime snapshot**, not a blanket release-proof promise.

- Some surfaces below are operator-only, env-gated, permission-gated, or empty until configured.
- `npm test` and browser suites that depend on mock hub wiring are useful regressions, but they are **not** release proof.
- For the active contract, use [`docs/current-source-of-truth.md`](docs/current-source-of-truth.md).
- For release evidence rules, use [`docs/release-evidence-policy.md`](docs/release-evidence-policy.md).

---

## Current Runtime Surface

<table>
<tr>
<td width="50%">

### Chat & Execute
Built-in tools and managed skills. Ask Friday to research, write, code, analyze, and automate through the tools and skills currently installed and enabled on this runtime.

</td>
<td width="50%">

### Visual Workflows
Drag-and-drop DAG workflow builder. Chain skills, rules, and conditions visually. One-click deploy to hub or edge satellites. Live execution tracing.

</td>
</tr>
<tr>
<td>

### Messaging Integrations (Env-Gated)
Discord · Slack · Telegram · WhatsApp · Signal · LINE · IRC · QQ · Lark · Webchat — one Friday, everywhere you chat when the channel credentials and runtime wiring are configured. Per-channel allowlists and health monitoring.

</td>
<td>

### Memory & Adaptive Persona
16-personality MBTI templates with 9 tunable dimensions. Bayesian confidence decay on learned facts. Friday's tone, directness, and guidance style evolve to match you.

</td>
</tr>
<tr>
<td>

### Self-Healing with Supervision
Closed-loop incident pipeline: detect → diagnose → risk-rate → propose fix → get approval → execute → verify → rollback if needed → learn. Auto-pauses after 3 consecutive failures.

</td>
<td>

### Rules Engine & Policy
YAML-based rule DSL with allow/deny/warn/audit decisions. Pre- and post-execution hooks gate every action. 100% of rule decisions recorded with context. Zero unsafe-action escapes.

</td>
</tr>
<tr>
<td>

### Skill Generator & Safety
AI-powered skill generation with self-test before save. Shell safety scanner blocks 20+ dangerous patterns. Each skill is sandboxed, verified, and version-tracked.

</td>
<td>

### Desktop Automation (Permission-Gated)
Cross-platform desktop control: click, type, screenshot, scroll, drag on macOS / Windows / Linux. Action recording & replay. Availability depends on machine permissions, companion readiness, and Rules Engine policy.

</td>
</tr>
<tr>
<td>

### Distributed Fleet
Hub + satellite architecture. Capability-based workflow placement. Heartbeat monitoring, offline detection, and explicit blocking state — no silent fallback.

</td>
<td>

### Security & Audit
JWT + RBAC. SHA-256 hash-chained tamper-evident audit trail. SSRF guards. Capability grants with expiration. Tenant-isolation building blocks exist in code, but multi-tenant runtime surfaces are env-gated and not enabled by default. SIEM export (JSONL + webhook).

</td>
</tr>
<tr>
<td>

### Observability (Operator-Facing)
Distributed tracing across all modules. SLO monitoring with multi-window burn-rate alerting. Cost dashboard per provider. Alert pipeline: webhook, email, Slack, PagerDuty.

</td>
<td>

### Import & Enablement (Bounded)
Drop in a skill or workflow and Friday can verify and wire it up through imports, deep links, or generation flows. Some assets still depend on source configuration, preflight checks, and runtime permissions.

</td>
</tr>
<tr>
<td>

### BYOK — Your Keys, Your Data
Connect directly to OpenAI, Anthropic, Google, or any compatible provider. Provider health monitoring, circuit breakers, automatic fallback to cheaper models when budgets tighten.

</td>
<td>

### Quality Gates & Acceptance (Advanced)
Per-artifact pass/fail/warn verdicts with evidence chains. Schema, threshold, quality, and custom checks. Advanced and operator-heavy by default.

</td>
</tr>
</table>

---

## Quick Start

**Option 1 — npm package**

```bash
npm install -g @thesongzhu/friday
friday start
# Open http://localhost:3141
```

**Option 2 — From source**

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday && npm install && npm run build
npm start
# Open http://localhost:3141
```

**Option 3 — Docker**

```bash
cd docker
docker-compose up -d
# Open http://localhost:3141
```

> **First time?** Friday will guide you through setup. The exact path depends on which providers, permissions, and optional surfaces are available on this machine.

---

## Download

| Platform | Method | Status |
|----------|--------|--------|
| **macOS / Linux / Windows** | `npm install -g @thesongzhu/friday` | Available |
| **macOS** | Native DMG + Homebrew | Coming soon |
| **Linux** | `.deb` / `.AppImage` | Coming soon |
| **Docker** | `docker-compose up -d` | Available |
| **iOS / Android** | Mobile console | Planned |

---

## Good to Know

<details>
<summary><b>BYOK — Bring Your Own Keys</b></summary>

Friday never stores or proxies your API keys through third-party servers. You connect directly to OpenAI, Anthropic, Google, or any OpenAI-compatible provider. Your keys, your data, your control.

</details>

<details>
<summary><b>Workspace Context</b></summary>

Friday loads personality and memory files from your project:

- `context/AGENTS.md` — repo rules and task routing
- `context/SOUL.md` — response style and personality
- `context/USER.md` — your preferences
- `context/MEMORY.md` — durable project knowledge
- `memory/YYYY-MM-DD.md` — daily notes

Edit these files and Friday adapts immediately — no restart needed.

</details>

<details>
<summary><b>Skills System</b></summary>

Skills are like apps for Friday. Import from archives or generate with AI. Each skill is sandboxed, verified, and version-tracked.

```bash
friday list              # See installed skills
friday import ./my.tgz   # Install a skill
```

</details>

<details>
<summary><b>Security First</b></summary>

- JWT authentication with role-based access control
- Hash-chained audit trail (tamper-evident)
- Shell safety scanner blocks dangerous commands
- SSRF guards on all outbound requests
- Capability grants with expiration and revocation
- All operations require explicit approval for destructive actions

</details>

---

## Important Notes

- **API keys are required.** Friday uses your own API keys (Anthropic, OpenAI, Google, etc.) to call LLM providers. You are responsible for any costs incurred. Friday never proxies your keys through third-party servers.
- **Small models have limited capabilities.** Models with fewer than 7 billion parameters (e.g., `llama3.2:3b`, `phi-3-mini`) cannot reliably use tools/function calling. Friday automatically disables tool declarations for these models to prevent hallucinated tool invocations. For full agent capabilities (web search, code execution, browser automation, etc.), use models with 7B+ parameters.
- **Self-hosted means self-managed.** Friday runs on your machine. You are responsible for securing access, managing API keys, and keeping dependencies up to date.
- **Not a substitute for professional advice.** AI-generated outputs may contain errors. Always verify critical information independently.
- **npm package name.** The official npm package is `@thesongzhu/friday`. The unscoped `friday` package on npm is an unrelated project.

---

<p align="center">
  <a href="docs/README.md">Documentation</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href=".github/CONTRIBUTING.md">Contributing</a> ·
  <a href=".github/SECURITY.md">Security</a> ·
  <a href="https://discord.gg/x2rd4WsY">Discord</a> ·
  <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <sub>Built with care. Grows with you.</sub>
</p>
