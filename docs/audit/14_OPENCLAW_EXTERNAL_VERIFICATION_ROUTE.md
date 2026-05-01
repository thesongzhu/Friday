# OpenClaw External Verification Route Follow-Up

Date: 2026-05-01

Branch: `codex/openclaw-external-verification`

Reference inspected: `openclaw/openclaw` at `f64b660b243cec831626275900d8c3997647f024`.

## What Friday Adopted From The OpenClaw Route

1. Separate local/mock proof from secret-bearing live proof.
2. Put secret-bearing live runs behind a GitHub Environment.
3. Require trusted actor/ref checks before live workflows can access environment secrets.
4. Use an explicit staging deployment profile with HTTPS, health checks, persistent state, and production env boundaries.
5. Treat external CORS/callback/channel/observability proof as GRAY until a real external endpoint and sandbox credentials are exercised.

## Repository/Environment Changes Completed

| Item | Status | Evidence |
| --- | --- | --- |
| `main` branch protection made stricter | VERIFIED | GitHub API now reports required status checks with `strict=true`, one required approving review, conversation resolution enabled, and force-push/delete disabled. |
| `staging-e2e` GitHub Environment created | VERIFIED | Environment exists with deployment branch policy restricted to protected branches. |
| Environment secrets seeded for cloud E2E | VERIFIED | `OPENAI_API_KEY` and `FRIDAY_E2E_CLOUD_LOCAL_PASSPHRASE` exist in `staging-e2e`; values were not printed. |
| Fly staging profile added | VERIFIED_BY_CODE | `fly.toml` uses `docker/Dockerfile`, persistent `/data`, HTTPS, `/v1/health`, and production env defaults. |

## Still Blocked For True External Proof

| Area | Status | Blocker |
| --- | --- | --- |
| Real staging deploy | BLOCKED | No Fly API token/account login is available locally or in repo secrets. `flyctl` is also not installed. |
| Cloud Live E2E actor/ref guard | BLOCKED | The local workflow hardening patch could not be pushed because the authenticated GitHub OAuth token lacks `workflow` scope. Re-auth with workflow scope or apply through a token/app that can modify workflows. |
| Real deployed URL/domain CORS/cookie test | BLOCKED | No deployed `https://...` target exists yet. |
| OAuth callback/domain test | BLOCKED | No external deployed callback URL exists; provider dashboard configuration cannot be verified without that URL. |
| Discord interactions/live channel | BLOCKED | `DISCORD_BOT_TOKEN` is not present in the local environment or GitHub environment. The token pasted in chat should be rotated before use. Discord Developer Portal cannot be accessed from the CLI without a Discord account/browser session. |
| Webhook provider live callback | BLOCKED | Needs a deployed HTTPS target and provider-specific signing secret/test event source. |
| Email link callback | BLOCKED | Needs deployed callback URL plus SMTP/email-link provider sandbox credentials. |
| Grafana Cloud/OTEL backend | BLOCKED | No `OTEL_EXPORTER_OTLP_ENDPOINT`, Grafana token, or collector endpoint is configured. Friday also documents OTLP export as a future phase, so external export cannot be claimed until implemented/configured. |

## Recommended External Verification Path

1. Rotate the provider keys and Discord bot token exposed in this chat.
2. Create a Fly app using `fly.toml` and set secrets:
   - `FRIDAY_TOKEN_SECRET`
   - `FRIDAY_CORS_ORIGINS`
   - `FRIDAY_E2E_CLOUD_LOCAL_PASSPHRASE`
   - provider keys required for live LLM routing
   - channel/webhook/email callback secrets
3. Deploy staging and record its HTTPS base URL.
4. Re-auth GitHub with `workflow` scope and add an actor/ref guard to `Cloud Live E2E`.
5. Run `Cloud Live E2E` from `main` with:
   - `cloud_base_url=<staging-url>`
   - `auth_mode=local-passphrase`
   - `environment_name=staging-e2e`
6. Add and run a dedicated external smoke for:
   - allowed-origin CORS positive case
   - disallowed-origin CORS negative case
   - HTTPS/HSTS headers
   - OAuth callback URL reachability
   - valid/invalid/replayed webhook delivery
   - email-link callback roundtrip
   - Discord sandbox inbound/outbound message with provider message ID
7. Configure OTEL/Grafana only after Friday has an actual OTLP exporter or collector integration path; until then, keep external observability as GRAY, not VERIFIED.

## Current Verdict

YELLOW: GitHub control-plane readiness improved and a Fly staging route now exists in code. Real external production/staging behavior remains GRAY/BLOCKED until a real Fly app, domain, callback providers, channel sandbox, and observability backend are configured and exercised.

## Verification Commands Run

| Command | Result |
| --- | --- |
| `git diff --check` | PASS |
| `fly.toml` smoke check for Dockerfile and `/v1/health` | PASS |
| `npm run typecheck` | PASS |
| `npm run check:architecture-boundaries` | PASS |
| `npm audit --audit-level=moderate --omit=dev` | PASS |
| `npm run check:migrations` | PASS |
| GitHub branch protection API readback | PASS |
| GitHub `staging-e2e` Environment API readback | PASS |
