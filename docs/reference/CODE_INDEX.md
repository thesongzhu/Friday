> Status: Current reference. For active product truth and operational boundaries, start with [`docs/current-source-of-truth.md`](../current-source-of-truth.md).

# Code Index

Date: 2026-03-04 (America/Los_Angeles)

## Key Entrypoints

1. CLI entry: [`src/cli/friday-cli.ts`](../../src/cli/friday-cli.ts)
   - Parses CLI args and dispatches to hub/runtime operations.
2. Hub composition root: [`src/hub/friday-hub-bootstrap.ts`](../../src/hub/friday-hub-bootstrap.ts)
   - Wires state, API runtime, agent runtime, channels, jobs, browser/desktop capabilities.
3. HTTP server: [`src/api/http/friday-http-server.ts`](../../src/api/http/friday-http-server.ts)
   - Owns request lifecycle, auth/error mapping, route dispatch, SSE/WS handling.
4. Discord channel adapter: [`src/channels/discord/friday-discord-channel.ts`](../../src/channels/discord/friday-discord-channel.ts)
   - Inbound Discord messages -> hub handler; outbound delivery back to Discord.
5. UI app entry: [`ui/src/main.tsx`](../../ui/src/main.tsx)
   - React bootstrap for frontend panel.

## Module Index (src/*)

1. `acceptance`: acceptance-test engine and API contracts.
2. `agent`: LLM orchestration runtime, tool registry, run lifecycle, subagents.
3. `api`: auth/realtime/http route runtime and external API contracts.
4. `browser`: browser manager/session targeting/artifact handling.
5. `channels`: multi-channel adapters and channel registry (Discord/Slack/etc.).
6. `cli`: command-line command parsing and runtime loop.
7. `config`: config IO, backup, migration/rotation helpers.
8. `converter`: source-to-skill conversion pipeline and diagnostics.
9. `daemon`: daemonized runtime process management.
10. `desktop`: desktop automation adapters, permissions, recording/session manager.
11. `errors`: shared domain error model and code taxonomy.
12. `heartbeat`: periodic health/maintenance execution runner.
13. `hub`: top-level runtime composition and service wiring.
14. `jobs`: scheduler and background jobs (sessions/workflows/learning/satellites).
15. `learning`: self-learning runtime, auto-fix, preference extraction services.
16. `ledger`: persistent run/event storage.
17. `lib`: shared low-level constants and utility primitives.
18. `link-understanding`: URL/content understanding pipeline.
19. `marketplace`: marketplace model/engine/persistence/routes.
20. `media`: media utilities and handling.
21. `media-understanding`: image/media understanding primitives.
22. `memory`: memory services, sync, repositories.
23. `node-runner`: execution for pipeline/workflow nodes.
24. `nodes`: node definitions and execution contracts.
25. `observability`: event/audit/trace model and engine.
26. `packaging`: package build/sign/publish APIs.
27. `playbook`: playbook model/runtime/persistence.
28. `plugins`: plugin lifecycle, registry, signature/marketplace integration.
29. `providers`: model provider auth/catalog/routing/fallback.
30. `retry`: retry engine/classifier/orchestrator APIs.
31. `routing`: reply routing and destination policy.
32. `rules`: rule engine and policy evaluation.
33. `satellites`: distributed node sync/pairing/services.
34. `security`: tenant isolation, safe paths, audit log, authz boundaries.
35. `sessions`: session lifecycle and extraction services.
36. `skills`: skill registry/generator/import/marketplace sync.
37. `state`: SQLite state runtime and migrations.
38. `tui`: terminal UI flows.
39. `uix`: guided UX workflow/runtime models and APIs.
40. `utilities`: shared filesystem/network/string helpers.
41. `workflows`: workflow compile/runtime/execution services.
42. `xhs`: XHS-specific browser interaction/session tooling.

## Non-src Code Areas

1. `test/`: unit/integration/e2e suites and helpers.
2. `scripts/`: CI/ops/quality gates and local automation scripts.
3. `ui/`: web frontend code and styles.
4. `docs/`: architecture, operations, runbooks, test plans, review packages.
5. `.github/workflows/`: CI pipelines and release gates.

## Module Relationship (High-Level)

1. Ingress:
   - CLI (`src/cli`) or channel adapters (`src/channels`) or HTTP (`src/api/http`).
2. Composition:
   - Hub (`src/hub`) resolves capabilities and wires services.
3. Execution:
   - Agent runtime (`src/agent`) + workflows (`src/workflows`) + tools (`src/agent/tools` + domain modules).
4. Persistence/State:
   - State/session/memory/ledger (`src/state`, `src/sessions`, `src/memory`, `src/ledger`).
5. Egress:
   - API responses (`src/api/http`), channel outbound messages (`src/channels`), artifacts (`reports/` or configured paths).
