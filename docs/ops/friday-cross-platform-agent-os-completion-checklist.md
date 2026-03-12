# Friday Cross-Platform Agent OS Completion Checklist

This checklist is the single completion source of truth for the current cross-platform Agent OS program.

Only these status labels are allowed:

- `validated and keep`
- `validated but temporary`
- `missing`

## Supported Release Baselines

- `macOS 15+`
- `iOS trusted-device beta`
- `Android trusted-device beta`
- `Windows 11`

Unsupported for this milestone:

- Linux
- iOS device-local automation
- Android device-local automation

## Validated And Keep

- Shared Node hub and web Operator Console
- Stable `/v1/system/*` and `/v1/system/remote/auth/*` route families
- Shared cross-platform companion contract with explicit runtime kinds, transport kinds, and action capability reporting
- Native Swift/AppKit companion package in `apps/macos/FridayCompanion`
- Unix-socket and named-pipe companion transport bridges with companion-first Agent OS routing and explicit fallback control
- Passkey-backed trusted-device remote flow in the Operator Console
- Release manifest generation in `scripts/ops/write-friday-release-manifest.mjs`
- Source distribution packaging in `scripts/ops/build-friday-source-distribution.sh`
- macOS companion app, DMG, verification, and release-record scripts in `scripts/ops`
- macOS beta smoke and evidence-writer scripts in `scripts/ops`

## Validated But Temporary

- Node companion daemon fallback for development
- Source and npm install as the Windows operator fallback
- Browser Operator Console access as the temporary iOS and Android fallback until dedicated mobile apps ship
- Windows native companion scaffold in `apps/windows/FridayCompanion`
- Homebrew channel generation without release-complete publication evidence

## Missing

- Real Apple-signed and notarized macOS release evidence archived for the current beta candidate
- Sparkle auto-update publication evidence for the macOS beta baseline
- Homebrew tap publication evidence for the macOS beta baseline
- Real iOS remote-console beta with TestFlight distribution evidence
- Real Android remote-console beta with Play internal or closed beta evidence
- Real Windows native companion with named-pipe transport and signed MSI evidence
- Archived clean-machine or device smoke evidence for:
  - `macOS 15+`
  - `iOS trusted-device beta`
  - `Android trusted-device beta`
  - `Windows 11`
- Verified external release inputs for:
  - Apple Developer ID signing, notarization, Sparkle, and Homebrew publication
  - iOS App Store Connect beta distribution
  - Android Play beta distribution
  - Windows code-signing

## Required External Release Inputs

The program is not complete until all of the following are available and validated:

1. `FRIDAY_MACOS_CODESIGN_IDENTITY`
2. `FRIDAY_MACOS_NOTARY_PROFILE`
3. `FRIDAY_MACOS_SPARKLE_PRIVATE_KEY`
4. `FRIDAY_MACOS_SPARKLE_PUBLIC_KEY`
5. `FRIDAY_MACOS_APPCAST_BASE_URL`
6. `FRIDAY_HOMEBREW_TAP_REPO`
7. `FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN`
8. `FRIDAY_IOS_APPLE_TEAM_ID`
9. `FRIDAY_IOS_BUNDLE_ID`
10. `FRIDAY_IOS_APP_STORE_CONNECT_KEY_ID`
11. `FRIDAY_IOS_APP_STORE_CONNECT_ISSUER_ID`
12. `FRIDAY_IOS_APP_STORE_CONNECT_PRIVATE_KEY_PATH`
13. `FRIDAY_ANDROID_APPLICATION_ID`
14. `FRIDAY_ANDROID_KEYSTORE_PATH`
15. `FRIDAY_ANDROID_KEYSTORE_PASSWORD`
16. `FRIDAY_ANDROID_KEY_ALIAS`
17. `FRIDAY_ANDROID_KEY_PASSWORD`
18. `FRIDAY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON`
19. `FRIDAY_WINDOWS_CODESIGN_PFX_PATH`
20. `FRIDAY_WINDOWS_CODESIGN_PFX_PASSWORD`
21. `FRIDAY_CROSS_PLATFORM_MACOS_SMOKE_TARGET`
22. `FRIDAY_CROSS_PLATFORM_IOS_SMOKE_TARGET`
23. `FRIDAY_CROSS_PLATFORM_ANDROID_SMOKE_TARGET`
24. `FRIDAY_CROSS_PLATFORM_WINDOWS_SMOKE_TARGET`

## Evidence Archive

Clean-machine smoke evidence is tracked in:

- `docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md`
- `docs/reports/ops/cross-platform-agent-os-beta-evidence/ios-latest-device-smoke.md`
- `docs/reports/ops/cross-platform-agent-os-beta-evidence/android-latest-device-smoke.md`
- `docs/reports/ops/cross-platform-agent-os-beta-evidence/windows-11-clean-machine.md`

Each evidence file must be marked `Status: complete` before the corresponding platform is considered finished.

## Current Approval Gate

Engineering completion requires all of the following:

1. `npm run typecheck`
2. `npm run build:ui`
3. `npm test`
4. `npm run check:cross-platform-release-inputs`
5. platform-native packaging and runtime tests for each supported OS baseline
6. no supported-platform required capability returning `unavailable`
7. archived clean-machine or device smoke evidence for all supported baselines
8. `Sparkle`, `Homebrew`, and `npm` all proven usable for the supported release matrix
9. real signing or notarization completed where required

Local repository validation can prove engineering readiness. It cannot prove external reviewer approval or external release-credential ownership.
