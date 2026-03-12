# Friday Agent OS Troubleshooting

Use this guide when the macOS Agent OS beta path does not behave as expected.

## Release preflight fails

Symptoms:

- `check-friday-companion-release-env.sh` exits with code `78`
- notarized release mode fails before build starts

Checks:

1. `security find-identity -v -p codesigning`
2. `xcrun notarytool history --keychain-profile "$FRIDAY_MACOS_NOTARY_PROFILE"`

Likely causes:

- no valid Developer ID identity in the active keychain
- requested signing identity does not match an installed identity
- missing or inaccessible `notarytool` keychain profile

## Packaged app is missing

Symptoms:

- `dist/macos/FridayCompanion.app` does not exist
- launchd falls back to the Swift build or Node daemon

Checks:

1. `bash scripts/ops/release-friday-companion-app.sh`
2. `bash scripts/ops/build-friday-companion-app.sh`

Expected artifacts:

- `dist/macos/FridayCompanion.app`
- `dist/macos/FridayCompanion.release.json`
- `dist/macos/FridayCompanion.release.md`

## Companion socket or auth token is missing

Symptoms:

- `/v1/system/state` shows companion disconnected
- launchd logs mention socket or auth failures

Checks:

1. `bash scripts/ops/friday-launchagent-status.sh`
2. `ls .friday/run/`
3. `tail -n 100 ~/.friday/launchd/friday-companion.stderr.log`

Expected runtime files:

- `.friday/run/system-companion.sock`
- `.friday/run/system-companion.auth.token`

## Native companion is not selected

Symptoms:

- Operator Console reports a fallback runtime
- companion actions look stale or limited

Checks:

1. `bash scripts/ops/friday-launchagent-status.sh`
2. Confirm `dist/macos/FridayCompanion.app/Contents/MacOS/FridayCompanion` exists
3. Restart the companion:

```bash
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

Note:

The Node daemon is a development fallback only. External beta use should prefer the packaged native app.

## macOS permissions are missing

Symptoms:

- system health is degraded
- UI actions fail or safe mode appears immediately

Checks:

1. Accessibility permission
2. Screen Recording permission
3. Input Monitoring permission if requested

After changing permissions, restart the companion:

```bash
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

## Passkey enrollment or assertion fails

Symptoms:

- remote session open is rejected
- device exists but shows no verified passkey

Checks:

1. Re-open the Operator Console and inspect the device entry
2. Confirm the device is active
3. Confirm the request originates from a private-network address

Recovery path:

1. Clear the device passkey in the Operator Console
2. Re-enroll the device
3. Re-run the assertion flow before opening a remote session

## Recovery does not clear safe mode

Symptoms:

- `recover_ui` returns but health remains degraded
- the active control lease is not released

Checks:

1. Restart the companion:

```bash
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

2. Refresh the Operator Console and inspect `/v1/system/state`
3. Confirm the companion permissions are still granted

## What is still external

These steps cannot be proven by the local repo alone:

- a real signed and notarized production artifact with Apple credentials
- a clean-machine beta smoke run executed on the packaged native companion
