# Friday Troubleshooting & Self-Recovery

This guide is for fast local recovery when Friday fails to start or run.

## 1) Collect Basic Signals

Run these first:

```bash
node --version
npm --version
friday --help
curl -sS http://127.0.0.1:3141/v1/health
```

If `friday` command is missing, use source mode:

```bash
node dist/cli/friday-cli.js --help
```

## 2) Where Logs and State Live

Friday stores runtime state under `FRIDAY_STATE_DIR`.

If `FRIDAY_STATE_DIR` is unset, default state path is OS-specific:

- macOS: `~/Library/Application Support/Friday/state`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/friday`
- Windows: `%LOCALAPPDATA%/Friday/state`
- Legacy fallback: `~/.friday/state`

Key files:

- SQLite DB: `<stateDir>/friday.db`
- Config: `<stateDir>/config.json5`
- Audit log (JSONL): `<stateDir>/.friday/audit.jsonl`

## 3) Turn On Debug-Friendly Output

Friday currently exposes request-level debug logging via `FRIDAY_LOG_REQUESTS`.

```bash
NODE_ENV=development FRIDAY_LOG_REQUESTS=true friday start --host 127.0.0.1 --port 3141
```

For isolated repro runs:

```bash
FRIDAY_STATE_DIR=.friday/debug-state NODE_ENV=development FRIDAY_LOG_REQUESTS=true friday start
```

### Local UI/API doctor

Friday now includes a local runtime doctor that classifies common port and assembly mistakes:

```bash
npm run ops:doctor:runtime
npm run ops:doctor:runtime -- --port 3141 --port 5173
npm run ops:doctor:runtime -- --url http://127.0.0.1:50576 --url http://127.0.0.1:19487
```

It checks:

- whether `/` returns the UI shell or an API-only 404
- whether `/v1/health` is reachable on the same origin
- whether local bypass login is available
- whether `/v1/setup/status` works with and without auth

Use it first when the browser shows **Setup status unavailable** or a raw JSON `No route matches GET /` page.

## 4) FAQ / Common Failures

### Q: `friday: command not found`

Cause: CLI not linked or package not installed globally.

Fix:

```bash
npm run build
npm link
friday --help
```

### Q: `Cannot find dist/cli/friday-cli.js`

Cause: project not built yet.

Fix:

```bash
npm run build
npm start
```

### Q: Port `3141` already in use

Fix by picking another port:

```bash
friday start --port 32141
curl http://127.0.0.1:32141/v1/health
```

### Q: Browser shows `No route matches GET /`

Cause: you reached an API-only port, or Friday was started without a mounted UI bundle.

Fix:

```bash
npm run build
FRIDAY_UI_DIST_DIR=/Users/you/Projects/Friday/dist/ui NODE_ENV=development friday start --host 127.0.0.1 --port 3141
```

Then open:

```bash
http://127.0.0.1:3141/
```

### Q: Browser shows `Setup status unavailable`

Cause: the frontend shell loaded, but the same origin could not successfully complete `GET /v1/setup/status`.

Common reasons:

- the current origin is not proxying `/v1/*` to the Friday API
- the session is unauthenticated or missing setup-read permission
- local no-sign-in mode is disabled by auth policy

Fix:

```bash
npm run ops:doctor:runtime -- --port 3141 --port 5173 --port 4173
```

Prefer the target where:

- `GET /` returns HTML
- `GET /v1/health` returns `200`
- `GET /v1/setup/status` returns `200` after login

### Q: Local login (`{"local":true}`) fails

Cause: passwordless local login is disabled when `FRIDAY_TOKEN_SECRET` is set in non-dev mode.

Fix:

```bash
unset FRIDAY_TOKEN_SECRET
NODE_ENV=development friday start
```

For production, keep `FRIDAY_TOKEN_SECRET` set and use normal credential/token flow.

### Q: Demo script fails before run starts

Run with full context output:

```bash
npm run demo
```

The demo script prints:

- state directory
- DB path
- audit log path
- server stdout/stderr tails

Use those paths first; do not guess.

### Q: Workflow run stays non-terminal

Check run status and timeline:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3141/v1/workflow-runs/<runId>
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3141/v1/workflow-runs/<runId>/timeline
```

Then inspect audit entries:

```bash
tail -n 200 "<stateDir>/.friday/audit.jsonl"
```

## 5) Fast Recovery Checklist

1. `npm run build`
2. `npm test` (or targeted failing suite)
3. Run with isolated state dir (`FRIDAY_STATE_DIR=.friday/debug-state`)
4. Verify `/v1/health`
5. Re-run the exact failing command
6. Capture stdout/stderr + audit log tail + run ID

## 6) Escalation Artifact Bundle (for issue/PR)

Include:

- command used
- exact error output
- `node --version` and `npm --version`
- state directory path
- failing `runId` / `workflowId` if available
- relevant audit log excerpt
