# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project follows Semantic Versioning.

## [Unreleased]

### Added
- One-command local demo workflow runner: `npm run demo` (`scripts/demo/minimal-workflow-demo.mjs` + sample workflow JSON).
- Troubleshooting and self-recovery runbook: `docs/TROUBLESHOOTING.md`.
- Extension guide and copy-ready templates for skills/plugins/workflows: `docs/EXTENDING.md` and `examples/templates/*`.
- Release notes template and closed-loop usability blueprint docs.

### Changed
- README now surfaces one-command demo, troubleshooting, extensibility, release links, and CI/release status badges.
- `docs/RELEASING.md` now includes release artifact completeness checks (version/changelog/release notes/license/security/CI).
- Hub bootstrap env test now reads package version dynamically (no hardcoded `0.3.0`), preventing version-bump CI regressions.

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
