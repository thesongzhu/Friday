# Friday macOS Auto-Start

Use this when you want Friday to start after login and remain available while the Mac is awake.

This setup starts the local hub, starts the macOS companion when available, supervises both with `launchd`, and opens the local UI once the runtime is healthy.

## What This Gives You

1. Auto-start at login for the Friday hub.
2. Auto-start at login for the macOS companion.
3. Auto-restart if either process exits unexpectedly.
4. Persistent logs under `~/.friday/launchd/`.
5. Shared companion socket and auth token files under `.friday/run/`.
6. One-shot UI opener that waits for health and opens the browser UI once per boot/login session.
7. Channel readiness while the Mac is awake and the runtime is running.

## What This Does Not Do

- It does not wake a sleeping Mac from the network.
- It does not bypass macOS Accessibility, Screen Recording, or Input Monitoring prompts.
- It does not let channels bypass Friday's approval gates.
- It does not make missing provider keys or external accounts available.

## Prerequisites

From repo root:

```bash
npm run build:api
```

For native companion builds:

```bash
swift build -c release --package-path apps/macos/FridayCompanion
```

Optional packaged companion:

```bash
bash scripts/ops/build-friday-companion-app.sh
```

Provider and channel environment variables may live in the repo `.env` or another configured secret path. Do not commit secrets.

## Install

```bash
bash scripts/ops/install-friday-launchagent.sh
```

Optional custom repo path:

```bash
bash scripts/ops/install-friday-launchagent.sh /absolute/path/to/Friday
```

## Runtime Selection

The companion launch agent prefers:

1. `dist/macos/FridayCompanion.app/Contents/MacOS/FridayCompanion`
2. Swift build artifact in `apps/macos/FridayCompanion/.build/release/FridayCompanion`
3. Node daemon fallback in `dist/system/companion/friday-system-companion-daemon.js`

The Node daemon path is for development fallback. External beta operators should use the packaged native app or Swift build artifact.

## Status

```bash
bash scripts/ops/friday-launchagent-status.sh
```

Optional explicit repo path:

```bash
bash scripts/ops/friday-launchagent-status.sh /absolute/path/to/Friday
```

## Logs

- `~/.friday/launchd/friday.stdout.log`
- `~/.friday/launchd/friday.stderr.log`
- `~/.friday/launchd/friday-companion.stdout.log`
- `~/.friday/launchd/friday-companion.stderr.log`

Runtime files:

- `.friday/run/system-companion.sock`
- `.friday/run/system-companion.auth.token`
- `~/.friday/run/ui-launch-mode.txt`

Do not paste auth token contents into issues or docs.

## Uninstall

```bash
bash scripts/ops/uninstall-friday-launchagent.sh
```

Optional explicit repo path:

```bash
bash scripts/ops/uninstall-friday-launchagent.sh /absolute/path/to/Friday
```

## Channel Wake Semantics

For gateway/webhook channels, Friday must already be running to receive events. This launchd setup keeps the hub and companion alive after login, so channel traffic can reach Friday while the Mac is awake.

Channel control still uses the same policy model as the web UI:

- low-risk tasks may run automatically if policy allows
- sensitive actions require confirmation
- missing API keys, OAuth, payment, CAPTCHA, or OS permissions stop as human blockers

## Troubleshooting

Use [Local Runtime Troubleshooting](friday-agent-os-troubleshooting.md) if startup fails, companion permissions are missing, or channels cannot reach Friday.
