# Friday Troubleshooting

Use this guide when Friday fails to start, setup gets stuck, a provider looks wrong, or a capability does not close the loop.

## First Checks

```bash
node --version
npm --version
friday --help
curl -sS http://127.0.0.1:3141/v1/health
```

If the `friday` command is missing in source mode:

```bash
npm run build
node dist/cli/friday-cli.js --help
```

## Logs And State

Friday stores runtime state under `FRIDAY_STATE_DIR`.

Default state paths:

- macOS: `~/Library/Application Support/Friday/state`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/friday`
- Windows: `%LOCALAPPDATA%/Friday/state`
- Legacy fallback: `~/.friday/state`

Important files:

- SQLite DB: `<stateDir>/friday.db`
- Config: `<stateDir>/config.json5`
- Audit log: `<stateDir>/.friday/audit.jsonl`

## Local Runtime Doctor

Run the doctor before guessing:

```bash
npm run ops:doctor:runtime
npm run ops:doctor:runtime -- --port 3141 --port 5173 --port 4173
```

It checks whether:

- `/` returns the UI shell
- `/v1/health` works on the same origin
- local bootstrap/login is available
- `/v1/setup/status` works after auth

## Friday Opens A Recovery Or Auth Page

Possible causes:

- setup is incomplete
- local session expired
- local bootstrap passphrase is missing
- auth policy changed
- the UI opened before the hub finished starting

Recovery:

```bash
curl -sS http://127.0.0.1:3141/v1/health
npm run ops:doctor:runtime -- --port 3141
```

Then reload the UI. If setup is complete, Friday should route to Home.

## Setup Shows The Wrong Provider Name

The provider card should show the current live route, not stale setup text.

Check provider state:

```bash
curl -sS http://127.0.0.1:3141/v1/providers/health
curl -sS http://127.0.0.1:3141/v1/model-routing
curl -sS http://127.0.0.1:3141/v1/providers/routing/explain
```

If you configured OpenAI but see another provider name, verify:

- provider kind
- base URL
- default model
- routing default provider ID
- setup provider list

Friday should repair known stale display-name cases on startup, but a provider should still be re-saved from setup if route truth and UI truth disagree.

## A Capability Is Missing

Friday should not say a missing lane is working. Ask:

```text
What capabilities are available, what is missing, and what exact setup step is blocked by me?
```

Expected answer shape:

- capability name
- status
- missing provider/API/account/permission
- configuration location
- verification step

Human blockers include API keys, OAuth, paid plans, CAPTCHA, logins, sensitive permissions, and production-impacting actions.

## Provider Key Fails

Common causes:

- invalid or expired key
- provider account not enabled for the requested model
- wrong base URL
- wrong API family
- quota or billing issue
- network block

Fix:

1. Re-enter the provider in setup/settings.
2. Run provider doctor.
3. Execute a small representative task.
4. Confirm Friday marks the lane available only after verification.

Do not commit keys to the repo or paste them into public issues.

## Channel Receives Messages But Cannot Control Friday

Check:

- hub is running
- channel credentials are valid
- channel supervisor is healthy
- sender identity is allowed
- requested action is within policy
- high-risk action has a confirmation path

For macOS login startup, see [macOS Auto-Start](ops/friday-autostart-macos.md).

Channel wake means Friday can respond while the machine is awake and the runtime is running. It does not mean the channel can wake a sleeping computer from the network.

## Generated Skill Fails Verification

A generated skill should not become routable until verification passes.

Check:

- manifest validity
- package integrity
- runtime dependencies
- permission request
- dry-run output
- sandbox verdict
- audit evidence

Recovery:

1. Keep the failed skill disabled.
2. Inspect verification evidence.
3. Patch or regenerate.
4. Re-run sandbox/test.
5. Approve only after verification passes.

## Port Already In Use

```bash
friday start --port 32141
curl http://127.0.0.1:32141/v1/health
```

Or set:

```bash
export FRIDAY_PORT=32141
```

## Browser Shows `No route matches GET /`

Cause: you reached an API-only port or Friday started without a mounted UI bundle.

Fix from source:

```bash
npm run build
FRIDAY_UI_DIST_DIR=/Users/you/Projects/Friday/dist/ui NODE_ENV=development friday start --host 127.0.0.1 --port 3141
```

Open:

```text
http://127.0.0.1:3141/
```

## Setup Status Unavailable

Cause: the UI shell loaded, but `GET /v1/setup/status` failed.

Common reasons:

- current origin is not proxying `/v1/*` to the Friday API
- session is unauthenticated
- setup-read permission is missing
- local bootstrap is disabled

Run:

```bash
npm run ops:doctor:runtime -- --port 3141 --port 5173 --port 4173
```

Use the target where `/`, `/v1/health`, and `/v1/setup/status` work together.

## Escalation Bundle

When filing an issue, include:

- command used
- exact error output
- `node --version` and `npm --version`
- OS and install method
- state directory path
- relevant run ID, workflow ID, or provider ID
- sanitized audit/log excerpt
- what you expected Friday to do

Do not include API keys, channel tokens, screenshots with secrets, private documents, or personal credentials.
