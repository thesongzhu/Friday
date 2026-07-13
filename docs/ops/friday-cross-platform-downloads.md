# Friday Cross-Platform Downloads

Friday is moving from a source-first developer tool to a downloadable Agent OS product.

> **npm stays a developer/build/tooling surface, not a consumer install path.**
> Every `npm install` entry below is a developer/build/tooling surface for
> source/CI/internal-tooling use; it does not install the consumer product. The
> native Friday.app is the consumer release vehicle, and it is not yet publicly
> released, so no row below should be read as a shipped consumer download.

The release strategy is intentionally phased:

1. `macOS` is the first formal release-baseline target, with real
   signing/notarization, Sparkle/Homebrew publication, and clean-machine
   evidence still required before calling the beta baseline release-complete.
2. `iOS` gains a trusted-device remote console beta through TestFlight.
3. `Android` gains a trusted-device remote console beta through Play internal or closed testing.
4. `Windows` finishes the desktop Agent OS shell last.

The current program-level completion gate is tracked in [friday-cross-platform-agent-os-completion-checklist.md](./docs/ops/friday-cross-platform-agent-os-completion-checklist.md).

Supported release baselines for this milestone:

- `macOS 15+`
- `iOS trusted-device beta`
- `Android trusted-device beta`
- `Windows 11`

## Current Download Matrix

| Platform | Current Operator Path | Tagged Release Artifact | Native Companion | Truthful Status |
| --- | --- | --- | --- | --- |
| `macOS` | Source install and launchd today; GitHub Releases after a tagged artifact is produced | `DMG` + `zip` | `Swift/AppKit` | Local/CI beta packaging baseline; real signed/notarized evidence and clean-machine smoke remain missing |
| `iOS` | browser fallback today | TestFlight beta planned | mobile remote console planned | Not yet shipped for this milestone |
| `Android` | browser fallback today | Play internal or closed beta planned | mobile remote console planned | Not yet shipped for this milestone |
| `Windows` | developer/tooling install (`npm install -g @thesongzhu/friday`, not a consumer install) | signed installer planned | `.NET` scaffold | Scaffolded, not release-complete |

## Release Channels

1. `GitHub Releases`
   - primary channel for attached artifacts and release manifest
2. `Sparkle auto-update`
   - required macOS update channel once the native release baseline is complete
3. `Homebrew Cask`
   - required macOS install and upgrade channel generated from the DMG metadata
4. `npm`
   - cross-platform developer/build/tooling surface (source/CI/internal-tooling),
     not a consumer install path; a developer fallback while Windows remains on
     the native-installer track
5. `TestFlight`
   - planned iOS beta distribution channel for the mobile trusted-device app
6. `Play internal or closed beta`
   - planned Android beta distribution channel for the mobile trusted-device app

## Release Manifest

Every tagged release should publish:

- `dist/releases/Friday.release-manifest.json`
- `dist/releases/Friday.release-manifest.md`

The manifest is the source of truth for:

- version and tag
- platform artifact list
- checksums
- signing and notarization state
- install summaries
- release-channel readiness
- update-feed metadata for macOS release channels

## Notes

1. The Node hub and web Operator Console remain the shared product core on every platform.
2. The native companion is platform-specific and adds system-facing Agent OS behavior on desktop platforms.
3. iOS and Android are operator apps for trusted-device remote access, not mobile device-local automation runtimes.
4. Windows remains the last desktop completion track for this milestone.
