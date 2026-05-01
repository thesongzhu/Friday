# Phase 1 - Repo Map

## Architecture Overview

Friday is a local-first assistant hub with a TypeScript backend, React/Vite UI, and SQLite persistence. The central composition root still wires many subsystems, but marketplace and passwordless local login are no longer active product mechanisms after PR #171.

```text
Browser UI (ui/src/router.tsx)
  -> UI API client (ui/src/lib/api/client.ts)
  -> HTTP server (src/api/http/friday-http-server.ts)
  -> API runtime and route registry (src/api/runtime/friday-api-runtime.ts)
  -> service/domain modules (agent, workflows, memory, channels, plugins, observability, desktop, satellites)
  -> SQLite repositories and migrations (src/state/sqlite, src/**/persistence)
  -> external providers/channels/desktop integrations when configured
```

## Frontend

- Routes/pages include agent/chat, assistant inbox, automations, fleet, guided flow, home, observability, onboarding/setup, packs, plugins, reflex, settings, skills, skill generator, workflow builder/generator, MCP, usage, sessions, memory, studio, workflows, and channels.
- Marketplace UI routes/links are removed from active `ui/` scope.
- Auth/session: `ui/src/providers/auth-provider.tsx` restores an existing stored token and calls `/v1/auth/me`; it no longer tries `{ local: true }` fallback login.
- Local/session storage still exists for auth user metadata, chat/session UX, custom packs, onboarding/preferences; logout/storage minimization remains an audit concern.

## Backend

- HTTP server: `src/api/http/friday-http-server.ts` with static UI serving, CORS, security headers, and request body limits.
- Route registry: `src/api/http/friday-http-route-registry.ts`; route contract tests pass and operation IDs are unique.
- Route families cover health, auth, providers, workflows, workflow runs, sessions, memory, plugins, channels, webhooks, desktop/system, observability, fleet, setup, skills, satellites, security, MCP, and realtime.
- Marketplace route modules and `/v1/marketplace/*` registration are removed.
- Auth uses local passphrase bootstrap/login, bearer access tokens, refresh tokens, sessions, RBAC, lockout, and revocation. Passwordless local bypass env/config paths are removed.
- Webhooks: channel webhooks and workflow webhooks remain; billing/marketplace webhook work is no longer a product surface after marketplace retirement.

## Database/Data

- SQLite migrations v001-v075 remain contiguous on the tracked tree.
- Retired marketplace standalone migrations are reserved/no-op style history; fresh installs should not create new marketplace schema/runtime access.
- Core active tables cover users, auth sessions/tokens, providers/secrets, sessions/messages, memory/embeddings, workflows/runs/triggers/approvals/evidence, plugins, observability, satellites, desktop/system remote tables, and multi-tenant security tables.

## Infrastructure

- Dockerfile runs non-root and exposes `/v1/health`.
- Docker smoke now uses passphrase bootstrap/login and passed on a unique port.
- CI/release scripts cover typecheck, tests, migration checks, security/adversarial scripts, route contracts, Docker smoke, release package checks, and audit integrity.
- Config remains env-heavy; a safe production/staging `.env` profile is still needed for real deployment.

## Duplicated/Competing Implementations

- npm and pnpm lockfiles coexist.
- Tests still mix true integration, mock hub, browser mock hub, route contract, skipped live tests, and scripts with local env assumptions.
- Channel adapters mix real implementations with stub/sandbox-only implementations; UI/API must keep that capability truth visible.

## Unknowns

- Real external production deployment, callback URLs, TLS/cookie domain behavior, external observability backends, and branch protection were not verified.
- Real channel delivery and live Discord remain unverified without safe sandbox env.
- Real-world LLM smoke remains partial, not release-green.
