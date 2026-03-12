> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday SSD vs Code Gap Report

This report now tracks only the **remaining canonical truth gaps** that still
matter for the current non-platform product surface. Historical contract
drift that has already been settled in favor of the runtime is retained only as
compatibility or archive guidance.

## Canonical contract decisions already settled

The following product-level API questions are no longer open design debates:

- `/v1/realtime/*` is the canonical realtime transport surface.
- `/v1/realtime/ws` is the canonical websocket bridge.
- `/v1/ws` is a compatibility alias, not the primary transport contract.
- `/v1/workflow-approvals*` is canonical; `/v1/approvals*` is compatibility-only.
- `/v1/diagnosis/*` and `/v1/auto-fix/*` are the canonical self-healing route families.
- `/v1/sessions/:sessionKey` is the canonical session route shape.
- `/v1/health` is the public liveness surface; deeper health belongs to system and observability surfaces.
- `/v1/plugins*` and `/v1/marketplace/plugins*` are active plugin distribution surfaces.
- Runtime validation defaults to `400 VALIDATION_ERROR` unless a route explicitly documents another status.
- Current auth scopes and provider kinds are defined by the runtime auth/provider models, not older SSD examples.

Active truth for those decisions lives in:

- `docs/current-source-of-truth.md`
- `README.md`
- route contract snapshots and HTTP/WebSocket tests

## Remaining deferred or partial gaps

These are the real non-platform gaps that still remain after canonical truth
cleanup.

1. **Discovery protocols remain deferred.**
   - mDNS, relay mesh, and Tailscale-native discovery are not part of the active runtime.
   - Current fleet discovery baseline is static peers, registered satellites, and the trust-scored fleet directory.
   - Evidence: `src/satellites`, `src/hub`, `docs/current-source-of-truth.md`.

2. **Satellite-side local execution is still partial.**
   - Registration, pairing, capability reporting, heartbeat, sync, outbox, and hub-side placement are active.
   - A richer first-class satellite-local task runner, capability adapter, and telemetry runtime remains deferred.
   - Evidence: `src/satellites/runtime/friday-satellite-runtime.ts`, `src/workflows/services/friday-workflow-satellite-dispatch-service.ts`.

3. **Offline autonomy is intentionally limited.**
   - Already-dispatched work can recover and resume through the current distributed execution flow.
   - Fully local offline plan generation or offline trigger creation is still deferred.
   - Evidence: `src/workflows/services/friday-workflow-execution-service.ts`, `src/api/http/routes/friday-satellite-runtime-routes.ts`.

4. **Transport-envelope ambitions remain beyond the current runtime.**
   - The handshake negotiates algorithms and runtime payload protection exists.
   - The older SSD per-frame envelope and key-rotation wording is still broader than the active transport implementation.
   - Evidence: `src/satellites/services/friday-satellite-pairing-service.ts`, `src/satellites/services/friday-satellite-sync-service.ts`.

5. **Full multi-hub federation remains deferred.**
   - The current fleet control plane is hub-centered.
   - Federation, richer mesh discovery, and cross-hub placement are still future work.

6. **Plugin marketplace/commerce maturity is bounded.**
   - Skills lifecycle is a validated closed-loop product surface.
   - Plugin distribution routes are active and test-backed.
   - Marketplace commerce and publisher flows exist but remain bounded operator/admin capabilities and must not be overstated as universal beginner-facing product surfaces.

7. **ML-heavy quality and rules expansion remains deferred.**
   - The active product surface includes sandboxed acceptance checks, provider-level retry circuit breakers, retry replay evidence, and rules simulation/explanation.
   - ML-heavy anomaly detection, natural-language rule authoring, and marketplace-style expansion for acceptance or rules are not part of the current closure boundary.

## Historical divergences retained for compatibility or archaeology

The following older SSD or plan-era contract shapes should be treated as
historical unless a compatibility shim explicitly preserves them:

- `/v1/ws` as the primary realtime transport
- `/v1/approvals*` as the primary approvals surface
- `/v1/ai/diagnose` / `/v1/ai/lessons` as the primary diagnosis surface
- `sessionId` as the primary path token for `/v1/sessions`
- `AUTH_UNAUTHORIZED` / `CONFIG_VALIDATION_FAILED` as the universal public error contract
- provider-kind language that treats `"custom"` as the primary modern extension point

Those historical shapes may still appear in archived plans, reviews, or SSD-era
documents, but they are not the active product contract.

## Rule for future closeout work

When historical SSD text conflicts with runtime behavior:

1. `docs/current-source-of-truth.md` wins.
2. `README.md` and route contract tests must be aligned to that same truth.
3. Historical docs stay archived in place rather than reintroduced as primary architecture references.

## Expectation-setting rule

When user-facing docs describe Friday's current capability:

- supervised self-healing and bounded autonomous loop behavior may be described as active
- unrestricted autonomy, richer offline plan generation, richer discovery/mesh/federation, and broader plugin-commerce maturity must stay clearly deferred or bounded
- OpenClaw parity must always be phrased as parity for the tracked overlap surfaces, not full behavioral identity
