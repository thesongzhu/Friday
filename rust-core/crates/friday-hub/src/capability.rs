//! UNW-016 — capability route table + truth-labeled disabled-route stubs + Command Sheet
//! entrypoint resolver.
//!
//! The composition-time half of the oracle's capability-disabled mechanism
//! (`throwFridayCapabilityDisabled` → `CAPABILITY_DISABLED` `{capability, surface,
//! state:"disabled"}`): a capability that is NOT wired resolves to a **truth-labeled**
//! [`CapabilityResolution::Disabled`] carrying its status + exact blocker — NEVER a silent
//! no-op, NEVER a fake-ready response. This closes the design-to-runtime contract's
//! `menu_command_sheet_entrypoints` orphan: every Command Sheet command resolves to either a
//! real route (`Routed`) or a truth-labeled disabled stub, and an unregistered command/
//! capability fails closed (`Unknown`) — never a default/fake route ("无孤儿交互", "no
//! fake-ready UI").
//!
//! ## Honest scope (v1 = NO-GO)
//! This delivers the **composition-root** capability table + the truth-labeled disabled
//! **resolution carrier** + the Command Sheet resolver. The oracle's UNW-016 also has an
//! **HTTP route-family** half (mapping `Disabled` to a 501 `CAPABILITY_DISABLED` response);
//! Rust v1 has **no HTTP API**, so that half stays NO-GO. A future HTTP/UI layer maps a
//! `Disabled` resolution to its surface (501 / a truth-labeled disabled button); this module
//! is the runtime resolution it consumes. It does not itself execute a wired capability — a
//! `Routed` resolution hands off to the agent loop ([`crate::runtime::HubRuntime::run_task`]).

use std::collections::BTreeMap;

/// A capability's runtime status (mirrors the contract registry status enum, minus the
/// doc-only `historical`/`release_only` which are not user-routable commands).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapabilityStatus {
    Wired,
    NoGo,
    OperatorGated,
    ExternalBlocked,
}

impl CapabilityStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            CapabilityStatus::Wired => "wired",
            CapabilityStatus::NoGo => "NO-GO",
            CapabilityStatus::OperatorGated => "operator_gated",
            CapabilityStatus::ExternalBlocked => "external_blocked",
        }
    }
    /// Only a `Wired` capability is dispatchable; everything else resolves to a truth-labeled
    /// disabled stub.
    pub fn is_dispatchable(&self) -> bool {
        matches!(self, CapabilityStatus::Wired)
    }
}

/// One capability route-table entry. Sealed construction enforces the truth-label invariant:
/// a non-`Wired` entry MUST carry a non-empty exact blocker (no silent/untruth-labeled
/// disabled capability can exist).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityEntry {
    id: String,
    status: CapabilityStatus,
    blocker: Option<String>,
}

impl CapabilityEntry {
    /// A wired (dispatchable) capability — no blocker.
    pub fn wired(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            status: CapabilityStatus::Wired,
            blocker: None,
        }
    }
    /// A non-wired capability with its EXACT blocker (truth-label). Panics on an empty
    /// blocker — a disabled capability without a blocker would be an untruth-labeled stub,
    /// which the contract forbids. `status` must not be `Wired` (use [`CapabilityEntry::wired`]).
    pub fn disabled(
        id: impl Into<String>,
        status: CapabilityStatus,
        blocker: impl Into<String>,
    ) -> Self {
        let blocker = blocker.into();
        assert!(
            !status.is_dispatchable(),
            "use CapabilityEntry::wired for a Wired capability"
        );
        assert!(
            !blocker.trim().is_empty(),
            "a disabled capability MUST carry a non-empty exact blocker (no untruth-labeled stub)"
        );
        Self {
            id: id.into(),
            status,
            blocker: Some(blocker),
        }
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn status(&self) -> CapabilityStatus {
        self.status
    }
    pub fn blocker(&self) -> Option<&str> {
        self.blocker.as_deref()
    }
}

/// The result of resolving a capability id or a Command Sheet command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityResolution {
    /// Wired → dispatchable; the caller proceeds to the runtime (the agent loop).
    Routed { id: String },
    /// Not wired → a TRUTH-LABELED disabled stub (mirrors `throwFridayCapabilityDisabled`:
    /// `state:"disabled"` + capability + surface + the exact blocker). Never a fake-ready
    /// response, never a silent no-op.
    Disabled {
        capability: String,
        surface: String,
        status: CapabilityStatus,
        blocker: String,
    },
    /// The command/capability is not registered → fail closed (never a default/fake route).
    Unknown(String),
}

impl CapabilityResolution {
    pub fn is_routed(&self) -> bool {
        matches!(self, CapabilityResolution::Routed { .. })
    }
    pub fn is_disabled(&self) -> bool {
        matches!(self, CapabilityResolution::Disabled { .. })
    }
    /// The constant `state` label a disabled resolution carries (oracle parity).
    pub const DISABLED_STATE: &'static str = "disabled";
}

/// The capability route table: capability_id → entry. Resolving a non-wired capability yields
/// a truth-labeled `Disabled`; an unregistered id yields `Unknown` (fail-closed).
#[derive(Clone, Debug, Default)]
pub struct CapabilityRouteTable {
    entries: BTreeMap<String, CapabilityEntry>,
}

impl CapabilityRouteTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, entry: CapabilityEntry) {
        self.entries.insert(entry.id.clone(), entry);
    }

    pub fn get(&self, capability_id: &str) -> Option<&CapabilityEntry> {
        self.entries.get(capability_id)
    }

    /// Resolve a capability id on a given `surface` (e.g. "mobile"/"desktop"/"telegram").
    /// Wired → `Routed`; non-wired → truth-labeled `Disabled`; unregistered → `Unknown`.
    pub fn resolve(&self, capability_id: &str, surface: &str) -> CapabilityResolution {
        match self.entries.get(capability_id) {
            None => CapabilityResolution::Unknown(capability_id.to_string()),
            Some(e) if e.status.is_dispatchable() => {
                CapabilityResolution::Routed { id: e.id.clone() }
            }
            Some(e) => CapabilityResolution::Disabled {
                capability: e.id.clone(),
                surface: surface.to_string(),
                status: e.status,
                // Sealed construction (CapabilityEntry::disabled) guarantees a non-empty
                // blocker for every non-Wired entry — so this `.expect` is unreachable. We
                // assert it rather than substitute a fake string, keeping the truth-label
                // invariant self-documenting (a future regression would panic, not silently
                // emit an untruth-labeled disabled stub).
                blocker: e.blocker.clone().expect(
                    "non-Wired CapabilityEntry always carries a blocker (sealed construction)",
                ),
            },
        }
    }

    /// A baseline table seeded from the design-to-runtime contract (file 56), current to main.
    /// Wired = the agent-loop/runtime capabilities; NO-GO/gated = the XL/gated families, each
    /// with its exact blocker (so a disabled resolution is always truth-labeled).
    pub fn friday_baseline() -> Self {
        // NOTE (traceability): these capability ids are short, surface-friendly aliases of the
        // verbatim file-56 contract rows (e.g. `agent_loop_run_task` ↔
        // `agent_loop_planning_clarify_approval_dangerous_action`; `approval_pocket_decision` ↔
        // `security_approval_bound_principal_gate_cat10_netnew`). Each alias maps to a row whose
        // status here matches the contract — no status is misrepresented by the renaming.
        let mut t = Self::new();
        // Wired (dispatchable) — agent-loop substrate + runtime, proven on main.
        for w in [
            "agent_loop_run_task",
            "memory_review_no_silent_write",
            "activity_needs_me_inbox",
            "approval_pocket_decision",
            "token_ledger_spend_cost",
            "provider_routing_decision_layer",
            "tool_execution_file_rw",
        ] {
            t.register(CapabilityEntry::wired(w));
        }
        // NO-GO (no Rust owner yet) — exact blocker per the contract.
        for (id, blk) in [
            ("session_control_full_native", "no provider session list/open/stop/approve/transcript-streaming subsystem (full Codex/Claude parity NO-GO)"),
            ("context_passport_backend", "no Context Passport backend/FFI projection subsystem"),
            ("workflow_builder", "no workflow execution engine (only run/step persistence + completion gate)"),
            ("channel_config_telegram", "no Rust channels/connectors/trusted-inbound subsystem"),
            ("skills_lifecycle", "no skills/plugin promotion+execution subsystem"),
            ("memory_cognition_recall", "no recall/ranking/PII-decay cognition pipeline (PROOF-MEMORY-001 unbuilt)"),
            ("self_heal", "no self-heal/repair subsystem"),
        ] {
            t.register(CapabilityEntry::disabled(id, CapabilityStatus::NoGo, blk));
        }
        // operator_gated — built/partly-built, blocked on an operator decision.
        t.register(CapabilityEntry::disabled(
            "design_baseline_ui",
            CapabilityStatus::OperatorGated,
            "operator must confirm the saved design baseline for wiring (truthLabel='Design proof only / no runtime PASS')",
        ));
        // external_blocked — matches the freshest contract row (file 56 line 184,
        // GATED_multi_provider_routing_fallback_resilience): the env has only DeepSeek
        // (anthropic secret empty), in addition to Codex/Claude login being absent.
        t.register(CapabilityEntry::disabled(
            "multi_provider_live_routing",
            CapabilityStatus::ExternalBlocked,
            "env has only DeepSeek (anthropic secret empty) + Codex/Claude login (OAuth/CLI) not present; decision layer #487 live on DeepSeek only",
        ));
        // external_blocked.
        t.register(CapabilityEntry::disabled(
            "hub_phone_sync",
            CapabilityStatus::ExternalBlocked,
            "real LAN/Tailscale network + a second physical device required",
        ));
        t
    }
}

/// The Command Sheet entrypoint resolver: a menu/command label → capability id. Resolving a
/// command routes through the [`CapabilityRouteTable`]; an unregistered command fails closed
/// (`Unknown`) — never a default/fake route. This is what gives the saved-design Command Sheet
/// a runtime owner (closing the contract orphan).
#[derive(Clone, Debug, Default)]
pub struct CommandSheet {
    commands: BTreeMap<String, String>,
}

impl CommandSheet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Map a Command Sheet command label to the capability id it invokes.
    pub fn register(&mut self, command: impl Into<String>, capability_id: impl Into<String>) {
        self.commands.insert(command.into(), capability_id.into());
    }

    /// Resolve a Command Sheet `command` on `surface` through `table`. An unregistered command
    /// fails closed (`Unknown`) — a quick command can never be a fake/default route.
    pub fn resolve(
        &self,
        command: &str,
        surface: &str,
        table: &CapabilityRouteTable,
    ) -> CapabilityResolution {
        match self.commands.get(command) {
            None => CapabilityResolution::Unknown(format!("command:{command}")),
            Some(cap) => table.resolve(cap, surface),
        }
    }

    /// The saved-design (`menuModel = Command Sheet`) baseline: each saved Command Sheet
    /// command mapped to its capability id (so every saved command resolves to Routed or a
    /// truth-labeled Disabled — no orphan). Pairs with [`CapabilityRouteTable::friday_baseline`].
    pub fn saved_design_baseline() -> Self {
        let mut s = Self::new();
        for (cmd, cap) in [
            ("Ask Friday", "agent_loop_run_task"),
            ("Needs Me", "activity_needs_me_inbox"),
            ("Approvals", "approval_pocket_decision"),
            ("Memory Review", "memory_review_no_silent_write"),
            ("Activity", "activity_needs_me_inbox"),
            ("Token / Trust", "token_ledger_spend_cost"),
            ("Session Control", "session_control_full_native"),
            ("Context Passport", "context_passport_backend"),
            ("Provider Workspace", "session_control_full_native"),
            ("Workflow Builder", "workflow_builder"),
            ("Channel Config", "channel_config_telegram"),
        ] {
            s.register(cmd, cap);
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_wired_routes_disabled_is_truth_labeled_unknown_fails_closed() {
        let t = CapabilityRouteTable::friday_baseline();
        // wired → Routed
        assert!(t.resolve("agent_loop_run_task", "mobile").is_routed());
        // NO-GO → truth-labeled Disabled (state "disabled" + capability + surface + blocker)
        match t.resolve("session_control_full_native", "mobile") {
            CapabilityResolution::Disabled {
                capability,
                surface,
                status,
                blocker,
            } => {
                assert_eq!(capability, "session_control_full_native");
                assert_eq!(surface, "mobile");
                assert_eq!(status, CapabilityStatus::NoGo);
                assert!(
                    !blocker.trim().is_empty(),
                    "disabled stub carries the exact blocker"
                );
            }
            other => panic!("NO-GO must resolve Disabled (truth-labeled), got {other:?}"),
        }
        // unregistered → Unknown (fail-closed, never a default route)
        assert!(matches!(
            t.resolve("does_not_exist", "mobile"),
            CapabilityResolution::Unknown(_)
        ));
    }

    #[test]
    fn operator_gated_and_external_blocked_resolve_disabled_not_routed() {
        let t = CapabilityRouteTable::friday_baseline();
        for (id, want) in [
            ("design_baseline_ui", CapabilityStatus::OperatorGated),
            (
                "multi_provider_live_routing",
                CapabilityStatus::ExternalBlocked,
            ),
            ("hub_phone_sync", CapabilityStatus::ExternalBlocked),
        ] {
            match t.resolve(id, "desktop") {
                CapabilityResolution::Disabled {
                    status, blocker, ..
                } => {
                    assert_eq!(status, want);
                    assert!(!blocker.is_empty());
                }
                other => panic!("{id} must be Disabled, got {other:?}"),
            }
            // ADVERSE: a non-wired capability must NEVER resolve Routed (no fake-ready).
            assert!(!t.resolve(id, "desktop").is_routed());
        }
    }

    #[test]
    fn self_heal_is_not_labeled_no_go_once_autofix_rollback_path_exists() {
        let t = CapabilityRouteTable::friday_baseline();
        match t.resolve("self_heal", "desktop") {
            CapabilityResolution::Disabled {
                status, blocker, ..
            } => {
                assert_eq!(
                    status,
                    CapabilityStatus::OperatorGated,
                    "B6: self_heal has an auto-fix execution + rollback path; the truth label must not keep claiming NO-GO"
                );
                assert!(
                    blocker.contains("auto-fix") && blocker.contains("rollback"),
                    "B6 blocker must point at the gated auto-fix/rollback path, got {blocker:?}"
                );
            }
            other => panic!("self_heal must stay disabled/gated until production ownership is enabled, got {other:?}"),
        }
    }

    #[test]
    #[should_panic(expected = "non-empty exact blocker")]
    fn disabled_entry_without_blocker_is_rejected() {
        // A disabled capability without a truth-label blocker is structurally forbidden.
        let _ = CapabilityEntry::disabled("x", CapabilityStatus::NoGo, "   ");
    }

    #[test]
    #[should_panic(expected = "use CapabilityEntry::wired")]
    fn disabled_with_wired_status_is_rejected() {
        let _ = CapabilityEntry::disabled("x", CapabilityStatus::Wired, "blk");
    }

    #[test]
    fn command_sheet_resolves_known_routes_unknown_command_fails_closed() {
        let t = CapabilityRouteTable::friday_baseline();
        let s = CommandSheet::saved_design_baseline();
        // a wired command → Routed
        assert!(s.resolve("Memory Review", "mobile", &t).is_routed());
        // a command backed by a NO-GO capability → truth-labeled Disabled (not a dead button)
        assert!(s.resolve("Workflow Builder", "desktop", &t).is_disabled());
        assert!(s.resolve("Channel Config", "desktop", &t).is_disabled());
        // an unregistered command → Unknown (fail-closed, never a default route)
        assert!(matches!(
            s.resolve("Self Destruct", "mobile", &t),
            CapabilityResolution::Unknown(_)
        ));
    }

    #[test]
    fn every_saved_command_resolves_no_orphan() {
        // 无孤儿交互: every saved Command Sheet command resolves to Routed or a truth-labeled
        // Disabled — never Unknown (each saved command maps to a registered capability).
        let t = CapabilityRouteTable::friday_baseline();
        let s = CommandSheet::saved_design_baseline();
        for cmd in [
            "Ask Friday",
            "Needs Me",
            "Approvals",
            "Memory Review",
            "Activity",
            "Token / Trust",
            "Session Control",
            "Context Passport",
            "Provider Workspace",
            "Workflow Builder",
            "Channel Config",
        ] {
            let r = s.resolve(cmd, "mobile", &t);
            assert!(
                r.is_routed() || r.is_disabled(),
                "saved command {cmd:?} is an ORPHAN (resolved {r:?})"
            );
        }
    }
}
