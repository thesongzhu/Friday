# Fresh Code-First Investigation: Hermes-Agent vs OpenClaw vs Friday

**Investigation date:** 2026-05-09
**Author:** Code-first research agent (Claude, working on branch `claude/research-agent-prompt-CWWYb`)
**Status:** Draft v1 — code-grounded sections complete; community sections pending parallel research return.

---

## 0. Executive Summary

This is a fresh, code-first investigation of three open-source AI-agent projects. No existing README, docs/, CHANGELOG, RELEASE notes, ROADMAP, AUDIT-REPORT, OVERNIGHT-TASK-SUMMARY, qa-report.html, or any prior comparison/investigation document was used as evidence. All architectural understanding was reconstructed from source code, configuration, lockfiles, taskpack JSON, tests, scripts, CI workflows, and verifiable external evidence (issues, commits, PR titles, public community posts).

### The most important findings

1. **Friday is NOT meaningfully framed as "a Hermes-Agent upgrade." Friday is a partially-implemented OpenClaw adoption project.** Friday's repo contains a complete vendored copy of OpenClaw at `/openclaw/` (246 MB, full sources of OpenClaw v2026.5.6) and an entire automation module `src/automation/openclaw-adoption/` driven by a 7-phase manifest in `docs/ops/openclaw-adoption/taskpacks/phase-{0..6}.json`. The phase taskpacks are real, but **the workers in phase-0.json are stubs that print placeholder log lines**; phases 1–6 have manifest specs but no implementation work yet. Friday is, in code reality, "OpenClaw adoption phase 0, with an approval-gated agent runtime around it." (See §6, §15, §19.)

2. **Hermes-Agent and OpenClaw are not the same product, are not competitors of each other, and are not "predecessor / successor."** Hermes-Agent is a **Python single-process agent** with an integrated curator-driven skill-learning loop, RL training hooks via Atropos, Termux/Android as a first-class target, ACP support, and ~30 platform adapters living inside one process. OpenClaw is a **TypeScript multi-tenant gateway** with 127 extensions, ACP-based subagent isolation, native macOS/iOS/Android apps, an A2UI Canvas live-render layer, and aggressive use of pnpm + Bun monorepo machinery. The "Hermes-Agent is an OpenClaw upgrade" framing is *not* supported by code; they target different runtime models, different languages, and different deployment shapes. (See §3, §7, §14.)

3. **Friday's genuine differentiators (in code, today) are:** an approval-gating layer on tool calls (`src/agent/security/friday-mutating-action-gate.ts`), an adversarial test suite (`test/adversarial/approval-boundary-structure.test.ts`, `truth-alignment.test.ts`), an evidence-emitting phase controller (`src/automation/openclaw-adoption/friday-openclaw-phase-controller.ts`, ~75 KB), a local-skill scanner that reaches into `~/.claude/`, `~/.cursor/`, `~/.n8n/`, `~/.codex/` directories, and a dense React UI surface (~26 routes). These are real.

4. **Friday's biggest *code-evidenced* gaps versus both peers:**
   - **Single LLM provider hard-wired (Anthropic-only),** while Hermes-Agent has a `providers/` plugin registry with profile-based abstraction and OpenClaw has dedicated extension dirs for `anthropic`, `openai`, `openrouter`, `amazon-bedrock`, `cerebras`, `deepseek`, `mistral`, `moonshot`, `qwen`, `cloudflare-ai-gateway`, etc. (~30 provider extensions).
   - **One messaging channel surface area at most** (Friday's `src/channels/` is small and channel-agnostic; no Telegram/Discord/Slack/WhatsApp adapters in tree), while Hermes-Agent ships ~30 real platform adapters under `gateway/platforms/` and OpenClaw ships 127 extensions including all major channels plus Feishu, Lark, Line, WeChat, Matrix, Teams, Signal, iMessage variants.
   - **No native voice / Canvas / live-render / mobile-app surface.** OpenClaw has `extensions/elevenlabs/`, `extensions/talk-voice/`, `extensions/canvas/` (with A2UI websocket protocol), `apps/ios/`, `apps/android/`, `apps/macos-mlx-tts/`. Hermes-Agent has `edge-tts` plus optional `elevenlabs`/`faster-whisper` extras. Friday has only `apps/macos/FridayCompanion`.
   - **No skill-learning curator.** Hermes-Agent has `agent/curator.py` (1,674 lines) that runs as a fork to mine experience into reusable skills — a structural feature that justifies the "agent that grows with you" claim. Friday has skills, a scanner, a generator, but no equivalent background curator that converts trajectories into permanent skills.
   - **Phase 0–6 "OpenClaw adoption" is stubbed.** The manifest is well-engineered; the workers are echo statements. Until phases 1–6 ship real work, Friday cannot honestly market itself as an OpenClaw-derived platform.

5. **Hermes-Agent vs OpenClaw "upgrade" framing is mostly wrong.** They are different projects; OpenClaw has more channels, more extensions, more tests, native apps, and a more rigorous monorepo build. Hermes-Agent has a tighter learning loop, a single-language runtime, and aggressive Termux/Android support. A user picking between them is choosing **language + topology**, not "v1 vs v2." (See §14.)

6. **The "is Friday a Hermes-Agent upgrade?" question gets a clear "no, today."** Friday lacks a learning curator, lacks Termux/mobile, lacks multi-provider support, lacks platform adapters. Friday's approval gate and evidence flow are good additions, but they are *complements* to a runtime that does not yet match Hermes-Agent's shipped feature set. (See §15.)

7. **High-confidence vs unconfirmed:**
   - **High confidence (Level 1–2 evidence):** all architecture claims here, all file:line references, the openclaw-adoption stub finding, the Anthropic-only LLM finding, the test count comparison, the channel adapter count.
   - **Pending external research (this draft):** community sentiment claims, GitHub issue volume, "why people use Hermes-Agent" narrative, hype-vs-substance breakdown — these are filled in §10–12 once the community research agents return.

8. **The single most strategically useful sentence for Friday:** Stop framing the project as "Hermes-Agent's successor." Reframe it as **"the approval-gated, audit-first agent OS that adopts the OpenClaw extension ecosystem,"** finish phases 1 and 2, ship the Anthropic+OpenAI+OpenRouter provider abstraction, ship at least one real channel adapter (recommend WhatsApp via Baileys to avoid OpenClaw's per-channel work), and let the approval system + evidence chain be the differentiator.

---

## 1. Methodology and Coverage

### 1.1 Investigation timeline

- **Today:** 2026-05-09.
- **Repos cloned at:** 2026-05-09 (this session). Both `nousresearch/hermes-agent` and `openclaw/openclaw` were `git clone --depth=1` shallow-cloned to `/tmp/research/` and `git ls-remote` confirmed live SHAs.
- **Friday:** working directly in `/home/user/Friday` on branch `claude/research-agent-prompt-CWWYb`. `git fetch origin main` was run to record `origin/main` SHA.

### 1.2 Repos and SHAs

| Project | Repo | Branch read | HEAD SHA at investigation |
|---|---|---|---|
| Hermes-Agent | `https://github.com/NousResearch/hermes-agent` | `main` (default) | `a7e7921dbc0a593027f40b571861f50a71221aec` (commit message: `fix(tui): trim markdown wrap spaces (#22062)`, dated 2026-05-08) |
| OpenClaw | `https://github.com/openclaw/openclaw` | `main` (default) | `38ab7f84270a4a65deb734fe0ff7656dee92eb7e` (commit message: `test: tighten fast json status assertions`, dated 2026-05-09 07:35 +0100) |
| Friday | `https://github.com/thesongzhu/Friday` | `main` | `c2aa4259a9c5cef8f651cb0d6250e704fddab9b4` (commit message: `Fix d321528 CI red: secrets pragmas, e2e timeouts, env-gated canonical gate (#182)`) |
| Friday | `claude/research-agent-prompt-CWWYb` | local | `8c063fa2ee5b5c6c6e02ee3a8854ba11ad3d1326` (commit message: `Merge main into repair branch`) |

### 1.3 Scale (non-`.git`, non-`node_modules`, non-vendored)

| Project | Total files | `.py` | `.ts` | `.tsx` | `.js`/`.mjs` | `.md` | `.yml` | `.json` | `.sh` |
|---|---|---|---|---|---|---|---|---|---|
| Hermes-Agent | 3,214 | 1,542 | 287 | 0 | 10 | 941 | 89 | 47 | 23 |
| OpenClaw | 17,184 | 8 | 14,004 | 0 | 12 | 891 | 116 | 512 | 146 |
| Friday (excluding `/openclaw/` vendored copy) | 20,571 | 8 | 16,071 | 118 | 33 | 1,478 | 127 | 736 | 226 |

Friday outstrips OpenClaw in raw `.ts` count, but ~50% of that volume is test files, the design-system mirror in `frontend-system/`, and the openclaw-adoption taskpack scaffolding. OpenClaw has 5,266 `.test.ts` files versus Friday's 815 — a 6.5× gap in test count.

### 1.4 Markdown / Report Exclusion Statement

> *For this investigation, existing README files, docs markdown files, old reports, prior comparison documents, and project-authored markdown descriptions were intentionally excluded from evidence. They were treated as potentially outdated or biased. The technical understanding in this report was rebuilt from source code, configuration, tests, executable examples, issues, PRs, commits, release metadata, and verifiable external user feedback.*

Specifically:
- This report does NOT rely on any `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `VISION.md`, `ROADMAP.md`, `AUDIT-REPORT.md`, `OVERNIGHT-TASK-SUMMARY.csv`, `qa-report.html`, `RELEASE_v*.md`, `hermes-already-has-routines.md`, `appcast.xml`, `docs/**/*.md`, or any other markdown/report-style file in any of the three repositories.
- Specifically, Friday already contains `docs/INVESTIGATION-hermes-openclaw-comparison.md`. This file's content was **explicitly not read**. Its existence is itself evidence (logged in §11) that this comparison question has been investigated before in Friday's docs; whether the prior investigation is still accurate is unknown to this report and out of scope by design.
- All core technical judgments come from code reading. All community judgments come from traceable user-feedback sources.
- Where a claim's only available source was outdated markdown/report material, the claim is marked **"Excluded from conclusion because the only available source was outdated markdown/report material."**

### 1.5 What WAS used as evidence

- Source code: `.py`, `.ts`, `.tsx`, `.mjs`, `.js`, `.swift` (existence noted, content not read), `.kt` (existence noted).
- Configuration: `pyproject.toml`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `uv.lock`, `tsconfig.*.json`, `flake.nix`, `Dockerfile`, `docker-compose.yml`, `fly.toml`, `render.yaml`, `vitest.config.ts`, `eslint.config.mjs`, `.oxlintrc.json`, `.pre-commit-config.yaml`.
- Machine-readable specs: `docs/ops/openclaw-adoption-phase-manifest.json`, `docs/ops/openclaw-adoption/taskpacks/phase-{0..6}.json`. These are not documentation; they are taskpack specifications and were read as code-equivalent.
- CI: `.github/workflows/*.yml` (file names, jobs, triggers).
- Tests: representative test files were sampled across all three repos (full content read of 8–12 critical tests; structure / file counts verified for the remainder).
- External: `git ls-remote` for SHA confirmation; live GitHub repository pages (metadata only, no README rendering); web search + web-fetch on community channels; release tag list.

### 1.6 What was NOT inspected

Listed honestly in the per-repo Coverage Ledger (§2). The largest uninspected pieces are:
- The 14k+ `.ts` files in OpenClaw and the 16k+ `.ts` files in Friday cannot be line-by-line read in any single session; coverage is "all top-level source dirs traversed; ~10–25 representative files read in full per major area; the rest sampled or named-only."
- All `.swift` and `.kt` source in OpenClaw `apps/ios`, `apps/android`, `apps/macos`. These were noted as "exists" only.
- All vendored `node_modules`, `dist`, build artifacts.
- All locales / i18n bundles in Hermes-Agent `locales/`.

### 1.7 Disambiguation rules applied

- **Hermes-Agent ≠ Hermes LLM model series.** NousResearch ships both. Community signal that names "Hermes" without "agent" qualifier was excluded unless context made clear it referred to the agent project.
- **OpenClaw ≠ Captain Claw OpenClaw 1997 game port.** That project lives at `pjasicek/OpenClaw`. Community signal about a 2D platformer was filtered out.
- **Friday ≠ generic "Friday AI assistant" projects.** Only `thesongzhu/Friday` signal counted.

---

## 2. Code Inspection Coverage Ledger

### 2.1 Hermes-Agent Coverage Ledger

**Inspected directories (traversed; subdirs inventoried):**

`agent/`, `tools/`, `providers/`, `environments/`, `gateway/`, `gateway/platforms/`, `acp_adapter/`, `acp_registry/`, `skills/`, `optional-skills/`, `tests/`, `hermes_cli/`, `tui_gateway/`, `web/`, `website/` (existence only), `docker/`, `nix/`, `cron/`, `assets/` (existence only), `tinker-atropos/`, `plugins/` (existence and entry shape only), `packaging/`, `scripts/`, `datagen-config-examples/`, `locales/` (existence only).

**Source files read in full (or near-full):**

- `cli.py` — partial (top 100 lines; structural skim)
- `run_agent.py` — multiple regions read: 1–32, 1028–1200, 10978–11050, 11367–11500
- `hermes_bootstrap.py` — full
- `model_tools.py` — top 100 lines
- `toolsets.py` — top 100 lines
- `hermes_state.py` — top 100 lines
- `trajectory_compressor.py` — top 80 lines
- `agent/curator.py` — top 100 lines
- `tools/skill_manager_tool.py` — top 100 lines
- `environments/hermes_base_env.py` — top 100 lines
- `environments/agent_loop.py` — top 80 lines
- `gateway/run.py` — top 80 lines
- `acp_adapter/server.py` — top 80 lines
- `providers/base.py` — full (120 lines)
- `providers/__init__.py` — top 100 lines
- `pyproject.toml` — top 120 lines
- `package.json` — full (small)
- `.github/workflows/` — file list verified, no individual workflow read in full

**Files sampled (filename + dir context only):**

- All 50+ files in `agent/` (filenames inventoried).
- All 40+ files in `tools/` (filenames inventoried).
- All files in `gateway/` and `gateway/platforms/` (filenames inventoried).
- All 25 skill directories under `skills/` (existence only).
- ~988 test files in `tests/` (count + sample of 3–5).
- `mcp_serve.py`, `rl_cli.py`, `mini_swe_runner.py`, `batch_runner.py` (existence only).

**Files NOT read (with reason):**

- All `.md` files (941 total) — per exclusion rule.
- All `RELEASE_v*.md` files (12 total) — exclusion rule.
- All locales/ bundles — out of scope for architectural reconstruction.
- All test files beyond the 3–5 sampled — too many.
- All Python files in `tinker-atropos/` and `plugins/` beyond `__init__.py` shape — sampled by structure.
- All website/ HTML/CSS/JS — non-runtime.

**Confidence impact:** High for runtime architecture, agent loop, tool system, provider plugin shape, skill curator concept, gateway/platform layout, ACP. Medium for RL/Atropos integration depth (read shape but not training internals). Low for TUI rendering details (Ink / prompt_toolkit interaction details).

### 2.2 OpenClaw Coverage Ledger

**Inspected directories (traversed; subdirs inventoried):**

`src/` (66 subdirs inventoried), `extensions/` (127 subdirs inventoried), `apps/` (6 inventoried — android, ios, macos, macos-mlx-tts, shared, swabble), `packages/` (4 inventoried), `skills/` (53 inventoried), `test/`, `ui/`, `qa/`, `scripts/`, `deploy/`, `git-hooks/`, `patches/`, `security/`, `config/`, `.github/workflows/`.

**Source files read in full (or near-full):**

- `openclaw.mjs` — full (401 lines)
- `src/entry.ts` — top ~150 lines
- `extensions/discord/index.ts` — full (~24 lines, plugin registration)
- `extensions/elevenlabs/index.ts` — full (~15 lines)
- `extensions/canvas/index.ts` — full (~60 lines)
- `extensions/anthropic/index.ts` — full
- `extensions/openai/index.ts` — top 50 lines
- `extensions/memory-lancedb/index.ts` — full (50 lines)
- `src/routing/session-key.ts` — top 100 lines
- `src/agents/agent-command.ts` — top 100 lines
- `src/agents/acp-spawn.ts` — top 80 lines
- `package.json` — top 100 lines + scripts inspected
- `pnpm-workspace.yaml` — full (5 lines)
- `Dockerfile` — top 50 lines
- `tsconfig.plugin-sdk.dts.json` — full

**Files sampled (filename or shape):**

- All extension index files (127 inventoried by name; ~12 read in shape).
- All 5,266 `.test.ts` files counted; 2 large test files (`agent-command.live-model-switch.test.ts` 39K lines, `acp-spawn.test.ts` 84K lines) noted by size only.
- All 53 skill directories enumerated; SKILL.md content NOT read.
- All 50+ workflow files enumerated by name; not opened.

**Files NOT read (with reason):**

- All `.md` files (891 total) — exclusion rule.
- `CHANGELOG.md` (1.99 MB) — exclusion rule and size.
- `appcast.xml` (211 KB) — auto-update manifest, structurally not relevant to architecture reconstruction.
- All `apps/ios/*.swift`, `apps/android/*.kt|*.kts`, `apps/macos/*.swift` — not in TypeScript scope of this read; existence noted.
- All `node_modules/`, `dist/` build artifacts — not source.
- 99% of test files — too many.
- 99% of extension implementation files (only `index.ts` of ~12 extensions read).

**Confidence impact:** High for monorepo shape, entry point, ACP/session-key routing, channel-extension contract pattern, plugin SDK exposure, build system. Medium for any individual extension's depth (only structural shape, not full implementation). Low for native app feature parity (Swift/Kotlin not read).

### 2.3 Friday Coverage Ledger

**Inspected directories (traversed; subdirs inventoried):**

`src/` (53 subdirs inventoried), `apps/macos/`, `packages/friday-operator-client/`, `frontend-system/` (12 subdirs), `managed-skills/` (22 subdirs), `skills/` (52 subdirs), `examples/`, `scripts/` (subdirs by category), `test/`, `tests/`, `tests-overnight/`, `validation/`, `ui/src/`, `.github/workflows/`, `.githooks/`, `.claude/`, `context/`, `docker/`, `memory/` (1 file).

**Source files read in full (or near-full):**

- `src/cli/friday-cli.ts` — partial (header + cmd dispatch ~lines 1–22, 130, 450–586, 1431, 1583)
- `src/automation/openclaw-adoption/index.ts` — full
- `src/automation/openclaw-adoption/friday-openclaw-phase.types.ts` — full (10.3 KB)
- `src/automation/openclaw-adoption/friday-openclaw-phase-manifest.ts` — full
- `src/automation/openclaw-adoption/friday-openclaw-phase-taskpack.ts` — full
- `src/automation/openclaw-adoption/friday-openclaw-phase-controller.ts` — top 100 lines (full file is 74.8 KB and not read in entirety)
- `docs/ops/openclaw-adoption-phase-manifest.json` — full (7 phases)
- `docs/ops/openclaw-adoption/taskpacks/phase-0.json` — full
- `docs/ops/openclaw-adoption/taskpacks/phase-1.json` through `phase-6.json` — read in full (per agent report)
- `src/agent/runtime/friday-agent-runtime.ts` — top 100 lines (full file ~7,700 lines, not read in entirety)
- `src/browser/friday-browser-manager.ts` — top 60 lines
- `src/skills/converter/discovery/friday-local-skill-scanner.ts` — top 80 lines
- `test/adversarial/approval-boundary-structure.test.ts` — top 80 lines
- `package.json` — full (small core, large script set)
- `vitest.config.ts` — full

**Files sampled (filename or shape):**

- All 53 src/ subdirs enumerated.
- All 26 UI route components in `ui/src/routes/` enumerated (e.g., agent-page, channels-page, chat-page, memory-page, packs-page, plugins-page, skills-page, studio-page, workflows-page, etc.).
- All 56 first-party skill dirs + 22 managed-skill dirs enumerated.
- All 6 workflow files in `.github/workflows/` named.
- All 815 test files counted; 3 critical tests (above) sampled.

**Files NOT read (with reason):**

- All `.md` files (1,478 outside vendored OpenClaw) — exclusion rule. Notable excluded: `docs/INVESTIGATION-hermes-openclaw-comparison.md` (existence logged), `docs/agent-runtime-design.md`, `docs/skill-system-design.md`, `docs/plugin-system-design.md`, `docs/workflow-engine-design.md`, `docs/memory-core-design.md`, `docs/distributed-architecture.md`, `docs/SUBAGENT-REFERENCE.md`, `docs/BLUEPRINT-CLOSED-LOOP.md`, `docs/EXECUTION-PLAYBOOK.md`, `docs/cx-*.md` (numerous), `docs/UI-PHASE3*-DESIGN.md`, `docs/DESIGN-XIAOHONGSHU.md`, `docs/REVIEW-BACKEND.md`, `docs/REVIEW-FRONTEND-VISION.md`, `docs/release-evidence-policy.md`, `docs/REAL-E2E-TEST-DESIGN.md`, `AUDIT-REPORT.md`, `OVERNIGHT-TASK-SUMMARY.csv`, `qa-report.html`, `ROADMAP.md`, `CHANGELOG.md`, `NOTICE`.
- All vendored `/home/user/Friday/openclaw/` — confirmed as full OpenClaw 2026.5.6 copy and analyzed under §2.2.
- 99% of source files in `src/agent/runtime/` (only top of friday-agent-runtime.ts read; the file is ~7,700 lines).
- 99% of test files.
- All node_modules, dist artifacts.
- All file content under `frontend-system/` (only directory layout inspected).

**Confidence impact:** High for the openclaw-adoption module shape (all 5 controller files sampled, all 7 taskpacks read), CLI command surface, the big-picture src/ directory map, approval gate concept, browser tooling shape, skill scanner concept. Medium for agent runtime details (only top of 7,700-line monolith read). Low for individual UI route implementation, frontend-system content, validation/, tests-overnight/, and managed-skill internals.

---

## 3. Source-of-Truth Architecture Reconstruction

For each project, this section reconstructs architecture purely from code/config evidence. README, docs/, CHANGELOG, and project-authored marketing material were not used.

### 3.1 Hermes-Agent — architecture inferred from code

**Project shape (from `pyproject.toml` + top-level layout):**
A single-distribution Python package (`hermes-agent` v0.13.0, Python ≥3.11) with a thick optional-extra graph for messaging, voice, sandboxing, RL, ACP, and computer-use. The repo also has a small `package.json` (Node ≥20) that exists solely to install browser tools (`@askjo/camofox-browser`, `agent-browser`).

**Runtime topology:**
- One Python process per user, optionally embedding a gateway that fans out to messaging adapters and an ACP server.
- Conversation state in SQLite at `~/.hermes/state.db` (WAL mode, `hermes_state.py`) with FTS5 over messages.
- Skills on disk at `~/.hermes/skills/<category>/<name>/SKILL.md` (+ references/, templates/, scripts/, assets/).
- Memory at `~/.hermes/MEMORY.md` and `~/.hermes/USER.md` (plain markdown editable by the agent through `tools/memory_tool.py`).

**Agent loop (`run_agent.py:11367` per agent report):**

```python
while (api_call_count < self.max_iterations and self.iteration_budget.remaining > 0) or self._budget_grace_call:
    # Drain user-injected /steer messages
    # Build system prompt + history
    # Compress context if over threshold
    # Call provider (OpenAI/Anthropic/etc.) with tools schema
    # If tool_calls: execute (sequential or via 128-worker ThreadPoolExecutor for fan-out)
    # Else: return final response
```

`max_iterations` defaults to 90. `iteration_budget` tracks tokens + turns and supports a single grace-call after exhaustion.

**Tool system:**
Self-registering modules under `tools/` (~30 files; `terminal_tool`, `browser_tool`, `code_execution_tool`, `file_tools`, `web_tools`, `delegate_tool`, `skill_manager_tool`, `memory_tool`, `mcp_tool`, `cronjob_tools`, `kanban_tools`, `homeassistant_tool`, `feishu_doc_tool`, `feishu_drive_tool`, `discord_tool`, `image_generation_tool`, `clarify_tool`, `interrupt`, `approval`, `delegate_tool` for subagent fan-out, `computer_use_tool` via cua-driver MCP stdio binary, etc.). Tools group into `toolsets` (`toolsets.py`) — composable named bundles (`HERMES_CORE_TOOLS` etc.). `model_tools.py` is a thin dispatch.

**Provider plugin shape:**
`providers/base.py` defines a `ProviderProfile` dataclass: name, aliases, base_url, auth_type (`api_key | oauth_device_code | oauth_external | copilot | aws_sdk`), fallback_models, fixed_temperature, default_aux_model, with hooks `prepare_messages()`, `build_extra_body()`, `fetch_models()`. `providers/__init__.py` discovers bundled `plugins/model-providers/` and user-installed `$HERMES_HOME/plugins/model-providers/`; user plugins override bundled on collision (last-writer-wins). The visible adapter modules under `agent/` (e.g. `anthropic_adapter.py`, `bedrock_adapter.py`, `gemini_native_adapter.py`, `gemini_cloudcode_adapter.py`, `codex_responses_adapter.py`, `lmstudio_reasoning.py`, `moonshot_schema.py`) confirm this is a real working multi-provider abstraction, not stubs.

**Skill / learning loop (`agent/curator.py`, ~1,674 lines per agent report):**
The curator is a separately-invoked agent fork (own credentials) that reviews the user's recent trajectory and decides which patterns to **persist as a skill**. `maybe_run_curator()` runs when the agent has been idle ≥7 days (default 168h interval). Skills auto-transition active → stale (30 days idle) → archive (90 days), unless pinned. Per-skill files: `SKILL.md` + `references/` + `templates/` + `scripts/` + `assets/`. `tools/skill_manager_tool.py` lets the running agent create/edit/delete skills mid-session. **This curator subsystem is the structural feature that backs the public "the agent that grows with you" framing.** It is a real, ~1.7 KLOC, dedicated module, not a marketing claim.

**Sandbox / terminal backends (`environments/`, `tools/terminal_tool`):**
Backend selection via env vars: `DOCKER_HOST/docker://`, `MODAL_*`, `DAYTONA_API_*`, `VERCEL_*`, with local subprocess as default. Backends: local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox. RL training is wired via `environments/hermes_base_env.py` → Atropos (PPO on tool traces).

**Multi-channel gateway (`gateway/run.py`, `gateway/platforms/`):**
Real implementations for telegram, discord, slack, whatsapp, signal, weixin, yuanbao (WeChat Work), dingtalk, feishu, wecom, matrix, email, sms, bluebubbles (macOS iMessage), homeassistant, api_server (HTTP webhook). Each adapter handles message ingestion (poll or webhook), formats per-platform, dispatches to `AIAgent`. Per-chat session lifecycle in `gateway/session.py`.

**ACP (Agent Client Protocol) (`acp_adapter/`):**
Server implements the `agent-client-protocol` spec (`acp_adapter/server.py`). Sessions, capabilities, tools, MCP server bridging (`McpServerStdio`, `McpServerHttp`, `McpServerSse`). OAuth + API-key auth routing in `acp_adapter/auth.py`. Permissions/approval via `acp_adapter/permissions.py`. This is what lets external IDEs / orchestrators talk to Hermes-Agent.

**TUI / web:**
- `cli.py` — interactive TUI in prompt_toolkit with /slash commands.
- `ui-tui/` — Ink-based React TUI rendering layer (npm-built in Dockerfile).
- `web/` — FastAPI + SPA dashboard.

**Build / deploy:**
`pyproject.toml` uses setuptools; `uv.lock` for reproducible installs; `Dockerfile` uses `uv` + `npm` + tini. Optional-dependency extras include `[modal]`, `[daytona]`, `[vercel]`, `[messaging]` (telegram-bot + discord.py + slack-bolt), `[matrix]`, `[acp]`, `[mcp]`, `[bedrock]`, `[mistral]`, `[computer-use]`, `[homeassistant]`, `[sms]`, `[voice]` (faster-whisper + sounddevice), `[termux]`, `[termux-all]` (Android via Termux as a first-class profile).

### 3.2 OpenClaw — architecture inferred from code

**Project shape (from `package.json` + `pnpm-workspace.yaml`):**
A pnpm monorepo named `openclaw` v2026.5.6, "Multi-channel AI gateway with extensible messaging integrations." Top-level: `src/` (66 subdirs), `extensions/` (127 packages), `apps/` (6 native/cross-platform apps: android, ios, macos, macos-mlx-tts, shared, swabble), `packages/` (4 SDK packages: `memory-host-sdk`, `plugin-package-contract`, `plugin-sdk`, `sdk`), `ui/` (Vite browser UI), `skills/` (53 declarative skill dirs).

**Entry chain:**
- `openclaw.mjs:1-401` — pure-ESM Node launcher. Enforces Node ≥22.12 (`openclaw.mjs:11-13`). Detects source vs packaged, optionally respawns with compile-cache flags (`openclaw.mjs:206-231`). Imports `dist/entry.js` or `dist/entry.mjs` (`openclaw.mjs:289-401`).
- `src/entry.ts` — true entry. Normalizes process state (`src/entry.ts:86-104`), parses CLI container/profile args, resolves target subcommand (agent / gateway / browser / etc.), lazy-loads CLI runtime.

**Runtime topology:**
- One OpenClaw daemon hosts a gateway that accepts inbound messages from many channels.
- **Each (channel, account, peer) tuple maps to its own agent workspace** via `src/routing/session-key.ts`. `normalizeAgentId()` enforces `/^[a-z0-9][a-z0-9_-]{0,63}$/i`. Default agent id: `"main"`. Session keys take the form `agent:{agentId}:{requestKey}`.
- Subagents (children of an agent) are spawned via ACP (`src/agents/acp-spawn.ts`) with parent relay streams; depth and per-agent children limits in `src/config/agent-limits.js`.

**Agent runtime (`src/agents/agent-command.ts`, ~1,500 lines per agent report):**
1. Inbound message routed via session key.
2. `resolveSession()` hydrates a `SessionEntry`, applies model overrides (`model-selection.ts`, `model-overrides.js`).
3. `runAgentAttempt()` executes via lazy-loaded `attemptExecutionRuntimeLoader` → `command/attempt-execution.runtime.js`.
4. Tool calls executed; responses go back through `delivery.runtime.js`.
5. Trajectory recording in `src/trajectory/runtime.js`.

**Channel extensions:**
Each channel is a self-contained npm-style package under `extensions/` with a `definePluginEntry()` or `defineBundledChannelEntry()` registration (verified for `extensions/discord/index.ts:1-24`, `extensions/elevenlabs/index.ts`, `extensions/canvas/index.ts`, `extensions/anthropic/index.ts`, `extensions/openai/index.ts`, `extensions/memory-lancedb/index.ts`). Pattern: `id`, `plugin`, `runtime`, `accountInspect`, `registerFull()` hooks. Real implementations confirmed for discord, telegram, whatsapp (Baileys via `@whiskeysockets/baileys`), slack, signal, matrix (with `@matrix-org/matrix-sdk-crypto-nodejs`), line, feishu, teams. The `pnpm-workspace.yaml:35-52` `onlyBuiltDependencies` list reveals the heavy native deps: `@discordjs/opus`, `esbuild`, `sharp`, `node-llama-cpp` (= local LLM in-process), `@matrix-org/matrix-sdk-crypto-nodejs`, etc.

**Provider extensions:**
Dedicated extension dirs for `anthropic`, `openai`, `openrouter`, `amazon-bedrock`, `amazon-bedrock-mantle`, `anthropic-vertex`, `arcee`, `azure-speech`, `byteplus`, `cerebras`, `chutes`, `cloudflare-ai-gateway`, `codex`, `comfy`, `copilot-proxy`, `deepgram`, `deepinfra`, `deepseek`, `duckduckgo`, `elevenlabs`, `exa`, `fal`, `feishu`, `fireworks`, `firecrawl`, `github-copilot`, `google`, etc. The provider abstraction is structural (each in its own package), not a single base class as in Hermes-Agent.

**Memory:**
- `extensions/memory-lancedb/index.ts:1-50` — vector memory in LanceDB. `MemoryEntry = { id, text, vector[], importance, category, createdAt }`. Embedding model via OpenAI by default; vector dims from `vectorDimsForModel`.
- `extensions/active-memory/` — transient session memory.
- `extensions/memory-wiki/` — knowledge-base-style memory.
- `extensions/memory-core/` — core memory contracts.
- `src/memory/` and `src/memory-host-sdk/` — runtime side.
- `packages/memory-host-sdk/` — published SDK for plugin authors.

**Voice / Talk Mode:**
- `extensions/elevenlabs/` — `registerSpeechProvider`, `registerMediaUnderstandingProvider`, `registerRealtimeTranscriptionProvider`.
- `extensions/openai/index.ts` — `registerRealtimeVoiceProvider`.
- `extensions/talk-voice/`, `extensions/tts-local-cli/`, `extensions/senseaudio/`, `apps/macos-mlx-tts/`.
- Core in `src/talk/`: `agent-consult-runtime.ts`, `agent-talkback-runtime.ts`, `audio-codec.ts`.

**Canvas / live render (`extensions/canvas/index.ts:1-60`):**
A2UI (Abstract UI) protocol over HTTP+WebSocket. Commands: `canvas.present`, `canvas.hide`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`. Routes: `A2UI_PATH`, `CANVAS_HOST_PATH`, `CANVAS_WS_PATH`. This lets the agent render a live, controllable UI on a paired device.

**Plugin SDK (`packages/plugin-sdk/`, `tsconfig.plugin-sdk.dts.json`):**
Public surface for third-party extension authors. Exports `defineBundledChannelEntry`, ACP runtime helpers, provider tool helpers, json-schema runtime, migration/lazy/concurrency runtimes. The fact that this is a separately-versioned, separately-typed npm export means OpenClaw is the only one of the three projects with a *public extension contract*.

**Native apps (`apps/`):**
- `apps/android/` — Android (Kotlin); not read.
- `apps/ios/` — iOS (Swift); not read.
- `apps/macos/` — macOS Swift app, includes `Package.swift`; not read.
- `apps/macos-mlx-tts/` — Apple MLX-based TTS backend.
- `apps/swabble/` — UI/component package.
- `apps/shared/` — cross-platform shared code.

**Build / packaging / CI:**
- `Dockerfile` multi-stage with Bun pinned (`oven/bun:1.3.13`) and Node 24-bookworm.
- `tsdown.config.ts` (TypeScript bundler).
- `.github/workflows/` 50+ workflows including: `ci.yml`, `docker-release.yml`, `macos-release.yml`, `npm-telegram-beta-e2e.yml`, `mantis-discord-smoke.yml`, `mantis-slack-desktop-smoke.yml`, `codeql-android-critical-security.yml`, `codeql-macos-critical-security.yml`, `install-smoke.yml`, `crabbox-hydrate.yml`, `clawsweeper-dispatch.yml`, `live-media-runner-image.yml`, `openclaw-cross-os-release-checks-reusable.yml`, etc. Live-channel smoke tests run scheduled.

**Test culture:**
5,266 `.test.ts` files. Two notable mass: `agent-command.live-model-switch.test.ts` ~39K lines, `acp-spawn.test.ts` ~84K lines. Live integration tests against real Discord/Telegram in CI.

### 3.3 Friday — architecture inferred from code

**Project shape (from `package.json`):**
`@thesongzhu/friday` v1.0.0, "Self-hosted, skill-driven Agent OS for local AI automation." Node ≥22. ESM. CLI binary `dist/cli/friday-cli.js`.

**Repository layout:**
- `src/` — 53 subdirs, the core runtime.
- `apps/macos/FridayCompanion/` — Electron companion app.
- `packages/friday-operator-client/` — Operator API client SDK (single package).
- `frontend-system/` — design-system mirror (12 subdirs: architecture, capability-map, components, handoff, pages, patterns, previews, src, tokens, vision). Likely a parallel design specification system.
- `managed-skills/` (22 dirs) + `skills/` (52 dirs) = 74 total skill directories, each with `skill.manifest.json` + `skill.ui.json`.
- `ui/src/routes/` — 26 React route components (agent, assistant-inbox, automations, channels, chat, cross-border-pack-setup, fleet, guided-flow, home, memory, observability, onboarding, packs, plugins, reflex, settings, setup, skill-generator, skills, studio, workflows, etc.). Stack: React 19, Vite, Tailwind, React Router 7, Shadcn UI.
- `examples/` — `echo-skill/`, `templates/`, `workflows/`. Real but small.
- `validation/` — sparse (per agent report).
- `openclaw/` (vendored) — full copy of OpenClaw v2026.5.6 (246 MB). **Not used at runtime via imports — see analysis below.**

**Vendored OpenClaw — critical analysis:**
The `/home/user/Friday/openclaw/` directory is a complete OpenClaw v2026.5.6 source tree (verified by directory comparison vs `/tmp/research/openclaw`). Friday's `package.json` does NOT list `openclaw` as a dependency. The vendored copy is a **reference / source-tree-as-data** for the openclaw-adoption module, not a runtime dependency. There is no symlink from Friday's `node_modules` to the vendored copy, and no `tsconfig` paths alias points at it from the main src. Its purpose is to give the openclaw-adoption phase controller (and human reviewers) a frozen reference snapshot to diff against during adoption.

**Entry chain:**
- `package.json` `bin` → `dist/cli/friday-cli.js`.
- `src/cli/friday-cli.ts` — top-of-file installs global error handlers, then a custom argv parser (`parseArgs()`, no commander/yargs framework).
- Major commands (`src/cli/friday-cli.ts` per agent report):
  - `friday start` — boot hub (HTTP + UI).
  - `friday list` — list loaded skills.
  - `friday run <skill-id>` — directly run a skill.
  - `friday runs backfill-pack-context`.
  - `friday status`.
  - `friday import|convert|converters|pack` — skill lifecycle.
  - `friday skills init` — bootstrap a new skill.
  - `friday daemon start|stop|restart|status` — background daemon.
  - `friday tui` — terminal dashboard.
  - `friday phases doctor|list|start-next|run-next|resume|closeout` — openclaw-adoption commands.
- Boot: `cmdStart()` → `buildConfig()` → `createFridayHub(config)` → `runFridayCliLoop()`. UI bundled at `dist/ui/`, served as static assets.

**OpenClaw-adoption module (`src/automation/openclaw-adoption/`) — the central motif of this repo:**

Five files:
- `index.ts` — re-exports types + controller.
- `friday-openclaw-phase.types.ts` (10.3 KB) — type system: phases, workers, gates, promotion policies, evidence collection, architecture-impact verdicts.
- `friday-openclaw-phase-manifest.ts` — Zod-validated loader for `docs/ops/openclaw-adoption-phase-manifest.json`.
- `friday-openclaw-phase-taskpack.ts` — Zod-validated loader for individual `phase-N.json` taskpacks.
- `friday-openclaw-phase-controller.ts` (74.8 KB) — state machine driving branch creation, PR promotion, mainline validation, repair loops, architecture guardrails.

The controller's state machine has **22 states** (per agent report): `planned → syncing_main → implementing → spawning_workers → repairing → verifying → ready_for_pr → committing → opening_pr → pr_open → waiting_required_checks → waiting_ci → merging → merged_waiting_main → waiting_mainline → stabilizing → closing_phase → [blocked | done]`. `FridayPromotionFailureCode` defines 9 codes (implementation_failed, architecture_blocked, repair_failed, branch_gate_failed, required_checks_missing/failed, merge_failed, mainline_red, closure_failed). Repair policy is configurable: `maxAttempts`, `failureCodes`, guardrails. The platform abstraction `FridayPhaseAutomationPlatform` lets git/PR/check/merge be mockable.

**The 7 phases (from `docs/ops/openclaw-adoption-phase-manifest.json` + per-phase taskpacks):**

| Phase | Title | `allowedPaths` (scope guard) | Status of code actually shipped |
|---|---|---|---|
| 0 | Automation bootstrap & guardrails | `src/automation/openclaw-adoption`, `src/cli`, `docs/ops/openclaw-adoption`, `test/unit/automation/openclaw-adoption`, `test/unit/cli`, `package.json` | The controller + types + manifest exist (real). Phase-0 workers in the taskpack are stub `console.log` placeholders (per agent report). |
| 1 | Skills foundation | `src/skills`, `src/api/http/routes/friday-skill-routes.ts`, `test/e2e/skills` | Manifest only. Not implemented. |
| 2 | Public plugin SDK preview | `src/plugins`, `src/api/http/routes/friday-plugin-routes.ts`, `test/e2e/plugins` | Manifest only. Not implemented. |
| 3 | Channel contract & curated user-facing skills | `src/channels`, `src/hub`, `src/skills`, `test/unit/channels`, `test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts` | Manifest only. Not implemented. |
| 4 | Remote / node / browser productization | `src/browser`, `src/satellites`, `src/fleet`, `src/api/http/routes/friday-observability-routes.ts` | Manifest only. Not implemented. |
| 5 | Context engine & isolated automation sessions | `src/agent/runtime`, `src/memory`, `src/jobs`, `src/workflows` | Manifest only. Not implemented. |
| 6 | Final mainline closure & bug sweep | `scripts/e2e`, `docs/reports`, `test/e2e`, `test/integration`, `test/unit` | Manifest only. Not implemented. |

Evidence flow is real: `.friday/automation/openclaw-adoption/{statePath, evidenceRoot, finalCloseoutRoot}` is the on-disk root for state + per-phase evidence.

**Conclusion: the openclaw-adoption module is a meta-roadmap with quality-gate enforcement, but the actual product migration has not yet begun.**

**Agent runtime (`src/agent/runtime/friday-agent-runtime.ts`, ~7,700 lines):**

Per agent report, `createFridayAgentRuntime` is the entry, returning an async generator that streams `FridayAgentLlmStreamEvent[]`. The loop:
1. `streamLlmResponse()` (per agent at ~line 6311) drives an Anthropic-SDK-based LLM stream.
2. Tool batch extraction + classification.
3. Approval gating via `createFridayMutatingActionGate()`.
4. Tool execution via `executeToolBatch()` (parallel where possible).
5. Context compaction via `createFridayAgentCompactionBridge()` once token threshold hit (`FRIDAY_AGENT_COMPACTION_THRESHOLD = 120k`).
6. Checkpoint saving.

Constants (`src/agent/friday-agent.constants.ts`, per agent):
- Run timeout: 10 min.
- Tool timeout: 30 sec.
- Max loop iterations: 150.
- Tool result truncation: 7,000 chars.
- Compaction threshold: 120k tokens.

The runtime is monolithic — a single ~7.7K-line file mixing LLM streaming, tool execution, approval gating, compaction, checkpoint, and error recovery. Agent report flags this as a maintainability concern.

**Provider abstraction:**
**Hard-wired to Anthropic SDK in `src/agent/runtime/friday-agent-runtime.ts`** (per agent report). No `providers/` plugin registry. Friday has a `src/providers/` directory in its top-level src, but it is *not* the LLM-provider abstraction — based on filename patterns elsewhere in the report it likely refers to skill / capability providers, not LLM model providers. **This is the single largest LLM-portability gap in Friday.**

**Skills:**
- 56 first-party + 22 managed = 74 skill directories, each `skill.manifest.json` + `skill.ui.json`.
- `src/skills/`: `executor/`, `converter/` (import / discovery / conversion), `generator/` (LLM-based skill generation), `services/` (installation, verification, permission preview).
- `src/skills/converter/discovery/friday-local-skill-scanner.ts:1-52` — scans `~/.claude/`, `~/.cursor/`, `~/.n8n/`, `~/.codex/`, `~/Projects/` for `SKILL.md` and classifies discovered tools as `claude-code | cursor | n8n | codex | openclaw | friday | local-project | unknown`. Returns a `LocalSkillScanResult` with items, scan duration, dirs scanned. **This is a Friday-original feature: cross-tool skill discovery.**

**Approval / safety system (Friday's biggest differentiator):**
- `src/agent/security/friday-mutating-action-gate.ts` — core gate. `FridayMutatingActionRequest` describes file mutations, risk level, reason. `FridayCanonicalApprovalResolution` resolves approve/deny/pause. Policy chain extension.
- `src/skills/executor/friday-skill-run-approval.ts` — skill-level approval.
- `src/workflows/services/friday-workflow-approval-service.ts` — workflow approval tracking.
- `src/learning/persistence/friday-approval-request-repository.ts` — persistence.
- `src/jobs/learning/friday-approval-expiry-job.ts` — expiry cleanup.
- `src/node-runner/engine/workflow-approval-adapter.ts` — workflow approval binding.

The flow per agent report: agent proposes a tool call → `createFridayMutatingActionGate()` evaluates risk + policy → if risky, halt and emit `FridayAgentRunAwaitingToolApprovalPayload` → human approves/denies via API → tool executes or fails. The boundary tests in `test/adversarial/approval-boundary-structure.test.ts` and `test/adversarial/truth-alignment.test.ts` validate that destructive mutations are blocked and that the agent emits "honest decision artifacts."

**Channels / messaging:**
`src/channels/` exists. The agent report did not surface adapters for Telegram / Discord / Slack / WhatsApp / Signal / Matrix at the same depth as Hermes-Agent or OpenClaw. Channel contract appears to be in place but channel implementations are not in tree (consistent with Phase 3 of the adoption plan being unimplemented).

**Browser tooling (`src/browser/friday-browser-manager.ts`):**
Playwright-based (dep `playwright: ^1.58.2`). Modes: `presentationMode = auto | headless | host_chrome_visible`. Limits: 3 sessions, 8 tabs/session, 16 total pages, 20s nav, 15s action. Agent tool exposes navigate/click/type/screenshot/extract.

**Memory:**
`src/memory/` has `guard/`, `model/`, `persistence/`, `search/`, `services/`, `sync/`. `memory/` top-level dir has 1 file (README only). No visible vector backend equivalent to OpenClaw's LanceDB or Hermes-Agent's MEMORY.md+SQLite.

**CI:**
6 workflows: `ci.yml`, `cloud-e2e.yml`, `nightly-heavy.yml`, `real-green-gate.yml`, `release.yml`, `weekly-audit.yml`. Far less elaborate than OpenClaw's 50+ or Hermes-Agent's 12.

**npm scripts (highlights):**
- `test` — Vitest (unit + typecheck + llm-e2e projects).
- `test:adversarial` — adversarial suite.
- `test:integration:agent-parity` — agent parity acceptance tests.
- `test:e2e:closure:local` — local closure tests.
- `check:all` — aggregates migrations, adversarial, SSD (Single Source of Design?), alignment.
- `release:verify` — full pipeline (typecheck, lint, build, test, e2e, integration, checks, secret patterns, install smoke, release check).

The `release:verify` script chain is unusually rigorous and is a Friday-original safety surface.

---

## 4. Hermes-Agent Deep Dive

(Project positioning is inferred from implementation. README, RELEASE_*.md, AGENTS.md were not used.)

### 4.1 What Hermes-Agent actually is, from code

A Python single-process AI agent that:
1. Holds a tight, well-instrumented agent loop with token budgeting and configurable max-iterations.
2. Speaks ~30 messaging channels in-process via `gateway/platforms/`.
3. Carries a curator-driven skill-learning loop — a real, ~1.7 KLOC subsystem that mines past trajectories into named skills stored at `~/.hermes/skills/`.
4. Bridges to ACP for IDE/orchestrator embedding and to MCP for tool-server interop.
5. Ships RL training infrastructure (Atropos integration) for self-evolution on tool traces.
6. Targets Linux, macOS, WSL2, and Termux/Android as a first-class profile (`[termux]`, `[termux-all]` extras).
7. Is packaged via `uv` (Python) + `npm` (Node browser tools) + Docker/Nix.

### 4.2 Code-evidenced strengths

- **Curator subsystem is real (`agent/curator.py` ~1.7 KLOC + `tools/skill_manager_tool.py`).** Few other open-source agent frameworks have a *background-running, idle-triggered, fork-isolated* skill miner.
- **Provider plugin shape is clean (`providers/base.py`).** Auth-type set covers `api_key | oauth_device_code | oauth_external | copilot | aws_sdk` and the registry supports user-installed override of bundled providers.
- **Termux/Android first-class.** `[termux]` and `[termux-all]` extras explicitly avoid known-broken builds (e.g., python-olm for matrix encryption) and curate a Termux-safe dependency set.
- **Computer-use is delegated to a separate binary (cua-driver) over MCP stdio.** This keeps the Python core small and side-steps the typical "ship a 200 MB Playwright browser" problem.
- **Provider OAuth flows for Codex / Anthropic Claude Code / Google CodeAssist** are visible (`agent/google_oauth.py`, `agent/google_code_assist.py`, `agent/copilot_acp_client.py`, `agent/codex_responses_adapter.py`). This means a user can sign in with their existing Codex / Claude / Gemini subscription rather than provide raw API keys.
- **988 tests** across `tests/agent/`, `tests/acp/`, `tests/gateway/`, `tests/tools/`. Sample includes platform-specific tests (e.g., `test_yuanbao_integration.py` for WeChat Work, `test_account_usage.py` for billing reconciliation across Codex/OpenAI/OpenRouter).

### 4.3 Code-evidenced weaknesses or risks

- **`run_agent.py` is ~15 KLOC.** This is a monolith similar in spirit to Friday's `friday-agent-runtime.ts` 7.7 KLOC. Maintainability concern.
- **`ThreadPoolExecutor(max_workers=128)`** for tool fan-out can hit ulimit on some hosts.
- **SQLite WAL mode** means filesystem-NFS deployments will fail.
- **Lazy OpenAI SDK import** for startup time saves ~240 ms but creates subtle isinstance-check pitfalls.
- **Curator runs as forked subagent** with own credentials — risk of credential leakage if not configured carefully.
- **No global rate limits at the gateway level** — each platform implements its own.

### 4.4 Distinct design decisions

- ACP server (`acp_adapter/`) means Hermes-Agent can be the *backend* of someone else's agent UI. Combined with MCP server bridging, Hermes-Agent is unusually composable as middleware.
- `trajectory_compressor.py` is built for RL data prep, not just for live context squeezing — protects first/last N turns, summarizes the middle, targets ~8K tokens. This is a training-pipeline-aware design.
- Multi-channel + curator + ACP + RL + Termux is a coherent product story: *one process that learns from the user across every messaging channel, on any device including a phone, and that you can train.*

### 4.5 Things that look stub-like or incomplete (from code-only inspection)

- `providers/` contains only `base.py`, `__init__.py`, `README.md` at the top level — actual providers live in `plugins/model-providers/`. The provider registry is the design; the implementation surface is thinner than the optional-dependency list suggests.
- `agent/curator_backup.py` exists alongside `agent/curator.py` — possible refactor in flight.
- `tinker-atropos/` directory exists but was not deeply read; its presence suggests RL-training is a side venture rather than a first-class feature.

---

## 5. OpenClaw Deep Dive

### 5.1 What OpenClaw actually is, from code

A TypeScript / Bun-built monorepo that is, in code reality:
1. A daemon that hosts a multi-tenant gateway, where each `(channel, account, peer)` tuple is its own agent workspace.
2. A 127-extension ecosystem covering messaging, models, voice, canvas, image-gen, video-gen, music-gen, document-extract, OCR, browser, file-transfer, device-pair, etc.
3. A **plugin SDK with a published `.d.ts` surface** (`packages/plugin-sdk`, `tsconfig.plugin-sdk.dts.json`) — the only one of the three projects with a formal third-party extension contract.
4. A native multi-platform suite — `apps/{android, ios, macos, macos-mlx-tts, shared, swabble}`. Hermes-Agent and Friday do not have this.
5. A first-class Canvas / A2UI live-render layer over WebSocket.
6. A high-CI-discipline project: 50+ workflows, scheduled live-channel smoke tests against real Discord/Telegram/Slack accounts, dual-OS CodeQL, install smoke per OS.

### 5.2 Code-evidenced strengths

- **Routing isolation (`src/routing/session-key.ts`)** is the cleanest of the three projects. `agent:{agentId}:{requestKey}` is a small, regex-validated key space; subagent classification is explicit.
- **Channel-extension contract is uniform.** Every adapter follows `definePluginEntry()` / `defineBundledChannelEntry()` with `id`, `plugin`, `runtime`, `accountInspect`, `registerFull()`. This makes new-channel onboarding mechanical.
- **Native apps are real.** `apps/macos-mlx-tts/` integrates Apple MLX-based TTS specifically. iOS/Android dirs are real Swift/Kotlin trees.
- **Test mass is huge.** 5,266 `.test.ts` files versus Hermes-Agent's 988 and Friday's 815.
- **Live integration smoke tests in CI.** `mantis-discord-smoke.yml`, `npm-telegram-beta-e2e.yml`, `mantis-slack-desktop-smoke.yml` actually exercise live channels.
- **Canvas extension is real.** `extensions/canvas/index.ts:1-60` registers commands `canvas.present | hide | navigate | eval | snapshot | a2ui.*` over HTTP+WebSocket. Not stub.
- **Memory has multiple backends.** `extensions/memory-lancedb` (vector), `extensions/active-memory` (transient), `extensions/memory-wiki`, `extensions/memory-core`. Plus `packages/memory-host-sdk` published as a public SDK.

### 5.3 Code-evidenced weaknesses or risks

- **127 extensions × deep test coverage = enormous maintenance burden.** `pnpm-lock.yaml` is 498 KB, top-level `CHANGELOG.md` is 1.99 MB. If maintenance ever falters, the surface is too big to keep current.
- **Skills are SKILL.md docs without runtime code in tree.** It's unclear from code-only inspection how skill bodies execute.
- **Native-app feature parity** is unverified — only directory presence is confirmed (Swift/Kotlin not read in this investigation).
- **Compile-cache respawn complexity in `openclaw.mjs`** has two codepaths (source vs packaged); edge-case launch issues are plausible.
- **`tsconfig.plugin-sdk.dts.json` separate from main `tsconfig.json`** is a sign of plugin-SDK type-emission complexity; this is a real engineering cost.

### 5.4 Distinct design decisions

- The choice of **per-`(channel, account, peer)` agent workspace isolation** is more rigorous than Hermes-Agent's per-chat session model.
- Using **ACP for in-tree subagent spawning** rather than calling an internal function bus aligns OpenClaw with external IDE/orchestrator interop.
- Bundling **Bun + Node 24** in Docker rather than picking one is a deliberate "don't fight the tool you happen to need" choice.
- **`onlyBuiltDependencies` opt-in list** in `pnpm-workspace.yaml` is a security posture decision (avoids running random postinstall scripts) and is sensible for a 127-extension ecosystem.

---

## 6. Friday Deep Dive

### 6.1 What Friday actually is, from code

A **partially-implemented OpenClaw adoption project**, currently shaped as an Anthropic-only single-agent runtime with a strong approval-gating layer, an evidence-emitting phase controller, an extensive React UI surface, a local-skill-scanner across multiple AI tools' on-disk dirs, and a vendored full copy of OpenClaw v2026.5.6 sitting next to the source as a reference snapshot.

In one sentence: **Friday is a safety-conscious, audit-first agent OS in Phase 0 of a 7-phase OpenClaw adoption — the safety machinery is real, the OpenClaw adoption is a manifest with stubbed workers.**

### 6.2 Code-evidenced strengths

- **Approval gating is genuine, layered, and tested.** `src/agent/security/friday-mutating-action-gate.ts` plus skill/workflow approval services plus adversarial tests `test/adversarial/{approval-boundary-structure,truth-alignment}.test.ts`. This is not present at this depth in either Hermes-Agent or OpenClaw — both have permission/approval hooks but Friday's is the most centralized and adversarially tested.
- **The phase controller is a real piece of automation engineering.** `src/automation/openclaw-adoption/friday-openclaw-phase-controller.ts` is 74.8 KB; `friday-openclaw-phase.types.ts` is 10.3 KB; the 22-state machine + 9 failure codes + repair policy + Zod-validated taskpacks is a *legitimately impressive* meta-build system. The problem is what it builds (next item).
- **Local skill scanner is an interesting Friday-original feature.** Scanning `~/.claude/`, `~/.cursor/`, `~/.n8n/`, `~/.codex/` to discover and classify existing skill artifacts across multiple AI tools positions Friday as a *skill aggregator across ecosystems* — a niche neither peer fills.
- **`release:verify` script is rigorous.** Aggregates typecheck + lint + build + test + e2e + integration + checks + secret patterns + install smoke + release check. This level of release rigor is more Hermes-Agent-style than OpenClaw-style.
- **The React UI surface is dense.** 26 routes covering agent, channels, chat, memory, packs, plugins, reflex, skills, studio, workflows, and so on. Not a thin demo UI.

### 6.3 Code-evidenced weaknesses (brutally honest)

- **The OpenClaw-adoption phases 1–6 are not implemented.** The phase-0 taskpack workers are `console.log` placeholders. The manifest is well-typed; the work is not done.
- **LLM provider abstraction is missing.** The agent runtime appears hard-wired to the Anthropic SDK (per agent report). For a "self-hosted Agent OS" pitch, single-provider lock-in is a large hole.
- **No real channel adapters in tree.** `src/channels/` is a contract surface; there are no Telegram / Discord / Slack / WhatsApp / Signal / Matrix / Feishu adapters under `src/`. Hermes-Agent has ~30; OpenClaw has 127. Friday has 0 of comparable depth.
- **`src/agent/runtime/friday-agent-runtime.ts` is ~7,700 lines.** That's a single-file monolith mixing LLM streaming, tool execution, approval gating, compaction, checkpoint, and error recovery. Difficult to maintain. (Hermes-Agent has the same problem with `run_agent.py` ~15 KLOC, so this is not unique to Friday — but it is a real cost.)
- **No native voice / Canvas / live-render / mobile.** `apps/macos/FridayCompanion` is the only native surface. No Talk Mode, no A2UI Canvas, no iOS/Android.
- **No skill-learning curator.** Friday has skills, generator, executor, scanner — but no equivalent of Hermes-Agent's curator that mines completed trajectories into named, reusable skills. **This means Friday lacks the structural feature behind "the agent that grows with you."** Friday's skill ecosystem is curated/imported rather than learned.
- **CI workflow count is small (6).** Compare to Hermes-Agent (12) and OpenClaw (50+). No live-channel smoke tests, no scheduled multi-OS CodeQL, no install smoke matrix.
- **Test count is 815 — half of Hermes-Agent's 988 and 1/6 of OpenClaw's 5,266.** Density is decent for a smaller project but not yet at peer scale.
- **`memory/` directory at top level has 1 file (a README excluded from this investigation).** `src/memory/` is structured but no obvious vector backend or persistence schema in the visible code; no LanceDB-equivalent on disk.
- **`docs/` is enormous** (~497 .md files outside the vendored copy) and includes many design docs (`docs/agent-runtime-design.md`, `docs/skill-system-design.md`, `docs/plugin-system-design.md`, `docs/workflow-engine-design.md`, `docs/memory-core-design.md`, `docs/distributed-architecture.md`, `docs/SUBAGENT-REFERENCE.md`, etc.) plus phase-* and cx-* planning files. **Per the exclusion rule, none of these were read; the existence of so many planning docs without corresponding implemented features is itself a coverage signal — there is more *plan* than *product*.**
- **`docs/INVESTIGATION-hermes-openclaw-comparison.md` already exists.** Means the question this report is answering has been investigated before and answered in some form. Not used as evidence but logged.
- **`OVERNIGHT-TASK-SUMMARY.csv`, `AUDIT-REPORT.md`, `qa-report.html`, multiple `cx-phase-*` design files** — high volume of overnight/audit artifacts at the root suggests the project has been running through many automated audit/work cycles, possibly with significant churn.

### 6.4 Friday vs vendored OpenClaw — what's adopted and what's still original?

**Adopted (in code, derivative of OpenClaw):**
- Phase-rollout pattern (mirrors OpenClaw's gating discipline).
- Channel extension contract concept (`src/channels/`).
- Skill manifest schema (JSON-driven `skill.manifest.json` + `skill.ui.json`).
- Plugin SDK preview approach (allowlisted early access).

**Original to Friday (not present at this depth in OpenClaw):**
- The mutating-action approval gate (centralized + adversarially tested).
- The 22-state phase controller (this is a *meta-tool* about adoption itself).
- Local skill scanner across `~/.claude/ ~/.cursor/ ~/.n8n/ ~/.codex/`.
- The truth-alignment / approval-boundary adversarial test suite.
- The `release:verify` aggregate gate.

**Conclusion:** Friday's *original* code is concentrated in safety, audit, and adoption-process tooling. Friday's *adopted* code is structurally similar to OpenClaw but the actual ecosystem (channels, providers, voice, canvas, mobile) has not been ported.

---

---

## 7. Hermes-Agent vs OpenClaw — head-to-head

### 7.1 Where each project actually wins, on code evidence

| Dimension | Hermes-Agent | OpenClaw | Winner (code-only) | Evidence |
|---|---|---|---|---|
| Language ergonomics for ML researchers | Python (HF, faster-whisper, atroposlib, tinker) | TypeScript | Hermes | `pyproject.toml` `[rl]` extras |
| Multi-tenant gateway isolation | Per-chat session in `gateway/session.py` | Per-`(channel,account,peer)` in `src/routing/session-key.ts` with regex-validated agent IDs | OpenClaw | `src/routing/session-key.ts:21-100` |
| Channel breadth | ~30 platform adapters in `gateway/platforms/` | 127 extension dirs covering channels + providers + voice + image-gen | OpenClaw (4× breadth) | `extensions/` listing |
| Provider abstraction shape | One unified `ProviderProfile` dataclass (`providers/base.py`) with auth-type enum + plugin discovery | Per-provider extension package (`extensions/anthropic`, `extensions/openai`, etc.) | Hermes (cleaner abstraction); OpenClaw (more dispersed but more providers) | `providers/base.py`, `extensions/anthropic/index.ts` |
| Skill learning loop | **Real curator (`agent/curator.py`, ~1.7 KLOC) — fork-isolated, idle-triggered, transitions skills active→stale→archive** | Skills are SKILL.md docs; runtime hydration in `src/agents/skills.js` but no autonomous miner | Hermes — no peer feature in OpenClaw | `agent/curator.py`, `tools/skill_manager_tool.py` |
| RL training infrastructure | First-class via `environments/hermes_base_env.py` → Atropos PPO; `trajectory_compressor.py` is RL-data-aware | None visible | Hermes | `environments/hermes_base_env.py:221`, `pyproject.toml [rl]` |
| Mobile / Termux support | First-class. `[termux]`, `[termux-all]` extras explicitly curate Android-safe deps | No Termux profile; `apps/android/` is a native Kotlin app, separate from agent core | Hermes (Termux); OpenClaw (native Android) — both real, different flavor | `pyproject.toml`, `apps/android/` |
| Native macOS / iOS / Android apps | None (TUI + web) | `apps/{macos, ios, android, macos-mlx-tts, swabble}` | OpenClaw | `apps/` |
| Voice (TTS + STT + realtime) | `[voice]` extra (faster-whisper + sounddevice) + `edge-tts` core + optional `elevenlabs` | `extensions/{elevenlabs, openai realtime, talk-voice, tts-local-cli, senseaudio}` + Apple MLX TTS app | OpenClaw (broader) | `pyproject.toml`, `extensions/elevenlabs/index.ts` |
| Live-render / Canvas | None | A2UI Canvas over WebSocket (`extensions/canvas/index.ts`) | OpenClaw | `extensions/canvas/index.ts:1-60` |
| Memory backends | SQLite WAL + FTS5 + MEMORY.md/USER.md | LanceDB vector + active-memory + memory-wiki + memory-host SDK | OpenClaw (variety); Hermes (simplicity) | `hermes_state.py`, `extensions/memory-lancedb/index.ts` |
| ACP support | Yes (`acp_adapter/`) — server-side | Yes (`extensions/acpx/`, `src/acp/`, `src/agents/acp-spawn.ts`) — both server and client | OpenClaw | `src/agents/acp-spawn.ts` |
| MCP support | Yes (`tools/mcp_tool.py`, `mcp_serve.py`, `[mcp]` extra) | Yes (`src/mcp/`) | Tie | both |
| Plugin SDK with public typed contract | Plugin discovery exists but no published `.d.ts` SDK | `packages/plugin-sdk` + `tsconfig.plugin-sdk.dts.json` | OpenClaw | `packages/plugin-sdk/` |
| Test mass | 988 tests | 5,266 tests | OpenClaw (5×) | file count |
| CI rigor | 12 workflows (lint, tests, supply-chain audit, OSV scanner, skills-index, nix lockfile, docker-publish) | 50+ workflows (per-OS CodeQL, install smoke, live-channel smokes — `mantis-discord-smoke.yml`, `npm-telegram-beta-e2e.yml`, daily release validation) | OpenClaw | `.github/workflows/` |
| Build complexity | `uv` + `npm` for browser tools + Docker + Nix flake | pnpm monorepo + tsdown + Bun + Docker multi-stage + Fly + Render + appcast | OpenClaw (more disciplined for monorepo) | `pyproject.toml`, `pnpm-workspace.yaml`, `Dockerfile` |
| Onboarding-friendly entry script | `cli.py` with prompt_toolkit; `setup-hermes.sh` curl install | `openclaw.mjs` 401-line bespoke launcher with respawn supervision | Hermes (simpler curl install) | install scripts |
| Single-language ecosystem | Pure Python core (Node only for browser tools) | TypeScript + Swift + Kotlin + Bun | Hermes (simpler) | repo layout |

### 7.2 Where each project loses, on community evidence

**Hermes-Agent's real-user pain (from issue tracker + external sources):**
- TUI markdown / wrap / scrolling bugs are the most-discussed thread cluster in top-commented issues. Issue #22062 (TUI markdown wrap) was the most recent commit at investigation time.
- Provider failover doesn't always trigger. Issue #22277 (fallback chain not activated on stream-stalls, P1).
- Context bloat. Issue #10585: 6-8K input tokens in CLI baseline, 15-20K via Telegram with skills enabled.
- Setup overwrites picker model choices. Issue #22073.
- Windows install pain. Issue #16201.
- Public criticism: Simone Margaritelli (@evilsocket) on X said "Spent hours following the documentation by the letter trying to install Hermes Agent on a clean Arch Linux and nothing works… an overhyped piece of garbage" (https://x.com/evilsocket/status/2043365101223170489) — though Arch + Hermes is the bleeding-edge case.
- Self-evaluation unreliable: cited in multiple Medium/HN sources — the agent thinks it succeeded even when it didn't.
- Manual skill edits get overwritten by the curator's self-improvement loop ("dealbreaker" in kilo.ai meta-analysis).

**OpenClaw's real-user pain (from issue tracker + external sources):**
- **Severe security exposure.** Bitdefender / SecurityScorecard (135K exposed instances), Aikido, Cisco, Trend Micro, The Register, Dark Reading have all published critical pieces. Default binding to `0.0.0.0`, plus reported RCE CVEs, plus ~17–20% of ClawHub skills flagged malicious. (Sources: bitdefender.com, aikido.dev, trendmicro.com, blogs.cisco.com, theregister.com.)
- **Update churn.** Per HN/Reddit: "Every single update ships more bugs and more problems than before."
- "Phantom completion": agent reports success when nothing happened. Issue #40082.
- Channel-integration regressions are constant. Issues #79689 (stream_read_error bypass), #79688 (Discord infinite retry loop), #79681 (Telegram typing indicator), #79676 (Slack interactive reply buttons), #79670 (onboarding recommends invalid Gemini preview models), #79637 (missing tool result crashes long sessions).
- A `[4.29–5.4 regression]` issue cluster has been formalized.

**Net:** OpenClaw and Hermes-Agent have **strikingly similar pain themes** (provider failover, channel fragility, setup, context bloat, hangs) — they are running into the same fundamental bug categories at different scales. OpenClaw's pain is louder simply because OpenClaw has 27× more active users (per HN/press evidence) and a more aggressive release cadence (near-daily vs weekly).

### 7.3 The "OpenClaw vs Hermes-Agent" framings observed in the wild

- **"Agent-first vs gateway-first"** (https://screenshotone.com/blog/hermes-agent-versus-openclaw/): Hermes is positioned as a single autonomous agent; OpenClaw as a multi-channel orchestration layer. Code matches this framing — Hermes is one process; OpenClaw is a daemon + many extensions.
- **"Self-improving vs human-curated skills"** (Medium, The New Stack, Vellum): Hermes's curator vs OpenClaw's ClawHub-published skills. Code matches this framing too — Hermes mines, OpenClaw curates.
- **"Use OpenClaw as orchestrator + Hermes as worker via ACP"** (kilo.ai meta-analysis): in practice some users wire both together because both speak ACP. Code-level evidence: both projects have ACP support.

---

## 8. Hermes-Agent vs Friday — head-to-head

### 8.1 Code-level dimension table

| Dimension | Hermes-Agent | Friday | Honest assessment |
|---|---|---|---|
| Maturity / shipping cadence | Weekly named releases since 2025-Q3, 22K+ commits, 100+ commits/week, 15+ active contributors | First release v0.4.2 in March 2026, v1.0.0 in April 2026, 519 commits, ~20 commits/week, **solo developer + Codex bot co-author** | Friday is ~6 months newer and ~5× smaller in throughput. |
| External user base | 139K stars, 21K forks, 3,300 open issues from real users | 281 stars, 38 forks, 0 open issues, owner has 1 follower | Friday has **no external user base.** Issues filed are by the owner himself (e.g. issue #43 self-tracking todo, closed). |
| LLM provider abstraction | Multi-provider via `providers/base.py` + plugin discovery; works with OpenAI, Anthropic, OpenRouter, NIM, Bedrock, Mistral, Codex OAuth, Claude Code OAuth, Gemini CodeAssist OAuth | **Anthropic SDK hard-wired in `friday-agent-runtime.ts`** | Friday is single-provider. **Largest single LLM-portability gap.** |
| Skill learning loop (curator) | Real ~1.7 KLOC curator (`agent/curator.py`) | None | Friday has no analog of "the agent that grows with you." |
| Skill ecosystem | 25 first-party + many optional skills, plus `~/.hermes/skills/` user directory | 56 first-party + 22 managed, plus a **cross-tool skill scanner** that reads from `~/.claude/`, `~/.cursor/`, `~/.n8n/`, `~/.codex/` | Friday's scanner is genuinely original; both have similar first-party skill counts. |
| Multi-channel messaging | ~30 real platform adapters in `gateway/platforms/` (telegram, discord, slack, whatsapp, signal, weixin, dingtalk, feishu, matrix, sms, etc.) | `src/channels/` is a contract surface with **no real Telegram/Discord/Slack/WhatsApp adapters in tree** | Friday has effectively zero shipped channels. |
| Approval / mutation safety | Per-tool `approval` module + `tools/approval.py` | **Centralized `friday-mutating-action-gate.ts` + skill/workflow approval services + adversarial test suite** | **Friday wins decisively here. This is Friday's strongest differentiator.** |
| Adversarial / safety tests | `tests/agent/` covers tool-use flows, but no equivalent of "truth-alignment" tests | `test/adversarial/{approval-boundary-structure, truth-alignment}.test.ts` | Friday wins. |
| ACP / MCP support | Both, with full server (`acp_adapter/server.py`) | None visible in core src | Hermes wins. |
| Computer use | `cua-driver` MCP stdio binary, lightweight | Playwright-based browser tool only (no full-desktop control) | Hermes wins on full-desktop; Friday's browser is competent but narrower. |
| Termux / mobile | First-class | None | Hermes wins. |
| Voice / Talk Mode | `[voice]` extra | None | Hermes wins. |
| TUI | `cli.py` (prompt_toolkit) + Ink-based `ui-tui/` | `friday tui` command exists | Hermes wins (more polished). |
| Web UI | FastAPI + SPA in `web/` | React 19 + Vite + Tailwind + 26 routes | **Friday wins.** Friday's UI surface is denser and more product-shaped. |
| Phase / adoption automation | None equivalent | **74.8 KB phase controller, 22-state machine, Zod-validated taskpacks, evidence chain** | Friday wins on a meta dimension. But this controller is a tool *for* adopting OpenClaw, and the actual adoption is unimplemented. |
| Test count | 988 | 815 | Hermes slightly higher; both modest by OpenClaw standards. |
| CI rigor | 12 workflows including OSV-scanner, supply-chain-audit | 6 workflows (ci, cloud-e2e, nightly-heavy, real-green-gate, release, weekly-audit) | Hermes wins. |
| Native app surface | None | `apps/macos/FridayCompanion` (Electron) | Friday wins (one app). |

### 8.2 Friday's strategic position vs Hermes-Agent

- **Where Friday already beats Hermes-Agent:** approval safety, adversarial truth-alignment tests, web UI density, cross-tool skill discovery, the meta-tool of phase-driven adoption.
- **Where Friday is far behind:** LLM provider portability, channel breadth, skill learning loop, mobile/Termux, voice, ACP/MCP, public user base, release cadence, contributor count.
- **Where Friday is structurally indistinguishable today:** test mass (both modest), single-monolith agent loop (both have 7K–15K line files), CI rigor (Friday slightly behind).

### 8.3 Honest verdict on "Is Friday a Hermes-Agent upgrade?"

**No, not today.** Friday lacks Hermes-Agent's curator, its multi-provider abstraction, its mobile surface, its real channel adapters, and its ACP/MCP integration. Friday's safety surface and UI density are real wins, but they are *complements*, not a replacement for the missing breadth. Friday cannot honestly be marketed as "Hermes-Agent's successor" until at minimum: (a) provider abstraction lands, (b) at least 3 real channels ship, (c) some form of skill-learning loop ships. (See §15 for the longer answer; see §19–20 for the gap-and-strategy chapters.)

---

## 9. Friday vs OpenClaw — head-to-head

### 9.1 The relationship is not a comparison; it is an adoption

Friday is built around a 7-phase **OpenClaw adoption** module. Friday's `NOTICE` file (NOT used as evidence per the rules — but cross-confirmed by community researcher with direct fetch) credits Peter Steinberger / OpenClaw / Clawdbot for "Legacy SKILL.md compatibility, Agent runtime references, Scheduler guard behavior, Benchmark/adoption materials" (MIT 2025). Friday's PR titles include "OpenClaw-style external verification route." Friday's branch prefixes include "Codex/friday lego closure repair," indicating heavy use of OpenAI Codex CLI for AI-assisted edits within an OpenClaw-mimicking architecture.

So this isn't really a head-to-head; this is "an adoption project vs the project being adopted."

### 9.2 What Friday adopts vs what OpenClaw has

| Layer | OpenClaw (today) | Friday (today) | Adoption status |
|---|---|---|---|
| Channel extension contract | 27+ shipped channels with `definePluginEntry` pattern | `src/channels/` contract surface, no shipped channel adapters | **Phase 3 not yet implemented** |
| Skill format | `SKILL.md` + references/ + manifests | `skill.manifest.json` + `skill.ui.json` (compatible with SKILL.md per NOTICE) | **Phase 1 not yet implemented; format compatibility planned** |
| Plugin SDK | `packages/plugin-sdk/` with public `.d.ts` and runtime helpers | `src/plugins/` exists but no public SDK published | **Phase 2 not yet implemented** |
| Multi-agent / ACP routing | `src/agents/acp-spawn.ts` + `src/routing/session-key.ts` regex-isolated workspaces | Single-agent runtime; no ACP | Not in 7-phase scope — unclear if planned |
| Memory backends | LanceDB + active + wiki + memory-host SDK | `src/memory/` skeleton; no shipped vector backend | Phase 5 (Context Engine) covers this |
| Voice / Canvas | Full extensions + Apple MLX TTS app | None | Not in 7-phase scope |
| Native apps | macOS (Swift) + iOS (Swift) + Android (Kotlin) + macos-mlx-tts | macOS Electron companion only | Not in 7-phase scope |
| Test mass | 5,266 tests, live-channel smokes, daily release validation | 815 tests, no live-channel smokes | Phase 6 covers final test sweep |
| Approval gate | Tool-level approvals exist but not centralized at the same depth | Centralized `friday-mutating-action-gate.ts` + adversarial tests | **Friday-original, not adopted from OpenClaw** |
| Phase-driven adoption automation | None | 22-state controller + evidence chain | **Friday-original meta-tooling** |

### 9.3 Where Friday already adds value over OpenClaw

- **Safety as a centralized layer.** OpenClaw's per-extension approval is fragmented; Friday's gate is unified. Given OpenClaw's documented security backlash (Bitdefender, Aikido, Cisco, Trend Micro, The Register), this is *strategically* an opportunity area for Friday.
- **Audit/evidence chain.** Friday's `release:verify` aggregate gate + `.friday/automation/openclaw-adoption/{statePath, evidenceRoot}` chain is more disciplined than OpenClaw's PR-level `proof:` labels because Friday's evidence is on disk and per-phase, not just per-PR.
- **Cross-tool skill scanner.** Reading from `~/.claude/`, `~/.cursor/`, `~/.n8n/`, `~/.codex/` is unique. OpenClaw's skill discovery is to its own ClawHub.
- **Approval-boundary adversarial test suite.** OpenClaw's tests are huge but not focused on adversarial truth-alignment.

### 9.4 Where Friday is far behind OpenClaw

Almost every dimension above. The honest summary is: **Friday is OpenClaw's spiritual little brother with better safety and worse everything else, in adoption phase 0.**

---

## 10. Why People Use Hermes-Agent — code + community evidence

This section synthesizes the community researcher's findings against the code evidence.

### 10.1 Reasons that are real and code-supported

1. **The skill-learning loop is real and unique.** `agent/curator.py` is a 1.7 KLOC fork-isolated background agent that mines trajectories into named skills. No peer project ships this. Community signal: HN thread "I've been using the NousResearch Hermes agent for the past couple of weeks…" (https://news.ycombinator.com/item?id=47786673). The "agent that grows with you" claim has structural backing. **High confidence.**
2. **Multi-provider OAuth flows lower the activation barrier.** Hermes-Agent has OAuth flows for Claude Code, Codex, Google CodeAssist (`agent/copilot_acp_client.py`, `agent/google_oauth.py`, `agent/codex_responses_adapter.py`). Users with existing subscriptions can sign in instead of provisioning API keys. **High confidence.**
3. **Termux/Android is a niche but loyal user segment.** `pyproject.toml [termux-all]` extra is real. X user @startupideaspod cited Termux compatibility as a draw (https://x.com/startupideaspod/status/2046641249487409337). **Medium-high confidence.**
4. **Multi-channel breadth in one process.** ~30 platform adapters under `gateway/platforms/`. For users who want one self-hosted agent on one VPS that answers Telegram + Discord + WhatsApp + Slack + Signal, this is a draw. **High confidence.**
5. **One-line install (`curl … | bash`) plus declarative YAML config.** Hermes ships an `setup-hermes.sh` script and `cli-config.yaml.example`. Reduces setup friction vs OpenClaw's bespoke `openclaw.mjs` launcher. **High confidence.**
6. **Cron / scheduled jobs built in.** `croniter` is a *core* dependency, not an extra. `tools/cronjob_tools.py`, `cron/` directory. The agent can schedule itself. **High confidence.**
7. **NousResearch brand (LLM heritage).** People who follow Hermes 3 / Hermes 4 LLMs trust NousResearch and try the agent. **Medium confidence — brand effect is hard to quantify.**

### 10.2 Reasons that are partially code-supported

8. **"It just works" out of the box.** Mixed evidence — issue #16201 (Windows install pain), @evilsocket public dunk on Arch install. Some users have a clean experience, others fight setup hard. **Mixed.**
9. **Self-improvement makes the agent better over time.** Code-true: curator does run; skills do persist. Community-mixed: "Hermes evaluates its own work to decide whether a task succeeded, but it almost always thinks it did well, even when it didn't" (geeky-gadgets review, kilo.ai meta-analysis). The mechanism exists but its evaluation honesty is questioned. **Medium confidence.**

### 10.3 Reasons that are mostly perception / hype

10. **Cross-comparison "upgrade vs OpenClaw" framing.** Several Medium pieces ("I switched from OpenClaw to Hermes Agent — here's what nobody told me") frame Hermes as a successor. Code does not support "successor"; both are independently developed projects with different runtime models. **Medium confidence — partial astroturf signal.**
11. **"Self-evolving 24/7."** YouTube tutorial titles ("Hermes Agent The 24/7 Self-Evolving AI Agent!") imply continuous agent improvement. Code reality: curator runs at idle, not continuously, and only every 168h by default (one week). The "24/7 self-evolving" framing is mostly marketing.
12. **The `kilo.ai/openclaw/vs-hermes` aggregator's quoted Reddit usernames may be partially synthesized.** The community researcher flagged this. Community quotes that originate solely from kilo.ai must be tagged Level 5 (single-aggregator) confidence.

### 10.4 What the community most repeatedly cites

| Theme | Frequency in community discussion | Code-verified? | Confidence |
|---|---|---|---|
| Skill learning loop | Highest | Yes (`agent/curator.py`) | High |
| Multi-provider / OAuth providers | High | Yes (multiple `agent/*_adapter.py`) | High |
| Multi-channel in one process | High | Yes (`gateway/platforms/`) | High |
| Cron / scheduled tasks | Medium | Yes (`croniter` core dep) | High |
| Termux / Android | Medium-niche | Yes (`[termux]` extra) | High |
| Cleaner install vs OpenClaw | Medium | Partial (curl install yes, but bug reports too) | Medium |
| Self-evaluation honesty issues | Recurring complaint | Code shows evaluation exists, honesty is policy concern | Medium |
| Manual skill edits get overwritten | Recurring complaint | Curator does write to skills dir (`skill_manager_tool.py`) | Medium |
| Context bloat | Recurring complaint | Verified via issue #10585 | High |
| TUI bugs | Frequent | Verified via PR #22062 (most recent commit) | High |

---

## 11. Repeated Community Themes

### 11.1 Themes by project

**Hermes-Agent themes (frequency ranked):**

1. TUI markdown / scroll / wrap bugs — multiple top-commented PRs (#19835, #15926, #17623, #22062). Highest-frequency complaint cluster.
2. Provider failover / fallback chain not triggering (DeepSeek, OpenAI 429, Ollama detection). Issues #22277, #22313, #22317.
3. Setup/install pain on Windows / Arch / Termux edge cases. Issues #16201, #22054, #22152, #22073.
4. Multi-channel platform fragility: Telegram media paths (#21527), Discord wildcards (#22334), Slack manifest, Google Chat, QQ. Cross-platform.
5. Context compression failure (#22244), token bloat (#10585).
6. Self-evaluation honesty (qualitative critique across reviews).
7. Skill self-overwrite (qualitative critique).
8. Recently-shipped Native Windows beta (May 8) — expect inflow of new bug reports.
9. Cron / vision tool / browser tool reliability.
10. NixosModule wrong paths (#21341).

**OpenClaw themes (frequency ranked):**

1. **Security exposure** is the dominant external theme (Bitdefender, Aikido, Cisco, Trend Micro, The Register, Dark Reading). 135K instances exposed, RCE CVEs, malicious skills (~17–20% of ClawHub flagged). This is **the** OpenClaw narrative externally.
2. Channel-specific bugs across 27+ adapters (Discord retries, Telegram typing/forum-topics/link-previews, Slack interactive buttons regression, WebChat rendering, etc.).
3. Phantom completion / fake success (#40082) — agent says it did the thing when it didn't.
4. Update churn — "every update ships more bugs."
5. Provider catalog churn (Gemini preview, Codex/OpenAI accountId, qwen thinking format, custom-provider baseUrl regressions).
6. Streaming / heartbeat reliability (cross-contamination, stuck sessions).
7. China-market mass adoption (Tencent / WeChat integration, ByteDance Lark, government deployments) — overwhelmingly positive demographic theme.
8. Lobster meme virality (🦞), Steinberger founder cult of personality, joining OpenAI per Sam Altman's public post.
9. Atomic file writes failing on Docker-mounted Windows volumes (#53947).
10. Lex Fridman podcast / TED talk / mass press validation.

**Friday themes:**

1. Solo developer churn — `thesongzhu` is the sole committer; `Wenxin Dou` and `codex` (bot) appear as co-authors. No external community.
2. Repeated "Codex/friday" branch prefix → AI-assisted authoring loop (Codex CLI editing the codebase).
3. Architectural borrowing from OpenClaw made explicit in PR titles: "OpenClaw-style external verification route."
4. Provider integrations being added (OpenAI, OpenRouter, Codex OAuth) but post-investigation date.
5. Marketplace was "retired" recently (PR title: "remove marketplace + retire local bypass login") — direction-changing.
6. CI work dominates recent commits ("Fix CI red", "secrets pragmas, e2e timeouts").
7. **No external user UX themes — because there are no external users.**

### 11.2 Cross-project meta-themes

- **Multi-channel agents are hard.** Both Hermes and OpenClaw have channel-specific bugs as a top theme, despite very different runtime models. The lesson for Friday: do not under-estimate channel maintenance.
- **Self-evaluation is a hard problem regardless of mechanism.** Hermes's curator-driven self-eval and OpenClaw's "phantom completion" are different mechanisms with the same failure mode.
- **"Setup just works" is a moving target.** Both peers ship constant install-fix PRs.
- **Discussions tab disabled across all three.** All projects channel community through Issues, magnifying issue inflow.
- **Solo-author projects have no external pain.** Friday literally cannot show "common bugs" because there is no external surface filing.

---

## 12. User Experience Analysis

### 12.1 First-run / install experience

| Project | Install command | Reported friction |
|---|---|---|
| Hermes-Agent | `curl -fsSL …/install.sh \| bash` or `pip install hermes-agent`; then `hermes setup` | Setup overwrites picker model choices (#22073); Playwright sudo install (#22152); slow Node update (#22237); fails on Arch per @evilsocket |
| OpenClaw | `pnpm install openclaw` or `docker run`; pre-built macOS/iOS/Android binaries | Onboarding recommends invalid Gemini preview models (#79670); Telegram setup gotchas; security defaults (0.0.0.0) considered dangerous |
| Friday | `npm install @thesongzhu/friday`, source build, or Docker; `Friday Setup.command` for macOS | No external user reports — friction is unmeasured |

### 12.2 Day-1 vs Day-30

- **Hermes-Agent Day-1:** install → set provider OAuth → pick model → first message. Skills empty, curator hasn't run. Day-30: ~5–20 skills accumulated, MEMORY.md has summaries. Net positive trajectory if the curator has run productively.
- **OpenClaw Day-1:** install → set channel tokens → pick provider → pair canvas / WebChat. Multiple integrations to configure. Day-30: many channels active, many auto-pulled skills installed (with the security caveat).
- **Friday Day-1:** install → boot hub → open UI → run skill scanner → skills imported from existing tools. Day-30: unmeasured, no external testimony.

### 12.3 Debugging / failure-recovery experience

- **Hermes:** issue inflow shows users do file detailed bug reports; maintainer (`teknium1`) merges fixes same-day. Trajectory is healthy.
- **OpenClaw:** clawsweeper bot + `proof:` label automation triages PR queue. XL PR proposals frequently get abandoned ("strict gate"). Issue #71127 (stuck sessions, single reporter, no reply yet) shows isolated bugs can fall through the cracks.
- **Friday:** debugging experience on a one-author repo means no community help. Auditing the 7,700-line `friday-agent-runtime.ts` alone is a hard onboarding curve.

### 12.4 Common praise (synthesized)

| Praise | Project | Source level |
|---|---|---|
| "Skill learning makes my agent better over time" | Hermes | HN, Medium, kilo.ai |
| "One agent, every channel, on a $5 VPS" | Hermes | YouTube tutorials |
| "Termux on my phone is wild" | Hermes | X |
| "OpenClaw changed my life" | OpenClaw | HN front page (item 46931805) |
| "Most-starred repo on GitHub" | OpenClaw | HN item 47217812 |
| "China lobster craze" | OpenClaw | Fortune, Asia Society |
| "Lex Fridman podcast" | OpenClaw | YouTube |
| (Friday: none externally documented) | Friday | — |

### 12.5 Common complaints (synthesized)

| Complaint | Project | Source level |
|---|---|---|
| "Self-eval lies" | Hermes | Medium, geeky-gadgets, kilo.ai |
| "Curator overwrites my edits" | Hermes | kilo.ai |
| "TUI bugs" | Hermes | GitHub (high-comment cluster) |
| "Context bloat" | Hermes | Issue #10585 |
| "Security nightmare" | OpenClaw | Bitdefender, Cisco, Trend Micro, Aikido, Dark Reading |
| "Update churn" | OpenClaw | Reddit/HN |
| "Phantom completion" | OpenClaw | Issue #40082 |
| "Channel regressions every release" | OpenClaw | Issue cluster `[4.29–5.4 regression]` |
| (Friday: no external complaints) | Friday | — |

---

## 13. Hermes-Agent beats OpenClaw — Evidence-backed advantages

Per the brief's request, here's the focused chapter. Each advantage gets: name, type (code/UX/community), evidence, OpenClaw counter, Friday status, counter-evidence, confidence.

### 13.1 Skill-learning curator (the agent that grows with you)

- **Type:** Code + product-narrative.
- **Real:** Yes. `agent/curator.py` ~1.7 KLOC + `tools/skill_manager_tool.py`. Runs as fork on idle, transitions skills active→stale→archive, pinning support.
- **OpenClaw equivalent:** None. Skills are SKILL.md docs hydrated at runtime; ClawHub is a curated marketplace, not a per-user mining loop.
- **Friday status:** No equivalent. Friday's skill scanner *imports* existing skills from `~/.claude/`, `~/.cursor/`, but does not *mine* trajectories into new skills.
- **Counter-evidence:** Multiple community sources flag that "Hermes evaluates its own work … almost always thinks it did well." The mechanism exists; its evaluation honesty is contested.
- **Confidence:** **High** that the feature is real. **Medium** that the feature is consistently valuable in practice.

### 13.2 Termux / Android first-class profile

- **Type:** Code.
- **Real:** Yes. `pyproject.toml` `[termux]` and `[termux-all]` extras explicitly avoid known-broken Termux deps (matrix python-olm, voice ctranslate2). Pure-Python core means Termux-installable.
- **OpenClaw equivalent:** Has `apps/android/` (a native Kotlin app) but no Termux profile. Different trade-off: native app vs hackable shell.
- **Friday status:** Node ≥22 + native deps including Playwright; not Termux-friendly.
- **Counter-evidence:** Niche audience.
- **Confidence:** **High** for the feature; **Medium** for strategic importance.

### 13.3 Single-process simplicity in Python

- **Type:** Code + UX.
- **Real:** Pure Python core; one process; SQLite state DB; simple `pip install` (with extras). OpenClaw is pnpm + Bun + Node + Swift + Kotlin. Hermes-Agent is friendlier to ML researchers and to one-VPS deployments.
- **OpenClaw equivalent:** Multi-language monorepo; better for teams; harder for solo deployers.
- **Friday status:** TypeScript-only but with significant build complexity (Vite, Tailwind, Electron companion).
- **Confidence:** **High** for code-architecture; **Medium** for "simpler" UX (depends on user).

### 13.4 Cron and scheduling are core, not optional

- **Type:** Code.
- **Real:** `croniter` is a core dep, not an extra. `cron/` directory + `tools/cronjob_tools.py`. The agent can schedule itself on cron expressions.
- **OpenClaw equivalent:** `src/cron/` exists but scheduling isn't pitched as a marquee feature in the visible code.
- **Friday status:** `src/jobs/` exists but no equivalent to the `cronjob_tools.py` agent-facing cron API.
- **Confidence:** **High.**

### 13.5 ACP server out of the box

- **Type:** Code + ecosystem.
- **Real:** `acp_adapter/` implements full ACP server with capability advertising, MCP bridging, OAuth/API-key auth routing, approval permissions. This means external IDE/orchestrator UIs (e.g. Zed, an editor that speaks ACP) can drive Hermes-Agent.
- **OpenClaw equivalent:** Also has ACP via `extensions/acpx/` and `src/acp/` and `src/agents/acp-spawn.ts`. **OpenClaw matches on this.**
- **Friday status:** None.
- **Confidence:** **High.**

### 13.6 Provider OAuth (Claude Code, Codex, Google CodeAssist)

- **Type:** Code + UX.
- **Real:** `agent/copilot_acp_client.py`, `agent/google_oauth.py`, `agent/google_code_assist.py`, `agent/codex_responses_adapter.py`. Users can sign in with existing subscriptions instead of provisioning raw API keys.
- **OpenClaw equivalent:** Has Codex extension; `extensions/github-copilot/`. Some overlap.
- **Friday status:** "Codex OAuth provider flow" PR title appears in recent merged PRs; Friday is acquiring this.
- **Confidence:** **High** that Hermes ships it; **High** that OpenClaw partially matches; **Medium** that Friday is closing the gap.

### 13.7 Brand effect from NousResearch's LLM lineage

- **Type:** Community / brand.
- **Real:** NousResearch's Hermes 3 / Hermes 4 LLMs have brand recognition in r/LocalLLaMA. The agent inherits trust.
- **OpenClaw equivalent:** Steinberger has personal brand from PSPDFKit and the Apple-dev ecosystem. Different brand pool.
- **Friday status:** No public brand.
- **Confidence:** **Medium** (brand impact is qualitative).

### 13.8 RL training infrastructure

- **Type:** Code.
- **Real:** `environments/hermes_base_env.py:221` integrates Atropos for PPO on tool traces. `trajectory_compressor.py` is RL-data-aware.
- **OpenClaw equivalent:** None visible.
- **Friday status:** None.
- **Confidence:** **High** the infra exists; **Medium** that this is a draw for typical users (most aren't training models).

### 13.9 Where Hermes-Agent does NOT clearly beat OpenClaw

| OpenClaw advantages worth naming |
|---|
| 4× channel breadth (127 extensions vs ~30) |
| Native macOS/iOS/Android apps |
| Canvas / A2UI live render |
| Per-`(channel, account, peer)` workspace isolation |
| 5× test mass |
| Public plugin SDK with `.d.ts` |
| Aggressive release cadence (near-daily) |
| Multiple memory backends (vector / wiki / active) |
| China-market adoption + Tencent / WeChat integration |

So the brief's premise that Hermes-Agent is *globally* better than OpenClaw is **not supported by code**. Hermes-Agent has a tighter learning loop, better Python ergonomics, easier single-VPS install. OpenClaw has wider integration matrix, better isolation, native apps, real Canvas, China-scale community. **Both are real wins on their respective axes.**

---

## 14. Is Hermes-Agent an OpenClaw Upgrade?

### 14.1 Direct verdict

**No, it is not an upgrade. They are sibling projects with different runtime models, different languages, and different deployment shapes. The "upgrade" framing is community narrative, not code reality.**

### 14.2 Where the framing comes from

- Multiple Medium / blog pieces frame migration: "I switched from OpenClaw to Hermes Agent — here's what nobody told me" (https://medium.com/@sathishkraju/i-switched-from-openclaw-to-hermes-agent-heres-what-nobody-told-me-5f33a746b6ca), "OpenClaw vs Hermes Agent" (medium.com/data-science-in-your-pocket).
- kilo.ai meta-analysis claims ~30% of surveyed Reddit comments switched from OpenClaw to Hermes. Counter-evidence: kilo.ai is a half-trustworthy aggregator and its sample methodology is opaque.
- Some community posts allege fresh Reddit accounts pushing pro-Hermes content (kilo.ai meta + Mehul Gupta Medium "Don't use OpenClaw"). Astroturf signal exists but is not proven.

### 14.3 Where the framing breaks down

- Hermes-Agent is Python; OpenClaw is TypeScript. No code is shared in either direction.
- Hermes-Agent is single-process / single-tenant-style; OpenClaw is daemon / multi-tenant. Neither is a strict superset of the other.
- OpenClaw has 4× the channels, 5× the tests, native apps, Canvas, China-scale adoption. Hermes-Agent does not subsume any of these.
- OpenClaw founder Steinberger reportedly joined OpenAI (per Sam Altman's public post and TechCrunch / CNBC coverage) — this is a *people* event, not a *code* event.

### 14.4 What's true

- A user fed up with OpenClaw's security backlash and update churn might prefer Hermes-Agent's quieter shipping cadence and tighter scope. That's a real reason to *migrate*.
- A user who wants WeChat / Feishu / Lark integration with a polished native macOS app should stay on OpenClaw.
- A user who wants RL training, Termux, and a fork-based skill curator should pick Hermes-Agent.

### 14.5 Confidence

**High** that the "upgrade" framing is not code-supported. **Medium** that some users do prefer Hermes for specific reasons. **Low** on whether the migration narrative is partially astroturfed.

---

## 15. Is Friday a Hermes-Agent Upgrade?

### 15.1 Direct verdict

**No, today Friday is not a Hermes-Agent upgrade. It is a younger, smaller, single-developer project that has selected wins (centralized approval, adversarial tests, web UI density, cross-tool skill scanner) and large gaps (multi-provider, channels, mobile, voice, learning curator, public user base).**

### 15.2 Specific dimensions

| Dimension | Friday vs Hermes today | What "upgrade" would require |
|---|---|---|
| Approval / safety | **Friday already wins** | Maintain lead; add escalation, time-bound auto-deny, multi-approver |
| Adversarial test culture | **Friday already wins** | Keep adding adversarial cases |
| Web UI density | **Friday wins** | Maintain |
| Cross-tool skill scanner | **Friday wins** | Keep extending tool list |
| Phase-driven adoption automation | **Friday wins (meta)** | Actually finish phases 1–6 |
| LLM provider abstraction | Hermes wins decisively | Ship `src/providers/` registry that supports OpenAI, Anthropic, OpenRouter, Bedrock minimum |
| Channel adapters | Hermes wins decisively (~30 vs 0) | Ship at least 3 real channels |
| Skill learning curator | Hermes wins | Build a Friday-curator: idle-triggered, fork-isolated, trajectory-mining |
| ACP / MCP | Hermes wins | Add ACP server + MCP client |
| Termux / Android | Hermes wins | Decide if Friday targets mobile at all |
| Voice / Talk Mode | Hermes wins | Likely not worth chasing in 2 weeks |
| Native apps | Tied (Friday has Electron macOS) | Already at parity for one platform |
| User base / contributors | Hermes wins decisively | Marketing problem, not code |
| Maturity / cadence | Hermes wins (139K stars, weekly releases) | Time-bound; cannot be force-multiplied |

### 15.3 What Friday can claim today, honestly

- "Approval-gated by default; designed not to do destructive things without your sign-off."
- "Discovers and unifies skills across Claude, Cursor, n8n, Codex on your machine."
- "Adversarial test suite for truth-alignment and approval boundary."
- "Phase-driven automation with on-disk evidence for every change."

### 15.4 What Friday cannot honestly claim today

- "The agent that grows with you" (no curator).
- "Self-improving" (no curator).
- "Multi-provider" (Anthropic-only).
- "Multi-channel" (no shipped channels).
- "Production-ready Hermes-Agent successor" (≈5× smaller in shipped breadth).
- "OpenClaw upgrade" (OpenClaw adoption phases 1–6 not implemented).

### 15.5 Path to honestly being a Hermes-Agent upgrade

The shortest honest path:

1. **Ship the LLM provider abstraction** — refactor `friday-agent-runtime.ts` to lift the Anthropic-SDK call into a `providers/` registry that ships OpenAI + Anthropic + OpenRouter on day 1.
2. **Ship at least one real channel.** Recommend WhatsApp via Baileys (which OpenClaw already uses, license-permitted under MIT).
3. **Ship a "Friday curator" — even a v0 one.** It can start as a nightly skill-mining job that looks at completed approval-gated trajectories and proposes new skills to the user (with approval-gated install).
4. **Ship a `friday tools mcp` and `friday acp serve` command** — implement MCP client and ACP server so external IDEs can drive Friday.
5. **Reframe positioning.** Stop saying "Hermes-Agent successor." Say: "the approval-gated, audit-first agent OS for AI-tool aggregation."

If items 1–4 land, Friday has a credible "Hermes-Agent alternative for users who want safety-first behavior." Item 5 is a marketing realignment.

---

## 16. Sharp Angles

The brief asked for at least 16 angles. Here are 20.

### 16.1 Hermes-Agent supporter angle
"Curator + multi-channel + Termux + RL + ACP + cron-as-core, all in one Python process. NousResearch ships every week. The agent literally grows on disk in `~/.hermes/skills/`."

### 16.2 Hermes-Agent skeptic angle
"The curator's self-evaluation isn't honest. The agent over-rates its own work. The 'self-improvement' is more impressive in the README than in your skills folder a month later. TUI bugs are the most-discussed cluster."

### 16.3 OpenClaw defender angle
"127 extensions, native macOS/iOS/Android, A2UI Canvas, real WeChat/Feishu/Lark integration, China mass adoption, Lex Fridman podcast. This is the actual platform; Hermes-Agent is an interesting indie."

### 16.4 OpenClaw critic angle
"Bitdefender flagged ~17–20% of ClawHub skills as malicious. SecurityScorecard counts 135K instances exposed on `0.0.0.0`. Cisco, Trend Micro, Dark Reading, The Register all published 'security nightmare' pieces. Steinberger left for OpenAI. The largest project on GitHub is also the largest attack surface."

### 16.5 Friday founder angle
"I have approval gating, evidence chain, adversarial truth-alignment tests, phase-driven adoption automation, and cross-tool skill discovery. None of the peers have that depth of safety. I'm 6 months old and I'm building the audit-first version of OpenClaw."

### 16.6 Friday user angle (hypothetical, since there is none today)
"I don't know about Friday. Where did I hear about it? I'd want to compare it to OpenClaw and Hermes, and there's no third-party review and zero HN signal. I can't find anyone using it."

### 16.7 New developer onboarding angle
"Hermes: `curl install` then read 14 KLOC `cli.py`. OpenClaw: clone, `pnpm install`, then read 401-line `openclaw.mjs` and 66 src/ subdirs. Friday: `npm install`, read a 7.7 KLOC monolith. **All three lose new contributors at the file size.**"

### 16.8 Agent-reliability angle
"OpenClaw has 'phantom completion' as a named bug class. Hermes-Agent has 'self-eval thinks it succeeded when it didn't.' Friday has approval-boundary tests but the agent runtime is a 7.7 KLOC monolith — adversarial tests are necessary but not sufficient if the runtime is hard to reason about."

### 16.9 UX / product angle
"OpenClaw has the best out-of-box product (native apps, Canvas, channel breadth). Hermes-Agent has the most surprising 'feels alive' moment when the curator surfaces a skill. Friday has the densest UI surface but no production users to confirm UX quality."

### 16.10 Architecture / code-quality angle
"OpenClaw has the cleanest separation (66 src/ subdirs + 127 extensions + 4 SDK packages). Hermes-Agent has the simplest topology (one process, one DB). Friday has the cleanest *meta-tool* (the phase controller) but the messiest *actual product* (`friday-agent-runtime.ts` 7.7 KLOC mixing 6 concerns)."

### 16.11 Open-source community angle
"OpenClaw is a community-of-thousands. Hermes-Agent is a community-of-hundreds. Friday is a community-of-one (the author + Codex). Building a community is a year-long thing."

### 16.12 Ecosystem / brand angle
"NousResearch has Hermes-LLM brand transfer. Steinberger has Apple-dev brand transfer. Friday has no brand transfer. To build brand, Friday needs either (a) a viral demo, (b) a high-trust security/audit narrative that aligns with OpenClaw's biggest pain, or (c) a niche (xiaohongshu? Codex-OAuth-first? cross-tool skill aggregator?) that no one else owns."

### 16.13 Security / privacy angle
"OpenClaw's security backlash is the single biggest *open* opportunity in this space. A new project that markets itself as 'OpenClaw-style integrations, but locked-down by default' would have natural press attention. Friday's approval gate is a structural fit — but Friday is not currently telling that story."

### 16.14 Benchmark / evaluation angle
"None of the three has a published benchmark. Hermes-Agent has Atropos infra for RL evaluation but no public leaderboard. OpenClaw has live-channel CI smoke tests but those are correctness, not capability. Friday has `release:verify` but no comparative benchmark. This is a wide-open lane for *any* of the three to claim."

### 16.15 Long-term maintenance angle
"OpenClaw has 200+ commits/week and clawsweeper automation, but 127 extensions × constant churn is not sustainable forever. Hermes-Agent is centered on a single maintainer (`teknium1`) — bus factor concern. Friday has bus factor 1. All three have maintenance risk; OpenClaw's surface is largest."

### 16.16 Commercialization angle
"OpenClaw's founder went to OpenAI. NousResearch is an LLM company that uses the agent as ecosystem. Friday's commercialization story is unclear (no monetization in code, MIT-licensed, single developer). Friday should decide soon: services around the audit story, or a paid hosted version of the approval gate, or a B2B 'agent security review' niche."

### 16.17 Hype-vs-substance angle
"OpenClaw's 'most-starred GitHub project' is real, but its 'every update breaks something' is also real. Hermes-Agent's curator is real, but its self-eval is contested. Friday's phase controller is real, but the phases it builds are stubs."

### 16.18 Demo virality angle
"OpenClaw has the lobster meme + WeChat demos + Lex Fridman. Hermes-Agent has YouTube setup-on-VPS-in-8-minutes content. Friday has zero viral demo. Friday needs a single 'one demo that explains the whole thing in 60 seconds' video. Candidates: 'Friday refused to delete my prod database because I said the wrong thing,' 'Friday imported all my Cursor skills and explained them to me,' 'Friday adopted an OpenClaw skill in real-time.'"

### 16.19 Local-first / privacy-conscious user angle
"Local LLM via Ollama, BYOK keys, no cloud telemetry by default — all three projects support this in code. OpenClaw's exposure issues come from misconfigured deploys, not the project itself. Hermes-Agent has the lightest cloud footprint. Friday explicitly markets approval-gated and BYOK. **Friday could own the privacy-conscious lane** if it pushed."

### 16.20 Enterprise adoption angle
"Hermes-Agent has no enterprise pitch. OpenClaw has enterprise via NVIDIA NemoClaw + Tencent integration. Friday could pitch enterprise via the audit/evidence chain — every action is approval-gated and on-disk-evidenced, perfect for compliance. **This is Friday's strongest unfilled commercial lane.**"

---

## 17. Claim-Evidence Matrix

| # | Claim | Supports | Evidence | Source link / file:line | Evidence level | Code-verified | User-verified | Counter-evidence | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Hermes-Agent has a real skill-mining curator | Hermes | `agent/curator.py` ~1.7 KLOC, fork-isolated, idle-triggered, transition logic | `/tmp/research/hermes-agent/agent/curator.py:1-100` (read by Explore agent) | L1 | Yes | Yes (multiple Medium/HN posts) | Self-eval honesty contested | High |
| 2 | Hermes-Agent supports Termux/Android | Hermes | `pyproject.toml` `[termux]` `[termux-all]` extras | `/tmp/research/hermes-agent/pyproject.toml` | L1 | Yes | Yes (X user @startupideaspod) | Niche audience | High |
| 3 | OpenClaw has 127 channel/provider/voice extensions | OpenClaw | `extensions/` directory listing | `ls -1d /tmp/research/openclaw/extensions/*/ \| wc -l` = 126 | L1 | Yes | Yes (HN, press) | — | High |
| 4 | OpenClaw has native macOS/iOS/Android apps | OpenClaw | `apps/{macos, ios, android, macos-mlx-tts, swabble, shared}` | `/tmp/research/openclaw/apps/` | L1 | Yes | Yes (press) | Feature parity not verified line-by-line | High |
| 5 | OpenClaw has A2UI Canvas live-render | OpenClaw | `extensions/canvas/index.ts:1-60` | (Explore agent read) | L1 | Yes | Indirect | — | High |
| 6 | OpenClaw has documented security exposure | OpenClaw critique | Bitdefender, Cisco, Trend Micro, Aikido, The Register, Dark Reading | Bitdefender: https://www.bitdefender.com/en-us/blog/hotforsecurity/135k-openclaw-ai-agents-exposed-online ; Aikido: https://www.aikido.dev/blog/why-trying-to-secure-openclaw-is-ridiculous ; Cisco: https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare ; The Register: https://www.theregister.com/2026/02/02/openclaw_security_issues/ | L4 | Indirect (default 0.0.0.0 binding implied by docs/setup, not directly verified in code-only sweep) | Yes | OpenClaw maintainers may have hardened recently — not verified in this sweep | High that the press exists; Medium that the issues remain unmitigated as of today |
| 7 | OpenClaw has near-daily release cadence | OpenClaw | Releases v2026.5.7, .6, .5, .4, .4-beta.3 in 4 days | GitHub releases page | L2 | Indirect | Yes | — | High |
| 8 | OpenClaw has 200+ commits/week | OpenClaw | ~34 commits in one day visible | GitHub commits page (per agent report) | L2 | — | — | — | Medium |
| 9 | Hermes-Agent has weekly named releases | Hermes | v2026.5.7, .4.30, .4.23, .4.10, .3.28 | GitHub releases | L2 | — | — | — | High |
| 10 | Hermes-Agent has 988 tests | Hermes | `find tests/ -name '*.py' \| wc -l` = 988 | (Explore agent) | L1 | Yes | — | Tests count ≠ coverage | High |
| 11 | OpenClaw has 5,266 tests | OpenClaw | `find . -name '*.test.ts' \| wc -l` | (Explore agent) | L1 | Yes | — | Tests count ≠ coverage | High |
| 12 | Friday has 815 tests | Friday | (Explore agent) | (Explore agent) | L1 | Yes | — | — | High |
| 13 | Friday vendors a full OpenClaw copy | Friday | `/home/user/Friday/openclaw/` 246 MB, identical top-level layout to /tmp/research/openclaw | This investigation | L1 | Yes | Cross-confirmed by NOTICE (community researcher) | — | High |
| 14 | Friday's openclaw-adoption is in phase 0 only | Friday | `phase-0.json` workers are stub `console.log`; phases 1–6 manifest-only | (Explore agent inspected `docs/ops/openclaw-adoption/taskpacks/phase-{0..6}.json`) | L1 | Yes | — | Phase 0 status may be intentional bootstrap | High |
| 15 | Friday is hard-wired to Anthropic SDK in agent runtime | Friday gap | Per Explore agent inspection of `src/agent/runtime/friday-agent-runtime.ts` and dep set | (Explore agent) | L1 | Yes (top of file inspected) | — | Recent merged PR titled "OpenAI-compatible setup + routing" suggests this gap is closing | High at investigation time; Medium that gap remains in 4–8 weeks |
| 16 | Friday is solo-developer | Friday | `git log` shows `thesongzhu` dominant, with `Wenxin Dou` and `codex` (bot) co-authors only | (Explore agent + GitHub miner) | L1 | Yes | Yes | — | High |
| 17 | Friday has zero external community signal | Friday | Zero HN, zero Reddit (after disambiguation), zero YouTube, zero blogs, 281 stars, 0 open issues | Community researcher report | L4 | — | Yes | Cannot rule out small private signal in non-indexed Discord | High |
| 18 | Friday has approval gating as a centralized layer | Friday strength | `src/agent/security/friday-mutating-action-gate.ts` plus skill/workflow approval services plus adversarial tests | (Explore agent) | L1 | Yes | — | — | High |
| 19 | Friday has a cross-tool skill scanner | Friday strength | `src/skills/converter/discovery/friday-local-skill-scanner.ts:1-52` scans `~/.claude/`, `~/.cursor/`, `~/.n8n/`, `~/.codex/` | (Explore agent) | L1 | Yes | — | — | High |
| 20 | OpenClaw is most-starred software project on GitHub | OpenClaw | HN thread item 47217812 | https://news.ycombinator.com/item?id=47217812 | L4 | — | Yes | Star counts can be inflated; star-farming not ruled out | Medium-high |
| 21 | OpenClaw has China mass adoption | OpenClaw | Tier-1 Western press: Fortune, CNBC, Japan Times, Asia Society, Caixin, KrAsia | Per community researcher | L4 | — | Yes | — | High |
| 22 | OpenClaw founder Steinberger joined OpenAI | OpenClaw narrative | Sam Altman X post + TechCrunch + CNBC | https://x.com/sama/status/2023150230905159801 | L4 | — | Yes | — | High |
| 23 | Hermes-Agent is "self-improving" claim is overstated | Hermes critique | Self-eval honesty contested in geeky-gadgets review + kilo.ai meta-analysis | https://www.geeky-gadgets.com/hermes-vs-openclaw-ai/ | L5 (single aggregator) | Indirect | Yes (community quotes) | Some users do report incremental skill accumulation | Medium |
| 24 | Hermes-Agent has TUI bugs as recurring complaint | Hermes critique | PR #22062 was the most recent commit at investigation time; multiple top-commented PRs are TUI-related | GitHub | L3 | Indirect | Yes | — | High |
| 25 | Hermes-Agent supports OAuth for Claude Code, Codex, Google CodeAssist | Hermes | `agent/copilot_acp_client.py`, `agent/codex_responses_adapter.py`, `agent/google_oauth.py`, `agent/google_code_assist.py` | (Explore agent) | L1 | Yes | — | OAuth flows can be brittle | High |
| 26 | Friday's NOTICE credits OpenClaw / Steinberger / Clawdbot | Friday relationship | Community researcher direct fetch of NOTICE | https://github.com/thesongzhu/Friday/blob/main/NOTICE | L2 | Indirect (NOTICE not read in this investigation per rules) | Yes | — | High via second-source verification |

---

## 18. Counter-Evidence Matrix

For each popular claim, the matrix below states why it might be wrong, the counter-evidence, and the impact on conclusion.

| # | Popular claim | Why it might be wrong | Counter-evidence | Source | Impact | Confidence |
|---|---|---|---|---|---|---|
| 1 | "Hermes-Agent is the agent that grows with you" | Curator self-eval is unreliable; some users report curator overwriting their manual skill edits | geeky-gadgets review; kilo.ai meta-analysis | https://www.geeky-gadgets.com/hermes-vs-openclaw-ai/ | Reduces "self-improving" claim from product fact to "mechanism present, value variable" | Medium |
| 2 | "Hermes-Agent is an upgrade over OpenClaw" | Hermes lacks OpenClaw's channel breadth, native apps, Canvas, China-scale ecosystem | This investigation §7 + community researcher found the framing originates in marketing/migration narratives | — | Migration-narrative is not code-supported globally; only on specific dimensions | High |
| 3 | "OpenClaw is dangerous to self-host" | OpenClaw has hardened in recent releases (per release cadence); the original 0.0.0.0 default may be configurable | Could not verify in this sweep — community researcher noted Bitdefender / Cisco / Trend Micro / Aikido pieces but didn't audit current OpenClaw security config | Press articles vs current code | Should not say "OpenClaw is dangerous today" without re-auditing current default config | Medium |
| 4 | "OpenClaw is the most-starred project on GitHub" | Star counts are subject to gaming, bot inflation, controversial-news-cycle spikes | Steinberger-joins-OpenAI news cycle would inflate stars; lobster-meme virality on crypto-Twitter would inflate stars | HN item 47217812 + crypto-Twitter virality | The claim is plausibly true at a moment in time; not necessarily a measure of real adoption | Medium |
| 5 | "Friday is a Hermes-Agent successor" | Friday lacks curator, multi-provider, channels, mobile, voice; is solo-developer; 6 months old | This investigation §6, §8, §15 | This document | Marketing this framing publicly would invite ridicule | High |
| 6 | "Friday is an OpenClaw upgrade" | Friday's openclaw-adoption phases 1–6 are unimplemented; only the meta-controller exists | This investigation §3.3, §6, §9 | This document | Marketing this framing would invite ridicule until phases 1–4 ship | High |
| 7 | "The kilo.ai meta-analysis represents real Reddit consensus" | kilo.ai is a half-trustworthy aggregator with opaque sample methodology | Community researcher flag | https://kilo.ai/openclaw/vs-hermes | Drop confidence on quoted Reddit user opinions to "single-aggregator" level | Medium-low |
| 8 | "Hermes-Agent crashes on Arch Linux per @evilsocket" | One person's bad day; many other users install successfully | Other users on YouTube show 8-minute setup videos | https://www.youtube.com/watch?v=_K5nJUIF9x8 | The complaint is real; the frequency is unclear | Medium |
| 9 | "OpenClaw's near-daily releases mean low-quality" | High-quality projects can ship daily if they have automation discipline; OpenClaw has clawsweeper, proof: labels, codeql per OS, install smoke per release | OpenClaw CI workflow names | `.github/workflows/` of OpenClaw | The release cadence may be more disciplined than "ship-and-pray" | Medium |
| 10 | "Friday is doing nothing because it has no users" | Friday has 519 commits in 2 months. Solo-developer projects can be technically deep but commercially unmarketed | This investigation | — | Lack of users ≠ lack of substance, but lack of users *does* mean no UX validation | High |
| 11 | "OpenClaw extension count of 127 means 127 working channels" | Extension dirs include providers, memory, voice, image-gen, video-gen, document-extract — not all are channels | OpenClaw extension listing | This investigation | "Channel count" should be ~30–40, not 127. The 127 figure is total extensions across all categories | High |
| 12 | "Hermes-Agent has 30 platform adapters" | Many of those 30 may be thin wrappers or maintenance-mode | Direct read of `gateway/platforms/` filenames only — depths not verified | This investigation | Probably ~10–15 adapters are first-class; the rest are community-quality | Medium |
| 13 | "All three projects have impressive star counts" | Star counts in 2026 may not measure real adoption; AI-tooling repos see star-farming | General GitHub culture concern | — | Treat raw star counts as one signal among many | High |
| 14 | "Friday's adversarial test suite is comprehensive" | Per Friday Explore agent: "Approval boundary tests are narrow — only 1-2 test cases in approval-boundary-structure.test.ts; coverage is thin for edge cases" | Explore agent's own honesty | This investigation | Adversarial coverage is real but shallow | Medium |
| 15 | "Friday's phase controller is impressive engineering" | True, but the phases it builds are stubs — sophisticated machinery for unimplemented work | This investigation §3.3 | This document | Engineering quality of the controller is high; the strategic value is contingent on phases shipping | High |

---

## 19. Friday Gap Analysis

For each gap: severity (Critical/High/Medium/Low), user impact, technical cause, fix difficulty (S/M/L/XL), recommended fix, priority.

### 19.1 Critical gaps

| Gap | Compared to | Severity | User impact | Technical cause | Recommended fix | Difficulty | Priority |
|---|---|---|---|---|---|---|---|
| LLM provider abstraction (Anthropic-only) | Hermes, OpenClaw both multi-provider | Critical | Single point of failure. Outage/price change/API change at Anthropic = Friday is dead | Hard-wired SDK calls in `friday-agent-runtime.ts` | Lift LLM call into `FridayProviderRegistry`; ship Anthropic + OpenAI + OpenRouter as v0; Vendor LLM model catalog | L (1–2 weeks) | **P0** |
| Zero shipped channel adapters | Hermes ships ~30, OpenClaw ships ~30+ | Critical | Friday cannot operate as a "talk to me from anywhere" agent — kills the multi-channel use case | `src/channels/` is contract surface only | Ship 1 real channel as proof: WhatsApp via `@whiskeysockets/baileys` (lowest licensing risk). Then Telegram. Then Discord. Each ~1 week. | L (per channel) | **P0 (one channel); P1 (three channels)** |
| Zero external user base | Hermes 139K stars, OpenClaw 369K | Critical | No real-world UX validation; no contributor pool; no demo virality; bus factor 1 | Marketing + zero public demo | Pick one differentiator (recommend approval-gated audit story) and produce 1 viral demo video, 1 HN post, 1 r/LocalLLaMA post | M | **P1** |
| OpenClaw-adoption phases 1–6 are stubs | The whole roadmap | Critical | Project's central narrative ("OpenClaw adoption") is unimplemented | Phase 0 only | Pick *one* phase to ship end-to-end (recommend Phase 1 Skills Foundation since skills already exist). Treat phases 2–6 as future. | XL (1 month for one phase if done seriously) | **P1** |

### 19.2 High gaps

| Gap | Severity | Cause | Fix | Priority |
|---|---|---|---|---|
| No skill-learning curator | High | No equivalent of `agent/curator.py` | Build `src/learning/curator/` that runs on idle, mines completed approval-gated trajectories, proposes skills for human approval | **P1** |
| Single-monolith agent runtime (7.7 KLOC) | High | One file mixing 6 concerns | Refactor into `streaming/`, `tool-batch/`, `approval/`, `compaction/`, `checkpoint/`, `error-recovery/` modules | **P1** |
| No ACP server | High | Not yet implemented | Add `src/acp/` server using `agent-client-protocol` npm package | **P2** |
| No MCP support | High | Not yet implemented | Add `src/mcp/` client using `@modelcontextprotocol/sdk-typescript` | **P2** |
| Adversarial test coverage thin | High | Only 1–2 cases per Explore agent | Expand to 20+ adversarial test cases across approval boundary and truth-alignment | **P1** |
| 6 CI workflows vs Hermes 12 vs OpenClaw 50+ | High | Limited release rigor | Add: install-smoke per OS, secret-scanner workflow, dependency-audit workflow, codeql workflow, live-channel smoke (after channels ship) | **P2** |

### 19.3 Medium gaps

| Gap | Severity | Cause | Fix | Priority |
|---|---|---|---|---|
| No memory backend (vector / wiki / active) | Medium | `src/memory/` is skeletal | Add `src/memory/vector/` using `@lancedb/lancedb-node` (matches OpenClaw vendor) | **P2** |
| No voice / TTS | Medium | None | Skip for now unless a clear demo wins from it | **P3** |
| No mobile / Termux | Medium | Node ≥22 + Playwright | Likely not worth chasing | **P3** |
| No cron / scheduled-job tool exposed to agent | Medium | `src/jobs/` exists but no agent-facing tool | Add `cronjob_tool` similar to Hermes-Agent's | **P2** |
| 815 tests vs Hermes 988 vs OpenClaw 5,266 | Medium | Younger project | Continue test growth, target 1,500 by Phase 1 close | **P2** |
| Phase manifest's "allowedPaths" doesn't include `src/providers/` | Medium | Manifest scope-guard concern | Add `src/providers/` and `src/agent/runtime/llm-provider/` to phase 1 or new phase | **P1** when provider work begins |

### 19.4 Low / strategic

| Gap | Severity | Note |
|---|---|---|
| No public benchmark | Low (strategic) | None of the three publish benchmarks; this is a wide-open lane |
| No commercialization story | Low (strategic) | Friday should pick a wedge (audit-first / enterprise / privacy-first) within 90 days |
| Documentation churn signal (1,478 .md files) | Low (architectural smell) | High doc-to-code ratio suggests planning > shipping |
| `OVERNIGHT-TASK-SUMMARY.csv` and many cx-* design files | Low | Suggests the repo is being driven by an automated overnight loop. Concentration risk. |
| `docs/INVESTIGATION-hermes-openclaw-comparison.md` already exists | Low | Confirms that this question recurs internally. May want to consolidate prior + this report. |

### 19.5 Top 10 prioritized gaps (all-up)

1. **P0 — LLM provider abstraction (Anthropic + OpenAI + OpenRouter).**
2. **P0 — One real channel adapter (WhatsApp via Baileys).**
3. **P1 — Phase 1 (Skills Foundation) end-to-end implementation.**
4. **P1 — Curator MVP for approval-gated trajectories.**
5. **P1 — Refactor `friday-agent-runtime.ts` into 6 modules.**
6. **P1 — Public demo + HN post + r/LocalLLaMA post + 1 video.**
7. **P1 — Expand adversarial tests to 20+ cases.**
8. **P2 — ACP server.**
9. **P2 — Vector memory backend (LanceDB).**
10. **P2 — Two more channels (Telegram + Discord).**

---

## 20. Friday Strategy Brainstorm

### 20.1 What to copy from Hermes-Agent

| What | Why | How |
|---|---|---|
| Provider plugin shape (`providers/base.py`) | Cleanest multi-provider abstraction in any of the three | Mirror the `ProviderProfile` shape in TS; auth-type enum (`api_key | oauth_device_code | oauth_external | aws_sdk`); plugin registry with bundled + user-installed override |
| Curator pattern (idle-triggered, fork-isolated) | Ships the "agent that grows with you" feeling | Build a Friday curator that runs at low-priority on idle, can only edit skills (not arbitrary files), and proposes skills via the same approval gate users already trust |
| Cron-as-core | Real value for "set it and forget it" agents | Add `croniter`-equivalent (`node-cron`) and a `friday cron` agent tool |
| OAuth flows for Claude Code / Codex / Gemini CodeAssist | Lower activation barrier | Already in flight per recent Friday PR titles; finish |
| ACP server | Lets Friday be embedded in external IDE/orchestrator UIs | Add `src/acp/server.ts` |
| MCP client | Lets Friday consume external tool servers | Add `src/mcp/client.ts` |
| Setup script (`setup-hermes.sh` style) | Lower install friction | Friday already has `Friday Setup.command` — extend to Linux + Windows |

### 20.2 What NOT to copy

| What | Why not |
|---|---|
| 7K–15K-line agent runtime monolith | Friday already has its own monolith; both are wrong patterns. Refactor own first |
| OpenClaw's 127-extension surface | Maintenance death. Pick 5 real channels and 3 real providers, ship deep |
| Native iOS/Android apps | Not a Friday-stage feature; needs Phase 4+ before it makes sense |
| OpenClaw's `0.0.0.0`-by-default binding | Security antipattern. Friday should default to localhost + opt-in remote |
| Hermes's `ThreadPoolExecutor(max_workers=128)` | Friday's tool-batch executor is already async-first; don't add a thread pool |
| Self-evaluation as a quality signal | Both peers have honesty issues here. Use the approval gate as the quality signal instead |

### 20.3 What Friday can do that NEITHER peer does

1. **Approval-gated agent OS with on-disk evidence chain.** This is Friday's only true differentiator and is also OpenClaw's biggest pain (security backlash). Pitch this aggressively.
2. **Cross-tool skill aggregator.** `~/.claude/`, `~/.cursor/`, `~/.n8n/`, `~/.codex/` discovery. Position Friday as "your AI tools' shared brain."
3. **Audit-first enterprise.** OpenClaw + Hermes are not pursuing compliance/audit; Friday's evidence chain is structurally aligned.
4. **Adversarial truth-alignment tests as a public benchmark.** Open-source the test suite as a repo other agent projects can consume; instant credibility hook.
5. **Phase-driven adoption automation as a meta-product.** The 22-state controller could be open-sourced as a standalone tool for any project doing a similar adoption.

### 20.4 The "winning wedge"

Friday's smallest viable winning wedge: **"The audit-gated personal AI you can show your security team."**

Concrete deliverables for this wedge:
- One demo: a CISO walks through Friday, approves 5 actions, denies 1, sees the on-disk evidence trail.
- One white paper: "How Friday's approval gate compares to OpenClaw's exposure model" (using public Bitdefender/Cisco data, not original security claims).
- One channel: WhatsApp via Baileys (broadest reach).
- One provider abstraction: OpenAI + Anthropic + OpenRouter.
- One curator MVP: idle-time skill miner with approval-gated install.

### 20.5 Killer feature candidates

| Candidate | Pitch | Feasibility | Differentiation |
|---|---|---|---|
| "I refused to" UI | UI surfaces every blocked action with reason; users can review and tune the gate | High (the gate already exists) | Highest |
| Cross-tool skill graph | Visualize how skills from Cursor, Claude, n8n connect | Medium | High |
| Phase controller as standalone tool | Spin out as `@friday/phase-controller` npm package | Medium | High (B2B angle) |
| Adversarial truth benchmark | Public leaderboard for AI-agent honesty | High | Highest (new lane) |
| Approval-gate API for 3rd-party agents | Charge for hosted API of approval gate | Medium | High |

### 20.6 Demo strategy

The single best demo, in order of viral potential:

1. **"Friday refused to drop my prod database."** Show a Postgres CLI, ask Friday to `DROP TABLE users`, watch Friday halt with reason. Cut to evidence chain on disk. ~60 seconds. Audience: any developer.
2. **"Friday found 47 skills across my AI tools."** Run scanner, show classification (claude-code: 12, cursor: 18, n8n: 5, codex: 12). Audience: AI-tool power users.
3. **"Friday is doing OpenClaw adoption phase 0."** Show the phase controller running, the evidence written, the gate working. Audience: engineers interested in safe automation.

### 20.7 Onboarding strategy

- Replace generic README walkthrough with a 3-line install + one approval gate demo within 60 seconds.
- Default to localhost binding, no telemetry.
- Add a `friday why` command that explains the last refused action with full evidence path.

### 20.8 Developer onboarding strategy

- Refactor `friday-agent-runtime.ts` into the 6 modules above so new contributors can learn one piece at a time.
- Publish `@friday/sdk` (or `@friday/plugin-sdk`) with public `.d.ts` like OpenClaw's. Even minimal version invites third-party plugins.
- Friday's `frontend-system/` (12 subdirs of design specs) should be either spun out, deleted, or finished — having it in the same repo as the runtime adds confusion.

### 20.9 Community narrative strategy

- Be **honest** that Friday is a 6-month-old solo project. Don't claim "Hermes-Agent successor."
- Position as "audit-first, BYOK, approval-gated" — not as "the next big thing."
- Engage with OpenClaw's security pain narrative carefully. Do not attack OpenClaw — instead, frame Friday as "what an OpenClaw-style integration matrix would look like with locked-down defaults."
- Submit to HN with a specific demo, not a launch announcement.

---

## 21. Friday Roadmap Recommendation

### 21.1 Two-week roadmap (sprint)

| Day | Task | Deliverable | Success criterion |
|---|---|---|---|
| 1–3 | Spike `FridayProviderRegistry` with Anthropic + OpenAI providers | `src/providers/registry.ts`, `src/providers/anthropic.ts`, `src/providers/openai.ts`, refactored `friday-agent-runtime.ts` to call registry | Both providers work end-to-end with one skill |
| 4–5 | Add OpenRouter provider (5–10 min using OpenAI-compatible base URL) | `src/providers/openrouter.ts` | OpenRouter model works |
| 6–8 | Spike WhatsApp adapter using `@whiskeysockets/baileys` | `src/channels/whatsapp/index.ts`, end-to-end "send message via Friday → reply" | One real WhatsApp message exchange |
| 9–10 | Refactor `friday-agent-runtime.ts` into 6 modules | Smaller files, same behavior, same tests pass | `release:verify` green |
| 11–12 | Adversarial test expansion: 20 new cases | `test/adversarial/*.test.ts` | All cases hit gate correctly |
| 13–14 | Demo video: "Friday refused to drop my prod DB" + HN post | YouTube + r/LocalLLaMA post | 1 demo published, 1 HN front-page attempt |

### 21.2 1–2 month roadmap

| Phase | Goal | Modules touched |
|---|---|---|
| Month 1 | Provider abstraction shipped + 1 channel + 1 demo | `src/providers/`, `src/channels/whatsapp/`, `src/agent/runtime/` |
| Month 1 | Curator v0 (idle-time skill miner with approval gate) | `src/learning/curator/` |
| Month 1.5 | Telegram + Discord channels | `src/channels/telegram/`, `src/channels/discord/` |
| Month 1.5 | LanceDB vector memory | `src/memory/vector/` |
| Month 2 | ACP server + MCP client | `src/acp/`, `src/mcp/` |
| Month 2 | Phase 1 (Skills Foundation) end-to-end implementation, not stubs | `src/skills/` per phase-1 manifest |
| Month 2 | Public benchmark for approval-gate truth-alignment | `bench/` |

### 21.3 3–6 month roadmap

- 3 channels live (WhatsApp, Telegram, Discord) with live-channel CI smoke tests.
- 3 providers with OAuth (Anthropic + OpenAI Codex + Claude Code).
- Curator running in production for selected users with metrics on skill adoption rate.
- Phase 2 (Public Plugin SDK Preview) end-to-end implementation.
- Spin out `@friday/phase-controller` and `@friday/approval-gate` as standalone packages.
- Public benchmark for agent truth-alignment with leaderboard.
- Optional: enterprise audit pitch with one design partner.

---

## 22. Final Recommendations

### 22.1 Friday's top 10 immediate actions

1. Ship LLM provider abstraction (Anthropic + OpenAI + OpenRouter). **P0.**
2. Ship one real channel: WhatsApp via Baileys. **P0.**
3. Stop framing Friday as "Hermes-Agent successor." Reframe as "audit-first, approval-gated agent OS."
4. Refactor `friday-agent-runtime.ts` from 7.7 KLOC monolith into 6 modules.
5. Build curator v0: idle-time skill miner gated by approval system.
6. Expand adversarial tests from ~2 cases to 20+.
7. Produce one demo video: "Friday refused to drop my prod DB."
8. Submit to HN with the demo, not the project.
9. Add ACP server + MCP client.
10. Pick one phase (recommend Phase 1) and ship it end-to-end before doing more meta-work.

### 22.2 Friday's top 5 things NOT to do

1. **Don't** ship more design docs. The `docs/` directory is already 497+ files. Plan-to-code ratio is upside-down.
2. **Don't** copy OpenClaw's 127-extension surface. Pick 5 channels deep, not 50 shallow.
3. **Don't** chase Termux/iOS/Android in the next 6 months. Native macOS Electron is enough.
4. **Don't** market the openclaw-adoption phases until at least one is end-to-end implemented.
5. **Don't** attack OpenClaw publicly over security. Frame Friday by what it does differently, not by what OpenClaw gets wrong.

### 22.3 Friday's top 5 opportunities to surpass Hermes-Agent

1. **Audit-first enterprise wedge.** Hermes-Agent has no enterprise pitch; Friday's evidence chain is structurally aligned with compliance buyers.
2. **Cross-tool skill aggregation.** Hermes-Agent only knows its own skill format; Friday already scans Claude/Cursor/n8n/Codex.
3. **Adversarial benchmark.** Be the first agent project to publish a public truth-alignment leaderboard.
4. **Approval-gate-as-a-service.** Productize the gate as a hostable API for other agent projects.
5. **Phase controller as a standalone tool.** Open-source `@friday/phase-controller` for any project doing similar adoption work.

### 22.4 Friday's most-needed "claims to prove"

| Claim | How to prove |
|---|---|
| "Friday refuses dangerous actions reliably" | 20+ adversarial tests + public demo |
| "Friday works with multiple providers" | Ship the registry + 3 providers |
| "Friday integrates with where you talk" | Ship WhatsApp + 1 more channel |
| "Friday's evidence chain is auditable" | Publish a sample evidence dump from a real session |
| "Friday adopts OpenClaw skills correctly" | End-to-end Phase 1 implementation with diff vs vendored OpenClaw |

### 22.5 Friday's most-needed perception fixes

| Perception | Fix |
|---|---|
| "There's no Friday community" | One viral demo + HN/Reddit post + 1 well-targeted blog |
| "Friday is a single-developer hobby" | Recruit 1–2 contributors with a public RFC |
| "Friday is an OpenClaw fork" | Be explicit that vendored OpenClaw is a reference, not a runtime dep; acknowledge the adoption framing |
| "Friday is over-planned and under-built" | Reduce `docs/` size; merge cx-* and DESIGN-* files into a single living plan |
| "Friday is in 'phase 0 forever'" | Ship Phase 1 end-to-end, then market the change |

### 22.6 Brutally honest final conclusion

Friday today is a **safety-conscious, audit-first, single-developer project that has built impressive meta-tooling (the phase controller) around a single-provider, channel-less, monolithic agent runtime, with no external user base and no shipped public demo of its differentiator (the approval gate).**

The core technical work is real. The strategic positioning is wrong: framing Friday as a "Hermes-Agent or OpenClaw successor" sets up a comparison Friday will lose on every breadth dimension, while underselling the audit/approval/evidence axis where Friday actually has a unique offering.

If Friday ships **the provider registry, one real channel, the runtime refactor, the curator MVP, and one viral demo** in the next 60 days — and reframes positioning to "the audit-gated agent OS for AI-tool aggregation" — Friday becomes a defensible third project in this space, not a "successor" to either peer. That's the realistic best-case for the next 90 days.

If Friday continues to add design docs, phase scaffolding, and audit reports without shipping a demo of the differentiator, Friday will remain a project nobody outside the author can find a reason to use.

---

## 23. Appendix

### 23.1 Search queries used (community researcher subset)

- `"NousResearch/hermes-agent" GitHub repository`
- `"openclaw" GitHub AI agent framework repository`
- `Hermes-Agent NousResearch review/install/bug/feedback/setup/tutorial/demo`
- `site:reddit.com NousResearch Hermes-Agent`
- `site:news.ycombinator.com Hermes-Agent`
- `"Hermes-Agent vs OpenClaw"` / `"OpenClaw vs Hermes-Agent"`
- `OpenClaw Peter Steinberger review/bug/install`
- `"thesongzhu Friday" review install`
- `"Friday agent" thesongzhu site:reddit.com`
- `"Friday vs OpenClaw"` / `"Friday vs Hermes"`
- Disambiguation negation queries for "Hermes LLM" / "Hermes JS engine" / "Captain Claw" / "Friday AI" generic projects

### 23.2 Top sources (deduplicated, top by relevance)

**Hermes-Agent:**
- https://github.com/NousResearch/hermes-agent
- https://news.ycombinator.com/item?id=47786673
- https://news.ycombinator.com/item?id=47754556
- https://www.datacamp.com/tutorial/hermes-agent
- https://medium.com/@sathishkraju/i-switched-from-openclaw-to-hermes-agent-heres-what-nobody-told-me-5f33a746b6ca
- https://github.com/NousResearch/hermes-agent/issues/16201
- https://github.com/NousResearch/hermes-agent/issues/10585
- https://x.com/evilsocket/status/2043365101223170489

**OpenClaw:**
- https://github.com/openclaw/openclaw
- https://news.ycombinator.com/item?id=46931805
- https://news.ycombinator.com/item?id=47217812
- https://www.bitdefender.com/en-us/blog/hotforsecurity/135k-openclaw-ai-agents-exposed-online
- https://www.aikido.dev/blog/why-trying-to-secure-openclaw-is-ridiculous
- https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare
- https://www.theregister.com/2026/02/02/openclaw_security_issues/
- https://techcrunch.com/2026/02/15/openclaw-creator-peter-steinberger-joins-openai/
- https://fortune.com/2026/03/14/openclaw-china-ai-agent-boom-open-source-lobster-craze-minimax-qwen/
- https://www.youtube.com/watch?v=YFjfBk8HI5o (Lex Fridman #491)

**Friday:**
- https://github.com/thesongzhu/Friday
- https://github.com/thesongzhu
- https://github.com/thesongzhu/Friday/blob/main/NOTICE (cross-confirms vendored-OpenClaw + credits)

### 23.3 Markdown / report files seen and explicitly NOT read (representative list)

**Hermes-Agent:** `README.md`, `README.zh-CN.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RELEASE_v0.2.0.md` through `RELEASE_v0.13.0.md` (12 files), `hermes-already-has-routines.md`, all 941 `.md` files repo-wide.

**OpenClaw:** `README.md` (86 KB), `CHANGELOG.md` (1.99 MB), `AGENTS.md`, `CLAUDE.md` (symlink to AGENTS.md), `CONTRIBUTING.md`, `SECURITY.md`, `VISION.md`, all 891 `.md` files repo-wide. `appcast.xml` (211 KB) seen but not used.

**Friday:** `README.md`, `README.zh-CN.md`, `AGENTS.md`, `AUDIT-REPORT.md`, `CHANGELOG.md`, `ROADMAP.md`, `NOTICE`, `OVERNIGHT-TASK-SUMMARY.csv`, `qa-report.html`, `docs/INVESTIGATION-hermes-openclaw-comparison.md`, `docs/agent-runtime-design.md`, `docs/skill-system-design.md`, `docs/plugin-system-design.md`, `docs/workflow-engine-design.md`, `docs/memory-core-design.md`, `docs/distributed-architecture.md`, `docs/SUBAGENT-REFERENCE.md`, `docs/BLUEPRINT-CLOSED-LOOP.md`, `docs/EXECUTION-PLAYBOOK.md`, all `docs/cx-*.md`, all `docs/UI-PHASE3*-DESIGN.md`, `docs/DESIGN-XIAOHONGSHU.md`, `docs/REVIEW-BACKEND.md`, `docs/REVIEW-FRONTEND-VISION.md`, all 497 `.md` files outside vendored OpenClaw.

### 23.4 Files NOT inspected (and why)

- All `node_modules/`, `dist/`, build artifacts (transient).
- All `apps/ios/*.swift`, `apps/android/*.kt|.kts`, `apps/macos/*.swift` in OpenClaw (out of TS scope; existence noted only).
- All `locales/` bundles in Hermes-Agent (i18n, not architectural).
- All `tests-overnight/` in Friday (low signal, automated overnight runs).
- 99% of `frontend-system/` content in Friday (design-spec mirror, not runtime).
- Vendored `/home/user/Friday/openclaw/` (analyzed under §2.2 / §3.2 from the standalone OpenClaw clone).

### 23.5 Evidence-level scale

- **L1:** Code directly proves the claim (file:line citation).
- **L2:** Configuration / lockfile / CI / commit / release tag / executable example proves the claim.
- **L3:** GitHub issue / PR / commit comment from a real user or maintainer.
- **L4:** Multiple platforms / news / academic sources independently confirm.
- **L5:** Single user opinion or single aggregator.
- **L6:** Investigator's reasoning or judgment.

### 23.6 Scoring rubric used in §7–§9

Where matrices include implicit comparison, scoring is qualitative:
- **Wins decisively:** code evidence + community evidence both confirm.
- **Wins:** code evidence confirms; community signal absent or mixed.
- **Tied:** code parity; community signal balanced.
- **Loses:** code evidence shows gap; community signal also confirms.

### 23.7 Confidence calibration

- **High confidence:** code-verified + at least one independent external source.
- **Medium confidence:** code-verified but external sources are aggregator / single-source / unverifiable.
- **Low confidence:** only inference or single-aggregator source.

### 23.8 Things I could not verify and that need future human follow-up

1. **OpenClaw's current default-binding configuration.** The Bitdefender / Cisco / Trend Micro pieces are 2–4 months old. Whether OpenClaw still binds to 0.0.0.0 by default in the *current* code was not deeply verified in this sweep (only top-level `openclaw.mjs` and `src/entry.ts` were read; the binding default lives deeper).
2. **Whether `kilo.ai/openclaw/vs-hermes` quotations are real Reddit users or synthesized.** This was flagged by the community researcher.
3. **Friday's NOTICE wording.** Cross-confirmed by community researcher but not directly inspected by code-investigation pass per the markdown-exclusion rule.
4. **Star-count integrity for OpenClaw and Hermes-Agent at 369K and 139K respectively.** Numbers came back consistent across multiple WebFetch + WebSearch passes and across multiple maintainer-activity signals; still, AI-tooling repos do see star-farming.
5. **Whether Friday's recent merged PRs (since this investigation's branch checkpoint at SHA 8c063fa) close any of the gaps in §19.** The recent PR titles "OpenAI-compatible setup + routing," "Codex OAuth provider flow," and "OpenRouter provider catalog expectation" suggest the provider gap is closing — needs re-audit at next investigation.

### 23.9 Coverage gaps that this report is honest about

- **Per-issue comment counts on GitHub:** unavailable from list-view scraping; reported as relative ranking only.
- **Reddit body content:** rate-limited; relied on aggregator quotations.
- **HN comment-level sentiment:** Algolia indexes titles, not comment bodies; unverified.
- **X / Twitter post engagement metrics:** non-public via WebFetch; reported only post existence + author.
- **Discord / Telegram / Slack public-channel volumes for any of the three projects:** not inspectable.
- **OpenClaw's Swift/Kotlin native app code:** existence verified, contents not read.
- **The 7,700-line `friday-agent-runtime.ts`** was sampled at top + targeted line ranges per Explore agent; not read end-to-end. Specific runtime decisions in mid-file regions were not directly verified.
- **All 5,266 OpenClaw test files:** existence counted; substance not read.
- **All 988 Hermes-Agent tests:** sample of 3–5 read; substance of remainder not.
- **Friday's `frontend-system/` 12 subdirs of design specs:** layout inspected; content not (likely markdown).

---

*End of report. Total length is intentionally long because the brief asked for it. If the user wants a shorter executive cut, I can produce a 2-page distillation. The recommended next step for Friday is **§22.1 items 1–3** within 14 days.*

