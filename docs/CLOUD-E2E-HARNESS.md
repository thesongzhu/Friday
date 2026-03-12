# Cloud E2E Harness

This harness runs live E2E scenarios against a deployed Friday instance (not local in-process hub).

## 1) Env Contract

Required when `FRIDAY_E2E_TARGET=cloud`:

- `FRIDAY_E2E_CLOUD_BASE_URL`
- `FRIDAY_E2E_CLOUD_AUTH_MODE` (`access-token` | `email-password` | `local-passphrase`)

Auth-mode specific:

- `access-token`:
  - `FRIDAY_E2E_CLOUD_ACCESS_TOKEN`
  - Optional: `FRIDAY_E2E_CLOUD_REFRESH_TOKEN`
- `email-password`:
  - `FRIDAY_E2E_CLOUD_EMAIL`
  - `FRIDAY_E2E_CLOUD_PASSWORD`
- `local-passphrase`:
  - `FRIDAY_E2E_CLOUD_LOCAL_PASSPHRASE`

Optional but recommended:

- `FRIDAY_E2E_CLOUD_NAMESPACE` (default: `cloud-e2e`)
- `FRIDAY_E2E_CLOUD_TIMEOUT_MS` (default: `30000`)
- `FRIDAY_E2E_CLOUD_ALLOW_DESTRUCTIVE` (default: `0`)

Provider gate (at least one):

- `FRIDAY_E2E_LIVE_OPENAI=1`
- `FRIDAY_E2E_LIVE_OLLAMA=1`

OpenAI live gate also needs:

- `OPENAI_API_KEY`
- `E2E_OPENAI_API_KEY_ENV=OPENAI_API_KEY`

## 2) Local Run

```bash
FRIDAY_E2E_TARGET=cloud \
FRIDAY_E2E_LIVE_OPENAI=1 \
FRIDAY_E2E_CLOUD_BASE_URL=https://your-staging-friday.example.com \
FRIDAY_E2E_CLOUD_AUTH_MODE=access-token \
FRIDAY_E2E_CLOUD_ACCESS_TOKEN=... \
OPENAI_API_KEY=... \
E2E_OPENAI_API_KEY_ENV=OPENAI_API_KEY \
npm run test:e2e:cloud
```

## 3) CI Run (Manual)

Use GitHub Actions workflow:

- `.github/workflows/cloud-e2e.yml`

Trigger via **workflow_dispatch** and provide:

- provider (`openai`/`ollama`)
- cloud_base_url
- auth_mode
- namespace
- timeout_ms
- environment_name

The workflow uploads logs/artifacts for each run.

## 4) Safety Model

- Cloud suite is prefix-scoped (`FRIDAY_E2E_CLOUD_NAMESPACE` + timestamp).
- Cleanup is best-effort and prefix-scoped.
- Existing local live suite (`friday-real-journeys.e2e.test.ts`) is now local-target only.
