//! Canonical Friday mechanism ownership matrix.
//!
//! This is a compact, code-owned guardrail for the global rewrite plan: every
//! user-triggerable product mechanism must name its Rust owner, entrypoint, proof
//! status, and blocker. TS/legacy can remain a UI/test/release/oracle helper, but
//! not the owner of product logic.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MechanismOwner {
    RustCore,
    RustHub,
    RustFfi,
    UiShellOnly,
    LegacyOracleOnly,
    OperatorExternal,
}

impl MechanismOwner {
    pub fn as_str(&self) -> &'static str {
        match self {
            MechanismOwner::RustCore => "rust_core",
            MechanismOwner::RustHub => "rust_hub",
            MechanismOwner::RustFfi => "rust_ffi",
            MechanismOwner::UiShellOnly => "ui_shell_only",
            MechanismOwner::LegacyOracleOnly => "legacy_oracle_only",
            MechanismOwner::OperatorExternal => "operator_external",
        }
    }

    pub fn can_own_product_logic(&self) -> bool {
        matches!(
            self,
            MechanismOwner::RustCore | MechanismOwner::RustHub | MechanismOwner::RustFfi
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MechanismStatus {
    /// Rust owns the product logic AND it is proven through every product entrypoint
    /// (the only v1-GO tier). The "RustProvenProduct" tier.
    RustOwnedProven,
    RustOwnedPartial,
    /// Reachable in Rust ONLY via a dev/test bridge or test-only entrypoint — NOT a
    /// production product path. STRICTLY BELOW `RustOwnedPartial`: it makes no partial
    /// product-ownership claim, only "the mechanism runs when poked by a dev harness."
    /// Never v1-GO. Introduced for the S0 `hub_run_task` write-bridge: it proves the
    /// agent loop is *reachable*, not that any product entrypoint is wired.
    RustWiredDev,
    NoGo,
    OperatorGated,
    ExternalBlocked,
    DesignFrozen,
    LegacyRetireRequired,
}

impl MechanismStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MechanismStatus::RustOwnedProven => "rust_owned_proven",
            MechanismStatus::RustOwnedPartial => "rust_owned_partial",
            MechanismStatus::RustWiredDev => "rust_wired_dev",
            MechanismStatus::NoGo => "NO-GO",
            MechanismStatus::OperatorGated => "operator_gated",
            MechanismStatus::ExternalBlocked => "external_blocked",
            MechanismStatus::DesignFrozen => "design_frozen",
            MechanismStatus::LegacyRetireRequired => "legacy_retire_required",
        }
    }

    pub fn is_v1_go(&self) -> bool {
        matches!(self, MechanismStatus::RustOwnedProven)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MechanismRow {
    pub id: &'static str,
    pub title: &'static str,
    pub owner: MechanismOwner,
    pub status: MechanismStatus,
    pub rust_entrypoint: &'static str,
    pub proof_gate: &'static str,
    pub blocker: &'static str,
    pub user_triggerable_product_logic: bool,
}

impl MechanismRow {
    pub fn v1_blocker(&self) -> Option<&'static str> {
        if self.user_triggerable_product_logic
            && (!self.owner.can_own_product_logic() || !self.status.is_v1_go())
        {
            Some(self.blocker)
        } else {
            None
        }
    }
}

pub fn friday_v1_mechanism_matrix() -> Vec<MechanismRow> {
    use MechanismOwner::*;
    use MechanismStatus::*;
    vec![
        MechanismRow {
            id: "identity_principal_gate",
            title: "Identity/principal/capability gate",
            owner: RustCore,
            status: RustOwnedProven,
            rust_entrypoint: "friday_core::gate",
            proof_gate: "cargo test -p friday-storage authorize_gate",
            blocker: "",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "mission_work_item_spine",
            title: "Mission/WorkItem/SurfaceEvent/timeline source of truth",
            owner: RustHub,
            status: RustOwnedProven,
            rust_entrypoint: "friday_hub::mission_runtime",
            proof_gate: "scripts/mission-spine-objective-coverage-gate.sh",
            blocker: "",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "global_work_graph",
            title: "Global Work Graph / adoption / advisor preflight",
            owner: RustHub,
            status: RustOwnedProven,
            rust_entrypoint: "friday_hub::global_work_graph",
            proof_gate: "cargo test -p friday-hub global_work_graph",
            blocker: "",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "skill_capability_advisor_bridge",
            title: "Skill / Capability Catalog / Advisor / run receipt bridge",
            owner: RustHub,
            status: RustOwnedProven,
            rust_entrypoint: "friday_hub::skill_catalog::{discover_skill_catalog,record_skill_run_receipt}",
            proof_gate: "cargo test -p friday-hub skill_catalog",
            blocker: "",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            // De-inflated: was RustOwnedPartial (implied partial PRODUCT ownership). The
            // truth is the loop has only a dev write-bridge (S0 `hub_run_task`, Rust-wired-
            // DEV) — NO production transport: the TS `executeRun`/`startRun` paths are now
            // fail-closed-FENCED (PRs #568/#570), and only 2/10 fs tools exist. The blocker
            // KEEPS the "real multi-turn live agent/tool execution" substring the v1 NO-GO
            // gate asserts, so this stays a NO-GO blocker (closure semantics unchanged).
            id: "agent_tool_execution",
            title: "Agent loop + tool execution",
            owner: RustHub,
            status: RustWiredDev,
            rust_entrypoint: "friday_hub::runtime::HubRuntime::run_task",
            proof_gate: "cargo test -p friday-hub run_loop",
            blocker: "real multi-turn live agent/tool execution is dev-bridge-only (hub_run_task = Rust-wired-DEV); only 2/10 fs tools exist and the TS executeRun/startRun product paths stay fail-closed-fenced — no production transport, not proven through any product entrypoint",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            // De-inflated: was RustOwnedPartial. The workflow runtime is reachable only
            // through a TEST-ONLY entrypoint (the TS `startRun` product path is fail-closed-
            // fenced, #570) — i.e. Rust-wired-DEV, not a production product wrapper.
            // `user_triggerable_product_logic` stays TRUE so the row REMAINS a NO-GO blocker
            // (flipping it to false would remove it from friday_v1_no_go_blockers() and shift
            // the blocker set — forbidden by the S0 brief; closure semantics unchanged).
            id: "workflow_runtime",
            title: "Workflow runtime",
            owner: RustHub,
            status: RustWiredDev,
            rust_entrypoint: "friday_hub::mission_runtime::run_workflow_for_mission",
            proof_gate: "cargo test -p friday-hub mission_runtime",
            blocker: "workflow runtime is reachable only via a test-only entrypoint (TS startRun product path is fail-closed-fenced) — no production transport; product entrypoints must all use Mission-bound wrappers",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "memory_learning",
            title: "Memory / learning / context passport",
            owner: RustHub,
            status: RustOwnedPartial,
            rust_entrypoint: "friday_hub::cognition",
            proof_gate: "cargo test -p friday-hub cognition",
            blocker: "runtime memory writer and review surface are not fully attached to all live call sites",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "providers",
            title: "Codex / Claude / DeepSeek provider routing",
            owner: RustHub,
            status: RustOwnedPartial,
            rust_entrypoint: "friday_hub::{provider_dispatch,mission_runtime}",
            proof_gate: "scripts/mission-spine-proof-gate.sh --local",
            blocker: "Codex/Claude remote/native live proofs and all product wrappers are still gated",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "channels",
            title: "Telegram/channel trusted ingress",
            owner: RustHub,
            status: RustOwnedPartial,
            rust_entrypoint: "friday_hub::{channels,channel_event,mission_runtime}",
            proof_gate: "cargo test -p friday-hub authenticated_channel",
            blocker: "live Telegram proof and all channel product entrypoints remain gated",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "process_workspace_control",
            title: "Process/workspace/port registry and control",
            owner: RustHub,
            status: RustOwnedPartial,
            rust_entrypoint: "friday_hub::global_work_graph",
            proof_gate: "cargo test -p friday-storage process_registry",
            blocker: "live supervisor/adoption/stop runtime is not proven; observed processes cannot be controlled",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "audit_token_proof_receipts",
            title: "Audit/token/proof receipts",
            owner: RustHub,
            status: RustOwnedProven,
            rust_entrypoint: "friday_storage::{audit,token_usage}; friday_hub::mission_preflight",
            proof_gate: "cargo test -p friday-storage audit token_usage && scripts/mission-spine-objective-coverage-gate.sh",
            blocker: "",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "pairing",
            title: "Pairing / trusted device bootstrap",
            owner: RustHub,
            status: RustOwnedProven,
            rust_entrypoint: "friday_hub::pair_runtime",
            proof_gate: "cargo test -p friday-hub pair_runtime && cargo test -p friday-storage pairing",
            blocker: "",
            user_triggerable_product_logic: true,
        },
        MechanismRow {
            id: "ui_shell",
            title: "Mobile/desktop/channel UI shell",
            owner: UiShellOnly,
            status: DesignFrozen,
            rust_entrypoint: "friday_ffi projections only",
            proof_gate: "scripts/mission-spine-ui-device-proof-gate.sh",
            blocker: "UI is allowed as shell/contract only until Rust-owned product logic is proven",
            user_triggerable_product_logic: false,
        },
        MechanismRow {
            id: "release_test_oracle",
            title: "TS tests/release/historical oracle",
            owner: LegacyOracleOnly,
            status: LegacyRetireRequired,
            rust_entrypoint: "none",
            proof_gate: "n/a",
            blocker: "legacy may not own product runtime logic",
            user_triggerable_product_logic: false,
        },
        MechanismRow {
            id: "live_external_proofs",
            title: "Real devices/provider remote/release proofs",
            owner: OperatorExternal,
            status: ExternalBlocked,
            rust_entrypoint: "operator-gated proof scripts",
            proof_gate: "strict final closure runbook",
            blocker: "requires operator environment: devices, accounts, Telegram, release credentials",
            user_triggerable_product_logic: false,
        },
    ]
}

pub fn friday_v1_no_go_blockers() -> Vec<&'static str> {
    friday_v1_mechanism_matrix()
        .into_iter()
        .filter_map(|row| row.v1_blocker())
        .filter(|blocker| !blocker.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_logic_is_not_owned_by_ui_or_legacy() {
        for row in friday_v1_mechanism_matrix() {
            if row.user_triggerable_product_logic {
                assert!(
                    row.owner.can_own_product_logic(),
                    "{} has non-Rust product owner {}",
                    row.id,
                    row.owner.as_str()
                );
                assert!(
                    !row.rust_entrypoint.trim().is_empty() && row.rust_entrypoint != "none",
                    "{} must name a Rust entrypoint",
                    row.id
                );
            }
        }
    }

    #[test]
    fn required_mechanisms_are_explicit_rows() {
        let rows = friday_v1_mechanism_matrix();
        for id in [
            "identity_principal_gate",
            "mission_work_item_spine",
            "global_work_graph",
            "skill_capability_advisor_bridge",
            "agent_tool_execution",
            "workflow_runtime",
            "memory_learning",
            "providers",
            "channels",
            "process_workspace_control",
            "audit_token_proof_receipts",
            "pairing",
            "ui_shell",
            "release_test_oracle",
            "live_external_proofs",
        ] {
            assert!(rows.iter().any(|row| row.id == id), "missing row {id}");
        }
    }

    #[test]
    fn v1_stays_no_go_until_every_product_mechanism_is_proven() {
        let blockers = friday_v1_no_go_blockers();
        assert!(
            blockers
                .iter()
                .any(|b| b.contains("real multi-turn live agent/tool execution")),
            "agent/tool execution partial must block v1 GO until every product entrypoint is proven"
        );
        assert!(
            blockers.iter().any(|b| b.contains("live supervisor")),
            "process/workspace control remains NO-GO until live control proof"
        );
    }

    #[test]
    fn rust_wired_dev_is_an_honest_non_go_tier_below_partial() {
        // The new dev-bridge tier is never v1-GO and renders as the documented string.
        assert!(!MechanismStatus::RustWiredDev.is_v1_go());
        assert_eq!(MechanismStatus::RustWiredDev.as_str(), "rust_wired_dev");
    }

    #[test]
    fn agent_loop_and_workflow_are_rust_wired_dev_after_s0() {
        let rows = friday_v1_mechanism_matrix();
        for id in ["agent_tool_execution", "workflow_runtime"] {
            let row = rows.iter().find(|r| r.id == id).unwrap();
            assert_eq!(
                row.status,
                MechanismStatus::RustWiredDev,
                "{id} must honestly be Rust-wired-DEV (dev/test bridge only), not partial-product"
            );
            // Still user-triggerable product logic with a Rust owner+entrypoint, so the
            // row keeps contributing to the v1 NO-GO blocker set.
            assert!(row.user_triggerable_product_logic);
            assert!(row.owner.can_own_product_logic());
        }
    }

    #[test]
    fn s0_does_not_shift_the_v1_no_go_blocker_set() {
        // CLOSURE-SEMANTICS GUARD: both rebadged rows MUST remain NO-GO blockers — the
        // truth-fix lowers the claim (RustWiredDev) without removing either from
        // friday_v1_no_go_blockers(), so the GO/NO-GO verdict is unchanged.
        let blockers = friday_v1_no_go_blockers();
        assert!(
            blockers
                .iter()
                .any(|b| b.contains("real multi-turn live agent/tool execution")),
            "agent_tool_execution must stay a NO-GO blocker"
        );
        assert!(
            blockers.iter().any(|b| b.contains("test-only entrypoint")),
            "workflow_runtime must stay a NO-GO blocker (now flagged test-only)"
        );
    }

    #[test]
    fn ui_shell_is_explicitly_not_product_logic_owner() {
        let row = friday_v1_mechanism_matrix()
            .into_iter()
            .find(|row| row.id == "ui_shell")
            .unwrap();
        assert_eq!(row.owner, MechanismOwner::UiShellOnly);
        assert!(!row.user_triggerable_product_logic);
        assert_eq!(row.status, MechanismStatus::DesignFrozen);
    }
}
