//! Context Passport object — the destination-bound, fail-closed-by-construction
//! carrier for an external context transfer (`07` §10, `02` §7/§12; north-star
//! loop closure, commit 2).
//!
//! The pure transfer gate already lives in [`crate::memory::gate_transfer`] (it blocks
//! a never-transferable secret/token item and requires explicit approval for a
//! sensitive item). What was MISSING is the *object* that binds those cleared items to
//! a SPECIFIC destination — so the Hub preflight can ask "does THIS passport authorize
//! THIS transfer to THIS lane/target?" rather than only "is a passport ref present?"
//! (the hollow check this object exists to replace).
//!
//! Fail-closed BY CONSTRUCTION: [`build_context_passport`] runs `gate_transfer`
//! internally, so a [`ContextPassport`] that clears a secret/raw-token item or an
//! unapproved sensitive item simply CANNOT be constructed — there is no struct-literal
//! escape (the fields are public for read, but the only constructor is the gated
//! builder, and the preflight rebuilds through it on load rather than trusting a stored
//! row).

use crate::error::CoreError;
use crate::memory::{gate_transfer, PassportItem};
use crate::mission::WorkLane;

/// A built, destination-bound Context Passport. Existence is proof that
/// [`gate_transfer`] cleared every included item for transfer (no secret/raw-token
/// content; sensitive items only with explicit approval).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextPassport {
    pub passport_id: String,
    pub mission_id: String,
    /// Optional: a passport may be scoped to one WorkItem, or to the Mission's transfer.
    pub work_item_id: Option<String>,
    /// The lane this passport authorizes a transfer TO.
    pub destination_lane: WorkLane,
    /// Optional concrete target (provider/agent/channel id). When present, a transfer
    /// must match it exactly; when `None`, the passport authorizes the whole lane.
    pub destination_target: Option<String>,
    /// The full item set (including non-included items) so a reload re-gates identically.
    pub items: Vec<PassportItem>,
    /// Whether sensitive items were explicitly approved when the passport was built.
    pub approved_sensitive: bool,
    pub created_at_ms: i64,
}

/// Build a Context Passport, GATING the item set by construction. Returns
/// [`CoreError::BlockedTransfer`] (the same error `gate_transfer` raises) if any
/// included item is a never-transferable secret/raw-token kind, or a sensitive item
/// without `approved_sensitive` — so a passport that would leak a secret can never
/// exist as a value.
#[allow(clippy::too_many_arguments)]
pub fn build_context_passport(
    passport_id: impl Into<String>,
    mission_id: impl Into<String>,
    work_item_id: Option<String>,
    destination_lane: WorkLane,
    destination_target: Option<String>,
    items: Vec<PassportItem>,
    approved_sensitive: bool,
    created_at_ms: i64,
) -> Result<ContextPassport, CoreError> {
    // The fail-closed core: if this errors, no ContextPassport value is produced.
    gate_transfer(&items, approved_sensitive)?;
    Ok(ContextPassport {
        passport_id: passport_id.into(),
        mission_id: mission_id.into(),
        work_item_id,
        destination_lane,
        destination_target,
        items,
        approved_sensitive,
        created_at_ms,
    })
}

impl ContextPassport {
    /// Whether this passport authorizes a transfer to `lane` (+ `target`). The
    /// destination BINDING the hollow ref-presence check could not see: the lane must
    /// match exactly, and if the passport carries a concrete target the request target
    /// must equal it. A passport with no target authorizes the whole lane.
    pub fn authorizes_transfer(&self, lane: WorkLane, target: Option<&str>) -> bool {
        if self.destination_lane != lane {
            return false;
        }
        match self.destination_target.as_deref() {
            Some(bound) => target == Some(bound),
            None => true,
        }
    }

    /// The included items this passport actually carries across the boundary — the
    /// record of WHAT was shared (so an audit can show the cleared payload, never the
    /// blocked/secret items, which `gate_transfer` already proved absent on build).
    pub fn shared_items(&self) -> Vec<&PassportItem> {
        self.items.iter().filter(|i| i.included).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::PassportItemKind;

    fn item(kind: PassportItemKind, label: &str, included: bool, sensitive: bool) -> PassportItem {
        PassportItem {
            kind,
            label: label.into(),
            included,
            sensitive,
        }
    }

    fn ok_items() -> Vec<PassportItem> {
        vec![
            item(PassportItemKind::Summary, "weekly plan", true, false),
            item(PassportItemKind::File, "design.md", true, false),
        ]
    }

    #[test]
    fn a_provider_secret_item_cannot_be_built_into_a_passport() {
        let items = vec![item(
            PassportItemKind::ProviderSecret,
            "deepseek key",
            true,
            true,
        )];
        let err = build_context_passport(
            "p1",
            "m1",
            None,
            WorkLane::Codex,
            Some("codex".into()),
            items,
            true,
            1,
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::BlockedTransfer(_)));
    }

    #[test]
    fn a_raw_token_item_cannot_be_built_into_a_passport() {
        let items = vec![item(PassportItemKind::RawToken, "bearer", true, false)];
        let err = build_context_passport("p1", "m1", None, WorkLane::Claude, None, items, false, 1)
            .unwrap_err();
        assert!(matches!(err, CoreError::BlockedTransfer(_)));
    }

    #[test]
    fn an_unapproved_sensitive_item_cannot_be_built_into_a_passport() {
        let items = vec![item(
            PassportItemKind::Summary,
            "salary figures",
            true,
            true,
        )];
        // approved_sensitive = false -> blocked by construction.
        let err = build_context_passport("p1", "m1", None, WorkLane::Codex, None, items, false, 1)
            .unwrap_err();
        assert!(matches!(err, CoreError::BlockedTransfer(_)));

        // The SAME item with explicit approval builds.
        let items = vec![item(
            PassportItemKind::Summary,
            "salary figures",
            true,
            true,
        )];
        let ok = build_context_passport("p1", "m1", None, WorkLane::Codex, None, items, true, 1);
        assert!(ok.is_ok());
    }

    #[test]
    fn authorizes_only_the_bound_lane_and_target() {
        let p = build_context_passport(
            "p1",
            "m1",
            None,
            WorkLane::Codex,
            Some("codex".into()),
            ok_items(),
            false,
            1,
        )
        .unwrap();

        assert!(p.authorizes_transfer(WorkLane::Codex, Some("codex")));
        // Wrong lane.
        assert!(!p.authorizes_transfer(WorkLane::Claude, Some("codex")));
        // Wrong target.
        assert!(!p.authorizes_transfer(WorkLane::Codex, Some("claude")));
        // Missing target where one is bound.
        assert!(!p.authorizes_transfer(WorkLane::Codex, None));
    }

    #[test]
    fn an_untargeted_passport_authorizes_the_whole_lane() {
        let p = build_context_passport(
            "p1",
            "m1",
            None,
            WorkLane::Channel,
            None,
            ok_items(),
            false,
            1,
        )
        .unwrap();
        assert!(p.authorizes_transfer(WorkLane::Channel, Some("telegram:1")));
        assert!(p.authorizes_transfer(WorkLane::Channel, None));
        assert!(!p.authorizes_transfer(WorkLane::Codex, None));
    }

    #[test]
    fn shared_items_are_only_the_included_ones() {
        let items = vec![
            item(PassportItemKind::Summary, "included", true, false),
            item(PassportItemKind::File, "excluded", false, false),
        ];
        let p = build_context_passport("p1", "m1", None, WorkLane::Codex, None, items, false, 1)
            .unwrap();
        let shared = p.shared_items();
        assert_eq!(shared.len(), 1);
        assert_eq!(shared[0].label, "included");
    }
}
