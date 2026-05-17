# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Semantic Versioning.

## [Unreleased]

### Docs

- Phase 15 docs-truth reconciliation only. Updated `docs/current-source-of-truth.md`, `docs/architecture/agent-package-rfc.md`, and `docs/architecture/multi-tenant-security-rfc.md` to reflect that Phase 11 (PR #233) shipped SQLite-backed persistence for packaging registry, install lifecycle, rollback history, lifecycle audit log, trusted-key store, and the multi-tenant security surface (tenants, workspaces, roles, role assignments, policies, secrets, audit log, violations, tenant-scoped resource registry); both surfaces remain default-off behind `FRIDAY_PACKAGING_ENABLED=true` / `FRIDAY_MULTI_TENANT_ENABLED=true` and Phase 11 closed `partial` with named Phase 14 release-proof debt for `module_16_packaging_release_proof_roundtrip`, `module_17_full_upgrade_lifecycle_evidence_harness`, and `module_18_cross_tenant_denial_rgg_assertion`.
- Reflected Phase 02a (PR #222) release-complete state for the media-understanding provider loop while preserving the `FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true` plus resolvable `env:OPENAI_API_KEY` runtime enablement boundary; `/v1/media-understanding/*` returns `503 MEDIA_UNDERSTANDING_DISABLED` when either gate is unmet.
- Added explicit channel-state honesty under `Channel secret and supervisor truth`: live external-channel proof is per-channel and scoped to configured test spaces only; Phase 14.5E closed as a user-approved partial/blocked report-only outcome with Discord as the only configured target and Lark/Feishu/Telegram remaining `not_configured` / `blocked_by_env`.
- Documented that `FRIDAY_MASTER_KEY` and `FRIDAY_TOKEN_SECRET` are internal runtime secrets generated and stored by the local or user-owned cloud runtime; ordinary user setup must not require pasting them.
- Added `docs/audit/CAPABILITY_PROOF_MATRIX_2026-05-17_POST_243.md` anchored to `origin/main` `42fac20f` (PR #243). Snapshot built from per-phase completion reports and `REPORTS_INDEX.csv`; honest about `blocked_by_env` not being pass.

This entry is docs-truth reconciliation hygiene only and is not a product release-complete claim. No product code, tests, runtime behavior, API contract snapshots, generated code, branch protection, GitHub state, credentials, release-proof standards, or governance semantics changed in this entry.

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
