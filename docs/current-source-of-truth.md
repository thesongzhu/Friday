# Friday Current Source Of Truth

This document is the current architecture reference for steady-state Friday runtime behavior.

## Route contract

- HTTP paths remain stable unless an explicit contract migration says otherwise.
- Runtime route `operationId` values must be canonical lowercase dot-segment names.
- Canonical route naming authority lives in `src/api/http/friday-http-route-contract.ts`.
- Historical rename mapping from legacy `operationId` values to canonical names lives in `FRIDAY_ROUTE_OPERATION_ID_RENAMES`.
- Route registration enforces the canonical naming rule in `src/api/http/friday-http-route-registry.ts`.
- Public migration guidance for tooling and SDK consumers lives in `docs/route-contract-migration.md`.

## Canonical and compatibility route families

- Canonical route families are the active product contract. Compatibility aliases exist only to preserve SSD-era or older client integrations while the public contract converges.
- Canonical families in steady-state Friday are:
  - `/v1/realtime/*`
  - `/v1/workflow-approvals*`
  - `/v1/diagnosis/*`
  - `/v1/auto-fix/*`
  - `/v1/sessions/:sessionKey*`
  - `/v1/fleet/*`
  - `/v1/satellites/*`
  - `/v1/agent-loop/*`
  - `/v1/skills/*`
  - `/v1/marketplace/sources*`
  - `/v1/marketplace/assets*`
  - `/v1/plugins*`
  - `/v1/marketplace/plugins*`
- Compatibility-only surfaces are:
  - `/v1/ws` as a thin alias over `/v1/realtime/ws`
  - `/v1/approvals*` as a compatibility alias for `/v1/workflow-approvals*`
- Compatibility surfaces must stay documented, tested, and explicitly marked as compatibility-only. They must not regrow into a second canonical contract.
- Historical SSD-only names such as `/v1/ai/diagnose` are not active public APIs and must not be revived as parallel product surfaces.

## Converter topology

- First-party canonical converter surface is `#skills/converter`.
- `src/skills/converter/` is the only evolvable converter implementation surface.
- Deprecated compat modules under `src/converter/` are fully retired and must not regrow.
- First-party code and tests must not import `src/converter/*` or `#converter`.

## Runtime authority

- `createFridayApiRuntime(...)` no longer exposes migration-era `legacy` helpers on the steady-state runtime object.
- `#state` exports SQLite/config/runtime surfaces, but not mirror compatibility helpers.
- Migration-era legacy decommission and mirror compatibility helpers are retired from the active codebase.
- Production workflow execution authority is the deterministic pipeline path.
- `FRIDAY_PIPELINE_ENABLE=false` disables the deterministic pipeline entirely.
- `FRIDAY_USE_NODE_RUNNER` is not a steady-state production control path anymore.
- `useNodeRunner=false` remains only as an explicit compatibility/test configuration at the facade boundary.
- The self-learning runtime is actively wired through hub bootstrap and the public API runtime for supervised self-healing flows.
- The supervised agent loop is a steady-state runtime surface: cooldown retries, repeated-failure halt conditions, rollback/verification evidence, and operator-visible loop state are all part of the canonical product path.

## Self-healing and beginner product surfaces

- Public route families `/v1/diagnosis/*`, `/v1/auto-fix/*`, and `/v1/uix/*` are part of the active steady-state product surface.
- Self-healing is supervised by default: higher-risk fixes require explicit approval, and rollback/evidence are part of the public contract.
- Failures must surface as incidents, diagnoses, actions, or evidence; do not hide self-healing failures behind silent fallback.
- `/assistant` is the beginner-first web surface for plain-language intent resolution, guided wizards, issue inbox, fix approvals, and direct skill generation.
- Expert autonomy is an opt-in layer above the supervised defaults. It may infer bounded context, run safe probes, and continue through cross-surface reasoning, but destructive or production-sensitive actions still require final approval.
- Skill generator sessions now support explicit draft self-test and evidence retrieval before approval/save.
- Diagnosis and auto-fix lifecycle updates are part of the realtime event surface and must stay consumable by both Operator Console and `/assistant`.

## Skills lifecycle and marketplace sources

- `/v1/skills/*` is the canonical skill lifecycle surface for catalog, detail, install, update, delete, manifest validation, and verification.
- `/v1/marketplace/sources*` is the canonical source-management surface for skill marketplace feeds, enablement state, and trust-scored catalog refresh.
- `/v1/marketplace/assets*` is the canonical public catalog and detail read surface for marketplace `skill`, `workflow`, and `agent` assets. It unifies discovery and detail views while keeping the skills lifecycle as the install/verify/enable backbone.
- `/v1/marketplace/creators*` and `/v1/marketplace/assets/:assetId/support` are the canonical creator-support surfaces for asset-backed support events, creator profiles, and reputation summaries.
- `/skills` is the operator-facing lifecycle surface for installed skills, updates, verification evidence, source policy, and generated-skill handoff from `/assistant`.
- The **skills lifecycle is the primary marketplace backbone**. It remains the canonical trust, verification, install, enable, update, delete, and source-management path for marketplace-delivered capabilities.
- Public marketplace support for `workflow` and `agent` assets extends this same backbone instead of replacing it with a separate store or commerce-first contract.
- Public marketplace assets are **declarative-first**. Publicly listed `skill`, `workflow`, and `agent` assets must use framework-owned execution plus explicit permission manifests; arbitrary executable package runtimes are not part of the primary public marketplace contract.
- Creator support is the primary reward path for public marketplace assets. Friday records support/tip events and creator reputation signals, but the platform itself takes `0%` commission and does not present the ecosystem as a guarantee-backed service marketplace.
- `/v1/marketplace/requests*` is the canonical connector-only request board for personal `skill`, `workflow`, and `agent` requests. It supports posting requests, collecting responses, and accepting or closing a request without implying escrow, fulfillment guarantees, arbitration, or after-sales support.
- Public marketplace installs must show explicit permission previews before enablement and require signature/hash verification.
- Public marketplace monetization is **support-first**. Declarative public assets remain free-first, users may support creators directly, the platform takes `0%` commission on creator support, and creator reputation must be multi-signal rather than star-only.
- Marketplace closeout evidence for this creator-support direction is archived in [../docs/reports/closeout/marketplace-creator-ecosystem/latest.md](./reports/closeout/marketplace-creator-ecosystem/latest.md).
- Skill generation is not a terminal leaf product. Generated skills must be able to flow directly into verification, install or enable recommendation, diagnosis, and recovery.
- Skill verification evidence must remain structured around manifest verdict, package integrity, dependency checks, runtime dry-run, and trust summary.

## Plugin distribution and marketplace commerce

- `/v1/plugins*` and `/v1/marketplace/plugins*` are active plugin distribution surfaces for installed-plugin lifecycle, marketplace browsing, version inspection, and install flows.
- Plugin distribution is real and test-backed, but it is **not** the same product surface as the canonical skills lifecycle. Docs must not blur `skills lifecycle` and `plugin marketplace/commerce` into one story.
- Public marketplace evolution remains **skills-first**. Plugin distribution and commerce do not replace the canonical skills lifecycle backbone and must stay documented as a distinct, bounded surface.
- Legacy executable skills/plugins/packages may still exist for local, operator, or migration scenarios, but they are not the primary public marketplace story and must not appear as ordinary public marketplace assets by default.
- Marketplace commerce and publisher flows are bounded operator/admin surfaces that may depend on runtime configuration. They are not the primary beginner-first product path, must not be described as universally available consumer commerce unless that configuration is present, and must not override the support-first public marketplace story.
- User-facing truth must distinguish:
  - skills lifecycle as a validated closed-loop product surface
  - future workflow and agent marketplace assets as additive extensions of that lifecycle backbone
  - creator support, creator reputation, and request-style matching as ecosystem layers above the skills/workflow/agent asset backbone
  - plugin distribution as an active bounded surface
  - marketplace commerce and publisher operations as configured, operator/admin-oriented capabilities

## Workflow product surfaces

- Public workflow product routes `POST /v1/workflows/:workflowId/drafts/:draftId/deploy`, `GET /v1/workflows/:workflowId/overview`, and `GET /v1/workflows/:workflowId/visualization` are part of the active steady-state product surface.
- One-click deploy must remain an orchestration surface on top of the existing workflow builder, publisher, runner, and evidence exporters; clients must not need to manually chain compile, publish, run, export, and observability correlation.
- `/assistant` may show simplified workflow deploy cards and recovery actions, but it must not expose builder jargon or raw DAG internals.
- `/workflows` is the operator-facing workflow control plane for graph visualization, draft and published state, deploy status, run timeline, and evidence export.
- Workflow deploy, publish, export, and generated-workflow failures must emit trace correlation, audit records, metrics, and diagnosis-visible evidence instead of failing only inside workflow-local tables.

## Fleet and distributed execution

- `/v1/fleet/*` is the operator-facing read surface for satellite trust, health, queue, workflow load, and capability detail.
- `/v1/satellites/*` is the active control-plane/runtime surface for registration, pairing, heartbeat, capabilities, sync, command polling, command acknowledgement, and satellite event polling.
- Workflow nodes may target `hub`, `satellite:<id>`, or `capability-match`; hub-side workflow execution is responsible for placement and must not silently fall back to hub when a selected satellite is unavailable.
- Satellite-offline execution failures must surface as explicit blocked or retryable state, pause the run instead of pretending to complete locally, and require an operator resume path to continue once the target recovers.
- `/fleet` is the operator-facing web surface for pairing, trust, capabilities, queue backlog, offline blocking, and distributed placement outcome.
- Satellite degradation and offline transitions must create visible self-healing incidents and agent-loop evidence; fleet recovery cannot depend on silent background retries.

## Observability and operator truth

- `/v1/observability/*` is part of the active steady-state product surface, not a dormant or optional architecture stub.
- The hub bootstrap is responsible for wiring trace manager, audit trail, metrics collector, health checks, dashboard data provider, alert engine, and the alert evaluation scheduler into the API runtime.
- `/v1/observability/overview` and `/v1/observability/time-series` are the operator-facing aggregation endpoints for dashboard consumption.
- Default SLO definitions and alert destinations are part of the steady-state observability runtime; operators must be able to inspect SLO status, alert routing, and dispatch health without custom bootstrap code.
- Self-healing, explicit skill draft testing, and `/assistant` interactions must emit observable traces, audit entries, metrics, and alertable failure state instead of living only in isolated domain tables.
- Expert-mode runs must carry structured assumptions, unknowns, hypotheses, probe steps, repair evidence, acceptance outcomes, and rollback outcomes; they are operator-visible evidence, not hidden background behavior.
- `/observability` is the operator-first web surface for trace, audit, alert, health, and time-series summaries.
- Slack webhook delivery and SMTP email delivery are the release-complete alert dispatch paths for the current observability surface.

## Quality gates, retry, and rules

- Acceptance custom checks execute in a sandboxed runtime; in-process execution is no longer the steady-state path for arbitrary custom assertions.
- Acceptance test definitions maintain version history and artifact history, and those records are part of the operator-facing quality surface.
- Provider-level retry circuit breakers, retry replay evidence, cost summaries, and escalation acknowledgement are active product surfaces, not deferred architecture notes.
- Rules simulation, rule version history, and audit-log visibility are part of the active steady-state operator surface and must stay explainable through `/observability` and the deterministic pipeline APIs.
- Beginner surfaces may only summarize quality gates, retry exhaustion, or policy denial; detailed retry/rules internals remain operator-facing concerns.

## Expectation boundary

- Friday's steady-state non-platform product is a **supervised, bounded automation system**.
- Friday's steady-state non-platform product may operate in **expert mode**, but only as opt-in bounded autonomy under the same audit, rollback, verification, and approval expectations.
- "Self-solving" currently means: detect incidents, diagnose likely causes, propose fixes, auto-execute low-risk fixes, verify outcomes, roll back when verification fails, and pause after repeated failures.
- In expert mode, "self-solving" also includes bounded context inference, minimal decisive questioning, safe probes, and cross-surface orchestration when those steps stay inside policy.
- "Self-solving" does **not** currently mean: unrestricted long-horizon autonomous troubleshooting, arbitrary cross-system recovery without policy gates, or full human-level adaptive judgment in ambiguous environments.
- OpenClaw comparison must stay scope-accurate: Friday matches OpenClaw on the explicitly tracked overlap surfaces in the bridge matrix, but that does not imply full behavioral identity outside that overlap scope.
- Fleet/distributed execution is intentionally bounded to a single-hub trust domain with static peers, registered satellites, and the trust-scored fleet directory as the active discovery baseline.
- Offline execution is intentionally limited to continuation and recovery of already-dispatched work; richer offline plan generation or offline trigger creation remains deferred.
- Full multi-hub federation, cross-hub placement, mDNS/relay/Tailscale-native discovery, and richer mesh coordination remain deferred.
- ML-heavy anomaly detection, natural-language rule authoring, and marketplace-style expansion for acceptance or rules remain deferred.

## Runtime admin and security surfaces

- `GET /v1/version` is the canonical lightweight version surface; `/v1/health` remains the public liveness probe.
- `/v1/sessions/:sessionKey` is the canonical session route shape; `sessionId` remains a scoped identifier for generators, workflows, and system runtimes, not the top-level session path key.
- `/v1/config*` is the active runtime configuration surface for read, patch, revision listing, and revision revert flows.
- `GET /v1/audit/logs` is the steady-state admin/security list surface for audit log search, while `/v1/observability/audit*` remains the richer operator-facing audit query surface.
- `/v1/secrets*` is the active CRUD surface for encrypted secret metadata and rotation backed by the existing provider secret repository.
- `GET /v1/workflow-versions/:versionId` is the canonical direct fetch route for workflow versions alongside `/v1/workflows/:workflowId/versions`.
- `/v1/realtime/*` is the canonical realtime transport surface. WebSocket clients may connect through `/v1/realtime/ws`, and `/v1/ws` remains a thin compatibility alias for the same gateway.
- `/v1/workflow-approvals*` is the canonical workflow approval surface; `/v1/approvals*` remains a compatibility alias for legacy or SSD-shaped clients.

## Canonical semantics

- `/v1/health` is a public liveness and uptime surface, not the deep operator health contract. Deeper health remains on system and observability surfaces.
- Public validation failures use the current runtime semantics: `400 VALIDATION_ERROR` is the default contract unless a route explicitly documents a different status.
- Public auth failures use the current runtime taxonomy: `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, and related canonical codes from `src/api/model/friday-api-error-codes.ts`.
- Scope taxonomy is defined by the current auth model, including `security.read` / `security.write`, `fleet.read`, `diagnosis.read` / `diagnosis.write`, and the workflow, skill, plugin, and session scopes present in `src/api/model/friday-api-auth.types.ts`.
- Provider kind and routing semantics are defined by the current provider model and cost-routing types. `openai-compatible` and `google` are canonical provider kinds; historical SSD wording around `"custom"` providers is not the active contract.

## Compatibility retirement policy

- Keep compat shims only when there is a named migration need or a guarded test proving the shim contract.
- Do not export migration-era helpers from steady-state public barrels.
- Do not delete compat implementations until internal consumers are removed or redirected.
- Prefer shrinking compat surfaces to thin shims before deletion.

## Validation gates

Every contract-affecting cleanup batch must pass:

- `npm run lint`
- `npm run typecheck`
- `npm run test:contracts`
- `npm run test:adversarial`
- `npm test`
- `npm run closeout:phase1`
- `npm run closeout:phase2`
- `npm run closeout:phase3`
- `npm run closeout:phase4`
- `npm run closeout:phase5`
- `npm run closeout:marketplace`
- `npm run check:ui-bundle-health`
- `npm run check:closeout:evidence:freshness`
- `npm run release:verify`
- `npm run closeout:final`

## Historical materials

- Historical audits, plans, reviews, reports, and one-off tasklists are catalogued in `docs/archive/README.md`.
- When a historical document conflicts with current behavior, this document wins.
