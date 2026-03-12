# Friday macOS Auto-Start (launchd)

Use this when you want Friday Agent OS to stay active after login, with both the hub and the macOS companion supervised by `launchd`.

For a first external-operator setup, follow [friday-agent-os-beta-onboarding.md](./docs/ops/friday-agent-os-beta-onboarding.md) first.
If startup fails or the companion is unhealthy, use [friday-agent-os-troubleshooting.md](./docs/ops/friday-agent-os-troubleshooting.md).

## What this gives you

1. Auto-start at login for both `com.friday.hub` and `com.friday.companion`.
2. Auto-restart if either process exits unexpectedly.
3. Persistent stdout/stderr logs under `~/.friday/launchd/`.
4. A shared companion auth token file at `.friday/run/system-companion.auth.token`.

## Prerequisites

1. Build artifacts exist:
   - `npm run build:api`
   - `swift build -c release --package-path apps/macos/FridayCompanion`
2. Node is installed and available for the hub.
3. Swift is available if you want the native companion to auto-build from source when no packaged app bundle is present.
4. Optional channel/provider env vars are in repo `.env`.
5. Optional packaged release bundle can be created with `bash scripts/ops/build-friday-companion-app.sh`.

## Install

From repo root:

```bash
bash scripts/ops/install-friday-launchagent.sh
```

Optional custom repo path:

```bash
bash scripts/ops/install-friday-launchagent.sh /absolute/path/to/Friday
```

When the companion launch agent starts, `scripts/ops/friday-companion-run.sh` prefers runtimes in this order:

1. `dist/macos/FridayCompanion.app/Contents/MacOS/FridayCompanion`
2. Swift build artifact in `apps/macos/FridayCompanion/.build/release/FridayCompanion`
3. Node daemon fallback in `dist/system/companion/friday-system-companion-daemon.js`

The Node daemon path is for development fallback only. External beta operators should use the packaged native app or the Swift build artifact.

## Status

```bash
bash scripts/ops/friday-launchagent-status.sh
```

Optional explicit repo path:

```bash
bash scripts/ops/friday-launchagent-status.sh /absolute/path/to/Friday
```

## Logs

1. `~/.friday/launchd/friday.stdout.log`
2. `~/.friday/launchd/friday.stderr.log`
3. `~/.friday/launchd/friday-companion.stdout.log`
4. `~/.friday/launchd/friday-companion.stderr.log`

The shared Unix socket and auth token live inside the repo:

1. `.friday/run/system-companion.sock`
2. `.friday/run/system-companion.auth.token`

## Uninstall

```bash
bash scripts/ops/uninstall-friday-launchagent.sh
```

Optional explicit repo path:

```bash
bash scripts/ops/uninstall-friday-launchagent.sh /absolute/path/to/Friday
```

## Remote Access

Trusted-device remote sessions require all of the following:

1. The device is registered and active.
2. The connection originates from a private-network address.
3. The web console completes the passkey assertion flow exposed through `/v1/system/remote/auth/*`.

## Note

For gateway/webhook channels (Discord/Slack/etc.), Friday must be running to receive events.
This launchd setup keeps both the hub and the companion running so channel traffic, Agent OS state, and companion-backed system actions stay available after login.
