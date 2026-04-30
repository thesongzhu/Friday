# Phase 1 - Repo Map

## Architecture Overview

Friday is a local-first assistant hub with a large TypeScript backend, a React/Vite web UI, and SQLite persistence. A single hub bootstrap composes state, auth, providers, agent runtime, workflows, channels, skills, marketplace, observability, desktop/system companion, satellites, and optional multi-tenant security.

Text diagram:

```text
Browser UI (ui/src/router.tsx)
  -> UI API client (ui/src/lib/api/client.ts)
  -> HTTP server (src/api/http/friday-http-server.ts)
  -> API runtime and route registry (src/api/runtime/friday-api-runtime.ts)
  -> service/domain modules (agent, workflows, marketplace, memory, channels, plugins)
  -> SQLite repositories and migrations (src/state/sqlite, src/**/persistence)
  -> external providers/channels/desktop/marketplace integrations when configured
```

## Frontend

- Routes/pages: agent, assistant inbox, automations, fleet, guided flow, home, observability, onboarding, packs, plugins, cross-border setup, reflex, settings, setup, skills, skill generator, workflow builder, workflow generator, MCP, marketplace, usage, sessions, chat, memory, studio, workflows, channels.
- Navigation/layout: centralized router in `ui/src/router.tsx`.
- State/API: shared API client in `ui/src/lib/api/client.ts`; React Query-style query modules; several local stores.
- Auth/session: `ui/src/providers/auth-provider.tsx` attempts `/v1/auth/me`, then local bypass `/v1/auth/login` with `{ local: true }` on failure.
- Local storage/session storage: auth user metadata, chat history, custom packs, onboarding/preferences.

## Backend

- HTTP server: `src/api/http/friday-http-server.ts` with static UI serving, CORS, security headers, 1 MB body limit.
- Route registry: `src/api/http/friday-http-route-registry.ts`; duplicate operation IDs rejected.
- Route families: 368 routes in route contract snapshot covering health, auth, workflows, agent, sessions, memory, marketplace, plugins, channels, webhooks, desktop, observability, fleet, setup, skills, system, satellites, etc.
- Auth: `src/api/auth/friday-auth-service.ts`, middleware, RBAC policy, session/token persistence.
- Services/domain: many independent engines plus a very large composition root in `src/hub/friday-hub-bootstrap.ts`.
- Jobs: scheduler/retention/session extraction/learning/heartbeat/workflow trigger jobs under `src/jobs`, `src/learning`, `src/workflows`.
- Webhooks: channel webhooks are public but rate-limited; workflow webhooks are public and token/secret based; billing webhook handler exists but is not wired to an HTTP route.

## Database/Data

- SQLite state runtime with migrations v001-v075.
- Core tables include users, auth sessions, tokens, providers/secrets, sessions/messages, memory/embeddings, workflows/runs/triggers/approvals/evidence, plugins, marketplace listings/purchases/subscriptions/entitlements/billing events, observability, satellites, desktop/system remote tables, and multi-tenant security tables.
- Migration check passed for contiguous ordering and registration.

## Infrastructure

- Dockerfile runs as non-root, exposes `/v1/health`, serves on `FRIDAY_HOST=0.0.0.0`, `FRIDAY_PORT=3141`.
- Docker compose provides state/skills volumes and optional Ollama.
- CI covers typecheck, lint, build, tests, migration check, security/adversarial scripts, route contracts, and release checks.
- Runtime config is env-heavy; `.env.example` documents many flags but keeps `FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN=true` as the local-auth example.

## Duplicated/Competing Implementations

- npm and pnpm lockfiles coexist.
- Auth has passphrase login, bearer/session tokens, bootstrap flow, and local bypass/passwordless modes.
- Channel implementations mix real adapters with explicit stub services.
- Tests mix real integration tests, mock hub/browser mock hub tests, skipped live tests, and route tests with type-only stubs.
- Billing has domain/webhook handlers but no registered webhook endpoint in the runtime route registry.

## Unknowns

- Real production LLM provider call path was not verified because live LLM e2e tests were skipped.
- Real channel delivery was not verified because live channel tests were skipped and several channel services are stubbed.
- Native macOS companion release/runtime is failing locally.
- Deployment branch protection and external CI enforcement were not verified from GitHub.
