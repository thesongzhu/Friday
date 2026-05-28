<p align="right">
  <a href="README.zh-CN.md">中文</a>
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>The trusted application layer for AI agents to do real work.</strong><br>
  Give Friday a goal, let it use configured tools, and keep approval, memory, evidence, and rollback in the loop.<br>
  Local-first · BYOK · Approval-first · Human-controlled · Evidence-backed
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522-brightgreen?style=flat-square" alt="Node >=22">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT">
  <img src="https://img.shields.io/badge/npm-%40thesongzhu%2Ffriday-red?style=flat-square" alt="@thesongzhu/friday">
  <img src="https://img.shields.io/badge/Release%20Truth-public%20v1%20local%20candidate-blue?style=flat-square" alt="Release Truth: public v1 local candidate">
  <img src="https://github.com/thesongzhu/Friday/actions/workflows/ci.yml/badge.svg" alt="CI">
</p>

---

## What Is Friday?

Friday is a self-hosted personal AI and automation runtime: a local-first application layer that helps AI agents turn user-approved goals into verified work.

It is meant to feel less like a blank chatbot and more like a private execution partner: you give a goal, Friday checks what it can do, uses configured capabilities, asks for the human-only pieces, executes, verifies the result, and records what it learned. Capability acquisition and self-upgrade flows are active work and should be treated as review-gated WIP rather than a fully autonomous promise.

Friday is not a magic fully autonomous system. It will not create accounts for you, bypass CAPTCHA, pay for services, take production-changing actions, or use credentials you have not provided. Its job is to do the work it can safely do, stop clearly when it needs you, and leave evidence behind.

## Current Release Posture

Friday is a **public v1 local candidate** distributed via **npm/source only**, not a release-complete claim for every integration in the repository.

- Current public claims focus on the local UI, local runtime, BYOK setup, supervised operator workflows, memory, evidence, approval-gated tool use, and configured trusted-channel inbound on Discord, Telegram, and Lark/Feishu (proven by same-SHA Real Green Gate channel artifacts).
- The current proof track does not claim outbound channel control automation, cloud live certification, external OTEL/Grafana export, desktop / Homebrew / notarized macOS / mobile distribution, "all integrations live", or release-complete-all.
- Slack HTTP Events-API inbound and QQ remain **`unsupported`** in this release.
- Real Green Gate success is counted only when the artifact is for the same SHA, has nonzero scenarios, all scenarios pass, and blockers are empty.
- `blocked_by_env`, mock-only tests, workflow success alone, stale artifacts, and wrong-SHA artifacts are not release proof.
- Dogfood gate for `1.0.1` closed as **`dogfood_partial_pass`** (UX 7.78/10 weighted). The published npm `1.0.2` package still carries the original nine proof-pending headlines. GitHub-visible source after `1.0.2` has closed several deterministic slices and is staged as a `1.0.3` package candidate, but `1.0.3` is not published until a future authorized release; see [`docs/public-v1-local-candidate.md`](docs/public-v1-local-candidate.md).

## The Product Loop

1. **You give a goal.** Example: "Read these PDFs, compare them with the latest web results, and save a short summary with citations."
2. **Friday checks capabilities.** It looks for text, vision, OCR, web search, PDF, file, browser, optional channel, model, memory, and workflow support.
3. **Friday reports or drafts gap closure.** It can search installed skills, trusted catalogs, MCP servers, local files, package registries, OpenAPI specs, and the web for candidate tools or skills. Generated or imported skills start as candidates, not as immediately runnable capabilities.
4. **Friday asks when humans are required.** API keys, OAuth, paid plans, CAPTCHA, logins, sensitive permissions, and high-risk actions go through a human gate.
5. **Friday runs and verifies.** It executes through skills, tools, workflows, browser/desktop control, or channel adapters, then checks the result.
6. **Friday learns safely.** It can store auditable memories, learned facts, routing signals, setup recipes, candidate skills, eval cases, and failure lessons. Learned signals do not automatically become unquestioned truth.

## What Friday Can Do

| Area | What Friday is built to do | Boundary |
| --- | --- | --- |
| Chat and task execution | Answer, plan, execute tool-backed work, show progress, and recover from failures | Depends on configured providers and granted tools |
| Text, vision, OCR, PDF, files | Route work to configured providers or built-in parsers, then report what is missing when a lane is unavailable | Vision/OCR/TTS depend on provider support and credentials |
| Web and browser work | Use configured web search providers, local browser control, and workflow steps | Login, payment, CAPTCHA, and sensitive accounts require the user |
| Skills and workflows | Import, validate, stage, promote, run, verify, update, and roll back reusable skills/workflows where the lifecycle is closed | Generated or imported skills are candidates until review, canary, and promotion gates pass; workflow upgrade proof is not identical to skill lifecycle proof |
| Memory and self-improvement | Store explicit preferences, learned facts, lessons, provider routing signals, recipes, evals, and recovery notes | User-visible, auditable, and reversible; learned signals are not hidden model training, unquestioned truth, or guaranteed prompt behavior |
| Self-healing | Detect failures, propose fixes, and run low-risk repairs only where the path is wired, configured, and evidence-backed | Dispatcher-style auto-fix is default-off; high-risk or data-changing repairs require approval, receipts, and rollback or an explicit non-reversible record |
| Optional channel adapters | Connect Discord, Telegram, and Feishu/Lark trusted-inbound (proven via same-SHA Real Green Gate channel artifacts on the release SHA) where configured; other configured channels remain optional surfaces | Channels are configured-only surfaces; outbound channel control automation is not part of the public v1 local release claim; Slack HTTP Events-API inbound and QQ are `unsupported`; sensitive actions still require confirmation |
| Long-running goals | Run user-authorized standing goals, create agenda items, gather evidence, and report outcomes | Friday is goal-driven by the user; it does not invent unrelated long-term agendas |

## Setup

### Option 1 - npm package

```bash
npm install -g @thesongzhu/friday
friday start
# Open http://localhost:3141
```

### Option 2 - from source

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
bash scripts/ops/friday-first-run.sh
# Or on macOS, double-click "Friday Setup.command"
```

The first-run helper installs dependencies, builds Friday, starts the local runtime, and opens the setup page. On macOS it also installs the login startup agent and menu bar companion so Friday can come back after restart. If you run it from Desktop, Documents, or Downloads, it prepares the launchd-safe runtime at `~/Friday` automatically before installing the login agents.

### Option 3 - manual source start

```bash
git clone https://github.com/thesongzhu/Friday.git
cd Friday
npm install
npm run build
npm start
# Open http://localhost:3141
```

### Option 4 - Docker from source

```bash
docker compose -f docker/docker-compose.yml up --build
# Open http://localhost:3141
```

First-run setup guides you through providers, local permissions, and optional capabilities. Channel setup is optional and must verify the configured channel before it is treated as available. After setup, Friday should open directly to Home.

## Providers And Keys

Friday is BYOK: you bring the model and search/API credentials you want to use.

The setup flow should answer four questions for every capability:

- **Do I have this capability?**
- **If not, what exactly is missing?**
- **Where do I configure it?**
- **After configuration, can Friday verify it with a real task?**

Typical provider lanes include OpenAI, Doubao/Volcengine, Moonshot, Anthropic, Google, OpenRouter, Tavily, Serper, local browser/PDF/file tooling, MCP servers, and custom skills. A missing key or account is not treated as success; Friday should show it as a human blocker with the next configuration step.

## Capability Self-Acquisition (WIP)

When Friday does not have a capability for a goal, the target closed loop is:

```text
goal -> capability gap -> candidates -> sandbox/test -> approval if required -> install/register -> doctor verify -> execute
```

This loop is not yet a blanket production guarantee. Current builds can report gaps and exercise parts of the workflow, while generated skills, self-upgrades, and adjustment-fidelity paths remain review-gated and covered by ongoing stress tests. Allowed automatic steps depend on policy. Searching, analysis, draft generation, and sandbox verification are low-risk by default. Downloading code, installing packages, writing config, registering tools, shell access, and external network calls are governed by the autonomy policy. OAuth, payment, CAPTCHA, API keys, sensitive permissions, and production writes always require the user.

## Memory, Growth, And Repair

Friday's self-improvement is intentionally boring and inspectable:

- **Memory facts:** preferences, project rules, recurring context, and user corrections.
- **Routing preferences:** which provider worked best for which kind of job.
- **Recipes:** setup and recovery steps that worked.
- **Skills and workflows:** generated or improved artifacts with tests and evidence.
- **Eval cases:** fixed scenarios that should keep passing.
- **Failure lessons:** what broke, what fixed it, and when to stop retrying.

This is not model-weight training. It is auditable state and reusable artifacts that the user can inspect, edit, pause, or delete.

## Safety Model

Friday follows a simple rule: automate the boring parts, keep the user in control of irreversible or sensitive parts.

- Local-first runtime and local state by default.
- Bring-your-own keys; credentials should live in environment variables, managed secret refs, or OS-backed secret storage.
- Capability grants have scope, reason, evidence, and expiry.
- High-risk actions require explicit approval.
- Tool calls, workflow runs, self-healing runs, and channel actions leave audit evidence.
- Failed installs or generated capabilities must support rollback.
- Public network exposure requires explicit auth, CORS, TLS/proxying, and least-privilege access.

## What Friday Is Not

- It is not a guarantee of universal automation.
- It is not a fully autonomous system that can do every task without you.
- It does not bypass logins, CAPTCHA, payment, platform rules, or provider limits.
- It does not safely run arbitrary third-party code without review.
- It does not remove your responsibility to secure the host, API keys, accounts, and connected channels.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Documentation Hub](docs/README.md)
- [Trust Model](TRUST.md)
- [Privacy](PRIVACY.md)
- [Responsible Use](RESPONSIBLE_USE.md)
- [Roadmap](ROADMAP.md)
- [Vision](docs/VISION.md)
- [Capability Matrix](docs/ops/friday-capability-matrix.md)
- [Extending Friday](docs/EXTENDING.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Contributing](.github/CONTRIBUTING.md)
- [Security](.github/SECURITY.md)

## Download And Distribution

| Platform | Method | Status |
| --- | --- | --- |
| macOS / Linux / Windows | `npm install -g @thesongzhu/friday` | Currently published on npm as `1.0.2`; npm/source-only distribution; R5 same-SHA Real Green Gate proof passed on the `1.0.2` release SHA; fresh isolated public install audit reports `0` vulnerabilities |
| Source | `git clone` + `npm install` + `npm run build` | Available |
| Docker | `docker compose -f docker/docker-compose.yml up --build` | Available from this repo |

The official npm package is `@thesongzhu/friday`. The unscoped `friday` package on npm is unrelated.
Repository metadata is staged as a `1.0.3` package candidate for the next operator-authorized publish; the npm registry latest remains `1.0.2`.
Linux and Windows desktop companion behavior should be read through the platform-specific capability checks and release evidence, not as a completed native desktop release claim. Desktop, Homebrew, notarized macOS, and mobile distribution are not claimed in `1.0.2`.

## Community

- **Discord** - [discord.gg/qXQRFg2u](https://discord.gg/qXQRFg2u)
- **Issues** - [GitHub Issues](https://github.com/thesongzhu/Friday/issues)
- **Security** - [SECURITY](.github/SECURITY.md)

## License

Friday is open-source software under the [MIT license](LICENSE).

## Third-Party Notices

Friday includes compatibility and adaptation work for third-party agent ecosystem formats and behavior. See [NOTICE](NOTICE) for preserved upstream copyright and license notices.
