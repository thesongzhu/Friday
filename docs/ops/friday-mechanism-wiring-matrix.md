# Friday Mechanism Wiring Matrix

Basis: current main after #916 (`123ff34e`). This document reconciles the Rust-owned coarse mechanism matrix, the TS-runtime retirement manifest, and the prod-flag test map. It is a current-head wiring artifact, not a go-live claim.

Truth labels:

- `rust_owned_proven`: Rust owns the product mechanism and the named proof gate covers its product path.
- `rust_owned_partial`: Rust owns the mechanism, but at least one product entrypoint or live proof is still missing.
- `rust_wired_dev`: Rust can run the mechanism from a dev/test bridge only; product transport remains blocked.
- `operator_gated` / `external_blocked`: mechanism requires operator-controlled environment or signatures.
- `design_frozen` / `legacy_retire_required`: not a product-logic owner.

Mutation defaults:

- `governed`: writes or executions flow through the named Rust gate or owner.
- `503-by-default`: TS/runtime product mutation is fenced until Rust ownership or an explicit test-only flag.
- `operator-gated`: no agent-autonomous closure; operator action is required.
- `not-a-product-mutator`: row is UI shell, release oracle, external proof, or read/projection surface.

| mechanism_id | owner | status | product_logic | mutation_default | entrypoint | proof_or_guard | exact_blocker |
|---|---|---|---|---|---|---|---|
| `identity_principal_gate` | `rust_core` | `rust_owned_proven` | `yes` | `governed` | `friday_core::gate` | `cargo test -p friday-storage authorize_gate` | none |
| `mission_work_item_spine` | `rust_hub` | `rust_owned_proven` | `yes` | `governed` | `friday_hub::mission_runtime` | `scripts/mission-spine-objective-coverage-gate.sh` | none |
| `global_work_graph` | `rust_hub` | `rust_owned_proven` | `yes` | `governed` | `friday_hub::global_work_graph` | `cargo test -p friday-hub global_work_graph` | none |
| `skill_capability_advisor_bridge` | `rust_hub` | `rust_owned_proven` | `yes` | `governed` | `friday_hub::skill_catalog::{discover_skill_catalog,record_skill_run_receipt}` | `cargo test -p friday-hub skill_catalog` | none |
| `agent_tool_execution` | `rust_hub` | `rust_wired_dev` | `yes` | `503-by-default` | `friday_hub::runtime::HubRuntime::run_task` | `cargo test -p friday-hub run_loop`; TS `agent_runs_start` method guard | real multi-turn live agent/tool execution is dev-bridge-only (hub_run_task = Rust-wired-DEV); only 2/10 fs tools exist and the TS executeRun/startRun product paths stay fail-closed-fenced - no production transport, not proven through any product entrypoint |
| `workflow_runtime` | `rust_hub` | `rust_wired_dev` | `yes` | `503-by-default` | `friday_hub::mission_runtime::run_workflow_for_mission` | `cargo test -p friday-hub mission_runtime`; TS `workflow_runs_start` method guard | workflow runtime is reachable only via a test-only entrypoint (TS startRun product path is fail-closed-fenced) - no production transport; product entrypoints must all use Mission-bound wrappers |
| `memory_learning` | `rust_hub` | `rust_owned_partial` | `yes` | `governed` | `friday_hub::cognition` | `cargo test -p friday-hub cognition`; TS durable-memory writes are fail-closed | runtime memory writer and review surface are not fully attached to all live call sites |
| `providers` | `rust_hub` | `rust_owned_partial` | `yes` | `governed` | `friday_hub::{provider_dispatch,mission_runtime}` | `scripts/mission-spine-proof-gate.sh --local`; prod flag tests | Codex/Claude remote/native live proofs and all product wrappers are still gated |
| `channels` | `rust_hub` | `rust_owned_partial` | `yes` | `503-by-default` | `friday_hub::{channels,channel_event,mission_runtime}` | `cargo test -p friday-hub authenticated_channel`; TS channel/session authoring guards | live Telegram proof and all channel product entrypoints remain gated |
| `process_workspace_control` | `rust_hub` | `rust_owned_partial` | `yes` | `governed` | `friday_hub::global_work_graph` | `cargo test -p friday-storage process_registry`; TS desktop action/recording guards | live supervisor/adoption/stop runtime is not proven; observed processes cannot be controlled |
| `audit_token_proof_receipts` | `rust_hub` | `rust_owned_proven` | `yes` | `governed` | `friday_storage::{audit,token_usage}; friday_hub::mission_preflight` | `cargo test -p friday-storage audit token_usage && scripts/mission-spine-objective-coverage-gate.sh` | none |
| `trust_passport_governance` | `rust_hub` | `rust_owned_partial` | `yes` | `operator-gated` | `friday_storage::trust_grant`; `friday_hub::mission_preflight`; `friday-operator-approve grant/revoke` | `npm run proof:d4:trust-passport` | built-DARK proof harness only; live enforcement and root grant remain operator-gated, and this does not satisfy strict OG9 organic or D20/B4 true signature |
| `pairing` | `rust_hub` | `rust_owned_proven` | `yes` | `governed` | `friday_hub::pair_runtime` | `cargo test -p friday-hub pair_runtime && cargo test -p friday-storage pairing` | none |
| `ui_shell` | `ui_shell_only` | `design_frozen` | `no` | `not-a-product-mutator` | `friday_ffi projections only` | `scripts/mission-spine-ui-device-proof-gate.sh` | UI is allowed as shell/contract only until Rust-owned product logic is proven |
| `release_test_oracle` | `legacy_oracle_only` | `legacy_retire_required` | `no` | `not-a-product-mutator` | `none` | `n/a` | legacy may not own product runtime logic |
| `live_external_proofs` | `operator_external` | `external_blocked` | `no` | `operator-gated` | `operator-gated proof scripts` | `strict final closure runbook` | requires operator environment: devices, accounts, Telegram, release credentials |

## Critical TS Mutation Fences

These TS surfaces remain in the retirement manifest as behavior-tested 503-by-default fences. They are not proof that the replacement Rust product path is complete; they are the no-ungated-hole side of L1. CI now runs every `methodRetiredSurfaces[*].behavioralTest` from `docs/ops/ts-runtime-retirement-manifest.json`; the table below is the critical subset mapped into the mechanism matrix, not the full behavior-test set.

| surface_id | mechanism | default | behavior |
|---|---|---|---|
| `agent_runs_start` | `agent_tool_execution` | `503-by-default` | direct TS `executeRun` start is method-fenced before provider/tool execution |
| `workflow_runs_start` | `workflow_runtime` | `503-by-default` | direct TS workflow start is method-fenced before product execution |
| `autofix_execute` | `agent_tool_execution` | `503-by-default` | direct TS auto-fix execute sink is method-fenced |
| `skills_run` | `skill_capability_advisor_bridge` | `503-by-default` | TS skill execution is fenced; Rust currently records gated receipts, not imported code execution |
| `skills_import` | `skill_capability_advisor_bridge` | `503-by-default` | TS skill import route is fenced; Rust SKILL.md materialization remains a separate build item |
| `mcp_server_rpc` | `agent_tool_execution` | `503-by-default` | TS MCP tool call route is fenced until Rust owns MCP execution |

## Governed Non-503 Mutation Surfaces

Not every mutation surface should be retired to 503. These surfaces stay reachable because they are bounded control or lifecycle surfaces, but they must remain governed by principal, scope, or canonical approval checks. Treating them as "must 503" would be a downgrade.

| surface | mechanism | default | guard |
|---|---|---|---|
| `agent_cancel_rollback` | `agent_tool_execution` | `governed` | visible-run / terminal-state control checks; rollback is a separate control path, not the start/execute sink |
| `agent_plan_tool_approvals` | `identity_principal_gate` | `governed` | bound-principal approval/rejection checks |
| `workflow_run_controls` | `workflow_runtime` | `governed` | workflow write scope plus owner/admin/operator principal checks |
| `skill_content_lifecycle` | `skill_capability_advisor_bridge` | `governed` | canonical approval for content/lifecycle/import mutations; execution remains separately fenced |
| `capability_grant_revoke` | `identity_principal_gate` | `governed` | authority/owner gate for grant revocation; root minting remains operator-only |
| `mission_spine_dispatch_status` | `mission_work_item_spine` | `governed` | Rust mission-spine ownership, dispatch-service absence fails closed, route decision/status mutations are owner-bound |

## Current NO-GO Summary

`friday_v1_no_go_blockers()` is expected to remain non-empty on this anchor. The hard blockers are:

- `agent_tool_execution`: Rust-wired dev bridge exists, but product transport and broad tool execution are not proven.
- `workflow_runtime`: Rust workflow runtime exists, but production product wrappers must be Mission-bound and are still fenced.
- `memory_learning`, `providers`, `channels`, and `process_workspace_control`: Rust-owned partial mechanisms with live proof or surface gaps.

This document closes the L1 documentation/wiring artifact gap only. It does not mark v1 done, does not satisfy strict physical-hand OG9, and does not replace D20/B4 operator-only signatures.
