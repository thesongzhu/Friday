# Friday Capability Proof Matrix — 2026-05-11 snapshot

**This file is a dated snapshot of the evidence state for `origin/main` as observed on 2026-05-11.** It is **not** a permanent truth source. The authoritative current product surface lives in [`docs/current-source-of-truth.md`](../current-source-of-truth.md); the authoritative evidence taxonomy lives in [`docs/release-evidence-policy.md`](../release-evidence-policy.md). When this snapshot conflicts with either, those documents win and this file is stale.

## 1. Snapshot anchor

| Field | Value |
|---|---|
| Snapshot date | 2026-05-11 |
| `origin/main` SHA | `edaadf7a1a177c833a74625374722daa7e6833e1` |
| Most recent merge | [#194 — Fail-closed gate for high-impact learned-preference injection](https://github.com/thesongzhu/Friday/pull/194) |
| Latest Real Green Gate run on this SHA | run id `25646562619` (workflow `real-green-gate.yml`) |
| Run workflow conclusion | `success` |
| Run downloaded artifact `real-green-gate-result.json` `status` | `blocked_by_env` |
| Run downloaded artifact `blocked_reasons` | `["env_var_missing:FRIDAY_BASE_URL_or_FRIDAY_ACCESS_TOKEN_or_FRIDAY_LOCAL_PASSPHRASE_or_FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN"]` |
| `scenarios_run` / `scenarios_total` / `scenarios_passed` | `0` / `0` / `0` |
| `evidence_kinds_observed` | `[]` |

### Workflow conclusion vs artifact status

These two signals are not the same and must not be conflated.

- **GitHub workflow conclusion = `success`** means workflow plumbing succeeded — the job ran without infrastructure error and emitted an artifact.
- **Downloaded artifact `status` = `blocked_by_env`** means release proof is **absent** for this SHA: the live gate did not execute its scenarios because the required environment variables (`FRIDAY_BASE_URL` / `FRIDAY_ACCESS_TOKEN` / `FRIDAY_LOCAL_PASSPHRASE` / `FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN`) were not configured.
- `blocked_by_env` must **never** be described as pass.

The validator [`scripts/ops/validate-real-green-gate-result.mjs`](../../scripts/ops/validate-real-green-gate-result.mjs) (introduced in PR #187) requires `status === "passed"` AND `scenarios_total > 0` AND `scenarios_passed === scenarios_total` AND `blocked_reasons === []`. The release-time `live-proof-gate` job in [`.github/workflows/release.yml`](../../.github/workflows/release.yml) (introduced in PR #188) downloads the artifact and runs that validator. A `blocked_by_env` artifact would therefore **fail** `live-proof-gate` if a release tag for this SHA were attempted.

## 2. Evidence-tier definitions

Per [`docs/release-evidence-policy.md`](../release-evidence-policy.md), only the following tiers are release-proof eligible:
- `real-provider`
- `real-browser`
- `real-runtime`
- `cloud-live`
- `manual-external`

`mock-contract`, `mock-hub`, and `browser-mock-hub` are useful for fast regression detection but are **not** release proof.

This snapshot uses the following classification tokens for each capability row:

| Token | Meaning |
|---|---|
| `release-proof same-SHA` | A `passed` Real Green Gate result artifact for the exact SHA in §1, validated by `validateRealGreenGateResult`. |
| `local real-runtime/provider` | A live e2e test exists; can be run on a local dev box with the right credentials; would produce real-runtime + real-provider evidence on that local box (not a release-proof same-SHA artifact). |
| `blocked_by_env` | Test/scenario exists but the env it requires is not currently configured. Specifically used here for any RGG scenario in run id `25646562619`. |
| `mock-only` | Only `mock-contract` / `mock-hub` / `browser-mock-hub` coverage. Per release-evidence-policy: not release proof. |
| `manual-external` | Requires a real external system (Discord guild, deployed Friday cloud env, etc.) on top of the test code. |
| `historical-only` | An older test/run produced evidence on a different SHA. Not release proof for current `main`. |
| `MISSING` | No test exists at any tier. |

### Headline state

**Current `main@edaadf7a` has zero release-proof same-SHA evidence.** Every capability row in §3 carries `blocked_by_env`, `mock-only`, `local real-runtime/provider`, `manual-external`, `historical-only`, or `MISSING` as its strongest current tier.

**Historical Real Green Gate evidence from April 23 on `cb3ae831` is historical-only and not release proof for current main.** That historical run (id `24819909526`) executed before PR #187 introduced the structured `real-green-gate-result.json` artifact format on 2026-05-10, so it has no validator-shaped result file at all; even if it had passed end-to-end, the validator's same-SHA check rejects any artifact whose `commit_sha` does not equal the expected SHA.

## 3. Capability rows grouped by surface family

Surface families are taken from [`docs/current-source-of-truth.md`](../current-source-of-truth.md) (snapshot 2026-05-11). Every row's strongest current tier is one of the tokens defined in §2.

### 3.1 Web UI surfaces (default-on)

| Surface | RGG scenario | Strongest current tier |
|---|---|---|
| `/home` | `l1-home-ui` (PUBLIC_SURFACE) | `blocked_by_env` |
| `/chat` | `l1-chat-ui` (DAILY_CORE) | `blocked_by_env` |
| `/packs` | `l1-packs-ui` + `l1-cross-border-pack-setup-ui` | `blocked_by_env` |
| `/assistant` | `l1-assistant-ui` (DAILY_CORE) | `blocked_by_env` |
| `/skills` | `l1-skills-ui` + `l1-skill-generator-ui` | `blocked_by_env` |
| `/workflows` | `l1-workflows-ui` + `l1-workflow-builder-ui` | `blocked_by_env` |
| `/observability` | `l1-observability-ui` (DAILY_CORE) | `blocked_by_env` |
| `/sessions` | `l1-sessions-ui` | `blocked_by_env` |
| `/mcp` | `l1-mcp-ui` | `blocked_by_env` |
| `/fleet` | `l1-fleet-ui` | `blocked_by_env` |
| `/channels` (UI) | `l1-channels-ui` | `blocked_by_env` |
| `/plugins` (UI) | `l1-plugins-ui` | `blocked_by_env` |
| `/automations` (UI) | `l1-automations-ui` + `l1-automation-detail-redirect-ui` | `blocked_by_env` |
| `/memory` (UI) | `l1-memory-ui` | `blocked_by_env` |
| `/usage` (UI) | `l1-usage-ui` | `blocked_by_env` |
| `/settings` | `l1-settings-ui` (DAILY_CORE) | `blocked_by_env` |
| `/command-center` | `l1-command-center-ui` | `blocked_by_env` |
| `/guided-flow` | `l1-guided-flow-ui` | `blocked_by_env` |

### 3.2 Public API contracts (L0 / L2 — no provider key required)

| Surface | RGG scenario | Strongest current tier |
|---|---|---|
| `/v1/health` | `l0-runtime-health` | `blocked_by_env` |
| `/v1/providers/health` (lanes ready) | `l0-provider-lanes-ready` | `blocked_by_env` |
| onboarding truth | `l0-onboarding-truth-mismatch` | `blocked_by_env` |
| `/v1/uix/*` (diagnostics) | `l2-uix-diagnostics-contract` | `blocked_by_env` |
| `/v1/channels*` (read contract + persona) | `l2-channels-contract` + `l2-channel-persona-contract` + `l2-channel-persona-update-contract` | `blocked_by_env` |
| `/v1/memory/*` (items create) | `l2-memory-items-create-contract` | `blocked_by_env` |
| `/v1/plugins*` | `l2-plugins-contract` | `blocked_by_env` |
| `/v1/fleet/*` (overview) | `l2-fleet-overview-contract` | `blocked_by_env` |
| `/v1/automations*` | `l2-automations-contract` | `blocked_by_env` |
| `/v1/sessions/*` | `l2-sessions-contract` | `blocked_by_env` |
| home snapshot | `l2-home-snapshot-contract` | `blocked_by_env` |
| heartbeat status | `l2-heartbeat-status-contract` | `blocked_by_env` |

### 3.3 Agent core capability (L3–L5 — provider-required)

| Capability | RGG scenario / live test | Strongest current tier |
|---|---|---|
| Direct chat answer | `l3-chat-direct-answer` (DAILY_CORE) | `blocked_by_env` |
| JSON extraction | `l3-json-extraction` | `blocked_by_env` |
| Multi-turn memory | `l3-multi-turn-memory` | `blocked_by_env` |
| Long-summary direct | `l3-long-summary-direct` | `blocked_by_env` |
| Summary misroute guard | `l3-summary-misroute-guard` | `blocked_by_env` |
| File tool roundtrip | `l4-file-tool-roundtrip` | `blocked_by_env` |
| Workflow approval roundtrip | `l5-workflow-approval-roundtrip` | `blocked_by_env` |
| 10 real user journeys (Anthropic-only) | `test/e2e/live/friday-real-journeys.e2e.test.ts` | `local real-runtime + real-provider Anthropic` (when `FRIDAY_E2E_LIVE_ANTHROPIC=1` + Anthropic key configured locally) |

### 3.4 Agent self-upgrade lanes (provider-agnostic since PR #192)

All gated on `FRIDAY_DEEP_PROOF_GATED` = exactly-one of `{anthropic|deepseek|openai|ollama}` provider lane + matching credential ([test/e2e/live/_helpers/deep-proof-env.ts](../../test/e2e/live/_helpers/deep-proof-env.ts)). Evidence is **lane-specific**: a DeepSeek run proves DeepSeek, not Anthropic.

| Capability | Live test | Strongest current tier |
|---|---|---|
| Channel adapter self-upgrade | `friday-self-upgrade-channel-adapter-live.e2e.test.ts` | `local real-runtime + real-provider <selected lane>` |
| MCP server self-upgrade | `friday-self-upgrade-mcp-server-live.e2e.test.ts` | same |
| Plugin self-upgrade | `friday-self-upgrade-plugin-live.e2e.test.ts` | same |
| Provider profile self-upgrade | `friday-self-upgrade-provider-profile-live.e2e.test.ts` | same |
| Workflow self-upgrade | `friday-self-upgrade-workflow-live.e2e.test.ts` | same |
| Autonomous restart matrix | `friday-autonomous-restart.e2e.test.ts` | same |
| Subagent (fresh + fork mode) | `friday-subagent-live.e2e.test.ts` | same; fork-mode further gated on `FRIDAY_SUBAGENT_FORK_MODE_ENABLED` |
| Generator maintenance (skill) | `friday-generator-maintenance-live.e2e.test.ts` | same |
| Generator maintenance (workflow) | `friday-workflow-generator-maintenance-live.e2e.test.ts` | same |

### 3.5 Provider-specific tests

| Capability | Live test | Gate | Strongest current tier |
|---|---|---|---|
| Self-healing matrix | `friday-self-healing-live.e2e.test.ts` | `SELF_HEALING_PROOF_GATED` (OpenAI **or** DeepSeek) | `local real-runtime + real-provider <openai\|deepseek>` |
| Learning pipeline | `friday-learning-live.e2e.test.ts` | `LEARNING_PROOF_GATED` (OpenAI **or** DeepSeek) | same |
| Playbook upgrade boundary | `friday-playbook-upgrade-boundary-live.e2e.test.ts` | `OPENAI_PROOF_GATED` (OpenAI only) | `local real-runtime + real-provider OpenAI` |
| Voice execution | `friday-execution-voice-live.e2e.test.ts` | `LIVE_VOICE_GATED` (`FRIDAY_E2E_LIVE_VOICE=1` + provider lane) | `local real-runtime + real-provider <selected lane>` |
| Blind-user matrix | `friday-blind-user-matrix.e2e.test.ts` | `CHROMIUM_AVAILABLE && hasLiveAnthropicApiKey()` | `local real-runtime + real-provider Anthropic + real-browser` |
| Reflex live | `friday-reflex-live.e2e.test.ts` | `FRIDAY_REFLEX_LIVE_PROFILE` | `local real-runtime` (provider not strictly required) |

### 3.6 External-dependent surfaces

| Capability | Live test | External dep | Strongest current tier |
|---|---|---|---|
| Discord channel inbound→outbound | `friday-discord-channel-live.e2e.test.ts` | `FRIDAY_E2E_LIVE_DISCORD=1` + sandbox bot token + `DISCORD_SETUP_USER_ID`; finding F-008 OPEN — token must be rotated before any run | `local real-runtime + manual-external` (sandbox guild) when env configured |
| Cloud journeys | `friday-cloud-journeys.e2e.test.ts` | `FRIDAY_E2E_TARGET=cloud` + `FRIDAY_E2E_CLOUD_BASE_URL` + auth + provider lane; finding F-009 OPEN — Fly app + secrets not provisioned | `cloud-live + real-provider <selected lane>` when env configured |

### 3.7 Default-on capabilities WITHOUT a live test (mock-only or missing)

| Capability | Source-of-truth claim | Live test | Strongest current tier |
|---|---|---|---|
| Deep link parse / validate | `/v1/deeplink/preview` + `/v1/deeplink/apply` for provider-template / skill-source / workflow-template | none in `test/e2e/live/`; unit tests in CONVERGENCE_FEATURE_TESTS (`friday-deeplink-parser`, `friday-deeplink-validator`) | `mock-only` (unit) |
| Policy extension chain | `src/security/policy-extension-chain.ts` | unit only (CONVERGENCE_FEATURE_TESTS) | `mock-only` |
| Shell safety scanner | `src/skills/safety/friday-shell-safety-scanner.ts` | unit only (CONVERGENCE_FEATURE_TESTS) | `mock-only` |
| Skill discovery + manifest loader + lifecycle | `/v1/skills/*` | CLAUDE_SKILL_TESTS unit/integration (3 tests in run-real-green-gate.mjs) with mock `lifecycle` deps; see also Finding F-017 — `POST /v1/skills/:skillId/verify`, `GET /v1/skills/catalog`, `GET /v1/skills/:skillId`, `POST /v1/skills/validate-manifest`, and the lifecycle-branch `install`/`update`/`delete` are **not registered** in the standalone hub today because `skillLifecycle` is not wired into `createFridayApiRuntime` (`src/hub/friday-hub-bootstrap.ts` has zero `skillLifecycle` references). Standalone-hub registered `/v1/skills/*` routes today: `GET /v1/skills`, `POST /v1/skills/:skillId/run`, and `PATCH /v1/skills/:skillId/content` (canonical-approval gated). | `mock-only` (unit/integration) — lifecycle HTTP route real-runtime coverage is **not** currently available in the standalone hub; the wiring fix is gated by Finding F-017 and requires canonical-approval gating on `update`/`delete` before lifecycle can be wired safely. |
| Provider doctor / validation / setup wizard (full UX) | `/v1/providers/*`, `/v1/setup/*`, doctor, lane health | partial coverage in `friday-self-upgrade-provider-profile-live` (single-provider self-upgrade slice); no end-to-end "wizard → save → doctor → settings" live test | `mock-only` for full setup UX; `local real-runtime + real-provider` for self-upgrade slice |
| Channel adapters other than Discord (Lark / Telegram / Webhook / Email) | `/v1/channels*` registry surface | none live | `mock-only` |
| Fleet / satellite registration / heartbeat | `/v1/satellites/*` control plane | UI scenario only (`l1-fleet-ui`, `l2-fleet-overview-contract` — both `blocked_by_env`); no two-hub live test | `mock-only` for control-plane semantics |
| Distributed workflow placement (`hub` / `satellite:<id>` / `capability-match`) | placement contract | none live | `mock-only` |
| Realtime WebSocket gateway (`/v1/realtime/ws`) | canonical realtime transport | indirectly via `l5-workflow-approval-roundtrip` (real-runtime when RGG runs) | `blocked_by_env` |
| Workflow deploy / publish / overview / visualization | one-click deploy + builder | UI scenario covers builder; no dedicated workflow-deploy live e2e | `mock-only` for the deploy slice; `blocked_by_env` for UI |
| Self-healing executors (`disable_skill`, `retry_node`, `switch_model_fallback`, `trim_payload`, `pause_workflow`) | hub-wired side effects | `friday-self-healing-live` covers the auto-fix path overall; per-executor matrix not enumerated this audit. **2026-05-11 DeepSeek local live run**: 4 of 5 `it` blocks in `test/e2e/live/friday-self-healing-live.e2e.test.ts` passed under `FRIDAY_E2E_LIVE_DEEPSEEK=1` (auto-fix + lesson readback; rollback over real HTTP; anti-learning lesson disable; workflow-failure → incident + loop run). The 5th `it` (`turns a real skill verification drift into a disable-skill self-healing action that verifies`) failed because `POST /v1/skills/:skillId/verify` returned HTTP 404 from the router — the route is not registered (Finding F-017). The failure is provider-independent (no LLM call between test start and the 404) and would occur on any provider lane. This is **not** full local real-runtime self-healing proof; it is partial coverage of the auto-fix + lesson + rollback + anti-learning + workflow-failure paths only. Local DeepSeek evidence is also **not** RGG release proof. | `local real-runtime + real-provider <openai\|deepseek>` for the 4-pass subset only (2026-05-11 DeepSeek). The skill-verification-drift → `disable_skill` executor path remains `MISSING` real-runtime coverage in standalone hub until Finding F-017 is resolved. |
| Approval-gated executors (`apply_config_patch`, `grant_permission`) | deterministic approval-only | unit only | `mock-only` |
| Phase 4A.7 high-impact learned-preference fail-closed gate (PR #194) | `src/agent/runtime/friday-agent-preference-injector.ts` | `test/unit/agent/runtime/friday-agent-preference-injector.test.ts` (9 tests) + sensitivity unit tests | `mock-only` (unit). PR #194 closes Phase 4A.7 Gap #2 semantics at unit level. It is **not** real-runtime, **not** real-provider, **not** release proof. |
| Compaction context replay write side (PR #184) | DEC-013 markers | unit only | `mock-only` |
| Compaction context replay read side ("unconfirmed_summary" marker respected by prompt builder) | F3 Gap #1 (deferred) | none | `MISSING` |
| Real Green Gate suite itself | `npm run ops:real-green-gate` | covered by `scripts/ops/lib/real-green-gate-result.mjs` validator unit tests | `mock-only` for the validator; the suite itself is `blocked_by_env` at this SHA |
| Release governance (P4-G1) | `release.yml` `live-proof-gate` job | wired in code (PR #187 / #188 / #189) but **never exercised on a real release tag** | `mock-only` for the validator; workflow plumbing is `historical-only` in the sense that no real tag has ever taken the chain through `live-proof-gate` |
| `/v1/packages*` | env-gated, in-memory only when `FRIDAY_PACKAGING_ENABLED=true` | none live | `mock-only`; doc-honesty mirror of PR #191 deferred to phase F2 |
| `/v1/security/tenants*` | env-gated, in-memory only when `FRIDAY_MULTI_TENANT_ENABLED=true`; not a persistence isolation guarantee per PR #191 | none live | `mock-only`; doc honesty already landed in PR #191 |
| Media-understanding primitives | code-present, `FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true`; no real provider-registration path per source-of-truth | none live | `MISSING` for real lane (already documented as not-ready) |
| Slack webhook + SMTP email alert dispatch | source-of-truth claims "release-complete" for current observability | none in `test/e2e/live/`; unit/integration only | `mock-only` |
| Setup status diagnostics (`ui/src/lib/setup/setup-status-diagnostics.ts`) | auth/error remediation | unit only | `mock-only` |
| Tool call summary + capability-grant evidence trail | realtime event surface | covered indirectly when RGG runs | `blocked_by_env` |
| WebDAV cross-device sync | source-of-truth: deferred post-release; "infrastructure does not exist" | none | `MISSING` (already acknowledged in source-of-truth) |

### 3.8 Other source-of-truth named surfaces

These surfaces are explicitly named in [`docs/current-source-of-truth.md`](../current-source-of-truth.md) as canonical route families or active steady-state surfaces but do not have a dedicated RGG scenario or live e2e test of their own. Their evidence comes from indirect coverage (a UI scenario, an agent-loop scenario, or a higher-level live test that exercises them transitively) or from unit/integration mock tests.

| Surface | Test / scenario | Strongest current tier |
|---|---|---|
| `/v1/agent-loop/*` (supervised agent loop) | exercised by `friday-self-healing-live.e2e.test.ts:450,537` (`/v1/agent-loop/policy` + `/v1/agent-loop/runs?limit=20`); no dedicated route-contract scenario; not exercised by `friday-real-journeys.e2e.test.ts` (which targets `/v1/agent/runs` instead) and not exercised by L3–L5 DAILY_CORE scenarios | `local real-runtime + real-provider <openai\|deepseek>` (self-healing-live, when env configured) |
| `/v1/diagnosis/*` | exercised by `friday-self-healing-live.e2e.test.ts` end-to-end (self-healing produces diagnoses) and indirectly by `l1-observability-ui` / `l1-assistant-ui`; no dedicated route-contract scenario | `local real-runtime + real-provider <openai\|deepseek>` (self-healing-live) / `blocked_by_env` (RGG UI path) |
| `/v1/auto-fix/*` | exercised by `friday-self-healing-live.e2e.test.ts` end-to-end; no dedicated route-contract scenario | `local real-runtime + real-provider <openai\|deepseek>` (self-healing-live) / `blocked_by_env` (RGG UI path) |
| `/v1/workflow-approvals*` | exercised by `l5-workflow-approval-roundtrip` (DAILY_CORE, L5; see §3.3) — `/v1/approvals*` is a compatibility alias per source-of-truth | `blocked_by_env` |
| `/v1/version` | no RGG scenario; covered by unit/contract tests | `mock-only` |
| `/v1/config*` | no RGG scenario; runtime configuration CRUD covered by unit/integration tests | `mock-only` |
| `/v1/audit/logs` | no RGG scenario; admin/security list surface covered by unit/integration tests | `mock-only` |
| `/v1/secrets*` | no RGG scenario; encrypted secret metadata + rotation CRUD covered by unit/integration tests | `mock-only` |
| `/v1/workflow-versions/:versionId` | no RGG scenario; canonical direct fetch route covered by unit/integration tests | `mock-only` |
| `/v1/providers/templates*` | no dedicated RGG scenario; canonical setup-time provider bootstrap surface, covered by unit/integration tests | `mock-only` |
| `/v1/observability/*` (operator-facing API: `overview`, `time-series`, `audit*`) | operator-facing API surface; exercised indirectly by `l1-observability-ui` (the operator dashboard reads these endpoints); no dedicated route-contract scenario | `blocked_by_env` (UI path) / `mock-only` (direct API unit tests) |

## 4. What this snapshot does and does not say

This snapshot says:
- Every capability listed in [`docs/current-source-of-truth.md`](../current-source-of-truth.md) as default-on or user-visible is classifiable into exactly one of the tokens in §2 today.
- Today, **zero** of those rows is classifiable as `release-proof same-SHA`.
- Most UI / API-contract / agent-core rows are `blocked_by_env` because the same RGG run that emitted `blocked_by_env` would have exercised them if the env had been present.
- A meaningful subset of agent-loop rows is `local real-runtime/provider` and could be exercised on a developer's local box with one credential, without producing a release-proof same-SHA artifact.
- A small set of rows is `manual-external` and depends on resolving findings F-008 (Discord) and F-009 (Fly cloud), which are **separate**: a normal full-env Real Green Gate run does not automatically close Discord sandbox or Fly cloud-live evidence unless those external envs and scenarios are actually configured and executed.
- A residual set of rows is `mock-only` or `MISSING` — the live tier does not exist in the repo today.

This snapshot does **not** say:
- That any capability is shipable as-is.
- That workflow `conclusion: success` on a Real Green Gate run is release proof — it is not, when the artifact `status` is anything other than `passed`.
- That a future full-env Real Green Gate run will automatically deliver release proof. A full-env run **could** convert these `blocked_by_env` rows to `release-proof same-SHA` evidence **only if** the run actually executes and all required scenarios pass. The proof would apply only to that exact SHA.

## 5. Smallest credible next steps to move the matrix

These are listed in order of impact-per-effort. Each is its own subphase under the standing audit→ask→fix→two-reviewers→commit-approval→push-approval discipline; none are bundled.

1. **One Real Green Gate run with full env** on the current SHA (`FRIDAY_BASE_URL` + `FRIDAY_LOCAL_PASSPHRASE` minted, plus one provider key). If — and only if — every scenario actually runs and every required scenario passes, this would convert the `blocked_by_env` rows in §3.1 / §3.2 / §3.3 (in-RGG portion) to `release-proof same-SHA` for that exact SHA. It would **not** automatically close the Discord (`F-008`) or Cloud (`F-009`) rows, which require their own envs and their own runs.
2. **F-008 Discord token rotation + sandbox run** would close one row in §3.6.
3. **F-009 Fly staging deploy + cloud-live env wiring** would close one row in §3.6 and unlock the cloud-e2e workflow.
4. **F3 Gap #1** (prompt builder respects `unconfirmed_summary` marker) would convert one `MISSING` row in §3.7 to `mock-only` (unit).
5. **F2 packaging doc-honesty mirror of PR #191** would not move any row's tier; it aligns the packaging surface description with code reality (in-memory engine, env-gated).

## 6. Audit ledger

This snapshot was assembled by reading on `origin/main = edaadf7a1a177c833a74625374722daa7e6833e1`:
- [`docs/current-source-of-truth.md`](../current-source-of-truth.md) (full)
- [`docs/release-evidence-policy.md`](../release-evidence-policy.md) (full)
- [`scripts/ops/run-real-green-gate.mjs`](../../scripts/ops/run-real-green-gate.mjs) (full — DAILY_CORE_SCENARIOS, PUBLIC_SURFACE_SCENARIOS, CLAUDE_SKILL_TESTS, CONVERGENCE_FEATURE_TESTS)
- [`scripts/ops/lib/real-green-gate-result.mjs`](../../scripts/ops/lib/real-green-gate-result.mjs) (full — `validateRealGreenGateResult`, `buildBlockedByEnvResult`)
- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) (`live-proof-gate` section)
- [`test/e2e/live/_helpers/deep-proof-env.ts`](../../test/e2e/live/_helpers/deep-proof-env.ts) (full)
- [`test/e2e/live/_helpers/real-env.ts`](../../test/e2e/live/_helpers/real-env.ts) (full)
- [`test/e2e/live/_helpers/cloud-env.ts`](../../test/e2e/live/_helpers/cloud-env.ts) (full)
- All 18 `test/e2e/live/*.e2e.test.ts` headers (env-gate inventory)

Plus:
- `gh run view 25646562619` and downloaded `real-green-gate-result.json` artifact for SHA `edaadf7a`.
- `gh run view 24819909526` (April 23 historical run on SHA `cb3ae831e35fe487bbb24fef247a65cf8354a74e`) — confirmed predates PR #187 (`mergedAt: 2026-05-10T08:08:37Z`), so it has no `real-green-gate-result.json` artifact.
