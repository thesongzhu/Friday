# Desktop Runtime Enablement

## What This Enables

When `FRIDAY_DESKTOP_ENABLED=true`, Friday registers the `desktop` agent tool and starts a desktop session manager at hub bootstrap.

Tool actions include:

- `session_info`
- `check_permissions`
- `execute` (click/type/keypress/scroll/drag/screenshot/read_element/launch_app/close_app/clipboard/file_operation)
- `inspect_element`
- `search_elements`
- `start_recording` / `stop_recording`

## Required Config

Add these to `.env` (or your runtime environment):

```bash
FRIDAY_DESKTOP_ENABLED=true
FRIDAY_DESKTOP_PRINCIPAL_ID=friday-desktop
FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS=/absolute/path/one,/absolute/path/two
```

Notes:

- `FRIDAY_DESKTOP_ENABLED` defaults to disabled (`false` unless explicitly set to `true`).
- `FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS` defaults to workspace root when unset.
- For browser automation that should be visible on your desktop, set `FRIDAY_BROWSER_PRESENTATION_MODE=auto` (recommended) or `FRIDAY_BROWSER_PRESENTATION_MODE=host_chrome_visible`.

## Dependency and Permission Check

Run:

```bash
npm run check:desktop-runtime
```

This checks:

- env status (`FRIDAY_DESKTOP_ENABLED`, sandbox roots)
- platform commands used by adapters
- platform permission hints

## OS-specific Notes

### macOS

Required binaries:

- `osascript`
- `screencapture`
- `base64`

Required system permissions (TCC):

- Accessibility
- Screen Recording
- Input Monitoring
- Automation

### Linux

Recommended tools:

- `xdotool` (input automation)
- one screenshot backend: `import` (ImageMagick) or `gnome-screenshot` or `scrot`
- `base64`

### Windows

Required:

- `powershell`

Some actions may require elevated privileges depending on target app/session.

## Verification Path

1. Enable env vars and restart Friday.
2. Execute an agent run that invokes `desktop` tool (e.g. `session_info` or `check_permissions`).
3. Confirm:
   - run has `toolCallCount > 0`
   - `agent.run.tool_end` contains `toolName=desktop`
   - user-visible response is returned through the entry channel (API/Discord/Webchat)
