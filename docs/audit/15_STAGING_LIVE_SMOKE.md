# Staging Live Smoke Follow-Up

Date: 2026-05-02

## Scope

This pass created a temporary public staging URL through Cloudflare Tunnel and tested the current Friday production runtime through that URL. The goal was to verify external CORS/cookie/callback/webhook/email/Discord behavior without using passwordless auth, mint-token shortcuts, mock providers, or stale localhost ports.

Runtime under test:

- Product commit: `a45126356e53eca8f8df4c2b0e4d69c6a21a0aa7`
- Current `main` after PR #174 merge: `989cba2b123e8b8bd7b5427f6d8f0b4aa6bda3bb`
- Runtime delta between those commits: `.github/workflows/cloud-e2e.yml` only, so no product runtime code changed between the smoke and current `main`.
- Worktree: `/tmp/friday-staging-smoke-20260501T234916Z/worktree`
- Public staging URL: `https://assured-blonde-predict-with.trycloudflare.com`
- Local runtime: `127.0.0.1:63602`
- Auth mode: `local_passphrase_login`
- State: fresh temporary state directories under `/tmp/friday-staging-smoke-20260501T234916Z/`

Secrets were supplied only through environment variables or temporary chmod-600 files outside the repo. Secret scan over the generated report directories found no full OpenAI key or Discord token strings.

## Artifacts

Local evidence artifacts:

- `/tmp/friday-staging-smoke-20260501T234916Z/live-smoke-pass2/staging-live-smoke-summary.json`
- `/tmp/friday-staging-smoke-20260501T234916Z/live-smoke-pass2/discord-live-probe-rerun.json`
- `/tmp/friday-staging-smoke-20260501T234916Z/live-smoke-pass4-discord/staging-live-smoke-summary.json`
- `/tmp/friday-staging-smoke-20260501T234916Z/live-smoke-pass4-discord/discord-outbound-live-smoke.json`
- `/tmp/friday-staging-smoke-20260501T234916Z/live-smoke-pass4-discord/discord-direct-rest-control.json`

First smoke pass was discarded as invalid for authenticated checks because the temporary audit script redacted the access token before reusing it in memory, causing false 401s. The script was corrected so raw tokens remain only in process memory while persisted reports stay redacted. The valid pass is `live-smoke-pass4-discord`.

## Results

| Area | Status | Evidence |
| --- | --- | --- |
| Public staging reachability | VERIFIED | `GET /v1/health` returned 200 through the Cloudflare URL. |
| UI over staging URL | VERIFIED | `GET /` returned 200 through the Cloudflare URL. |
| HSTS/security headers | VERIFIED | `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. |
| CORS allowed origin | VERIFIED | `Origin: https://assured-blonde-predict-with.trycloudflare.com` was reflected exactly. |
| CORS preflight | VERIFIED | `OPTIONS /v1/auth/login` returned 204 with the staging origin and allowed methods/headers. |
| CORS disallowed origin | VERIFIED | `Origin: https://evil.invalid` was not reflected. |
| Cookie surface | VERIFIED | UI and login responses did not set cookies; auth is bearer-token based in this runtime. |
| Passphrase auth | VERIFIED | Bootstrap and `POST /v1/auth/login { localPassphrase }` returned tokens; `GET /v1/auth/me` succeeded with bearer and failed without bearer. |
| Setup API | VERIFIED | `POST /v1/setup/network` and `POST /v1/setup/complete` succeeded through the staging URL. |
| OAuth callback route | VERIFIED_FAIL_CLOSED | Unauthenticated initiate returned 401; authenticated initiate returned 200; dummy callback returned 400 validation error for missing expected `authorizationCode`. No real third-party OAuth callback exchange was performed. |
| Workflow webhook | VERIFIED_CLOSED_LOOP | Created workflow, published it, resynced webhook trigger, invoked public `/v1/workflow-webhooks/:pathToken`, and received 200 with `accepted: true` and a real run id. |
| Unknown workflow webhook | VERIFIED_FAIL_CLOSED | `POST /v1/workflow-webhooks/nonexistent-token` returned 404 `WORKFLOW_WEBHOOK_NOT_FOUND`. |
| Channel webhook disabled surfaces | VERIFIED_FAIL_CLOSED | Lark and WhatsApp webhook routes returned 501 `CAPABILITY_DISABLED` when listeners were not configured. |
| Email link auth | VERIFIED_ABSENT | `POST /v1/auth/email-link` returned 404; route search found no magic-link/email-link auth implementation. |
| Discord bot token identity | VERIFIED | Discord `/users/@me`, `/oauth2/applications/@me`, and `/gateway` returned 200. Bot id redacted in local reports. |
| Discord gateway startup | VERIFIED_PARTIAL | Friday started the Discord channel with `intents: 0`; `/v1/channels` reported `running: true`, `status: connected`, `diagnostics.connected: true`. |
| Discord guild visibility | BLOCKED_EXTERNAL_CONFIG | Discord `/users/@me/guilds` returned 200 with `count: 0`; bot is not currently visible in any shared guild. |
| Discord DM channel creation | VERIFIED_PARTIAL | Discord REST created a DM channel with the application owner, status 200. |
| Discord outbound message send | BLOCKED_EXTERNAL_CONFIG | Direct Discord REST send to the DM channel returned 403 with Discord error code `50278`; Friday outbound also returned 500 and did not persist an outbound message. |

## Command Summary

Commands and outcomes:

- `npm ci`: PASS in clean temporary worktree.
- `npm run build`: PASS in clean temporary worktree.
- `cloudflared tunnel --url http://127.0.0.1:63602 --no-autoupdate`: PASS, produced public staging URL.
- `node dist/cli/friday-cli.js start`: PASS with production env and temporary state.
- Valid staging smoke script: PASS for 13 verified checks, 1 verified absent email-link route, 1 partial Discord runtime result.
- Discord outbound control script: 5 VERIFIED, 2 FAILED due Discord 403 send denial.
- Secret report scan: PASS, no full provider key or Discord token found in generated report directories.

## Findings

### SLS-001: Email Link Auth Is Not Implemented

Severity: P2

Category: Closed-loop wiring / Product scope

Evidence:

- `POST /v1/auth/email-link` returned 404 `NOT_FOUND`.
- Route/code search found email-password auth references but no email-link/magic-link route or provider-backed email send flow.

Impact:

- Any product expectation of passwordless email link login is currently unwired. This is acceptable only if email-link auth is explicitly out of scope.

Recommended fix:

- Either document email link as unsupported, or add a real email provider, signed one-time token table, callback route, expiration/replay controls, and E2E smoke against a sandbox inbox.

### SLS-002: Discord Full Message Closure Is Blocked By External Discord Configuration

Severity: P1 if Discord is launch-critical, otherwise P2

Category: External integration / Closed-loop wiring

Evidence:

- Bot token identity and gateway discovery are valid.
- Friday Discord channel connects when started with `intents: 0`.
- Discord `/users/@me/guilds` returned count `0`.
- Direct Discord REST send to the created DM channel returned 403 with Discord code `50278`.
- Friday `POST /v1/sessions/:sessionKey/outbound` returned 500 for the same DM target.
- Discord's official JSON error table defines `50278` as "Cannot send messages to this user due to having no mutual guilds": https://docs.discord.com/developers/topics/opcodes-and-status-codes

Impact:

- Friday can connect to Discord gateway, but cannot prove a user-visible Discord message loop until the bot shares a guild with the target user/channel or Discord DM permissions permit sending.

Recommended fix:

- Invite the bot to a test guild shared with the test user, then rerun outbound and inbound smoke against a known guild/channel or DM user.
- For production readiness, store a dedicated test guild id, channel id, and setup user id in GitHub Environment secrets for live Discord E2E.

### SLS-003: Discord Upstream Errors Are Masked As Generic 500

Severity: P2

Category: Observability / Integration reliability

Evidence:

- Direct Discord REST control returned 403 code `50278`.
- Friday outbound endpoint returned 500 `INTERNAL_ERROR` without surfacing the upstream Discord status/code in the API response.

Impact:

- Operators cannot distinguish Discord permission/config issues from Friday internal defects using API output alone.

Recommended fix:

- Map Discord REST 401/403/429/5xx into structured Friday integration errors with upstream status and safe upstream code, while keeping tokens and message content out of logs.

### SLS-004: Plaintext Channel Secret Policy Works

Severity: Positive control

Category: Security

Evidence:

- Starting runtime with plaintext Discord token embedded in `FRIDAY_CHANNELS_JSON` was rejected: `Plaintext secret is blocked by policy for channel discord.token; use env:, $ENV_VAR, file:, or secret://...`.
- Restarting with `$DISCORD_BOT_TOKEN` env reference succeeded.

Impact:

- Channel secret handling prevents one common accidental secret exposure path.

## Current Launch Readiness Impact

GREEN:

- External staging URL, CORS allow/deny behavior, bearer auth, setup endpoints, workflow webhook closed loop, disabled channel-webhook fail-closed behavior, Discord gateway connection with safe `intents: 0`.

YELLOW:

- OAuth callback route reachability and fail-closed behavior verified, but no real third-party OAuth exchange was completed.
- Discord DM channel creation verified, but no message send closure.

RED:

- Discord user-visible outbound/inbound closure remains blocked by external Discord guild/DM permissions if Discord is a launch-critical channel.
- Email-link auth is not implemented if it is expected as a product feature.

GRAY:

- Real email delivery, sandbox inbox confirmation, real third-party OAuth callback domain exchange, and Discord interactions/slash-command callback were not verified in this pass.

## Next Verification Tasks

1. Invite the Discord bot to a dedicated staging guild and store test `guildId`, `channelId`, and `setupUserId` in a protected environment.
2. Rerun Friday Discord outbound through `/v1/sessions/:sessionKey/outbound` against that staging channel.
3. Add an inbound Discord gateway smoke that sends a user message in the staging guild and verifies Friday mirrors/persists the inbound message.
4. Decide whether email link is in scope. If yes, implement sandbox email provider and magic-link token flow; if not, remove it from production concern lists.
5. Add safe upstream error mapping for Discord REST failures.
