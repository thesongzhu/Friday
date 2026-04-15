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
  <img src="https://img.shields.io/badge/Tests-10000%2B-success?style=flat-square" alt="Tests">
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square" alt="TypeScript">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
  <a href="https://discord.gg/x2rd4WsY"><img src="https://img.shields.io/discord/1234567890?style=flat-square&logo=discord&label=Discord&color=5865F2" alt="Discord"></a>
</p>

---

## What is Friday?

Friday is not just another AI tool — it's a self-hosted AI companion that **learns your habits, remembers your preferences, and gets better the more you use it**.

Bring your own API keys. Install skills like apps. Connect your favorite messaging platforms. Friday runs on your machine, your data stays with you.

> Think of Friday as your personal AI that starts as a helpful assistant and gradually becomes an indispensable partner in everything you do.

---

## What Friday Can Do

<table>
<tr>
<td width="50%">

### Chat & Execute
30+ built-in tools, 52+ skills. Ask Friday to research, write, code, analyze, automate — and it actually does it, not just talks about it.

</td>
<td width="50%">

### Visual Workflows
Drag-and-drop DAG workflow builder. Chain skills, rules, and conditions visually. One-click deploy to hub or edge satellites. Live execution tracing.

</td>
</tr>
<tr>
<td>

### 10 Messaging Platforms
Discord · Slack · Telegram · WhatsApp · Signal · LINE · IRC · QQ · Lark · Webchat — one Friday, everywhere you chat. Per-channel allowlists and health monitoring.

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

### Skill Marketplace & Generator
AI-powered skill generation with self-test before save. Marketplace with 0% commission — users directly support creators. Shell safety scanner blocks 20+ dangerous patterns.

</td>
<td>

### Desktop Automation
Cross-platform desktop control: click, type, screenshot, scroll, drag on macOS / Windows / Linux. Action recording & replay. All operations pass through the Rules Engine.

</td>
</tr>
<tr>
<td>

### Distributed Fleet
Hub + satellite architecture. Capability-based workflow placement. Heartbeat monitoring, offline detection, and explicit blocking state — no silent fallback. Fleet dashboard at `/fleet`.

</td>
<td>

### Security & Audit
JWT + RBAC. SHA-256 hash-chained tamper-evident audit trail. SSRF guards. Capability grants with expiration. Multi-tenant ready. SIEM export (JSONL + webhook).

</td>
</tr>
<tr>
<td>

### Full Observability
Distributed tracing across all modules. SLO monitoring with multi-window burn-rate alerting. Cost dashboard per provider. Alert pipeline: webhook, email, Slack, PagerDuty.

</td>
<td>

### macOS Native Companion
Swift/AppKit desktop app. launchd auto-start. Passkey-based remote access. Desktop shortcuts and notification actions. Sparkle auto-updates with delta releases.

</td>
</tr>
<tr>
<td>

### BYOK — Your Keys, Your Data
Connect directly to OpenAI, Anthropic, Google, or any compatible provider. Provider health monitoring, circuit breakers, automatic fallback to cheaper models when budgets tighten.

</td>
<td>

### Quality Gates & Acceptance
Per-artifact pass/fail/warn verdicts with evidence chains. Schema, threshold, quality, and custom checks. Determinism > 99.5%. Escape rate < 1%. Every decision auditable.

</td>
</tr>
</table>

---

## Quick Start

**Option 1 — npm (recommended)**

```bash
npm install -g friday
friday start
# Open http://localhost:3141
```

**Option 2 — From source**

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday && npm install && npm run build
npm start
```

**Option 3 — Docker**

```bash
cd docker
docker-compose up -d
# Open http://localhost:3141
```

> **First time?** Friday will guide you through setup — connect your API key, pick a persona, and you're ready to go.

---

## Download

| Platform | Method | Status |
|----------|--------|--------|
| **macOS / Linux / Windows** | `npm install -g friday` | Available |
| **macOS** | Native DMG + Homebrew | Coming soon |
| **Linux** | `.deb` / `.AppImage` | Available |
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

Skills are like apps for Friday. Install from the marketplace, import from archives, or generate with AI. Each skill is sandboxed, verified, and version-tracked.

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
