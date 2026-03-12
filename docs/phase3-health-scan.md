> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 3: Full Project Health Scan
# CX (gpt-5.3-codex) — 2026-02-18

**1) Health Scan Findings**

1. **Source files with no corresponding test file (226 total)**  
Method used: strict file-path correspondence (`src/.../x.ts` expected `test/unit/.../x.test.ts`, plus existing migration naming exceptions).  
Breakdown: `workflows 59`, `skills 42`, `api 30`, `providers 15`, `satellites 14`, `state 14`, `learning 11`, `memory 11`, `jobs 6`, `hub 5`, `sessions 5`, `plugins 4`, `config 3`, `errors 2`, `ledger 2`, `utilities 2`, `cli 1`.

```text
## api (30)
src/api/http/friday-http-error-mapper.ts
src/api/http/friday-http-route-registry.ts
src/api/http/routes/friday-provider-routes.ts
src/api/http/routes/friday-provider-usage-routes.ts
src/api/index.ts
src/api/legacy/friday-legacy-decommission.types.ts
src/api/model/friday-api-auth.types.ts
src/api/model/friday-api-common.types.ts
src/api/model/friday-api-fleet.types.ts
src/api/model/friday-api-memory.types.ts
src/api/model/friday-api-plugin.types.ts
src/api/model/friday-api-principal.types.ts
src/api/model/friday-api-provider.types.ts
src/api/model/friday-api-realtime.types.ts
src/api/model/friday-api-security.types.ts
src/api/model/friday-api-session.types.ts
src/api/model/friday-api-skill-converter.types.ts
src/api/model/friday-api-skill-generator.types.ts
src/api/model/friday-api-workflow.types.ts
src/api/persistence/friday-api-token-repository.ts
src/api/persistence/friday-auth-session-repository.ts
src/api/persistence/friday-rate-limit-counter-repository.ts
src/api/persistence/friday-realtime-checkpoint-repository.ts
src/api/persistence/friday-realtime-event-repository.ts
src/api/persistence/friday-user-repository.ts
src/api/persistence/friday-workflow-conflict-repository.ts
src/api/realtime/friday-realtime-event-bus.ts
src/api/realtime/friday-realtime-event-bus.types.ts
src/api/runtime/friday-api-runtime.ts
src/api/runtime/friday-api-runtime.types.ts

## cli (1)
src/cli/index.ts

## config (3)
src/config/friday-config.schema.ts
src/config/friday-config.types.ts
src/config/index.ts

## errors (2)
src/errors/friday-domain-error.ts
src/errors/index.ts

## hub (5)
src/hub/index.ts
src/hub/services/friday-hub-config-manager.types.ts
src/hub/services/friday-hub-gateway-ingress.types.ts
src/hub/services/friday-hub-memory-state.types.ts
src/hub/services/index.ts

## jobs (6)
src/jobs/index.ts
src/jobs/learning/friday-approval-expiry.types.ts
src/jobs/learning/friday-learning-metrics.types.ts
src/jobs/marketplace/friday-marketplace-sync-job.ts
src/jobs/marketplace/friday-marketplace-sync.types.ts
src/jobs/retention/friday-retention.types.ts

## learning (11)
src/learning/index.ts
src/learning/model/friday-auto-fix.types.ts
src/learning/model/friday-learning.types.ts
src/learning/persistence/friday-diagnosis-record-repository.ts
src/learning/persistence/friday-learned-lesson-repository.ts
src/learning/services/friday-auto-fix-lesson-extraction-service.ts
src/learning/services/friday-auto-fix-rollback-service.ts
src/learning/services/friday-learning-event-collection-service.ts
src/learning/services/friday-learning-feedback-loop-service.ts
src/learning/services/friday-learning-lifecycle-service.ts
src/learning/services/friday-learning-metrics-service.ts

## ledger (2)
src/ledger/friday-ledger-internal.types.ts
src/ledger/index.ts

## memory (11)
src/memory/friday-memory.constants.ts
src/memory/guard/friday-memory-guard.constants.ts
src/memory/guard/index.ts
src/memory/guard/model/friday-memory-guard.types.ts
src/memory/guard/services/friday-memory-guard-factory.ts
src/memory/guard/services/friday-memory-guard-service.ts
src/memory/guard/services/friday-memory-guard-service.types.ts
src/memory/guard/services/friday-memory-output-filter.ts
src/memory/index.ts
src/memory/model/friday-memory.types.ts
src/memory/search/friday-memory-hybrid.ts

## plugins (4)
src/plugins/channels/friday-channel-plugin.types.ts
src/plugins/index.ts
src/plugins/manifest/friday-plugin-manifest.schema.ts
src/plugins/model/friday-plugin.types.ts

## providers (15)
src/providers/context/friday-provider-context-compactor.ts
src/providers/context/friday-provider-context-pruner.ts
src/providers/context/friday-provider-prompt-cache.ts
src/providers/context/friday-provider-token-estimator.ts
src/providers/cost/friday-provider-budget-service.ts
src/providers/cost/friday-provider-complexity-classifier.ts
src/providers/cost/friday-provider-cost-calculator.ts
src/providers/cost/friday-provider-cost-router.ts
src/providers/cost/friday-provider-pricing-catalog.ts
src/providers/cost/friday-provider-usage-normalizer.ts
src/providers/index.ts
src/providers/model/friday-provider-context.types.ts
src/providers/model/friday-provider-cost.types.ts
src/providers/model/friday-provider.types.ts
src/providers/persistence/friday-provider-usage-repository.ts

## satellites (14)
src/satellites/index.ts
src/satellites/model/friday-outbox.types.ts
src/satellites/model/friday-satellite-health.types.ts
src/satellites/model/friday-satellite-protocol.types.ts
src/satellites/model/friday-satellite.types.ts
src/satellites/persistence/friday-outbox-message-repository.ts
src/satellites/persistence/friday-satellite-api-token-repository.ts
src/satellites/persistence/friday-satellite-capability-repository.ts
src/satellites/persistence/friday-satellite-heartbeat-repository.ts
src/satellites/persistence/friday-satellite-pairing-request-repository.ts
src/satellites/persistence/friday-satellite-repository.ts
src/satellites/persistence/friday-stream-checkpoint-repository.ts
src/satellites/runtime/friday-satellite-runtime.ts
src/satellites/runtime/friday-satellite-runtime.types.ts

## sessions (5)
src/sessions/friday-session-memory-extraction.constants.ts
src/sessions/friday-session.constants.ts
src/sessions/index.ts
src/sessions/model/friday-session-memory-extraction.types.ts
src/sessions/model/friday-session.types.ts

## skills (42)
src/skills/bridge/index.ts
src/skills/converter/converters/friday-clawdbot-skill-md-converter.ts
src/skills/converter/converters/friday-n8n-node-converter.ts
src/skills/converter/converters/friday-native-skill-package-converter.ts
src/skills/converter/converters/friday-openai-gpt-action-converter.ts
src/skills/converter/converters/index.ts
src/skills/converter/index.ts
src/skills/converter/model/friday-skill-converter.types.ts
src/skills/converter/services/friday-skill-converter-registry.ts
src/skills/converter/services/friday-skill-converter-service.ts
src/skills/converter/services/friday-skill-converter-service.types.ts
src/skills/converter/services/friday-skill-import-installer.ts
src/skills/converter/services/friday-skill-package-archive.ts
src/skills/executor/index.ts
src/skills/generator/index.ts
src/skills/index.ts
src/skills/model/friday-skill-lifecycle.types.ts
src/skills/model/friday-skill-manifest-v2.types.ts
src/skills/model/friday-skill-marketplace.types.ts
src/skills/model/friday-skill-permission-policy.types.ts
src/skills/model/friday-skill-runtime.types.ts
src/skills/model/friday-skill-source.types.ts
src/skills/model/friday-skill-trust.types.ts
src/skills/persistence/friday-marketplace-cache-repository.ts
src/skills/persistence/friday-marketplace-source-repository.ts
src/skills/persistence/friday-skill-installation-repository.ts
src/skills/persistence/friday-skill-repository.ts
src/skills/persistence/friday-skill-version-repository.ts
src/skills/runtime/friday-skill-marketplace-runtime.ts
src/skills/runtime/friday-skill-marketplace-runtime.types.ts
src/skills/services/friday-marketplace-cache-service.ts
src/skills/services/friday-marketplace-discovery-service.ts
src/skills/services/friday-marketplace-http-client.ts
src/skills/services/friday-marketplace-source-service.ts
src/skills/services/friday-marketplace-sync-service.ts
src/skills/services/friday-skill-installation-service.ts
src/skills/services/friday-skill-package-installer.ts
src/skills/services/friday-skill-permission-check-service.ts
src/skills/services/friday-skill-signature-verifier.ts
src/skills/services/friday-skill-trust-scoring-service.ts
src/skills/services/friday-skill-version-resolution-service.ts
src/skills/validation/friday-skill-validation.types.ts

## state (14)
src/state/index.ts
src/state/sqlite/friday-sqlite-read-pool.ts
src/state/sqlite/friday-sqlite.types.ts
src/state/sqlite/migrations/friday-migration.types.ts
src/state/sqlite/migrations/index.ts
src/state/sqlite/migrations/v001-initial.ts
src/state/sqlite/migrations/v002-phase8-api-foundation.ts
src/state/sqlite/migrations/v003-provider-usage-cost-routing.ts
src/state/sqlite/migrations/v004-memory-core.ts
src/state/sqlite/migrations/v005-session-foundation.ts
src/state/sqlite/migrations/v006-session-memory-extraction.ts
src/state/sqlite/migrations/v007-session-forks.ts
src/state/sqlite/migrations/v008-plugin-system-foundation.ts
src/state/sqlite/migrations/v009-workflow-engine-triggers-approvals.ts

## utilities (2)
src/utilities/friday-path-safety.ts
src/utilities/index.ts

## workflows (59)
src/workflows/builder/index.ts
src/workflows/builder/model/friday-workflow-builder-canvas.types.ts
src/workflows/builder/model/friday-workflow-builder-collaboration.types.ts
src/workflows/builder/model/friday-workflow-builder-draft.types.ts
src/workflows/builder/model/friday-workflow-builder-io.types.ts
src/workflows/builder/model/friday-workflow-builder-runtime.types.ts
src/workflows/builder/model/friday-workflow-builder-template.types.ts
src/workflows/builder/model/friday-workflow-builder-test.types.ts
src/workflows/builder/model/friday-workflow-builder-validation.types.ts
src/workflows/builder/persistence/friday-workflow-builder-draft-repository.ts
src/workflows/builder/persistence/friday-workflow-builder-lock-repository.ts
src/workflows/builder/persistence/friday-workflow-builder-spec-version-repository.ts
src/workflows/builder/persistence/friday-workflow-builder-template-repository.ts
src/workflows/builder/persistence/friday-workflow-builder-test-run-repository.ts
src/workflows/builder/runtime/friday-workflow-builder-runtime.ts
src/workflows/builder/services/friday-workflow-builder-collaboration-service.ts
src/workflows/builder/services/friday-workflow-builder-compositor-service.ts
src/workflows/builder/services/friday-workflow-builder-draft-service.ts
src/workflows/builder/services/friday-workflow-builder-import-export-service.ts
src/workflows/builder/services/friday-workflow-builder-template-service.ts
src/workflows/builder/services/friday-workflow-builder-test-runner-service.ts
src/workflows/builder/services/friday-workflow-builder-validation-service.ts
src/workflows/builder/templates/friday-workflow-builder-builtin-templates.ts
src/workflows/compiler/friday-workflow-compiler.ts
src/workflows/compiler/friday-workflow-validator.ts
src/workflows/engine/friday-workflow-artifact-writer.ts
src/workflows/engine/friday-workflow-dag-scheduler.ts
src/workflows/engine/friday-workflow-expression-evaluator.ts
src/workflows/engine/friday-workflow-node-executor.ts
src/workflows/engine/friday-workflow-node-machine.ts
src/workflows/engine/friday-workflow-retry-manager.ts
src/workflows/engine/friday-workflow-run-machine.ts
src/workflows/friday-workflow-engine.constants.ts
src/workflows/index.ts
src/workflows/model/friday-workflow-editor.types.ts
src/workflows/model/friday-workflow-engine.types.ts
src/workflows/model/friday-workflow-expression.types.ts
src/workflows/model/friday-workflow-graph.types.ts
src/workflows/model/friday-workflow-spec.types.ts
src/workflows/model/friday-workflow-trigger.types.ts
src/workflows/model/friday-workflow.types.ts
src/workflows/persistence/friday-workflow-approval-repository.ts
src/workflows/persistence/friday-workflow-artifact-repository.ts
src/workflows/persistence/friday-workflow-repository.ts
src/workflows/persistence/friday-workflow-run-checkpoint-repository.ts
src/workflows/persistence/friday-workflow-run-node-repository.ts
src/workflows/persistence/friday-workflow-run-repository.ts
src/workflows/persistence/friday-workflow-trigger-delivery-repository.ts
src/workflows/persistence/friday-workflow-trigger-repository.ts
src/workflows/runtime/friday-workflow-runtime.ts
src/workflows/runtime/friday-workflow-runtime.types.ts
src/workflows/services/friday-workflow-approval-service.ts
src/workflows/services/friday-workflow-approval-service.types.ts
src/workflows/services/friday-workflow-crud-service.ts
src/workflows/services/friday-workflow-event-trigger-bridge.ts
src/workflows/services/friday-workflow-execution-service.ts
src/workflows/services/friday-workflow-skill-node-adapter.ts
src/workflows/services/friday-workflow-skill-node-adapter.types.ts
src/workflows/services/friday-workflow-trigger-service.ts
```

2. **Dead code (exported but not imported elsewhere in `src`)**
- `src/api/realtime/friday-realtime-subscription-service.ts:43` (`computeCursorHmac`)
- `src/api/realtime/friday-realtime-subscription-service.ts:55` (`verifyCursorHmac`)
- `src/sessions/services/friday-session-memory-extraction-llm-client.ts:351` (`_EXTRACTION_SYSTEM_PROMPT`, test-only export)
- `src/sessions/services/friday-session-memory-extraction-llm-client.ts:352` (`_validateLlmResponse`, test-only export)
- `src/sessions/services/friday-session-memory-extraction-llm-client.ts:353` (`_parseJsonFromText`, test-only export)

Also found effectively dormant APIs with no production call sites:
- `src/workflows/services/friday-workflow-approval-service.ts:18` (`requestForNode`)
- `src/workflows/persistence/friday-workflow-trigger-repository.ts:91` (`upsertManyForVersion`)

3. **Circular dependencies**
- **Module-level SCCs found (2):**
  - `config <-> state` (`src/config/index.ts`, `src/state/index.ts`)
  - Large SCC across `memory, sessions, satellites, learning, jobs, hub, ledger, skills, workflows, api` (barrel/re-export driven; 148 files in SCC).
- **Strict import-only, non-barrel file cycles:** none (`0`).

4. **Cross-module deep imports bypassing barrels**
- `src/api/runtime/friday-api-runtime.ts:11` -> `../../workflows/services/friday-workflow-approval-service.js`
- `src/jobs/sessions/friday-session-lifecycle-job.ts:3` -> `../../sessions/services/friday-session-memory-extraction-service.types.js`
- `src/jobs/sessions/friday-session-memory-extraction-job.ts:7` -> `../../sessions/friday-session-memory-extraction.constants.js`
- `src/jobs/sessions/friday-session-memory-extraction-job.ts:8` -> `../../sessions/persistence/friday-session-memory-extraction-repository.js`
- `src/jobs/sessions/friday-session-memory-extraction-job.ts:9` -> `../../sessions/services/friday-session-memory-extraction-service.types.js`
- `src/jobs/sessions/friday-session-memory-extraction-job.types.ts:1` -> `../../sessions/model/friday-session-memory-extraction.types.js`
- Alias-submodule bypasses (non-canonical top-level barrel path):
  - `src/api/http/routes/friday-skill-converter-routes.ts:12` -> `#skills/converter`
  - `src/api/http/routes/friday-skill-generator-routes.ts:7` -> `#skills/generator`
  - `src/api/model/friday-api-skill-converter.types.ts:9` -> `#skills/converter`
  - `src/api/model/friday-api-skill-generator.types.ts:7` -> `#skills/generator`
  - `src/api/runtime/friday-api-runtime.types.ts:19` -> `#skills/converter`
  - `src/hub/friday-hub-bootstrap.ts:16` -> `#skills/generator`
  - `src/hub/friday-hub-bootstrap.ts:27` -> `#skills/converter`
  - `src/hub/index.ts:12` -> `#skills/converter`

5. **Style-guide inconsistencies**
- Import not top-of-file:
  - `src/api/model/friday-api-session.types.ts:73` (import appears after exported declarations)
- Wildcard barrel exports (`export *`) in 12 files:
  - `src/hub/index.ts`
  - `src/hub/services/index.ts`
  - `src/jobs/index.ts`
  - `src/learning/index.ts`
  - `src/ledger/index.ts`
  - `src/memory/index.ts`
  - `src/satellites/index.ts`
  - `src/skills/executor/index.ts`
  - `src/skills/generator/index.ts`
  - `src/state/index.ts`
  - `src/workflows/builder/index.ts`
  - `src/workflows/index.ts`
- `operationId` underscore naming (not lowercase dot-segments):
  - `src/api/http/routes/friday-fleet-routes.ts:29` (`fleet.list_satellites`)
  - `src/api/http/routes/friday-fleet-routes.ts:38` (`fleet.get_satellite_detail`)
  - `src/api/http/routes/friday-security-routes.ts:32` (`security.revoke_token`)
  - `src/api/http/routes/friday-security-routes.ts:42` (`security.revoke_satellite`)
  - `src/api/http/routes/friday-workflow-routes.ts:92` (`workflows.list_versions`)
  - `src/api/http/routes/friday-workflow-run-routes.ts:53` (`runs.list_nodes`)
- Test imports deep into `src` instead of alias:
  - `test/unit/sessions/services/friday-session-memory-extraction-llm-client.test.ts:5`

6. **Type-safety concerns (despite clean TSC)**
- `as unknown as`: `24` occurrences (hotspots)
  - `src/workflows/services/friday-workflow-execution-service.ts` (7)
  - `src/learning/services/friday-learning-pattern-recognition-service.ts` (4)
  - `src/workflows/services/friday-workflow-trigger-service.ts` (3)
  - `src/workflows/engine/friday-workflow-node-executor.ts` (3)
  - `src/api/runtime/friday-api-runtime.ts` (3)
- Route context casts: `ctx.body/query/params as ...` appears `105` times.
- Broad structural casts: `as Record<string, unknown>` appears `96` times.
- Non-null assertions on optional deps/principal:
  - `src/workflows/builder/services/friday-workflow-builder-template-service.ts:58`
  - `src/api/http/routes/friday-realtime-routes.ts:101`
  - `src/api/realtime/friday-realtime-event-bus.ts:28`
  - `src/api/realtime/friday-realtime-event-bus.ts:41`
  - `src/api/realtime/friday-realtime-event-bus.ts:59`
  - `src/api/realtime/friday-realtime-event-bus.ts:69`


---

**2) Integration / E2E Test Plan**

**Test architecture constraints**
- Use real module implementations across boundaries.
- Use in-memory SQLite (`test/unit/satellites/_helpers/create-test-db.helper.ts`) for all integration/E2E suites.
- Allowed mocks: filesystem, network, timers, subprocess I/O.
- Add one shared HTTP harness helper for route-runtime tests:
  - `test/e2e/api/_helpers/friday-api-test-server.helper.ts`  
    It should adapt `FridayHttpRouteRegistry` + auth middleware into a real local HTTP server and support real `fetch` calls.

### File plan (all new files)

1. `test/integration/state/sqlite/friday-migration-chain.test.ts`  
Tests: `runs_v001_to_v009_on_fresh_db`, `is_idempotent_when_reapplied`, `creates_expected_core_tables`, `creates_expected_v009_tables`  
Verifies: boot migration chain/schema  
Touches: `state/sqlite/migrations`, migration runner, repositories

2. `test/integration/hub/friday-hub-bootstrap-integration.test.ts`  
Tests: `create_hub_wires_core_services`, `start_transitions_to_running_and_loads_skills`, `stop_releases_state_runtime`  
Verifies: hub bootstrap wiring  
Touches: `hub`, `state`, `skills`, `providers`, `ledger`

3. `test/e2e/cli/friday-cli-start-runtime.test.ts`  
Tests: `friday_start_boots_hub_process`, `friday_start_with_port_exposes_api_listener`  
Verifies: CLI boot chain  
Touches: `cli`, `hub`, API runtime path  
Note: second test is currently blocked by missing API server wiring (`src/cli/friday-cli.ts:242`, `src/hub/friday-hub-bootstrap.ts:212`)

4. `test/e2e/skills/friday-skill-lifecycle.test.ts`  
Tests: `discovers_skill_from_filesystem`, `loads_manifest_and_registers`, `executes_shell_skill`, `executes_node_skill`, `persists_run_output`  
Verifies: skill E2E lifecycle  
Touches: `skills/registry`, `skills/executor`, `ledger`, `hub`

5. `test/e2e/plugins/friday-plugin-local-lifecycle.test.ts`  
Tests: `install_local_validates_manifest`, `enable_load_run_disable_uninstall`, `rejects_uninstall_when_dependencies_exist`, `persists_status_transitions`, `enforces_core_plugin_protection`, `records_trust_on_install_fingerprint`  
Verifies: local plugin lifecycle  
Touches: `plugins/services`, `plugins/persistence`, `plugins/security`

6. `test/e2e/plugins/friday-plugin-marketplace-lifecycle.test.ts`  
Tests: `downloads_marketplace_package`, `verifies_checksum_and_signature`, `installs_signed_plugin`, `trusts_signature_metadata`, `loads_enabled_marketplace_plugin`, `rejects_invalid_signature`  
Verifies: marketplace install chain  
Touches: `plugins/service`, `plugins/marketplace-client`, `plugins/signature-verifier`

7. `test/integration/sessions/friday-session-lifecycle.test.ts`  
Tests: `create_session_and_append_messages`, `fork_session_inherits_context`, `merge_fork_summary_into_parent`, `archive_session`, `prune_and_sweep_lifecycle`, `enforces_parent_child_merge_rules`  
Verifies: session lifecycle  
Touches: `sessions/service`, `sessions/repositories`, `state`

8. `test/integration/sessions/friday-session-memory-extraction-integration.test.ts`  
Tests: `extracts_memories_from_session_messages_inline`, `queues_extraction_jobs_when_configured`, `retries_failed_extractions`, `writes_items_into_memory_store`  
Verifies: session->memory extraction path  
Touches: `sessions/extraction-service`, `memory/service`, `providers`, `jobs/sessions`

9. `test/e2e/workflows/friday-workflow-approval-chain.test.ts`  
Tests: `publish_and_run_workflow_with_approval_pause`, `approve_resumes_and_completes`, `reject_marks_node_failed_and_run_failed`, `resume_requires_decision_for_blocked_approval`, `approval_list_and_get_routes`, `approve_route_invokes_resume`, `reject_route_invokes_resume`  
Verifies: approval full chain  
Touches: `workflows/crud`, `workflows/execution`, `workflows/approval`, `api/runtime`  
Note: add expected-fail for missing approval request creation integration (`requestForNode` unused)

10. `test/e2e/workflows/friday-workflow-trigger-chain.test.ts`  
Tests: `cron_trigger_starts_run`, `webhook_trigger_starts_run`, `event_trigger_starts_run`, `disabled_registration_does_not_fire`, `mark_fired_updates_registration`, `sync_published_triggers_registers_expected_nodes`, `reload_from_published_versions_rehydrates_triggers`  
Verifies: trigger chain (cron/webhook/event)  
Touches: `workflows/trigger-service`, `trigger-repository`, `execution-service`  
Note: persistence gap expected (`upsertManyForVersion` currently unused)

11. `test/e2e/workflows/friday-workflow-timeout-chain.test.ts`  
Tests: `run_timeout_moves_run_to_timed_out`, `node_timeout_marks_node_failed`, `timeout_job_reaps_and_sweeps`  
Verifies: timeout path  
Touches: `workflows/execution`, `jobs/workflows`

12. `test/integration/memory/friday-memory-service-pipeline.test.ts`  
Tests: `store_item_creates_memory_and_embedding`, `search_hybrid_returns_ranked_results`, `retrieve_by_id_returns_item`, `ttl_expiry_excludes_expired_items`, `prune_expired_removes_items`  
Verifies: memory core path  
Touches: `memory/service`, `memory/persistence`, `memory/search`, `providers`

13. `test/integration/memory/guard/friday-memory-guard-pii-namespace.test.ts`  
Tests: `pii_tagging_applies_expected_tags`, `pii_block_mode_rejects_sensitive_content`, `namespace_isolation_blocks_out_of_scope_access`, `reserved_namespace_rejected`, `rate_limits_are_enforced`, `quota_prunes_expired_before_rejecting`  
Verifies: guard/PII/namespace isolation  
Touches: `memory/guard`, `memory/service`, `memory/guard/persistence`

14. `test/e2e/api/friday-api-skills-routes.test.ts`  
Tests: `skills_converter_list`, `skills_convert`, `skills_import`, `skills_pack`, `skills_generator_session_flow`  
Verifies: skills route group via real HTTP  
Touches: `api/runtime`, `api/routes/skill-*`, `skills/*`

15. `test/e2e/api/friday-api-plugins-routes.test.ts`  
Tests: `plugins_list_get_versions`, `plugins_install_enable_disable_uninstall`, `marketplace_list_get_versions`, `marketplace_install`, `plugin_route_auth_scope_enforcement`, `plugin_route_not_found_errors`  
Verifies: plugins HTTP routes  
Touches: `api/routes/friday-plugin-routes`, `plugins/service`

16. `test/e2e/api/friday-api-workflows-routes.test.ts`  
Tests: `workflows_crud_and_publish`, `workflow_builder_draft_lifecycle`, `workflow_runs_start_get_nodes_timeline`, `workflow_conflicts_list_resolve`, `workflow_trigger_routes_via_webhook_event`, `workflow_error_shapes`, `workflow_version_listing`, `workflow_archive_path`  
Verifies: workflow-related route groups  
Touches: `api/routes/workflow*`, `workflows/runtime`, `workflows/builder`

17. `test/e2e/api/friday-api-sessions-memory-routes.test.ts`  
Tests: `sessions_create_get_list`, `sessions_messages_list_create`, `sessions_fork_create_list_merge`, `sessions_archive_prune_sweep`, `sessions_memory_extract_and_retry`, `memory_store_search_get_list_delete_prune`, `namespace_resolution_endpoint`, `session_memory_error_paths`  
Verifies: sessions + memory HTTP routes  
Touches: `api/routes/session`, `api/routes/memory`, `sessions`, `memory`

18. `test/e2e/api/friday-api-approvals-routes.test.ts`  
Tests: `approvals_list_pending`, `approvals_get_by_id`, `approvals_approve_endpoint`, `approvals_reject_endpoint`  
Verifies: approval route group  
Touches: `api/runtime` inline approvals registration, `workflows/approval-service`

19. `test/e2e/api/friday-api-auth-rbac-errors.test.ts`  
Tests: `auth_login_refresh_logout_me`, `rbac_scope_denied_returns_403`, `missing_token_returns_401`, `rate_limit_returns_429`, `domain_error_maps_to_4xx`, `unexpected_error_maps_to_500`, `request_id_propagates`, `error_envelope_contract_consistent`  
Verifies: auth middleware + error responses  
Touches: `api/auth/*`, `api/http/friday-http-error-mapper`, route handlers

20. `test/e2e/integration/friday-workflow-skill-memory-chain.test.ts`  
Tests: `workflow_action_executes_skill_that_stores_memory`, `memory_item_visible_via_search_after_run`, `artifact_and_run_node_records_are_consistent`  
Verifies: workflow->skill->memory cross-module chain  
Touches: `workflows/execution`, `skills/executor`, `memory/service`, `ledger`

21. `test/e2e/integration/friday-plugin-event-workflow-session-chain.test.ts`  
Tests: `plugin_event_triggers_workflow_run`, `workflow_hits_approval_pause`, `approval_decision_completes_run`, `approval_notification_written_to_session`  
Verifies: plugin->workflow->approval->session chain  
Touches: `plugins`, `workflows/triggers+approval`, `sessions`, `api/realtime (if used)`  
Note: notification-to-session behavior appears not implemented yet (expected red test until feature wiring exists)

### Estimated test count
- Estimated total: **100–115 tests** (plan above: ~110).

### Priority order
1. `A` boot/migrations + hub bootstrap + CLI start smoke (`1-3`).
2. Workflow blockers as red tests (`9-11`) to expose current integration gaps early.
3. Session/memory core integration (`7-8`, `12-13`).
4. Skill/plugin lifecycles (`4-6`).
5. Full API HTTP suites (`14-19`) after harness is in place.
6. Cross-module E2E chains (`20-21`) as final confidence gates.

### Critical implementation blockers revealed by scan (affects planned E2E)
1. `friday start` does not start API listener (`src/cli/friday-cli.ts:242`, `src/cli/friday-cli.ts:265`).
2. Hub bootstrap explicitly does not wire API/workflow runtimes yet (`src/hub/friday-hub-bootstrap.ts:211`).
3. Approval request creation path is not invoked by execution flow (`src/workflows/services/friday-workflow-approval-service.ts:18` has no caller in `src`).
4. Trigger persistence registration path is not invoked (`src/workflows/persistence/friday-workflow-trigger-repository.ts:91` has no caller in `src`).

