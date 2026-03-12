# Friday Agent OS Acceptance Checklist

This checklist tracks the current macOS Agent OS state with only three labels:

- `validated and keep`
- `validated but temporary`
- `missing`

## Validated And Keep

- `system` backend service and `/v1/system/*` routes
- Agent OS web console in `ui/src`
- Unix domain socket JSON-RPC companion transport
- Remote device and remote session persistence
- Health, degraded mode, safe mode, and recovery surfacing in `/v1/system/state` and `/v1/health`
- Passkey registration and assertion routes for trusted-device remote access
- Trusted-device passkey clear and re-enroll flow in the Operator Console
- Companion-first routing for `open`, `focus`, `open_url`, `open_project`, `arrange_windows`, `notification_list`, `read_notification`, `notification_act`, and `recover_ui`
- Native Swift/AppKit companion package in `apps/macos/FridayCompanion`
- Native Swift companion end-to-end integration coverage in `test/integration/system/friday-system-native-companion.integration.test.ts`
- Companion runtime identity surfaced in `/v1/system/state`, `/v1/system/session`, and the web console
- Real usernoted-backed notification intake with deep-link-aware open actions in the native companion
- Usernoted-backed notification dismissal and displayed-state mutation with deep-link fallback for `mark_read`
- Dual launch-agent install, status, and uninstall scripts for hub plus companion
- Native companion app-bundle build, signing, and notarization scripts in `scripts/ops`
- Native companion release preflight and dual-mode verification scripts in `scripts/ops`
- Native companion release record generation in `scripts/ops/write-friday-companion-release-record.sh`
- macOS companion release guide in `docs/ops/friday-companion-release-macos.md`
- External beta onboarding guide in `docs/ops/friday-agent-os-beta-onboarding.md`
- External beta troubleshooting guide in `docs/ops/friday-agent-os-troubleshooting.md`

## Validated But Temporary

- Node companion daemon fallback in `src/system/companion/friday-system-companion-daemon.ts`
- Launchd-managed login startup in place of a fully signed installer/distribution workflow

## Missing

- A real signed and notarized production artifact produced with release credentials
- A clean-machine beta onboarding smoke run recorded against the packaged native companion

## Current Approval Gate

Engineering acceptance should require all of the following:

1. `npm run typecheck`
2. `npm run build:ui`
3. `swift test --package-path apps/macos/FridayCompanion`
4. `npm test`
5. `bash scripts/ops/release-friday-companion-app.sh`
6. No planned macOS v1 system action returning `unavailable` in normal companion-backed flows
7. A clean-machine onboarding smoke run has been executed and archived for the current beta candidate

Local repository validation can prove engineering readiness. It cannot prove GitHub or external reviewer approval.
