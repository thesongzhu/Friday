# Friday Local Runtime Troubleshooting

Use this guide when the macOS local runtime, companion, auto-start, or channel wake path does not behave as expected.

## Release Preflight Fails

Symptoms:

- `check-friday-companion-release-env.sh` exits with code `78`
- notarized release mode fails before build starts

Checks:

```bash
security find-identity -v -p codesigning
xcrun notarytool history --keychain-profile "$FRIDAY_MACOS_NOTARY_PROFILE"
```

Likely causes:

- no valid Developer ID identity in the active keychain
- requested signing identity does not match an installed identity
- missing or inaccessible `notarytool` keychain profile

## Packaged App Is Missing

Symptoms:

- `dist/macos/FridayCompanion.app` does not exist
- launchd falls back to the Swift build or Node daemon

Checks:

```bash
bash scripts/ops/release-friday-companion-app.sh
bash scripts/ops/build-friday-companion-app.sh
```

Expected artifacts:

- `dist/macos/FridayCompanion.app`
- `dist/macos/FridayCompanion.release.json`
- `dist/macos/FridayCompanion.release.md`

## Companion Socket Or Auth Token Is Missing

Symptoms:

- `/v1/system/state` shows companion disconnected
- launchd logs mention socket or auth failures

Checks:

```bash
bash scripts/ops/friday-launchagent-status.sh
ls .friday/run/
tail -n 100 ~/.friday/launchd/friday-companion.stderr.log
```

Expected runtime files:

- `.friday/run/system-companion.sock`
- `.friday/run/system-companion.auth.token`

Do not print token contents in shared logs.

## Native Companion Is Not Selected

Symptoms:

- UI reports a fallback companion runtime
- desktop actions look stale or limited

Checks:

```bash
bash scripts/ops/friday-launchagent-status.sh
test -x dist/macos/FridayCompanion.app/Contents/MacOS/FridayCompanion
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

The Node daemon is a development fallback only.

## macOS Permissions Are Missing

Symptoms:

- companion health is degraded
- desktop or browser-adjacent actions fail
- safe mode appears immediately

Check these macOS permissions:

1. Accessibility
2. Screen Recording
3. Input Monitoring, if requested

After changing permissions:

```bash
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

## UI Does Not Open After Login

Checks:

```bash
curl -sS http://127.0.0.1:3141/v1/health
bash scripts/ops/friday-launchagent-status.sh
tail -n 100 ~/.friday/launchd/friday.stderr.log
tail -n 100 ~/.friday/launchd/friday.stdout.log
```

Expected behavior:

- hub listens on loopback
- `/v1/health` returns ok
- browser opens the local Friday UI once per login/boot session
- setup-complete users land on Home

## Channel Cannot Wake Or Control Friday

Channel wake means "Friday is already running and can receive the channel event." It does not mean "the channel can wake a sleeping computer."

Check:

- hub health
- channel credentials
- channel supervisor state
- sender allowlist/identity
- action risk level
- approval requirement

Sensitive actions requested through a channel must still go through confirmation.

## Provider Or Capability Looks Wrong After Restart

Run:

```bash
curl -sS http://127.0.0.1:3141/v1/providers/health
curl -sS http://127.0.0.1:3141/v1/model-routing
curl -sS http://127.0.0.1:3141/v1/providers/routing/explain
```

If the configured provider name, route, or model does not match setup, re-save the provider from setup/settings and re-run doctor verification.

## Safe Mode Does Not Clear

Symptoms:

- recovery returns but health remains degraded
- active control lease is not released

Recovery:

```bash
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

Then refresh the UI and inspect system state.

## What Remains External

These cannot be proven by the local repo alone:

- Apple signing/notarization without valid Apple credentials
- clean-machine beta smoke runs
- third-party provider account state
- OAuth, payment, CAPTCHA, or external platform approval
