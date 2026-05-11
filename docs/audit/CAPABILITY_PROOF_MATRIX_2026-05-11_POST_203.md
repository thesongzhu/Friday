# Friday Capability Proof Matrix — 2026-05-11 post-#203 ledger refresh

**This file is a dated post-#203 ledger refresh of the evidence state for `origin/main`.** It supersedes [`CAPABILITY_PROOF_MATRIX_2026-05-11.md`](CAPABILITY_PROOF_MATRIX_2026-05-11.md) for the current SHA but does not retroactively rewrite that snapshot. It is **not** a full repo line-by-line audit; it captures the delta surfaced by (a) PRs #195–#203 merging since the original anchor, (b) the 2026-05-11 DeepSeek local live queue, and (c) the doc-ledger reconciliation audit that produced Findings F-017 through F-020. The authoritative current product surface lives in [`../current-source-of-truth.md`](../current-source-of-truth.md); the authoritative evidence taxonomy lives in [`../release-evidence-policy.md`](../release-evidence-policy.md). When this snapshot conflicts with either, those documents win and this file is stale.

## 1. Snapshot anchor

| Field | Value |
|---|---|
| Snapshot date (local) | 2026-05-11 |
| Snapshot date (UTC) | 2026-05-11 |
| `origin/main` SHA | `9c27f9e98c1285818482e0dfe9a17ecb33aeb9c6` |
| Most recent merge | [#203 — Doc-honesty mirror for skill lifecycle HTTP route wiring gap (F-017)](https://github.com/thesongzhu/Friday/pull/203) |
| Predecessor snapshot anchor SHA | `edaadf7a1a177c833a74625374722daa7e6833e1` (PR #194; predecessor snapshot file `CAPABILITY_PROOF_MATRIX_2026-05-11.md`) |
| Merged PRs since predecessor anchor | #195 (capability matrix dated 2026-05-11, audit-only doc), #196 (packaging as Phase 1 in-memory preview), #197 (compaction context trust marker load-bearing), #198 (provider validate action in settings), #199 (region-limited provider section in setup wizard), #200 (MCP self-upgrade live test alignment), #201 (channel-adapter self-upgrade live test alignment), #202 (workflow reread + reviewer-source rules in AGENTS.md §23), #203 (doc-honesty mirror for F-017) |
| Latest Real Green Gate run on this SHA | run id `25698110479` (workflow `Real Green Gate`) |
| Run workflow conclusion | `success` |
| Run downloaded artifact `real-green-gate-result.json` `status` | `blocked_by_env` |
| Run downloaded artifact `commit_sha` | `9c27f9e98c1285818482e0dfe9a17ecb33aeb9c6` |
| Run downloaded artifact `ref_name` | `main` |
| Run downloaded artifact `blocked_reasons` | `["env_var_missing:FRIDAY_BASE_URL_or_FRIDAY_ACCESS_TOKEN_or_FRIDAY_LOCAL_PASSPHRASE_or_FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN"]` |
| `scenarios_run` / `scenarios_total` / `scenarios_passed` | `0` / `0` / `0` |
| `evidence_kinds_observed` | `[]` |
| Latest main CI run on this SHA | run id `25698110492` (workflow `CI`, all 10 jobs `success`) |

### Workflow conclusion vs artifact status

The §1 distinction from the predecessor snapshot remains in force at `9c27f9e9`:

- **GitHub workflow conclusion = `success`** means workflow plumbing succeeded — the job ran without infrastructure error and emitted an artifact.
- **Downloaded artifact `status` = `blocked_by_env`** means release proof is **absent** for this SHA: the live gate did not execute its scenarios because the required environment variables (`FRIDAY_BASE_URL` / `FRIDAY_ACCESS_TOKEN` / `FRIDAY_LOCAL_PASSPHRASE` / `FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN`) were not configured.
- `blocked_by_env` must **never** be described as pass.

The validator [`../../scripts/ops/validate-real-green-gate-result.mjs`](../../scripts/ops/validate-real-green-gate-result.mjs) (introduced in PR #187) requires `status === "passed"` AND `scenarios_total > 0` AND `scenarios_passed === scenarios_total` AND `blocked_reasons === []`. The release-time `live-proof-gate` job in [`../../.github/workflows/release.yml`](../../.github/workflows/release.yml) downloads the artifact and runs that validator. A `blocked_by_env` artifact would therefore **fail** `live-proof-gate` if a release tag for this SHA were attempted.

## 2. Evidence-tier definitions (unchanged from predecessor)

Per [`../release-evidence-policy.md`](../release-evidence-policy.md), only the following tiers are release-proof eligible:
- `real-provider`
- `real-browser`
- `real-runtime`
- `cloud-live`
- `manual-external`

`mock-contract`, `mock-hub`, and `browser-mock-hub` are useful for fast regression detection but are **not** release proof.

Classification tokens used by this snapshot:

| Token | Meaning |
|---|---|
| `release-proof same-SHA` | A `passed` Real Green Gate result artifact for the exact SHA in §1, validated by `validateRealGreenGateResult`. |
| `local real-runtime/provider` | A live e2e test exists; can be run on a local dev box with the right credentials; would produce real-runtime + real-provider evidence on that local box (not a release-proof same-SHA artifact). |
| `blocked_by_env` | Test/scenario exists but the env it requires is not currently configured. Specifically used here for any RGG scenario in run id `25698110479`. |
| `mock-only` | Only `mock-contract` / `mock-hub` / `browser-mock-hub` coverage. Per release-evidence-policy: not release proof. |
| `manual-external` | Requires a real external system (Discord guild, deployed Friday cloud env, etc.) on top of the test code. |
| `historical-only` | An older test/run produced evidence on a different SHA. Not release proof for current `main`. |
| `MISSING` | No test exists at any tier. |

### Headline state at `9c27f9e9`

**Current `main@9c27f9e9` has zero release-proof same-SHA evidence.** Every capability tabulated in §3 still carries `blocked_by_env`, `mock-only`, `local real-runtime/provider`, `manual-external`, `historical-only`, or `MISSING` as its strongest current tier. PR #203 is doc-only and does not advance any row's tier. The 2026-05-11 DeepSeek local live queue advances diagnostic coverage at `local real-runtime + real-provider <deepseek>` for the self-upgrade lanes and parts of self-healing / learning, but per §23.6 hard rule, local DeepSeek evidence is never same-SHA release proof on its own.

## 3. Capability deltas since predecessor anchor

This section enumerates ONLY the rows whose evidence state changed relative to `CAPABILITY_PROOF_MATRIX_2026-05-11.md`. Rows not listed here are presumed unchanged — readers should consult the predecessor snapshot for those. This refresh is not a full re-tabulation of §3.1–§3.8 and **does not claim** to re-verify every row in the predecessor.

### 3.A Skill lifecycle HTTP routes (Finding F-017 mirror)

Row: `Skill discovery + manifest loader + lifecycle` (`/v1/skills/*`) — predecessor §3.7 row.

| Field | Value |
|---|---|
| Strongest current tier | `mock-only` (unit/integration) |
| Wiring status | `POST /v1/skills/:skillId/verify`, `GET /v1/skills/catalog`, `GET /v1/skills/:skillId`, `POST /v1/skills/validate-manifest`, and lifecycle-branch `install`/`update`/`delete` are **not registered** in the standalone hub because `skillLifecycle` is not wired into `createFridayApiRuntime` (`src/hub/friday-hub-bootstrap.ts` has zero `skillLifecycle` references; `createFridaySkillLifecycleService` has no callers outside its definition and re-export). Standalone-hub registered `/v1/skills/*` routes: `GET /v1/skills`, `POST /v1/skills/:skillId/run`, `PATCH /v1/skills/:skillId/content` (canonical-approval gated). |
| Approval gate audit | `src/skills/services/friday-skill-lifecycle-service.ts:1277-1559` (`install`/`update`/`deleteSkill`/`verifySkill`) contains zero `assertCanonicalApproval` calls; only `PATCH /v1/skills/:skillId/content` (`src/api/http/routes/friday-skill-routes.ts:514`) enforces canonical approval today. |
| Reference | [Finding F-017 in `10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md). |
| Release-proof claim | None. Real-runtime HTTP route coverage for lifecycle is not available in the standalone hub; the wiring fix is gated by F-017 and requires canonical-approval gating on `update`/`delete` before lifecycle can be wired safely. |

### 3.B Self-healing executors (per-executor evidence detail)

Row: `Self-healing executors` (`disable_skill`, `retry_node`, `switch_model_fallback`, `trim_payload`, `pause_workflow`) — predecessor §3.7 row.

| Field | Value |
|---|---|
| Strongest current tier | `local real-runtime + real-provider <openai\|deepseek>` for the 4-pass subset only (2026-05-11 DeepSeek local live run). |
| 2026-05-11 DeepSeek live run | `test/e2e/live/friday-self-healing-live.e2e.test.ts` under `FRIDAY_E2E_LIVE_DEEPSEEK=1`: 4 of 5 `it` blocks passed (auto-fix + lesson readback; rollback over real HTTP; anti-learning lesson disable; workflow-failure → incident + loop run). 5th `it` (`turns a real skill verification drift into a disable-skill self-healing action that verifies`) failed because `POST /v1/skills/:skillId/verify` returned HTTP 404 from the router — route not registered per F-017. Failure is provider-independent (no LLM call between test start and the 404). |
| `disable_skill` via skill-verification-drift | `MISSING` real-runtime coverage in standalone hub until F-017 is resolved. |
| Other executors | The 4-pass subset is partial coverage of `auto-fix + lesson + rollback + anti-learning + workflow-failure` paths. Per-executor `disable_skill` / `retry_node` / `switch_model_fallback` / `trim_payload` / `pause_workflow` breakdown beyond the holistic test was not enumerated in this audit. |
| Release-proof claim | None. `local real-runtime + real-provider <deepseek>` is not same-SHA release proof on its own per §23.6. |

### 3.C Agent self-upgrade lanes — autonomous restart honest caveat (Finding F-018 mirror)

Row: `Autonomous restart matrix` (`test/e2e/live/friday-autonomous-restart.e2e.test.ts`) — predecessor §3.4 row.

| Field | Value |
|---|---|
| Predecessor tier | `local real-runtime + real-provider <selected lane>` across all four deep-proof lanes (`anthropic|deepseek|openai|ollama`). |
| Caveat introduced by this refresh | The 4th `it` block at `test/e2e/live/friday-autonomous-restart.e2e.test.ts:298-388` directs the verifier to use the browser tool and "verify visually" (line 320). The autonomous engine routes verifying steps with images to `method: "llm_vision"` (`src/agent/autonomous/friday-autonomous-engine.ts:1495`, `1517`, `1550`). DeepSeek provider templates (`src/providers/model/friday-provider-templates.ts:176-188`) list no vision-capable model (`grep "vision"` against the file returns zero matches). Deep-proof env (`test/e2e/live/_helpers/deep-proof-env.ts:260`) sets `FRIDAY_DEEP_PROOF_MODEL = FAST_MODEL` with no vision routing override. |
| Honest per-lane tier | DeepSeek lane: the 4th `it` cannot pass under DeepSeek because the lane has no vision-capable model. Predecessor row claim of `local real-runtime + real-provider <selected lane>` is overbroad for DeepSeek specifically. Anthropic / OpenAI lanes that register a vision-capable default model may still satisfy the test; this snapshot does not re-verify those lanes. |
| 2026-05-11 DeepSeek queue outcome | The test was excluded from the DeepSeek queue for exactly this reason; the exclusion is recorded in F-018. |
| Reference | [Finding F-018 in `10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md). |
| Release-proof claim | None. |

### 3.D Agent self-upgrade lanes — generator-to-candidate-store bridge honest caveat (Finding F-019 mirror)

Row: `Generator maintenance (skill)` (`test/e2e/live/friday-generator-maintenance-live.e2e.test.ts`) — predecessor §3.4 row.

| Field | Value |
|---|---|
| Predecessor tier | `local real-runtime + real-provider <selected lane>` across all four deep-proof lanes. |
| Caveat introduced by this refresh | Generator approve endpoint (`src/api/http/routes/friday-skill-generator-routes.ts:879-929`) returns `{ skillId, skillDir, registryRefreshed, promotionStage, evidence }` with no `candidateId`, no `canonicalApproval`, no `planDigest`. `approveAndSave` (`src/skills/generator/services/friday-skill-generator-service.ts:2021-2266`) directly writes manifest + `updateSkillStatus("installed")` + `upsertSkillFromCatalog`; zero references to `skillUpgradeLifecycle` / `registerCandidate` / `candidateId` / `canonicalApproval` / `planDigest`. The autonomy upgrade lifecycle (`src/autonomy/services/friday-skill-upgrade-lifecycle-service.ts`) requires `candidateId` for every lifecycle action (60+ references); `requireCandidate` throws `SKILL_CANDIDATE_NOT_FOUND` for any skill installed via generator approve. |
| Honest per-lane tier | The test cannot honestly run on the current contract because the generator approve flow does not produce a `FridayExternalSkillCandidate` row consumable by the autonomy upgrade lifecycle. Two parallel skill lifecycles coexist; the bridge between them is missing. |
| 2026-05-11 DeepSeek queue outcome | The test was excluded from the DeepSeek queue for exactly this reason; the exclusion is recorded in F-019. |
| Reference | [Finding F-019 in `10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md). |
| Release-proof claim | None. |

### 3.E Self-healing live test hygiene (Finding F-020 mirror)

Row: not a capability surface; this is a test-harness hygiene observation that affects the integrity of evidence collected via `friday-self-healing-live.e2e.test.ts`.

| Field | Value |
|---|---|
| Hygiene observation | `test/e2e/live/friday-self-healing-live.e2e.test.ts:37` declares `BUNDLED_SKILLS_DIR = path.join(process.cwd(), "skills")`. `/Users/jarvis/Projects/Friday/skills/` contains 177 git-tracked files; `.gitignore` does not exclude `skills/`. The drift `it` writes a broken manifest at line ~1007 **before** entering the `try` block at line ~1010. If the test process is killed between line 1007 and line 1010 (timeout, SIGTERM, or `env.hub!.skills.refresh()` hangs), the bundled production directory is left with a tampered manifest and no restoration, plus a leftover `e2e-skill-drift-<timestamp>` subdir under `<repo>/skills/`. |
| Risk classification | Test hygiene / workspace pollution; not release-proof eligible at any tier; independent of F-017 wiring. |
| Reference | [Finding F-020 in `10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md). |
| Release-proof claim | None. |

### 3.F Documentation drift — predecessor `CAPABILITY_PROOF_MATRIX_2026-05-11.md`

The predecessor snapshot was edited in place by PR #203 at lines 156 and 163 to reference Finding F-017. This violates the snapshot's self-described "dated snapshot, not permanent truth source" contract: its §1 anchor remains `edaadf7a` (PR #194 SHA) but its body now reflects state at `9c27f9e9` (PR #203). The present file replaces those in-place edits with a fresh dated snapshot anchored at `9c27f9e9`; the predecessor remains in the repo as a historical anchor only.

### 3.G Predecessor §3.1–§3.8 rows not re-verified

This refresh does **not** re-verify the predecessor's §3.1 (Web UI), §3.2 (Public API contracts), §3.3 (Agent core L3–L5), §3.4 (Agent self-upgrade lanes) [except the autonomous-restart and generator-maintenance(skill) rows updated in §3.C–§3.D above], §3.5 (Provider-specific tests), §3.6 (External-dependent surfaces), §3.7 (Default-on capabilities without a live test) [except the skill discovery + manifest loader + lifecycle row updated in §3.A and the self-healing executors row updated in §3.B], or §3.8 (Other source-of-truth named surfaces). Their last verified tier is whatever the predecessor recorded at `edaadf7a`. A future full-repo line-by-line re-tabulation may upgrade or downgrade those rows; until that happens, treat the predecessor as the authoritative tier source for those rows, modulated by the deltas in §3.A–§3.E above.

## 4. What this snapshot does and does not say

This snapshot says:
- Five evidence rows changed since the predecessor anchor `edaadf7a` and now sit at the tiers documented in §3.A–§3.E.
- The 2026-05-11 DeepSeek local live queue produced `local real-runtime + real-provider <deepseek>` diagnostic evidence for parts of the agent self-upgrade and self-healing surfaces, with the explicit exclusions and partial-pass framings recorded in F-017 / F-018 / F-019 / F-020.
- Current `main@9c27f9e9` still has zero release-proof same-SHA evidence.
- `blocked_by_env` is the honest current state of the RGG artifact and must never be described as pass.
- Workflow `conclusion: success` on the main CI run is plumbing-tier only and is not release proof on its own.

This snapshot does **not** say:
- That any capability is shippable as-is.
- That every row in the predecessor snapshot remains correct at `9c27f9e9` — only the five rows in §3.A–§3.E are re-verified here.
- That F-017 / F-018 / F-019 / F-020 are resolved — they are OPEN; this file only mirrors their evidence into a per-row tier statement.
- That the 2026-05-11 DeepSeek local queue is full real-runtime self-healing proof — it is partial coverage of the auto-fix + lesson + rollback + anti-learning + workflow-failure paths only.
- That branch protection currently prevents admin bypass — per F-013 supplement, `enforce_admins.enabled: false` on `main` permits repo admins to merge without satisfying the 1-review requirement; this is documented but not changed in this slice.

## 5. Smallest credible next steps to move the matrix

Listed in order of impact-per-effort. Each is its own subphase under the standing audit→ask→fix→two-reviewers→commit-approval→push-approval discipline; none are bundled.

1. **Full-env Real Green Gate run on `9c27f9e9`** (`FRIDAY_BASE_URL` + `FRIDAY_LOCAL_PASSPHRASE` minted, plus one provider key). If — and only if — every scenario actually runs and every required scenario passes, this would convert the `blocked_by_env` rows in predecessor §3.1 / §3.2 / §3.3 (in-RGG portion) to `release-proof same-SHA` for that exact SHA. It would not automatically close Discord (F-008) or Cloud (F-009) rows, which require their own envs.
2. **F-020 test hygiene fix** (independent, low risk): move `friday-self-healing-live` skill-drift writes off `<repo>/skills/` into `os.tmpdir()`-based temp dir with `beforeAll`/`afterAll` cleanup. Does not need F-017 wiring.
3. **F-018 doc + capability gate** for `friday-autonomous-restart` 4th `it`: add per-lane caveat in this snapshot (already done in §3.C); add `it.skipIf(...)` capability gate in the test harness slice.
4. **F-007 recapture** against current SHA: rerun the 2026-05-01 local smoke scenarios against `9c27f9e9` if local DeepSeek + OpenAI credentials are configured; record the new report path; this is not release proof but at least restores same-SHA-as-of-recapture diagnostic evidence.
5. **F-013 platform decision**: choose whether to flip `enforce_admins.enabled` to `true` (makes §23.6 admin-bypass prohibition enforceable at the platform layer) or route admin-author PRs through a non-admin reviewer.
6. **F-017 follow-on slices** in order: (a) canonical approval gates for skill `update`/`delete`; (b) wire `createFridaySkillLifecycleService` into hub bootstrap (depends on a); (c) rerun verify-drift `it` after both land.
7. **F-019 product design slice**: design generator → candidate-store bridge; high-risk; requires §3 ask-before-act.
8. **F-008 Discord token rotation + sandbox run** and **F-009 Fly staging deploy + cloud-live env wiring** continue to gate external-launch readiness.

## 6. Audit ledger

This refresh was assembled by reading on `origin/main = 9c27f9e98c1285818482e0dfe9a17ecb33aeb9c6`:
- [`../current-source-of-truth.md`](../current-source-of-truth.md) (full, including the Skills Lifecycle section landed by PR #203)
- [`../release-evidence-policy.md`](../release-evidence-policy.md) (full)
- [`./10_FINDINGS_REGISTER.md`](10_FINDINGS_REGISTER.md) (full, including F-017 row landed by PR #203 and F-018/F-019/F-020 rows landed by this slice)
- [`./CAPABILITY_PROOF_MATRIX_2026-05-11.md`](CAPABILITY_PROOF_MATRIX_2026-05-11.md) (full, as predecessor anchor reference)
- `src/api/http/routes/friday-skill-routes.ts:319, 514, 428-441` (skill route lifecycle gate + PATCH content gate + verify route handler)
- `src/api/http/friday-http-server.ts:547` (route-miss 404 source)
- `src/skills/services/friday-skill-lifecycle-service.ts:880, 1277-1559` (factory + install/update/deleteSkill/verifySkill paths)
- `src/skills/index.ts:223` (re-export)
- `src/hub/friday-hub-bootstrap.ts` (zero `skillLifecycle` reference verified via `rg`)
- `src/agent/autonomous/friday-autonomous-engine.ts:1495, 1517, 1550` (llm_vision routing)
- `src/providers/model/friday-provider-templates.ts:176-188` (DeepSeek templates; zero `vision` matches in file)
- `src/api/http/routes/friday-skill-generator-routes.ts:879-929` (generator approve handler)
- `src/skills/generator/services/friday-skill-generator-service.ts:2021-2266` (`approveAndSave` impl)
- `src/autonomy/services/friday-skill-upgrade-lifecycle-service.ts` (60+ `candidateId` references)
- `test/e2e/live/friday-autonomous-restart.e2e.test.ts:298-388` (4th `it`)
- `test/e2e/live/friday-generator-maintenance-live.e2e.test.ts:73-93, 500-520` (envelope + approve flow)
- `test/e2e/live/friday-self-healing-live.e2e.test.ts:37, 978-1072` (`BUNDLED_SKILLS_DIR` + skill-drift `it`)
- `test/e2e/live/_helpers/deep-proof-env.ts:260` (`FRIDAY_DEEP_PROOF_MODEL = FAST_MODEL`)

Plus:
- `gh pr view 203 --json …` (PR #203 metadata: `merged_by: thesongzhu`, `reviews: []`, `reviewDecision: REVIEW_REQUIRED`, `mergedAt: 2026-05-11T21:22:27Z`, `mergeCommit: 9c27f9e9`).
- `gh api repos/thesongzhu/Friday/branches/main/protection` (branch protection state with `enforce_admins.enabled: false`).
- `gh run view 25698110479 --json …` (post-merge main RGG run; downloaded artifact `real-green-gate-result.json` for SHA `9c27f9e9`).
- `gh run view 25698110492 --json …` (post-merge main CI run; 10/10 jobs `success`).
- `git ls-files skills/ | wc -l` = 177 (tracked production starter skills).
- `grep -nE "^skills\|/skills" .gitignore` returns zero matches.
- `find /Users/jarvis/Projects/Friday -name "*2026-05-01T21-2*"` returns zero matches (F-007 report files not present in current workspace).

This refresh is **not** a full repo line-by-line audit. The rows enumerated in §3.A–§3.E were re-verified at file:line evidence depth; predecessor rows §3.1–§3.8 not listed in §3.A–§3.E were not re-verified by this slice and inherit their tier from `CAPABILITY_PROOF_MATRIX_2026-05-11.md` (anchor `edaadf7a`).
