# Friday Current Source Of Truth

This document is the current architecture reference for steady-state Friday runtime behavior.

## Human-facing product boundary

- Friday's public positioning is a local-first personal AI and automation runtime, not an unbounded autonomous system.
- User-facing docs and UI copy must avoid promising universal automation or fully automatic behavior across arbitrary external systems.
- The core product loop is: user goal -> capability check -> gap closure -> execution -> verification -> learning.
- Friday may acquire or generate missing capabilities only through policy-governed discovery, sandbox/test, approval where required, registration, and doctor verification.
- API keys, OAuth, payment, CAPTCHA, account creation, sensitive OS permissions, and production-impacting actions are human blockers.
- Self-improvement means auditable updates to memory, routing preferences, setup recipes, skills/workflows, evals, and failure lessons. It does not mean hidden model-weight training by default.

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
  - `/v1/plugins*`
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

## Release truth and runtime snapshots

- `README.md`, settings copy, onboarding copy, and release summaries must be treated as **runtime snapshot surfaces**, not unconditional product promises.
- Ship decisions may rely only on evidence classified as `real-provider`, `real-browser`, `real-runtime`, `cloud-live`, or `manual-external` in [`docs/release-evidence-policy.md`](./release-evidence-policy.md).
- `mock-contract`, `mock-hub`, and `browser-mock-hub` evidence remain valid for fast regression detection, but they are not release proof and must not be presented as ship-readiness proof.
- `npm run release:verify:repo` is the repo-ready verification path. It is not sufficient by itself to claim real-world release proof.
- `npm run release:verify` is reserved for the real proof pack (`ops:real-green-gate` + no-mock leak scan + truth audit).
- The public v1 local track is limited to local UI + operator + non-technical independent-use readiness. Its release-facing claims must not exceed current proof: the Phase 18A live UI/LLM acknowledgement + SSE tail remains `blocked_by_env` until a safe provider environment is available. The track does not include channel/cloud live proof, external OTEL/Grafana proof, or release-complete-all. Those surfaces must stay explicit future/no-claim items unless a later phase provisions the required external environment and validates same-SHA RGG truth.
- `/v1/packages*` and `/v1/security/tenants*` are code-present but env-gated and default-off. They are only active on runtimes started with `FRIDAY_PACKAGING_ENABLED=true` or `FRIDAY_MULTI_TENANT_ENABLED=true`. Phase 11 (PR #233, merged `a5239ac7`) wired SQLite-backed persistence behind both gates: `src/packaging/persistence/friday-package-sqlite-store.ts` persists package registry, install lifecycle, rollback history, lifecycle audit, and trusted-key state, and the bootstrap publish handler now invokes real `verifySignatureLogical` against the trusted-key store rather than stub manifest data; `src/security/multi-tenant/persistence/friday-multi-tenant-sqlite-store.ts` persists tenant, secret, audit, and tenant-scoped resource registry rows. The current source tree adds a deterministic release-proof harness at `test/integration/release-proof/friday-package-multitenant-release-proof.test.ts` for the previously forwarded Phase 14 debt: package publish/install/upgrade/rollback/uninstall after restart, signature digest verification that excludes the detached signature object, lifecycle evidence readback, and tenant-scoped resource cross-tenant denial without existence leak. This is source proof for the env-gated surfaces only; `FRIDAY_PACKAGING_ENABLED=true` and `FRIDAY_MULTI_TENANT_ENABLED=true` default-on flips, npm package truth, and any production multi-tenant rollout remain explicit stop points.
- Media-understanding primitives exist in the repo, and Phase 02a (PR #222, merged `4ac409d6`) wired a real OpenAI vision provider through `src/media-understanding/providers/friday-openai-vision-provider.ts` and registered it via hub bootstrap with same-SHA RGG release proof. The surface remains runtime-gated: `FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true` plus a resolvable `env:OPENAI_API_KEY` secret ref are required; otherwise `/v1/media-understanding/*` returns `503 MEDIA_UNDERSTANDING_DISABLED`. The runtime enablement and credential-resolution boundary remains; `FRIDAY_MEDIA_UNDERSTANDING_ENABLED=true` alone does not bypass the credential gate.
- Missing external provider credentials, OAuth, billing, CAPTCHA, or account permissions must be presented as human blockers, not skipped success.
- When those gates are off, docs, UI copy, and release notes must describe them as unavailable on the current runtime rather than "implemented" or "ready by default".

## Self-healing and beginner product surfaces

- Public route families `/v1/diagnosis/*`, `/v1/auto-fix/*`, and `/v1/uix/*` are part of the active steady-state product surface.
- Self-healing is supervised by default: higher-risk fixes require explicit approval, and rollback/evidence are part of the public contract.
- Auto-fix execution is supervised and gated. The dispatcher is default-off unless `FRIDAY_AUTOFIX_DISPATCHER_ENABLED=true`; one-click/manual repair paths may still execute approved actions. `disable_skill`, `retry_node`, `switch_model_fallback`, `trim_payload`, `pause_workflow`, and `apply_config_patch` execute through hub-wired executors/verifiers when the required runtime dependencies exist and must produce side effects plus verification evidence. `grant_permission` remains an approval-gated deterministic directive-level executor/verifier rather than a hub-wired operational side effect.
- Failures must surface as incidents, diagnoses, actions, or evidence; do not hide self-healing failures behind silent fallback.
- `/assistant` is the beginner-first web surface for plain-language intent resolution, guided wizards, issue inbox, fix approvals, and direct skill generation.
- Expert autonomy is an opt-in layer above the supervised defaults. It may infer bounded context, run safe probes, and continue through cross-surface reasoning, but destructive or production-sensitive actions still require final approval.
- Skill generator sessions now support explicit draft self-test and evidence retrieval before approval/save.
- Diagnosis and auto-fix lifecycle updates are part of the realtime event surface and must stay consumable by both Operator Console and `/assistant`.
- The expected utility calculator (`src/learning/services/friday-expected-utility-calculator.ts`) is a steady-state component of the auto-fix decision pipeline. It computes `EU = benefit * P(success) - cost * P(failure) - riskPenalty` and returns `auto_apply`, `suggest`, or `defer` recommendations. The `FridayUtilityStrategy` interface is pluggable and may be replaced with trained ML models without changing callers.
- Setup status diagnostics (`ui/src/lib/setup/setup-status-diagnostics.ts`) provide user-friendly error messages and remediation hints for setup/auth failures in the UI, covering AuthExpired, 401, 403, 404, INVALID_RESPONSE, and NETWORK_ERROR states.
- The task-first web IA remains `/home`, `/chat`, `/packs`, and `/assistant`. `/assistant` is the approval, recovery, and guided handoff surface, not the primary place to start a brand-new task.

## Provider templates and routing health

- `/v1/providers/templates*` is the canonical setup-time provider bootstrap surface. Setup and settings should prefer template-driven provider creation over blank provider forms.
- `/v1/providers/health` is the canonical operator-facing provider lane and health snapshot surface. It exposes lane (`primary`, `fallback`, `standby`, `disabled`), doctor summary, validation status, and fallback circuit state.
- CLI / external-session providers are valid runtime lanes for read-only text tasks, but they are not proof of native-tool capability. If the active fallback lane is CLI-only, tool-required proof scenarios must stay explicitly bounded instead of being counted as a full provider pass.
- Provider template truth is tiered as `official`, `verified`, `community`, or `experimental`; setup UI may highlight official and verified templates first but must not hide the rest of the catalog.
- Provider templates may recommend default and fallback models plus required secret-reference shapes, but they must not silently override the operator's final provider configuration choice.
- Provider display names must describe the actual configured provider kind and route. Setup and provider truth UI must not preserve stale provider names when the detected kind/base URL/model changes.
- Canonical secret-ref inputs for provider credentials are `env:NAME`, legacy `$NAME`, `file:/absolute/path`, `secret://...`, and operator-gated `command:...`. Raw inline secrets remain compatibility input only and should be converted into managed secret refs when persisted.
- Friday's provider reliability plane is Friday-owned. It may normalize supported provider request/response contracts, expose provider health, and drive fallback/circuit state, but it is not a general-purpose reverse proxy for unrelated external AI CLIs or consumer OAuth products.

## Capability acquisition and standing goals

- Capability acquisition is a steady-state product loop: `candidate -> plan -> sandbox/test -> approval if required -> install/register -> doctor verify -> available`.
- Capability acquisition status or registration fields are not blanket installed/live-provider claims. Clients must inspect the additive `availabilityBoundary` / proof-tier fields on verification results, registered capabilities, and execution suggestions. `local_candidate_registered` means a generated/local candidate passed sandbox or dry-run proof but remains blocked from task execution until installation or lifecycle promotion proof exists; its verification result must use blocked lifecycle semantics rather than a runnable `passed` claim.
- Unverified generated, downloaded, imported, or discovered capability must not be routed as available.
- Source ranking should prefer installed/trusted local capability before open internet discovery.
- Open internet discovery is allowed only inside autonomy policy, budget, sandbox, and approval constraints.
- Standing goals require user authorization with scope, triggers, budget, risk policy, success criteria, and pause/delete controls.
- Agenda runs must record plan, capability check, execution evidence, verification result, cost where available, failure/rollback notes, and learning updates.
- Friday must not create unrelated long-term goals for itself.

## Channel secret and supervisor truth

- `/v1/channels*` is the canonical operator-facing read surface for channel supervisor state, credential posture, allowlist summary, and capability contract truth.
- Canonical channel secret refs follow the same secret-input family as providers: `env:NAME`, legacy `$NAME`, `file:/absolute/path`, `secret://...`, and operator-gated `command:...`.
- In strict mode, plaintext channel secrets are blocked. Setup and bootstrap may preserve refs, but runtime channel init must resolve them before handing config to the channel plugin.
- `FridayChannelRegistryView` is expected to surface both transport status and supervisor health. Health includes `state`, `restartCount`, `lastError`, `blockedReason`, and `credentialStatus` so skills, diagnostics, and operator surfaces do not need to infer restart state heuristically.
- Live external-channel proof is per-channel and scoped to configured test spaces only. Phase 14.5E closed as a user-approved partial/blocked report-only outcome: Discord is the only channel that was configured during the live-proof pass; Lark/Feishu and Telegram remain `not_configured` / `blocked_by_env`. Docs and UI copy must not present unconfigured channels as closed, ready, or release-proven. `blocked_by_env` is not pass.
- `FRIDAY_MASTER_KEY` and `FRIDAY_TOKEN_SECRET` are internal runtime secrets generated and stored by the local or user-owned cloud runtime. Ordinary user setup must not require pasting them into prompts, settings, configs, or screenshots. Maintainer CI or release-proof jobs may configure protected environment secrets when a production-like proof explicitly requires them.

## Tool call observability

- The tool call summary service (`src/agent/services/friday-tool-call-summary.ts`) captures privacy-safe metadata for each tool execution: tool name, argument keys (never values), result shape, error status, and tool category (read/write/query/mutate/navigate).
- Tool summaries are injected into the agent runtime's `buildToolEndEventPayload()` and published through the realtime event surface.
- Approval-gated tool calls now carry a capability-grant evidence trail. `agent.run.awaiting_tool_approval` must include a stable `grantId`, and approval resolution must emit `agent.run.capability_grant_issued` or `agent.run.capability_grant_denied` before the eventual `agent.run.capability_grant_used` event when the tool actually executes.
- Tool summaries are designed as world model training data: they capture execution patterns without leaking sensitive argument values or output content.
- Workflow runtime events are now buffered in hub bootstrap before the API runtime publisher is ready, then flushed. `resolveWorkflowRealtimeStreamId()` routes events to the correct SSE stream by runId or workflowId.

## Agent orchestration and rollout controls

- Deterministic agent truth remains the primary answer path for runtime capability and progress questions. The agent must keep using `capabilities`, `task_status`, and `get_subagent` instead of guessing deployment state or delegated progress from prompt text alone.
- Installed starter skills remain the preferred path for operational, workflow, review, QA, diff-risk, scope, design, release-readiness, and security-style requests.
- Skill manifests may declare `requirements.mcpServers[]`, where each requirement names a server and an auth floor of `connected` or `authenticated`.
- `capabilities` must surface MCP readiness as `mcp.servers[]` entries with `name`, `connected`, and `authenticated`.
- `skills_list` must surface `ready`, `blockers`, and any MCP requirements for each listed skill. `skill_run` must fail closed with structured blockers when those MCP requirements are not satisfied.
- `FRIDAY_AGENT_ENFORCE_STARTER_SKILL_ROUTING` defaults to off. When enabled, a high-confidence operational, workflow, review, or QA request that matches an installed starter skill must perform `skills_list` discovery before replying directly.
- `spawn_subagent` defaults to `mode="fresh"`. Explicit `mode="fork"` is rollout-gated by `FRIDAY_SUBAGENT_FORK_MODE_ENABLED`, must fork through the session service lineage, and must not silently degrade back to `fresh`.
- The rollout order and acceptance commands for these flags live in `docs/ops/friday-agent-orchestration-rollout.md`.

## Skills Lifecycle

- `/v1/skills/*` is the canonical skill lifecycle surface for catalog, detail, install, update, delete, manifest validation, and verification. The standalone hub now constructs `createFridaySkillLifecycleService` and passes `skillLifecycle` into `createFridayApiRuntime`, so lifecycle-gated routes are registered in the hub runtime instead of returning router-level 404 for missing registration.
- Mutating lifecycle routes remain approval-boundary surfaces. `POST /v1/skills/:skillId/update` and `DELETE /v1/skills/:skillId` must evaluate the canonical mutation gate before calling lifecycle mutation handlers; missing approval fails closed instead of silently mutating skills. Legacy external-skill `install`/`update`/`delete` operations still require the external-skill lifecycle path rather than being treated as general install proof.
- `POST /v1/skills/:skillId/verify`, `GET /v1/skills/catalog`, `GET /v1/skills/:skillId`, and `POST /v1/skills/validate-manifest` are now wired through the lifecycle service in standalone hub. This closes the F-017 route-registration/approval-gate blocker, but it is not same-SHA release proof and does not by itself prove every live provider self-healing scenario.
- Unit/contract tests cover the route registration and approval-gate contracts. Live-provider proof remains subject to the relevant lane credentials and Real Green Gate status; `blocked_by_env` remains not pass.
- `GET /v1/skills` is the canonical inventory/discovery snapshot for installed or discovered skills on the current runtime.
- `GET /v1/skills/catalog` is the canonical external catalog cache surface. An empty response means the runtime has no populated catalog snapshot yet; it does not by itself mean the skills system is broken.
- `/skills` is the operator-facing lifecycle surface for installed skills, updates, verification evidence, source policy, and generated-skill handoff from `/assistant`.
- Skill verification evidence now includes a canonical `preflight` summary with `ready`, `needs_review`, or `blocked` verdicts plus blocking/warning/advisory checks across manifest, integrity, runtime requirements, permissions, dry-run, and trust.
- Skill generation is not a terminal leaf product. Generated skills flow through the generator-to-candidate bridge so approved generated output carries a `candidateId` and can enter the candidate/lifecycle handoff instead of bypassing unified lifecycle tracking. The closeout design requirement is that **Generated skills must be able to flow directly into verification, install or enable recommendation, diagnosis, and recovery.** as a single end-to-end loop; in `1.0.1` the candidate-bridge handoff and the install / update / delete gates are wired with fail-closed `SKILL_LIFECYCLE_*_APPROVAL_REQUIRED` gating, but the full end-to-end candidate → verification → install/enable recommendation → diagnosis → recovery run remains `proof_pending` and is carried forward in the dogfood closure for a subsequent dogfood pass.
- Skill generator approval stages a candidate only. `promotionStage: "candidate_staged"` with `registryRefreshed: false` must not be described as installed, promoted, or runnable until the skill lifecycle completes the required verification/promotion path.
- Candidate approval receipts expose `candidateManifestTags`; legacy `promotedManifestTags` is compatibility-only and must remain empty for `candidate_staged` responses.
- Skill verification evidence must remain structured around manifest verdict, package integrity, dependency checks, runtime dry-run, and trust summary.
- `/v1/skills/catalog` and skill detail responses must expose machine-readable lifecycle guidance for operator surfaces, including trust tier, implementation status, blocked reasons, recommended next action, and first-use prompts. UI surfaces must consume that server-shaped guidance instead of reverse-engineering install state client-side.

## Plugin Distribution

- `/v1/plugins*` is the active plugin distribution surface for installed-plugin lifecycle, version inspection, and install flows.
- Plugin distribution is real and test-backed, but it is **not** the same product surface as the canonical skills lifecycle. Docs must not blur `skills lifecycle` and `plugin distribution` into one story.
- Legacy executable skills/plugins/packages may still exist for local, operator, or migration scenarios, but they are not a public commerce story and must not appear as ordinary public assets by default.
- User-facing truth must distinguish:
  - skills lifecycle as a validated closed-loop product surface
  - plugin distribution as an active bounded surface

## Workflow product surfaces

- Public workflow product routes `POST /v1/workflows/:workflowId/drafts/:draftId/deploy`, `GET /v1/workflows/:workflowId/overview`, and `GET /v1/workflows/:workflowId/visualization` are part of the active steady-state product surface.
- One-click deploy must remain an orchestration surface on top of the existing workflow builder, publisher, runner, and evidence exporters; clients must not need to manually chain compile, publish, run, export, and observability correlation.
- `/assistant` may show simplified workflow deploy cards and recovery actions, but it must not expose builder jargon or raw DAG internals.
- `/workflows` is the operator-facing workflow control plane for graph visualization, draft and published state, deploy status, run timeline, and evidence export.
- Workflow generator approval creates and publishes a workflow version through Workflow CRUD. That publish result is not the workflow upgrade lifecycle's shadow/canary/promote/rollback proof, and API/UI evidence must preserve that boundary.
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
- Slack webhook delivery and SMTP email delivery are configured external alert dispatch paths for the observability surface. They require the `external_alerts.ready` Real Green Gate precondition and real Slack or SMTP proof before any release-complete alert-dispatch claim; missing credentials or blocked external environments remain `blocked_by_env`, not pass.
- OTEL/Grafana external export remains future/no-claim for the public v1 local track. Internal trace, audit, metric, health, and alert-routing surfaces stay active, but no public v1 local claim should state that traces have landed in Grafana or an external OTEL collector.

## Quality gates, retry, and rules

- Acceptance custom checks must use a registered in-process handler installed via `registerCustomHandler()`. Ad-hoc inline scripts in `handlerConfig.script` are disabled by policy per locked decision GEC-007 (untrusted code does not run in-process); the deterministic pipeline returns a `fail`/`critical` verdict with `metadata.policy = "inline_scripts_disabled"` when an inline script is supplied for an unregistered `handlerRef`. The historical `node:vm`-backed in-process sandbox has been removed because `vm` is explicitly not a security mechanism. The future hardening direction in which **Acceptance custom checks execute in a sandboxed runtime** (out-of-process verifier with policy-enforced resource limits) is the design target only if inline script execution ever becomes a product requirement; in `1.0.1` the only safe execution path is the registered in-process handler contract above, and any claim that arbitrary acceptance checks already run in a sandboxed runtime is `not_in_this_release`.
- Acceptance test definitions maintain version history and artifact history, and those records are part of the operator-facing quality surface.
- Provider-level retry circuit breakers, retry replay evidence, cost summaries, and escalation acknowledgement are active product surfaces, not deferred architecture notes.
- Workflow retry receipts are user-visible source truth on GitHub main after PR #360: retrying failed workflow nodes without explicit `nodeIds` returns the actual retried node IDs, failed and retried attempts remain visible, authorized retry reaches final state with persisted evidence/export checksum, unauthenticated or unbound retry is denied, and stalled provider streams return a terminal timeout receipt instead of letting the caller lose the run ID. This is not npm `1.0.2` truth and does not claim live external-channel/provider retry proof.
- Rules simulation, rule version history, and audit-log visibility are part of the active steady-state operator surface and must stay explainable through `/observability` and the deterministic pipeline APIs.
- Beginner surfaces may only summarize quality gates, retry exhaustion, or policy denial; detailed retry/rules internals remain operator-facing concerns.

## Expectation boundary

- Friday's steady-state non-platform product is a **supervised, bounded automation system**.
- Friday's steady-state non-platform product may operate in **expert mode**, but only as opt-in bounded autonomy under the same audit, rollback, verification, and approval expectations.
- "Self-solving" currently means: detect incidents, diagnose likely causes, propose fixes, auto-execute low-risk fixes, verify outcomes, roll back when verification fails, and pause after repeated failures.
- In expert mode, "self-solving" also includes bounded context inference, minimal decisive questioning, safe probes, and cross-surface orchestration when those steps stay inside policy.
- "Self-solving" does **not** currently mean: unrestricted long-horizon autonomous troubleshooting, arbitrary cross-system recovery without policy gates, or full human-level adaptive judgment in ambiguous environments.
- Fleet/distributed execution is intentionally bounded to a single-hub trust domain with static peers, registered satellites, and the trust-scored fleet directory as the active discovery baseline.
- Offline execution is intentionally limited to continuation and recovery of already-dispatched work; richer offline plan generation or offline trigger creation remains deferred.
- Full multi-hub federation, cross-hub placement, mDNS/relay/Tailscale-native discovery, and richer mesh coordination remain deferred.
- ML-heavy anomaly detection, natural-language rule authoring, and ecosystem-style expansion for acceptance or rules remain deferred.

## Communication style and adaptive learning

- Communication style is a runtime preference and learning surface, not a first-run setup blocker.
- Setup must not ask users to choose an MBTI-style communication grid before reaching Home.
- `/v1/uix/persona` remains the canonical endpoint for reading the resolved communication style for the current user.
- `/v1/uix/preferences` is the canonical CRUD surface for user communication preferences (category: "communication").
- The communication style resolution priority cascade is: explicit preferences > learned preferences > system defaults.
- The communication prompt fragment is injected into the agent's effective system prompt at runtime. Enrichment failure is non-fatal and must not kill the agent run.
- The communication prompt builder reads both explicit preferences and learned preferences from the self-learning context builder.
- Learned preference facts use a Bayesian-inspired confidence model with decay, conflict penalty, and evidence boost. Low-confidence inferred preferences are kept below the active context threshold until an explicit/high-confidence preference or correction confirms them; repeated low-confidence observations alone must not make a learned preference affect behavior.
- The self-learning context enrichment service is wired through hub bootstrap and becomes available after self-learning runtime creation.
- Communication style affects wording, progress updates, failure phrasing, and clarification style only. It must not weaken approval gates, rollback rules, or destructive-action safeguards.
- Raw learned facts are not blanket prompt injection. `createFridayPreferenceInjector` exists as a bounded injector utility and test target, but current hub prompt wiring uses the communication prompt builder plus persisted Reflex/User Constitution preference fragments instead of silently injecting raw learned facts.
- High-impact execution, testing, security, memory-policy, workflow, skill, and User Constitution preferences must be confirmed through Review Center before they become persisted Reflex preferences that can enter the relevant prompt boundary.
- Guided wizard contexts in `/assistant` are persisted in SQLite (`uix_guided_contexts`) and can be resumed after service restart. Onboarding session progress is also persisted in SQLite (`uix_onboarding_sessions`) and restored on boot.
- Learned preference facts are user-visible through `/v1/uix/learned-facts`; the Settings UI renders explicit trust, memory, evidence, context-use, prompt-injection, review, and revocation boundaries. UIX learned-fact routes, memory search/list routes, and agent memory search metadata also return those boundary labels. The Assets surface can list and delete learned facts as learned knowledge, but it does not render the full boundary summary. Learned facts remain separate from explicit Memory and from confirmed Reflex preferences.
- Learned-fact deletion and non-resurrection are live-proven only for bounded route surfaces: two communication preference writes (`persona.tone`, `persona.verbosity`) created learned facts through `/v1/uix/preferences`; one learned fact deleted via `/v1/uix/learned-facts/:factKey` and one deleted via synthetic memory ID `learned-fact:<factKey>` both stayed absent from learned-facts, memory search, and memory list across one isolated runtime restart. This is route deletion proof for those communication keys, not proof that every preference category or channel-originated preference write materializes learned facts.
- `/v1/uix/preferences` remains the explicit communication-preference persistence surface. Claims about learned facts must distinguish explicit preference storage, learning-event emission, learned-fact materialization, learned-fact deletion/revocation evidence, and the narrower key set actually proven in live tests.
- False-recall guardrails are focused rather than universal: the agent prompt truth-labels memory search as scoped, runtime memory-recall tasks enforce or retry toward `memory_search` evidence, and compaction replay is labeled as unconfirmed context rather than durable memory. This reduces hallucinated memory risk, but docs and UI must not claim end-to-end hallucinated-memory detection across live channels, documents, tool output, or public-web flows.

## Runtime admin and security surfaces

- `GET /v1/version` is the canonical lightweight version surface; `/v1/health` remains the public liveness probe.
- `/v1/sessions/:sessionKey` is the canonical session route shape; `sessionId` remains a scoped identifier for generators, workflows, and system runtimes, not the top-level session path key.
- `/v1/config*` is the active runtime configuration surface for read, patch, revision listing, and revision revert flows.
- `GET /v1/audit/logs` is the steady-state admin/security list surface for audit log search, while `/v1/observability/audit*` remains the richer operator-facing audit query surface.
- `/v1/secrets*` is the active CRUD surface for encrypted secret metadata and rotation backed by the existing provider secret repository.
- `GET /v1/workflow-versions/:versionId` is the canonical direct fetch route for workflow versions alongside `/v1/workflows/:workflowId/versions`.
- `/v1/realtime/*` is the canonical realtime transport surface. WebSocket clients may connect through `/v1/realtime/ws`, and `/v1/ws` remains a thin compatibility alias for the same gateway.
- `/v1/workflow-approvals*` is the canonical workflow approval surface; `/v1/approvals*` remains a compatibility alias for legacy or SSD-shaped clients.
- `npm run check:architecture-boundaries` is the canonical repo-level import guard for core infrastructure layers (`state`, `security`, `channels`, `providers`) and must stay green before merge.
- `npm run check:security-doctor` is the canonical repo-level guard for secret refs, capability-grant evidence, provider/channel doctor surfaces, and their targeted safety tests.
- `npm run check:audit-integrity` is the canonical repo-level audit integrity guard for JSONL audit writer invariants, wrapper coverage, and audit-path documentation.
- `npm run check:desktop-release-pipeline` is the canonical repo-level
  pipeline-wiring completeness check for the current macOS desktop release path.
  It validates required scripts, packaging inputs, runbook presence, and
  local-mode release environment readiness. It does not prove signed/notarized
  release readiness, Sparkle/Homebrew publication, or clean-machine smoke
  evidence.

## Canonical semantics

- `/v1/health` is a public liveness and uptime surface plus a conservative runtime snapshot. It is not a deep operator health contract and not a blanket product promise.
- `/v1/health` capability flags such as search latestness, local bypass, or desktop enablement must be read as the current runtime's reported state.
- Public validation failures use the current runtime semantics: `400 VALIDATION_ERROR` is the default contract unless a route explicitly documents a different status.
- Public auth failures use the current runtime taxonomy: `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, and related canonical codes from `src/api/model/friday-api-error-codes.ts`.
- Scope taxonomy is defined by the current auth model, including `security.read` / `security.write`, `fleet.read`, `diagnosis.read` / `diagnosis.write`, and the workflow, skill, plugin, and session scopes present in `src/api/model/friday-api-auth.types.ts`.
- Provider kind and routing semantics are defined by the current provider model and cost-routing types. `openai-compatible` and `google` are canonical provider kinds; historical SSD wording around `"custom"` providers is not the active contract.
- Anthropic provider auth now has three real runtime modes: `api-key`, `oauth`, and `token`. The `token` mode is a compatibility path for pasted/setup subscription tokens and does not imply refresh semantics.
- OpenAI subscription/Codex account sign-in is **not** a current steady-state auth surface for Friday's `api.openai.com` provider path. The active OpenAI provider contract remains API-scoped `api-key` / `bearer-token` credentials. Subscription-based Codex access should be treated as a future Codex client/backend integration rather than a drop-in OAuth mode for the current HTTP provider path.

## Deep link protocol

- `friday://` is the canonical import protocol for provider templates, skill sources, MCP server configs, and workflow templates.
- All deep link imports must go through `POST /v1/deeplink/preview` (parse + validate + permission summary) before `POST /v1/deeplink/apply`.
- `POST /v1/deeplink/apply` currently performs real imports for `provider-template`, `skill-source`, and `workflow-template` bundle URLs. `mcp-server` payloads remain previewable but return an explicit unsupported apply result until dedicated install/config surfaces are wired.
- Deep link payloads require `version: 1`, a valid resource type, and type-specific required fields. Incomplete or high-risk payloads are rejected by the validator.
- Private/localhost URLs in deep link payloads produce warnings. Missing integrity hashes produce advisories.
- The deep link parser accepts both URI format (`friday://skill-source?url=...`) and JSON payload format for POST bodies.
- Deep link implementation: `src/deeplink/` (parser, validator, types). Route registration: `src/api/http/routes/friday-deeplink-routes.ts`.

## Policy extension chain

- `PolicyExtensionChain` (`src/security/policy-extension-chain.ts`) evaluates authorization decisions through a chain: core policy first, then extensions.
- Extensions can only tighten (deny) decisions, never loosen (allow) what core denied. This is a non-negotiable invariant.
- Each extension returns `pass`, `deny`, or `abstain`. First deny wins. All abstain preserves the core decision.
- Evaluation results include which extension triggered a denial, for audit trail purposes.

## Shell safety scanner

- `scanShellScript()` (`src/skills/safety/friday-shell-safety-scanner.ts`) scans shell-based skill scripts for dangerous patterns before installation.
- Three severity levels: `blocking` (rm -rf, sudo, curl|sh, eval, mkfs), `warning` (external curl/wget, netcat, path traversal), `advisory` (unbounded find, chmod/chown).
- Verdicts: `safe`, `needs_review`, `dangerous`. Blocking findings trigger `dangerous` verdict.
- This is a rules-based first version (regex + string matching), not tree-sitter AST analysis.

## Engineering doctrine

- `BELIEFS.md` documents 10 engineering principles that govern all contributions: task-first surfaces, skills-first, truthful release status, deny-precedence, no silent drops, server-shaped UI, additive evolution, mechanical enforcement, YAGNI, repo as authoritative source.
- ESLint config (`eslint.config.mjs`) enforces: no-console (warn), complexity limit 25 (warn), max-lines-per-function 200 (warn), security/detect-object-injection (warn), security/detect-non-literal-fs-filename (warn).
- Architecture boundary check (`scripts/quality/check-architecture-boundaries.mjs`) enforces import rules for `state`, `security`, `channels`, and `providers` layers.

## MCP management and session browser

- `/mcp` is the operator-facing UI for MCP server status, connection health, tool/resource counts, and configuration guidance.
- `/sessions` is the session browser UI for browsing, searching, viewing transcripts, and exporting session history (JSON and Markdown formats).
- Session export is client-side (blob download); no server-side export endpoint is required for the initial implementation.

## WebDAV sync deferral

- WebDAV-based cross-device configuration sync is deferred to post-release. The infrastructure does not exist in the current codebase.
- Rationale: Requires significant new infrastructure with low priority relative to core stability and governance features.

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
- `npm run check:architecture-boundaries`
- `npm run check:security-doctor`
- `npm run check:audit-integrity`
- `npm test`
- `npm run check:provider-reliability`
- `npm run check:desktop-release-pipeline`
- `npm run closeout:phase1`
- `npm run closeout:phase2`
- `npm run closeout:phase3`
- `npm run closeout:phase4`
- `npm run closeout:phase5`
- `npm run check:ui-bundle-health`
- `npm run check:closeout:evidence:freshness`
- `npm run release:verify:repo`
- `npm run release:verify`
- `npm run closeout:final`

## Historical materials

- Historical audits, plans, reviews, reports, and one-off tasklists are not part of the public source tree. Keep them in operator-controlled evidence storage when needed, and keep this document focused on the current public runtime contract.
- When a historical document conflicts with current behavior, this document wins.
