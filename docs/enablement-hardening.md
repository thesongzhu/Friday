# Enablement Hardening

This guide closes the most common runtime enablement gaps for local Friday deployments.

## One-command hardening

Run:

```bash
npm run ops:harden-local-enablement
```

What it does:

1. Ensures `FRIDAY_TOKEN_SECRET` exists in `.env` (preserves existing value).
2. Forces `FRIDAY_CHANNEL_SECRET_POLICY=strict`.
3. Configures browser runtime for stable mode (`FRIDAY_BROWSER_USE_HOST_CHROME=false`, `FRIDAY_BROWSER_HEADLESS=true`).
4. Ensures desktop runtime is enabled and sandbox-rooted to the current workspace.
5. Enables MCP via a safe local filesystem server config (`FRIDAY_MCP_SERVERS`).
6. If a legacy `~/.friday/friday.json` Discord token is found, migrates runtime channel config to env-ref mode:
   - `DISCORD_BOT_TOKEN=...`
   - `FRIDAY_CHANNELS_JSON=...token:"$DISCORD_BOT_TOKEN"...`

## Verification

Run:

```bash
set -a; source .env; set +a; npm run check:desktop-runtime
npm run check:enablement-gaps
```

`check:enablement-gaps` fails when:

- `FRIDAY_TOKEN_SECRET` is missing or weak
- channel secret policy is not strict
- channel config includes plaintext secrets
- desktop runtime is not enabled
- MCP server config is invalid

## Restart runtime

After updating `.env`, restart Friday:

```bash
launchctl kickstart -k gui/$(id -u)/com.friday.hub
```

Then verify process env and health:

```bash
PID=$(pgrep -f "dist/cli/friday-cli.js start" | head -n1)
ps eww -p "$PID" | tr ' ' '\n' | rg '^FRIDAY_'
curl -sS http://127.0.0.1:3141/v1/health
```
