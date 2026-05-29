# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Semantic Versioning.

## [Unreleased]

- Package metadata is staged as `1.0.3` for a future operator-authorized npm
  publish. This is prepare-only: no tag, GitHub release, or npm publish is
  included.
- Source truth after the immutable npm `1.0.2` package now includes deterministic
  closures for DP-10 personal-secretary loop proof (PR #352), Skill +
  link-to-skill lifecycle proof (PR #353), repair/self-upgrade/retry-audit proof
  (PR #354), Memory cognition v1 proof (PR #355), provider/cost truth and retry
  receipt repairs (PR #356 through PR #360), C2.4 parent-runtime natural-trigger
  source repair (PR #377), C3/C4 live-provider routing proof (PR #378), and C4.5
  direct synthetic real-user intelligence proof (PR #379). These are GitHub-main
  closures, not npm `1.0.2` package truth.
- Source truth after PR #379 further includes the strict-repair closure batch on
  GitHub `main` through PR #412 (final `main` SHA `f1755825`): the B6
  dangerous-command shell-risk gate was hardened across four bypass vectors
  (PR #396, #397, #399, #402); workflow completion-truth was closed for the
  deterministic core — declared side-effect nodes are labeled `proof_pending`,
  the run-level workflow-completion verifier refuses unverified run evidence, and
  the one concrete filesystem-write side-effect class is positively upgraded to
  `verified` by an independent on-disk re-read (PR #398, #407) — while the
  non-filesystem side-effect classes (send / connect / capture / execute /
  memory.write) remain `proof_pending` by design with no positive verified path
  yet; receipt / idempotency / usage-ledger truth was closed (PR #401, #403,
  #408); truth-label defects were corrected (PR #405, #406, #411); and the
  `write`/`edit` agent tools were fixed to anchor relative paths at the workspace
  root for read/write parity (PR #412). These are deterministic GitHub-main
  closures, exact-`main` proven via same-SHA CI + Real Green Gate; they are not
  npm `1.0.2` package truth and add no published-release claim.
- An isolated, operator-authorized live competence proof exercised the local
  read → DeepSeek reasoning → canonical approval-gated write → oracle-verified
  artifact loop end-to-end on the fixed build, DeepSeek-only (no fallback
  provider), through the real canonical approval gate, and produced a clean
  `verified_receipt`. This is a single bounded local proof. It does not claim
  100% all-mechanisms-live, all-integrations-live, latest-SHA live
  external-channel delivery, or broad live-provider quality; those remain
  deferred operator-gated proofs.
- C2.4 remains `source_closed_live_pending` / `proof_pending` until the deferred
  exact-SHA Telegram natural-trigger stress window passes. C4.5 live external-
  channel proof, npm publish, tag, and GitHub release remain deferred operator
  actions.
- Provider budget configuration writes now share the protected provider mutation
  boundary: in canonical-gate-required profiles, `PUT /v1/providers/budget`
  requires an approved plan digest and canonical approval before changing the
  budget setting, returns gate evidence, and strips approval control fields
  instead of persisting them into budget config.
- Usage & Cost source/UI proof now keeps near-limit and over-limit budget states
  visibly distinct. This supports cost-control truth without claiming hidden
  spend prevention beyond the configured budget/routing policy.
- No npm publish is included in this source change. Public npm package alignment
  still requires an explicit operator-approved future release.

## [1.0.2] — Post-Release Hardening Wave — 2026-05-26

`1.0.2` accumulates the post-release hardening queue on top of `1.0.1`.
It does not change the `1.0.1` release claim (public v1
local candidate, npm/source-only, `dogfood_partial_pass`, nine
`proof_pending` headlines carried forward, Slack HTTP / QQ / desktop /
Homebrew / notarized macOS / mobile / "all integrations live"
exclusions). Public install behavior changes ONLY in that
`npm install @thesongzhu/friday@1.0.2 && npm audit --omit=dev` now
reports `0` vulnerabilities, down from `3 high` on `1.0.1`.

### Changed

- **B0.5** Lark/Feishu long-connection (WebSocket) event subscription is
  now served by a native client under `src/channels/lark/internal/`
  (`lark-ws-client.ts`, `lark-ws-frame.ts`, `lark-event-dispatcher.ts`,
  `lark-domain.ts`, `lark-logger.ts`) instead of via
  `@larksuiteoapi/node-sdk`. The native client vendor-adapts the MIT-
  licensed SDK's `WSClient` + `EventDispatcher` + `pbbp2.Frame` protobuf
  schema verbatim so the wire protocol, heartbeat timing, ACK shape,
  reconnect-with-jitter loop, and lifecycle callbacks
  (`onReady`/`onReconnecting`/`onReconnected`/`onError`) are unchanged
  from `1.0.1`. `friday-lark-channel.ts` preserves all callback shapes
  and status semantics; downstream `parseMessageEventBase` and
  `parseCardApprovalActionEvent` consume the same flattened envelope
  the SDK was producing.
- **B2 / FRI-AUD-004** Plugins page (`ui/src/routes/plugins-page.tsx`)
  no longer renders trust-on-install as cryptographic "signature
  verified". The badge now uses a `pluginTrustLabel` helper that maps
  `signatureVerified=false` → "unsigned or unverified",
  `signatureVerified=true && trustMode="trust_on_install"` → "locally
  trusted (trust-on-install)", and
  `signatureVerified=true && trustMode="signed"` → "signature
  proof_pending (no trusted keyring)". Tone is always `neutral` for v1
  because no path produces a cryptographically verified marketplace
  signature yet. PR #308 already added the runtime advisory + JSDoc
  truth-label; this slice closes the user-facing UI overclaim. No
  runtime behavior change to plugin install/enable/disable.
- **B3 / FRI-AUD-005** Desktop policy + permission decision routes
  (`/v1/desktop/policies/*`, `/v1/desktop/permissions/respond`,
  `/v1/desktop/permissions/decisions`) now fail closed with typed 503
  errors (`DESKTOP_POLICY_NOT_PERSISTED` /
  `DESKTOP_PERMISSION_DECISION_NOT_PERSISTED`) when invoked. The
  previous hub-bootstrap dep wiring echoed requests back with synthetic
  ids and returned empty/null reads, which let synthetic responses look
  enforced even though no durable storage / evaluator / audit / rollback
  wiring exists. Routes stay registered for contract stability so the
  OpenAPI surface and `friday-http-route-contract` are unchanged.
  `desktop.permissions.list` (real OS capability check via
  `desktopSessionManager.checkPermissions`) is preserved as live. No
  desktop risk-tier changes; no UI consumer of the policy routes
  existed under `ui/`, so no user-facing flow regresses.
- **B4 / FRI-AUD-006** `memoryService.store()` now invokes
  `checkMemoryDuplicate` AFTER a successful persist in
  **advisory-only, non-destructive** mode. When a near-duplicate is
  detected above the configured threshold (default `0.92` placeholder,
  operator-tunable via `CreateFridayMemoryServiceDeps.dedupThreshold`),
  the service emits a `FridayMemoryDedupAdvisoryEvent` via
  `console.info` and the optional `deps.dedupAdvisorySink`. The
  advisory is purely additive — the candidate is already in the durable
  store by the time it fires. Friday NEVER deletes, overwrites, merges,
  or blocks any user memory based on this signal. `mergeMemoryContent`
  / `mergeMemoryConfidence` helpers remain available for future callers
  but are NOT invoked from `store()` — destructive merge/block
  semantics remain `policy_pending` per
  `POST_RELEASE_DEFAULT_DECISIONS.md` B4 + the 2026-05-26 operator
  directive. The dedup helper's file-header JSDoc + one-time
  module-level advisory log updated to reflect the new advisory-wired
  state.
- **B7 / FRI-AUD-012/013/014/017** Settings page now surfaces per-
  provider per-capability lane-failure advisories inline in each
  provider card after a `Run capability doctor` probe. Previously the
  probe's `capabilityResults` were only summarized as a toast count
  ("N probes checked") and the per-lane status messages were thrown
  away. The new render groups the latest results by `providerId` in a
  React state map and shows a `data-testid="provider-capability-lane-
  advisory"` block listing the capabilities whose `status !==
  "verified"` (so `failed`, `unsupported`, or `declared-only` lanes
  surface; `verified` lanes do not). Backend doctor-probe already
  returned the lane-specific truth-labels for the audit's named
  failures (Ollama embeddings "not wired", Codex subscription "has no
  embeddings", Google Generative AI runtime "does not yet execute",
  media-understanding env-gate 503); this slice stops the UI from
  hiding them behind a count. The advisory copy explicitly disclaims
  global provider-availability (`"this advisory is per-lane truth-
  label, not a provider-global availability claim"`). No new backend
  route, no snapshot model restructure, no change to the existing
  `enabled / disabled` global provider pill. A full capability-health
  dashboard remains carry-forward per the 2026-05-26 operator
  directive.
- **B9 / FRI-AUD-021** Renamed `createStubConfigManager` →
  `createPersistentConfigManager` in `src/hub/bootstrap/hub-helpers.ts`
  (+ re-export in `src/hub/bootstrap/index.ts` + call site in
  `src/hub/friday-hub-bootstrap.ts`). The "stub" name was stale: the
  implementation actually persists config snapshots + revisions in
  SQLite via `hub_settings` and the `/v1/config/*` HTTP routes are
  wired into the API runtime. The hub-bootstrap comment block was
  updated to drop the stale "intentionally stubbed for v0.4.x" and
  "Config mutations via API silently no-ops" wording and to explicitly
  distinguish the now-truthfully-named persistent configManager from
  the still-partial-stub `createStubMemoryState` (which has 4 real
  methods + 4 no-op methods with zero production consumers; interface
  narrowing is a carry-forward code-hygiene item documented in
  `B5_B6_B8_VERIFIED.md` § "FRI-AUD-022"). No runtime behavior change.

### Removed

- `@larksuiteoapi/node-sdk` is no longer a runtime dependency. The SDK
  pinned `axios ~1.13.3`, pulling 15+ axios CVEs (SSRF via NO_PROXY
  bypass, prototype pollution, header injection, XSRF leak, CRLF
  injection — three of these at HIGH severity per the post-R6
  isolated-install audit recorded in
  `HANDOFFS/R6_RECONCILE_public_install_audit_omit_dev_20260526.json`).
- The `package.json` `overrides.axios=^1.15.2` block is removed because
  no remaining dependency in the install graph pulls axios; `npm ls
  axios` after `npm install` on `1.0.2` returns empty.

### Added

- `ws ^8.19.0` and `protobufjs ^7.6.1` are now direct dependencies (both
  were previously transitive via the SDK; both audit clean). `@types/ws
  ^8.18.1` is added as a devDependency for strict-mode typecheck.

### Docs

- Public README, release-truth, capability-matrix, and getting-started
  docs updated to reflect that `1.0.2` is now the current published
  npm/source release and that QQ / Slack HTTP Events-API inbound remain
  unsupported.
- `CHANGELOG.md` `[1.0.1] ### Notes` records the R6 publish timestamp.

### Notes

- Behaviour-parity proof of the native Lark WS client against a real
  Lark/Feishu account is operator-driven and runs as phase24d
  (`scripts/ops/phase24d-lark-feishu-trusted-inbound-listener.mjs`) on
  the `1.0.2` release SHA via Real Green Gate `workflow_dispatch`
  (same protocol as `1.0.1` R5). Local verification on the `1.0.2`
  branch: full typecheck pass, focused `src/channels/lark` lint pass,
  45/45 lark unit tests pass (existing 27 + 18 new across frame /
  dispatcher / lifecycle), 390/390 channel-suite blast-radius pass,
  isolated `npm pack` + `npm install` + `npm audit --omit=dev` against
  the `1.0.2` tarball reports `0 vulnerabilities`. The `1.0.1` claim
  surface is unchanged.

## [1.0.1] — Release Closure Infrastructure — 2026-05-25

`1.0.1` is the first patch on top of `1.0.0`. Public claim is **public v1 local candidate, npm/source distribution** — no desktop, Homebrew, notarized macOS, mobile, or "all integrations live" claim is added. This patch ships the release infrastructure that makes a same-SHA Discord/Telegram/Lark+Feishu live channel proof verifiable as a publish precondition, plus a source/npm-only release mode that does not require macOS distribution artifacts.

### Added

- Source/npm-only release mode in `.github/workflows/release.yml`: `workflow_dispatch.inputs.release_mode` with enum `source-only | source-and-macos` (default `source-only`); push-tag triggers are forced to `source-only`. `macos-distribution` skips in source-only mode; `create-release` fails closed unless it can satisfy the source-and-macos path or the explicit source-only carve-out.
- Lark/Feishu trusted-inbound proof harness (`scripts/ops/phase24d-lark-feishu-trusted-inbound-listener.mjs`) modeled after the Discord/Telegram phase24b/c harnesses. Same lifecycle (createFridayHub → createFridayLarkChannel → wrap adapters.lifecycle.connect → in-process HTTP server → wait for trusted-user nonce probe → assert unified-task-state awaiting human). Same artifact shape with the stable token `friday.phase24d.lark_feishu_trusted_inbound_proof.v1`. Strict freshForRun semantics matching phase24c (no null-timestamp acceptance). Fail-closed `serializeScrubbedJson` rejects writes if any redacted token escaped.
- Same-SHA channel proof validator (`scripts/ops/validate-channel-proof-artifacts.mjs`): verifies schemaVersion, `status=passed` (the listener's authoritative verdict), `failures=[]`, the explicit `REQUIRED_NAMED_CRITERIA` set (currently `artifactHasNoToken`) is present in `criteria` AND each named criterion is `true`, observed-event non-null, no token residue (`xoxb-`, `Bot <opaque>`, `Bearer <opaque>`), and `commit_sha`/`head_sha` match against `--expected-sha`. Diagnostic/observational criteria that the listener writes outside its own `requiredCriteria` set (e.g., `<channel>ShortReceiptObserved`) are NOT independently re-evaluated by the validator — that responsibility stays with the listener.
- Shared token-redaction helper (`scripts/ops/lib/token-redaction.mjs`) used by all phase24 trusted-inbound listeners. Cyclic-throw `[REDACTED_UNSERIALIZABLE]` sentinel prevents secrets escaping when `JSON.stringify` throws.
- `phase24d_lark_feishu_trusted_inbound` workflow_dispatch input + job in `.github/workflows/real-green-gate.yml` mirroring phase24b/c structure.
- `write-friday-release-manifest.mjs` honors `FRIDAY_RELEASE_MODE=source-only`: marks every platform/channel as `not_in_this_release`, emits a `releaseClaim.boundary` block with the required RELEASE_CLAIM paragraph, skips Homebrew cask generation.
- 5 focused R1 test files covering token-redaction (cyclic-throw + redaction contract), validate-channel-proof-artifacts (13 negative cases including residue scan + commit_sha fallback + named-criterion enforcement), phase24d listener (env validation, nonce sanitisation, redaction round-trip, defense-in-depth env-secret coverage), run-friday-release-preflight source-only mode, write-friday-release-manifest source-only mode.

### Changed

- `scripts/ops/phase24b-discord-trusted-inbound-listener.mjs` and `scripts/ops/phase24c-telegram-trusted-inbound-listener.mjs` migrated to the shared `lib/token-redaction.mjs`. Both gained `environment.commit_sha` alongside the existing `githubSha` for same-SHA validation. Redaction labels and 12-char prefix logic preserved exactly.
- `scripts/ops/run-friday-release-preflight.mjs` reads `FRIDAY_RELEASE_MODE`; when `source-only` the cross-platform release inputs check is skipped (`crossPlatformReleaseInputs.status=skipped_source_only`) because the npm/source release does not promise iOS/Android/Windows/macOS distribution.
- `scripts/quality/release-truth-lib.mjs` `DEFAULT_PROOF_INPUTS` extended to include the new phase24b/c/d listeners, the channel-proof validator, and the shared token-redaction lib so `npm run check:proof:no-mock-leaks` scans them.

### Notes

- npm publish remains blocked by the repo variable `RELEASE_PUBLISH_NPM=false`. Same-SHA **provider lane + Discord/Telegram/Lark+Feishu** trusted-inbound live proof on the release SHA at R5 was the publish precondition; that gate PASSED on the release SHA via Real Green Gate `workflow_dispatch` (`status=passed`, 94/94 scenarios, `blocked_reasons=[]`, `evidence_kinds_observed=[real-runtime, real-provider, real-browser, manual-external]`; all three `phase24X` channel artifacts validated `valid:true, blockerClass:none`). R6 published `1.0.1` to npm at 2026-05-26T06:54:20Z. The post-R6 isolated `npm install @thesongzhu/friday@1.0.1 && npm audit --omit=dev` surfaced 3 HIGH severity findings (15+ axios CVEs via `@larksuiteoapi/node-sdk > axios ~1.13.3`); see the `[1.0.2]` entry above for the public-install-audit hotfix that closes those.
- Real Green Gate's `phase24b/c/d` trusted-inbound jobs only run on `workflow_dispatch` with the corresponding `phase24X_*_trusted_inbound=true` input; they remain `SKIPPED` on routine PR/push runs by design.
- The `1.0.1` dogfood gate closed as **`dogfood_partial_pass`** (weighted UX 7.78/10; below the 8.0 `dogfood_pass` threshold) with explicit operator authorization to proceed under a trimmed release claim. Nine `proof_pending` headlines are carried forward to a subsequent dogfood pass: (1) autonomous self-repair end-to-end execute → rollback, (2) autonomous self-upgrade actual mutation, (3) skill install/update/delete through the canonical-approval workflow, (4) end-to-end link-to-skill candidate → tests → approval → run, (5) queue/retry end-to-end receipt loop with a retry-eligible incident, (6) audit tamper-negative on a disposable ledger, (7) R1 Lark `phase24d` listener-shutdown bug (artifact correct, WebSocket holds event loop), (8) speed/cost end-to-end `near_limit`/`over_limit` UI surfacing, (9) memory per-item `confidence`/`last_accessed` field surfacing. See [`docs/public-v1-local-candidate.md`](docs/public-v1-local-candidate.md) for details.
- This release does not claim desktop, Homebrew, notarized macOS, mobile, or "all integrations live". Outbound channel-control automation is not claimed; only configured trusted-user inbound receipt on Discord/Telegram/Lark+Feishu is proven on the release SHA. **Slack HTTP Events-API inbound and QQ remain permanently `unsupported` in `1.0.1`.** Capabilities without same-SHA live proof remain labeled `setup_needed`, `proof_pending`, `blocked_by_env`, `unsupported`, or `not_configured`.

### Docs

- Phase 18B governance-truth reconciliation only. Recorded the 2026-05-19 live `main` branch-protection readback as strict required status checks with `required_approving_review_count=0`, required conversation resolution enabled, force-push/delete disabled, and `enforce_admins.enabled=false`, preserving the PR-side gate record requirement and not changing branch protection, GitHub settings, release proof standards, approval semantics, or runtime behavior.
- Phase 15 docs-truth reconciliation only. Updated `docs/current-source-of-truth.md`, `docs/architecture/agent-package-rfc.md`, and `docs/architecture/multi-tenant-security-rfc.md` to reflect that Phase 11 (PR #233) shipped SQLite-backed persistence for packaging registry, install lifecycle, rollback history, lifecycle audit log, trusted-key store, and the multi-tenant security surface (tenants, workspaces, roles, role assignments, policies, secrets, audit log, violations, tenant-scoped resource registry); both surfaces remain default-off behind `FRIDAY_PACKAGING_ENABLED=true` / `FRIDAY_MULTI_TENANT_ENABLED=true` and Phase 11 closed `partial` with named Phase 14 release-proof debt for `module_16_packaging_release_proof_roundtrip`, `module_17_full_upgrade_lifecycle_evidence_harness`, and `module_18_cross_tenant_denial_rgg_assertion`.
- Reflected Phase 02a (PR #222) release-complete state for the media-understanding provider loop while preserving the `FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true` plus resolvable `env:OPENAI_API_KEY` runtime enablement boundary; `/v1/media-understanding/*` returns `503 MEDIA_UNDERSTANDING_DISABLED` when either gate is unmet.
- Added explicit channel-state honesty under `Channel secret and supervisor truth`: live external-channel proof is per-channel and scoped to configured test spaces only; Phase 14.5E closed as a user-approved partial/blocked report-only outcome with Discord as the only configured target and Lark/Feishu/Telegram remaining `not_configured` / `blocked_by_env`.
- Documented that `FRIDAY_MASTER_KEY` and `FRIDAY_TOKEN_SECRET` are internal runtime secrets generated and stored by the local or user-owned cloud runtime; ordinary user setup must not require pasting them.
- Added private capability proof evidence anchored to `origin/main` `42fac20f` (PR #243). Snapshot built from per-phase completion reports; honest about `blocked_by_env` not being pass.

These `### Docs` entries are docs-truth reconciliations from work that landed between `1.0.0` and `1.0.1`; they do not by themselves change product code, tests, runtime behavior, API contract snapshots, generated code, branch protection, GitHub state, credentials, release-proof standards, or governance semantics. The product-code/test/workflow surfaces that DO change in `1.0.1` are enumerated in the `### Added` and `### Changed` sections above.

## [1.0.0] — Initial Release — 2026-04-18

### Added
- Deep link protocol: `friday://` import protocol for provider templates, skill sources, MCP server configs, workflow templates, and marketplace assets with preview + validate + confirm flow.
- PolicyExtensionChain: authorization chain where extensions can only tighten (deny) decisions, never loosen core policy, with full audit trail.
- Shell safety scanner: rules-based preflight scanner for shell-based skills detecting `rm -rf`, `sudo`, `curl | sh`, path traversal, and 20+ dangerous patterns.
- MCP management UI: `/mcp` page for viewing MCP server status, transport, tool/resource counts, and configuration guidance.
- Session browser: `/sessions` page with status filtering, transcript viewer, and JSON/Markdown export.
- Cost dashboard: `/usage` page with provider health, request counts, error rates, and cost estimation.
- Capability grant lifecycle: SQLite persistence, revoke API, and grant routes for full issue-use-expire-revoke flow.
- SIEM export: JSONL file export and HTTP webhook export sinks on the existing hash-chained audit trail.
- Linux packaging: complete .deb and .AppImage packaging with build scripts.
- Communication persona system: MBTI-based with 16 personality templates, 9 configurable dimensions, and learned preference integration.
- Learning-adaptive communication: learned preference facts from the self-learning pipeline feed into persona resolution with confidence-decaying Bayesian-inspired updates.
- User preference management: full CRUD API for user preferences at `/v1/uix/preferences`, persona preview, user profile onboarding, and assistant diagnostics.
- Expected utility calculator: pluggable utility scoring for auto-fix decisions (`EU = benefit * P(success) - cost * P(failure) - riskPenalty`).
- Tool call summary: privacy-safe tool execution summaries (arg keys only, no values) for observability and world model training data.
- OpenAI Responses API: full streaming support for the `openai-responses` API format alongside existing `openai-completions`.

### Changed
- Warn-once architecture: cross-module log deduplication (7+ modules) for cleaner runtime output.
- Workflow realtime events: buffered event publishing enables live workflow progress tracking via SSE/WebSocket.
- Setup diagnostics: user-friendly error messages and remediation hints for setup/auth failures in UI.
- Provider templates and lane health: setup/settings now consume template-driven bootstrap and lane visibility.
- Skill preflight verdicts: grouped blocking/warning/advisory preflight checks across manifest, integrity, requirements, permissions, runtime dry-run, and trust.

### Fixed
- WebSocket buffer accumulation now capped at 4 MB to prevent DoS via fragmented frames.
- Session key recursive parsing now enforces maximum subagent nesting depth of 10 to prevent stack overflow.
- Agent runtime progress timer and event listeners are now created inside the try block to prevent leaks on early failures.
- Subagent drain timeout now logs remaining in-flight execution count for shutdown diagnostics.
- Master key file-read cache path now sets TTL expiry, preventing stale cached keys from blocking rotation.
- Master key file permissions too-open warning now attempts `chmod 0600` remediation.
- Channel input sanitizer now enforces 50,000 character limit and applies Unicode NFC normalization.
- Error diagnosis lesson-disabled check logic simplified to prevent disabled lessons from being included when `factRepo` is unavailable.
- Auto-fix risk assessment 1h spike threshold now uses `Math.ceil()` for correct integer comparison against hourly baseline.
- Provider OAuth hardening: Claude Code request format matching for OAuth inference (Anthropic PKCE).

## [0.4.2] - 2026-03-24

### Fixed
- macOS release no longer fails the entire tagged release when optional Homebrew tap publication is rejected; the workflow now continues with generated cask artifacts and release manifest metadata.
- Homebrew tap publication now surfaces the underlying `git clone` / `git push` error output instead of failing with an opaque exit code.

## [0.4.1] - 2026-03-24

### Fixed
- Release workflow `verify` job now installs Playwright Chromium before running `release:verify`, matching main CI and preventing browser-backed mock E2E failures during tag validation.

## [0.4.0] - 2026-03-24

### Added
- Assistant `Outcome Receipt` guidance with direct follow-up actions for saving, scheduling, packaging, and deferring publication.
- Standalone browser E2E lane for incentive-alignment journeys via `npm run test:e2e:ui`.
- One-command local demo workflow runner: `npm run demo` (`scripts/demo/minimal-workflow-demo.mjs` + sample workflow JSON).
- Troubleshooting and self-recovery runbook: `docs/TROUBLESHOOTING.md`.
- Extension guide and copy-ready templates for skills/plugins/workflows: `docs/EXTENDING.md` and `examples/templates/*`.
- Release notes template and closed-loop usability blueprint docs.

### Changed
- `/automations` now surfaces leverage-oriented metadata including time-saved estimates, reuse counts, promotion state, and outcome score ranking.
- Marketplace asset ranking and creator reputation now use proof-of-use signals instead of install-count-first ordering, with typed scoring policy support.
- Assistant handoff into automations and marketplace requests now preserves task context and prefill data across the full loop.
- CI and `release:verify` now run the browser E2E lane explicitly instead of relying on default `npm test`.
- README now surfaces one-command demo, troubleshooting, extensibility, release links, and CI/release status badges.
- `docs/RELEASING.md` now includes release artifact completeness checks (version/changelog/release notes/license/security/CI).
- Hub bootstrap env test now reads package version dynamically (no hardcoded `0.3.0`), preventing version-bump CI regressions.

### Fixed
- `detect-secrets` false positives in browser/mock support tests are now inline-allowlisted, and the secrets baseline is synchronized with the new allowlist.
- GitHub CI no longer fails by trying to run browser E2E through the default `npm test` entry without a built UI bundle.

## [0.3.1] - 2026-02-27

### Added
- Release workflow for tag-driven GitHub releases with version/tag validation.
- `release:verify` script to run pre-release quality gates in one command.
- `SECURITY.md` disclosure policy and `docs/RELEASING.md` release runbook.

### Changed
- Release workflow now supports configurable npm publish mode via `RELEASE_PUBLISH_NPM` (`true`/`false`/auto).
- Installation and quickstart docs now use the canonical repository URL and current version examples.

## [0.3.0] - 2026-02-20

### Added
- Browser automation module and `browser` agent tool with open/navigate/snapshot/screenshot/act/tabs/close actions.
- Channel runtime foundation with QQ and Lark/Feishu connectors, inbound routing, and allowlist filtering.
- XHS session/page tooling and `xhs` agent tool for login, search, posting, and comment extraction.
- Shared DOM-lite types (`FridayDomElementLike`, `FridayDomDocumentLike`, `FridayDomWindowLike`) for browser-adjacent modules.
- Global browser page concurrency cap (`maxTotalPages`).
- Channel input sanitizer to strip control/zero-width characters before agent processing.
- `npm run typecheck` script and CI typecheck step.

### Fixed
- Path traversal: reject `.` and `..` segments in file tool and artifact path sanitization.
- Browser launch failures now clean up context and page resources on error.
- QQ channel reconnect race: epoch-guarded reconnect prevents duplicate connections.
- Lark channel stale socket close events no longer trigger reconnect after stop.
- Channel registry rolls back successful starts when partial failure occurs.
- Guarded `JSON.parse` calls in token validator, OAuth credential store, and fleet dashboard service.
- XHS cookies encrypted at rest via AES-256 envelope encryption.
- Replaced deprecated Playwright `accessibility.snapshot` with `ariaSnapshot()` API.
- Replaced fragile `text=` / `:has-text()` XHS selectors with Playwright locator API.
