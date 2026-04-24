<p align="right">
  <a href="README.zh-CN.md">中文</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Your AI that grows with you.</strong><br>
  Part always-on personal AI. Part self-healing automation employee that turns repeated work into skills.<br>
  Self-hosted · BYOK · Approval-first
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node >=22">
  <img src="https://img.shields.io/badge/License-GPL--3.0--only-blue?style=flat-square" alt="GPL-3.0-only">
  <img src="https://img.shields.io/badge/npm-%40thesongzhu%2Ffriday-red?style=flat-square" alt="@thesongzhu/friday">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

## What Is Friday?

Friday is a self-hosted Agent OS that ships two products in one:

- **A personal AI** — chat, skills, memory, multi-channel inbox, desktop control. The always-on assistant that runs on your hardware.
- **An automation employee** — workflows, self-healing, approval gates, skill auto-generation. The bounded operator that turns repeated work into reusable artifacts.

You bring your own model/API keys. Friday runs locally by default. Sensitive credentials stay in environment variables or managed secret refs. High-risk actions go through explicit approval.

## What It Looks Like

Four 30-second snapshots of how Friday earns its keep — both as a personal AI and as an automation employee.

### 1. It Evolves Itself, And Repairs Itself

You say once: *"From now on weekly reports should give me 3 insights, not a list of details."* Friday writes that into memory. Next week the report skill rewrites accordingly. The week after, the skill fails — Friday diagnoses the cause, patches the skill, runs self-tests, then pings you for approval before reusing it.

### 2. Incident Hits At 3 AM, It Acts First, You Approve Second

Slack `#alerts` fires a 5xx spike. A workflow triggers. Friday diagnoses it as OOM, drafts a PR raising the memory limit, posts it to Slack and waits. You tap approve, it merges, runs the verify workflow, and replies ✓. Every fix step is gated.

### 3. Half An Hour Of Repeated Work Becomes A Skill

Every Monday you spend 30 minutes triaging GitHub PRs, pulling metrics, and writing a summary. Friday watches you do it once, asks four clarifying questions, drafts a skill, runs self-tests, and waits for your review. Next Monday it runs on its own and you only read the output.

### 4. Preferences Stop Needing Repetition

You mention once: *"Use pnpm, deploy only via GitHub Actions."* Friday writes it to `memory/preferences.md` with a confidence score and timestamp. Three months later when you spin up a new project it picks pnpm and writes the GHA workflow. Switch to bun next year? Open the markdown file, change one line — no retraining.

## Why Now?

Recent agent discussions around long-term memory, reusable skills, self-healing loops, and tool security keep converging on the same problems:

- Memory needs structure, retrieval, and human visibility, not just a longer context window.
- Skills make agents powerful, but untrusted skills are a supply-chain and local-execution risk.
- Self-improvement is useful only when it produces reusable artifacts, tests, evidence, and rollback paths.
- Self-healing must stay supervised for destructive, credentialed, or production-sensitive actions.
- Context compaction and vague instructions can erase important boundaries, so approvals and audit trails matter.

Friday's answer is a practical one: make memory, skills, workflows, observability, and approval gates part of the product instead of relying on one endless chat thread.

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

| Platform | Method | Status |
| --- | --- | --- |
| macOS / Linux / Windows | `npm install -g @thesongzhu/friday` | Published on npm as `1.0.0` |
| Source | `git clone` + `npm install` + `npm run build` | Available |
| Docker | `docker compose -f docker/docker-compose.yml up --build` | Available from this repo |

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

## Community

- **Discord** — chat with us at [discord.gg/qXQRFg2u](https://discord.gg/qXQRFg2u) for help, skill sharing, and roadmap discussion.
- **Issues** — bugs and feature requests via [GitHub Issues](https://github.com/thesongzhu/Friday/issues).
- **Security** — see [SECURITY](.github/SECURITY.md) for vulnerability reporting.

## Open Source Readiness

Friday is open-source software under the license in [LICENSE](LICENSE). Before publishing a public source snapshot, review [Open Source Release Review](docs/open-source-release-review.md).

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

## Third-Party Notices

Friday includes compatibility and adaptation work for third-party agent ecosystem formats and behavior. See [NOTICE](NOTICE) for preserved upstream copyright and license notices.
