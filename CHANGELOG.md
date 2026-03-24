# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Semantic Versioning.

## [Unreleased]

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
