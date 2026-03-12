# Friday Native Companion Release Guide (macOS)

Use this guide when you want to build, sign, notarize, and ship the native `FridayCompanion.app` bundle for Agent OS deployments.

For a full early-user setup after release, continue with [friday-agent-os-beta-onboarding.md](./docs/ops/friday-agent-os-beta-onboarding.md).
If signing, notarization, launchd, passkey, or socket checks fail, use [friday-agent-os-troubleshooting.md](./docs/ops/friday-agent-os-troubleshooting.md).

The repo now has two release modes:

1. `local`: build and verify a locally runnable bundle without Apple release credentials
2. `notarize`: build, sign, notarize, staple, and verify a release-ready bundle

The distribution layer now adds release channels on top of the existing `.app` bundle:

1. a release `DMG`
2. a release `zip`
3. a `Sparkle` appcast when update credentials are configured
4. a generated `Homebrew Cask`, with optional tap publication
5. a release manifest that records the tagged download surface

## What this covers

1. Build the AppKit companion bundle from the Swift package.
2. Apply either an ad-hoc signature or a real Developer ID signature.
3. Submit the bundle for notarization with `notarytool`.
4. Verify the notarized app before rolling it out through `launchd`.
5. Package the bundle as a DMG for GitHub Releases and Homebrew Cask generation.

## Prerequisites

1. macOS with Swift and `xcrun` available.
2. Node is installed so the build script can read the project version.
3. For real release signing:
   - a valid Developer ID Application certificate
   - a configured `notarytool` keychain profile
4. For Sparkle auto-update publication:
   - `FRIDAY_MACOS_SPARKLE_PRIVATE_KEY`
   - `FRIDAY_MACOS_SPARKLE_PUBLIC_KEY`
   - `FRIDAY_MACOS_APPCAST_BASE_URL`
5. For Homebrew publication:
   - `FRIDAY_HOMEBREW_TAP_REPO`
   - `FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN`
4. Repo root available locally.

## Local Release Verification

From repo root:

```bash
bash scripts/ops/release-friday-companion-app.sh
```

Or through npm:

```bash
npm run release:companion:local
```

This path:

1. Checks that the local build environment is usable.
2. Builds `dist/macos/FridayCompanion.app`.
3. Verifies bundle structure and code-sign validity.
4. Packages release artifacts as `DMG + zip`.
5. Generates `dist/releases/Friday.release-manifest.json`, `dist/releases/Friday.release-manifest.md`, and `dist/releases/homebrew/Casks/friday.rb`.
6. Writes release evidence to `dist/macos/FridayCompanion.release.json` and `dist/macos/FridayCompanion.release.md`.
7. Stops before Gatekeeper or notarization checks, because ad-hoc signatures do not pass those checks.
8. When Sparkle credentials are configured, also generates `dist/releases/macos/appcast.xml`.
9. When Homebrew tap credentials are configured, also publishes the generated Cask to the tap and refreshes the manifest.

Use this mode for local engineering acceptance and CI coverage.

## Build The App Bundle

From repo root:

```bash
bash scripts/ops/build-friday-companion-app.sh
```

The script:

1. Builds the Swift package in `release` mode by default.
2. Creates `dist/macos/FridayCompanion.app`.
3. Writes `Info.plist` with the current project version.
4. Applies an ad-hoc signature by default so the bundle is runnable locally.

Useful environment overrides:

```bash
export FRIDAY_MACOS_CODESIGN_MODE=identity
export FRIDAY_MACOS_CODESIGN_IDENTITY="Developer ID Application: Example Corp (TEAMID1234)"
export FRIDAY_MACOS_BUNDLE_IDENTIFIER="com.friday.FridayCompanion"
export FRIDAY_MACOS_APP_VERSION="0.3.1"
export FRIDAY_MACOS_SPARKLE_PUBLIC_KEY="<sparkle-public-key>"
export FRIDAY_MACOS_APPCAST_BASE_URL="https://github.com/thesongzhu/Friday/releases/latest/download"
export FRIDAY_HOMEBREW_TAP_REPO="thesongzhu/homebrew-friday"
```

Supported signing modes:

1. `adhoc` (default): local runnable bundle with ad-hoc signing.
2. `identity`: Developer ID signing plus hardened runtime.
3. `skip`: create the bundle without signing.

## Notarize The Bundle

After building with a real signing identity:

```bash
export FRIDAY_MACOS_CODESIGN_MODE=identity
export FRIDAY_MACOS_CODESIGN_IDENTITY="Developer ID Application: Example Corp (TEAMID1234)"
export FRIDAY_MACOS_NOTARY_PROFILE="friday-notary"
export FRIDAY_MACOS_SPARKLE_PRIVATE_KEY="$HOME/.friday-keys/sparkle-private-key.txt"
export FRIDAY_MACOS_SPARKLE_PUBLIC_KEY="<sparkle-public-key>"
export FRIDAY_MACOS_APPCAST_BASE_URL="https://github.com/thesongzhu/Friday/releases/latest/download"
bash scripts/ops/release-friday-companion-app.sh
```

Or through npm:

```bash
npm run release:companion:notarize
```

Optional team override:

```bash
export FRIDAY_MACOS_TEAM_ID="TEAMID1234"
```

The notarized release flow:

1. Runs release-environment preflight.
2. Builds the app with Developer ID signing.
3. Runs the same local structure and codesign verification used by local mode.
4. Packages release artifacts as `DMG + zip`.
5. Submits the archive through `notarytool` and writes the result to `dist/macos/FridayCompanion.notary.json`.
6. Staples the notarization ticket.
7. Validates the stapled ticket and runs `spctl`.
8. Generates `dist/releases/Friday.release-manifest.json`, `dist/releases/Friday.release-manifest.md`, and `dist/releases/homebrew/Casks/friday.rb`.
9. Writes release evidence to `dist/macos/FridayCompanion.release.json` and `dist/macos/FridayCompanion.release.md`.
10. Generates `dist/releases/macos/appcast.xml` when Sparkle credentials are configured.
11. Publishes the Homebrew cask when tap credentials are configured.

If you need direct access to the lower-level scripts, they remain available:

```bash
bash scripts/ops/check-friday-companion-release-env.sh
bash scripts/ops/build-friday-companion-app.sh
bash scripts/ops/build-friday-companion-dmg.sh
bash scripts/ops/build-friday-sparkle-appcast.sh
bash scripts/ops/publish-friday-homebrew-cask.sh
bash scripts/ops/generate-friday-sparkle-keys.sh
bash scripts/ops/verify-friday-companion-app.sh
bash scripts/ops/notarize-friday-companion-app.sh
node scripts/ops/write-friday-release-manifest.mjs
```

## Launchd Rollout

Once the bundle is built and validated, keep the current two-process runtime:

1. Friday hub process
2. Friday native companion process

`scripts/ops/friday-companion-run.sh` remains the operational entrypoint, but the packaged bundle gives you a distributable native artifact for release management, signing, and upgrade workflows.
When `dist/macos/FridayCompanion.app` exists, the runner now prefers that packaged app before falling back to raw Swift build artifacts or the Node daemon.
The Node daemon remains a development fallback only and is not the intended release runtime for external beta operators.

## Release Evidence

Each release run now writes:

1. `dist/macos/FridayCompanion.release.json`
2. `dist/macos/FridayCompanion.release.md`
3. `dist/releases/macos/*.dmg`
4. `dist/releases/macos/*.zip`
5. `dist/releases/Friday.release-manifest.json`
6. `dist/releases/Friday.release-manifest.md`
7. `dist/releases/homebrew/Casks/friday.rb`
8. `dist/releases/macos/appcast.xml` when Sparkle is configured
9. `dist/releases/channels/*.json` when channel publication metadata exists

These files capture:

- bundle version and build
- bundle identifier
- signing mode and identity
- notarization status
- optional notarization result path
- rollout steps for launchd and Operator Console validation
- DMG and zip artifact metadata
- cross-platform release-channel readiness
- Sparkle appcast path when generated
- source fallback package path when generated
- current macOS clean-machine evidence path when it has been recorded

## Clean-Machine Evidence

After the packaged beta smoke run, write the evidence record:

```bash
bash scripts/ops/run-friday-macos-beta-smoke.sh
```

By default this writes a local smoke record to:

- `dist/macos/FridayCompanion.clean-machine-smoke.md`

For the real beta candidate, point the script at the canonical archive path:

```bash
FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH=docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md \
  bash scripts/ops/run-friday-macos-beta-smoke.sh
```

Or record the evidence directly if the smoke steps were run manually:

```bash
bash scripts/ops/write-friday-macos-clean-machine-evidence.sh
```

The canonical evidence file is:

- `docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md`

## Upgrade Checklist

1. Build the new bundle.
2. Sign with the release identity.
3. Notarize and staple.
4. Verify with the release script in `notarize` mode.
5. Restart `com.friday.companion` with:

```bash
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

## Notes

1. Local repository validation can prove the scripts, bundle structure, and local release workflow work.
2. Only a real Developer ID identity and Apple notarization run can prove release readiness.
3. `verify-friday-companion-app.sh` has two explicit modes:
   - `local`: bundle structure plus codesign verification
   - `notarized`: stapler plus Gatekeeper verification
4. `check-friday-companion-release-env.sh` now validates both the requested signing identity and the requested `notarytool` profile before a notarized release starts.
5. The Node companion remains a fallback path for development only; the intended macOS operator path is the native Swift companion.
