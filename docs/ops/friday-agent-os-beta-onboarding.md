# Friday Agent OS Beta Onboarding

Use this guide for the first external-operator setup of Friday Agent OS on a single-user Mac.

## What you need

1. macOS with Swift, Node, and `xcrun` available.
2. Repo root available locally.
3. A packaged native companion bundle or a local Swift build.
4. A browser that can complete passkey enrollment.
5. Private-network access for trusted-device remote sessions.

## 1. Build the native companion

For local engineering validation:

```bash
bash scripts/ops/release-friday-companion-app.sh
```

For a real beta release candidate, use the notarized path described in [friday-companion-release-macos.md](./docs/ops/friday-companion-release-macos.md).

Expected result:

- `dist/macos/FridayCompanion.app`
- `dist/macos/FridayCompanion.release.json`
- `dist/macos/FridayCompanion.release.md`
- `dist/releases/macos/*.dmg`
- `dist/releases/macos/*.zip`
- `dist/releases/Friday.release-manifest.json`
- `dist/releases/homebrew/Casks/friday.rb`

## 2. Install launchd startup

Build the backend first:

```bash
npm run build:api
```

Then install the hub and companion launch agents:

```bash
bash scripts/ops/install-friday-launchagent.sh
```

Check status:

```bash
bash scripts/ops/friday-launchagent-status.sh
```

Expected result:

- `com.friday.hub` is loaded
- `com.friday.companion` is loaded
- the companion socket and auth token exist under `.friday/run/`

## 3. Grant macOS permissions

The native companion path requires:

1. Accessibility
2. Screen Recording
3. Input Monitoring when the host asks for it

After granting permissions, restart the companion:

```bash
launchctl kickstart -k "gui/${UID}/com.friday.companion"
```

## 4. Open the Operator Console

Start or confirm the web console is available, then open the Command Center.

Validate:

- the shell reports the native companion runtime
- system health is `healthy` or clearly explains any degraded reason
- companion permissions are visible in Settings

## 5. Enroll a trusted-device passkey

From the Operator Console:

1. Open the remote devices section
2. Register the current device
3. Complete passkey enrollment
4. Confirm the device shows a registered passkey and recent assertion metadata

## 6. Open a trusted remote session

From a private-network device:

1. Open the web console
2. Complete passkey assertion
3. Request a remote session

Expected result:

- session opens only after a valid passkey assertion
- remote mode stays `trusted_private_network`
- revoked or inactive devices are rejected

## 7. Validate recovery

Run one basic operator recovery drill:

1. Trigger or enter safe mode
2. Use the Operator Console to recover UI state
3. Restart the companion with `launchctl kickstart`
4. Confirm the console returns to a healthy native companion state

## 8. Uninstall

To remove launchd startup:

```bash
bash scripts/ops/uninstall-friday-launchagent.sh
```

Then remove local build artifacts if needed:

```bash
rm -rf dist/macos
```

## Beta Acceptance Checklist

Before handing the setup to another external operator, confirm:

- release evidence files exist in `dist/macos/`
- packaged release artifacts exist in `dist/releases/macos/`
- the Homebrew Cask exists in `dist/releases/homebrew/Casks/friday.rb`
- launchd status is healthy
- required macOS permissions are granted
- passkey enrollment succeeds
- a trusted private-network remote session succeeds
- recovery works after a companion restart
- the local smoke record exists at `dist/macos/FridayCompanion.clean-machine-smoke.md`
- the final clean-machine evidence file is updated at `docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md`
