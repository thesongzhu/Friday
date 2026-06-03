//! Memory trust + Context Passport gating (`07`, `02` §11/§12). Pure logic.
//!
//! Load-bearing invariants:
//! - **No silent long-term writes** (`07` §6/§7): daily extraction produces
//!   *candidates*; a candidate becomes durable (`Confirmed`) ONLY by explicit
//!   user confirmation. There is no path that auto-confirms.
//! - **Candidates/inferred are not facts** (`07` §9, `02` §12): only `Confirmed`
//!   memory and high-confidence current context are auto-usable; inferred
//!   preference is temporary; a candidate is never treated as fact.
//! - **Conflicts produce a choice** (`07` §8): keep / replace / merge / ignore.
//! - **Context Passport gates external transfer** (`07` §10, `02` §7): provider
//!   secrets / raw tokens never transfer; a sensitive included item needs
//!   explicit approval; only included items transfer.

use crate::error::CoreError;

/// Layer/scope of a memory item (`02` §11).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryScope {
    Global,
    Project,
    Session,
}

impl MemoryScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryScope::Global => "global",
            MemoryScope::Project => "project",
            MemoryScope::Session => "session",
        }
    }
}

/// Confidence tier (`07` §9 / `02` §12).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Confidence {
    Confirmed,
    HighConfidenceContext,
    Inferred,
    Candidate,
}

impl Confidence {
    /// Confirmed memory + high-confidence current context are auto-usable;
    /// inferred preference is temporary-only and candidates are NOT facts.
    pub fn auto_usable(&self) -> bool {
        matches!(
            self,
            Confidence::Confirmed | Confidence::HighConfidenceContext
        )
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Confidence::Confirmed => "confirmed",
            Confidence::HighConfidenceContext => "high_confidence_context",
            Confidence::Inferred => "inferred",
            Confidence::Candidate => "candidate",
        }
    }
}

/// Lifecycle of a long-term memory item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryState {
    Candidate,
    Confirmed,
    Rejected,
}

impl MemoryState {
    /// Durable (usable as long-term fact) only when `Confirmed`.
    pub fn is_durable(&self) -> bool {
        matches!(self, MemoryState::Confirmed)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            MemoryState::Candidate => "candidate",
            MemoryState::Confirmed => "confirmed",
            MemoryState::Rejected => "rejected",
        }
    }

    /// A terminal lifecycle state. A `Confirmed` or `Rejected` item is not a
    /// pending candidate and is not re-decidable (no silent re-write / no
    /// downgrade); only a `Candidate` is awaiting the user's decision.
    pub fn is_terminal(&self) -> bool {
        matches!(self, MemoryState::Confirmed | MemoryState::Rejected)
    }
}

/// Apply the user's decision to a memory candidate. A candidate becomes
/// `Confirmed` ONLY with explicit confirmation; otherwise it stays a candidate
/// (pending) or is rejected — never silently written.
pub fn decide_candidate(state: MemoryState, user_confirmed: Option<bool>) -> MemoryState {
    match (state, user_confirmed) {
        (MemoryState::Candidate, Some(true)) => MemoryState::Confirmed,
        (MemoryState::Candidate, Some(false)) => MemoryState::Rejected,
        (MemoryState::Candidate, None) => MemoryState::Candidate, // still pending; not written
        (other, _) => other,
    }
}

/// Choice-card options when a candidate conflicts with existing memory (`07` §8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictResolution {
    KeepOld,
    Replace,
    Merge,
    Ignore,
}

/// Resolve a conflict between existing memory and a candidate. Returns the new
/// durable content, or `None` when nothing is persisted (`Ignore`).
pub fn resolve_conflict(res: ConflictResolution, old: &str, candidate: &str) -> Option<String> {
    match res {
        ConflictResolution::KeepOld => Some(old.to_string()),
        ConflictResolution::Replace => Some(candidate.to_string()),
        ConflictResolution::Merge => Some(format!("{old}\n{candidate}")),
        ConflictResolution::Ignore => None,
    }
}

/// Kinds of Context Passport items (`07` §10, `02` §7).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PassportItemKind {
    MemorySnippet,
    Summary,
    File,
    Screenshot,
    Attachment,
    /// Must NEVER leave the Hub.
    ProviderSecret,
    /// Must NEVER leave the Hub.
    RawToken,
}

impl PassportItemKind {
    /// Kinds that may never be transferred externally under any circumstance.
    pub fn is_never_transferable(&self) -> bool {
        matches!(
            self,
            PassportItemKind::ProviderSecret | PassportItemKind::RawToken
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PassportItem {
    pub kind: PassportItemKind,
    pub label: String,
    pub included: bool,
    pub sensitive: bool,
}

/// Gate an external context transfer (`07` §10, `02` §7/§12):
/// - a secret/raw-token kind that is included is a hard block (never transfers);
/// - a sensitive included item requires explicit approval;
/// - only included items transfer.
///
/// Returns the items cleared to transfer, or `BlockedTransfer` with the reason.
pub fn gate_transfer(
    items: &[PassportItem],
    approved_sensitive: bool,
) -> Result<Vec<&PassportItem>, CoreError> {
    for it in items.iter().filter(|i| i.included) {
        if it.kind.is_never_transferable() {
            return Err(CoreError::BlockedTransfer(format!(
                "secret-kind item '{}' must never be transferred",
                it.label
            )));
        }
        if it.sensitive && !approved_sensitive {
            return Err(CoreError::BlockedTransfer(format!(
                "sensitive item '{}' requires explicit approval",
                it.label
            )));
        }
    }
    Ok(items.iter().filter(|i| i.included).collect())
}

/// A phone-safe, REDACTED projection of a Context Passport item (`07` §10). The Hub holds the
/// real passport; this is what may be PROJECTED to the phone/UI (the "Checklist Sheet"). A
/// never-transferable kind (`ProviderSecret`/`RawToken`) or any `sensitive` item has its `label`
/// replaced with a generic redaction marker — the secret label/value NEVER leaves the Hub — and
/// a never-transferable item is `transferable: false`. A reader sees THAT a secret is in context
/// (so automation stays visible) but not WHAT it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedactedPassportItem {
    pub kind: PassportItemKind,
    pub label: String,
    pub included: bool,
    pub transferable: bool,
    pub redacted: bool,
}

fn redacted_label(kind: PassportItemKind) -> &'static str {
    match kind {
        PassportItemKind::ProviderSecret => "[redacted: provider secret]",
        PassportItemKind::RawToken => "[redacted: raw token]",
        _ => "[redacted: sensitive]",
    }
}

/// Project passport items into their phone-safe redacted form. The redaction boundary: a
/// never-transferable (secret/token) kind OR a `sensitive` item has its real label replaced by a
/// generic marker (the secret never projects); `transferable` is `false` for never-transferable
/// kinds (consistent with [`gate_transfer`]). Non-sensitive ordinary items project their real
/// label. This is the SOLE projection used to surface the passport off the Hub.
pub fn redact_passport_for_projection(items: &[PassportItem]) -> Vec<RedactedPassportItem> {
    items
        .iter()
        .map(|it| {
            let never = it.kind.is_never_transferable();
            let redact = never || it.sensitive;
            RedactedPassportItem {
                kind: it.kind,
                label: if redact {
                    redacted_label(it.kind).to_string()
                } else {
                    it.label.clone()
                },
                included: it.included,
                transferable: !never,
                redacted: redact,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_confirmed_and_high_confidence_are_auto_usable() {
        assert!(Confidence::Confirmed.auto_usable());
        assert!(Confidence::HighConfidenceContext.auto_usable());
        assert!(!Confidence::Inferred.auto_usable()); // temporary only
        assert!(!Confidence::Candidate.auto_usable()); // not a fact
    }

    #[test]
    fn candidate_is_never_silently_written() {
        // No decision -> stays pending (NOT durable).
        let pending = decide_candidate(MemoryState::Candidate, None);
        assert_eq!(pending, MemoryState::Candidate);
        assert!(!pending.is_durable());
        // Explicit confirm -> durable.
        assert_eq!(
            decide_candidate(MemoryState::Candidate, Some(true)),
            MemoryState::Confirmed
        );
        assert!(MemoryState::Confirmed.is_durable());
        // Explicit reject -> rejected, not durable.
        assert_eq!(
            decide_candidate(MemoryState::Candidate, Some(false)),
            MemoryState::Rejected
        );
        assert!(!MemoryState::Rejected.is_durable());
    }

    #[test]
    fn conflict_choice_card_options() {
        assert_eq!(
            resolve_conflict(ConflictResolution::KeepOld, "old", "new").as_deref(),
            Some("old")
        );
        assert_eq!(
            resolve_conflict(ConflictResolution::Replace, "old", "new").as_deref(),
            Some("new")
        );
        assert_eq!(
            resolve_conflict(ConflictResolution::Merge, "old", "new").as_deref(),
            Some("old\nnew")
        );
        assert_eq!(
            resolve_conflict(ConflictResolution::Ignore, "old", "new"),
            None
        );
    }

    #[test]
    fn context_passport_blocks_secrets_and_unapproved_sensitive() {
        let items = vec![
            PassportItem {
                kind: PassportItemKind::Summary,
                label: "summary".into(),
                included: true,
                sensitive: false,
            },
            PassportItem {
                kind: PassportItemKind::File,
                label: "diff.patch".into(),
                included: true,
                sensitive: false,
            },
            PassportItem {
                kind: PassportItemKind::Screenshot,
                label: "private.png".into(),
                included: false,
                sensitive: true,
            },
        ];
        // Non-sensitive included items transfer; excluded sensitive one is not in scope.
        let cleared = gate_transfer(&items, false).unwrap();
        assert_eq!(cleared.len(), 2);

        // A secret-kind included item is a hard block.
        let mut with_secret = items.clone();
        with_secret.push(PassportItem {
            kind: PassportItemKind::ProviderSecret,
            label: "deepseek".into(),
            included: true,
            sensitive: true,
        });
        assert!(matches!(
            gate_transfer(&with_secret, true),
            Err(CoreError::BlockedTransfer(_))
        ));

        // A sensitive included item needs explicit approval.
        let mut with_sensitive = items.clone();
        with_sensitive[2].included = true; // the private screenshot
        assert!(matches!(
            gate_transfer(&with_sensitive, false),
            Err(CoreError::BlockedTransfer(_))
        ));
        // ...and transfers once approved.
        assert_eq!(gate_transfer(&with_sensitive, true).unwrap().len(), 3);
    }

    #[test]
    fn scopes_are_distinct() {
        assert_ne!(MemoryScope::Global, MemoryScope::Project);
        assert_ne!(MemoryScope::Project, MemoryScope::Session);
        assert_ne!(MemoryScope::Global, MemoryScope::Session);
    }

    #[test]
    fn memory_state_terminality_matches_durability_semantics() {
        // A Candidate is awaiting the user's decision -> NOT terminal, re-decidable.
        assert!(!MemoryState::Candidate.is_terminal());
        // Confirmed/Rejected are terminal: no silent re-write, no downgrade.
        assert!(MemoryState::Confirmed.is_terminal());
        assert!(MemoryState::Rejected.is_terminal());
        // Only Confirmed is durable; a terminal Rejected is NOT durable.
        assert!(MemoryState::Confirmed.is_durable());
        assert!(!MemoryState::Rejected.is_durable());
    }

    #[test]
    fn enum_wire_strings_are_stable_and_distinct() {
        // These strings are persisted; they must be stable + mutually distinct.
        assert_eq!(MemoryScope::Global.as_str(), "global");
        assert_eq!(MemoryState::Candidate.as_str(), "candidate");
        assert_eq!(Confidence::Confirmed.as_str(), "confirmed");
        // A confirmed Confidence and a confirmed MemoryState share the wire token
        // (same lifecycle point) — intended, the repo keeps them consistent.
        assert_eq!(
            Confidence::Confirmed.as_str(),
            MemoryState::Confirmed.as_str()
        );
        assert_ne!(
            Confidence::Inferred.as_str(),
            Confidence::Candidate.as_str()
        );
    }

    #[test]
    fn secret_kinds_block_regardless_of_flags() {
        // The kind-block is independent of the `sensitive` flag and cannot be
        // overridden by approval: a secret-bearing kind blocks even when
        // sensitive=false AND approved_sensitive=true.
        for kind in [PassportItemKind::ProviderSecret, PassportItemKind::RawToken] {
            let items = vec![PassportItem {
                kind,
                label: "k".into(),
                included: true,
                sensitive: false,
            }];
            assert!(
                matches!(
                    gate_transfer(&items, false),
                    Err(CoreError::BlockedTransfer(_))
                ),
                "{kind:?} must block (sensitive=false, approved=false)"
            );
            assert!(
                matches!(
                    gate_transfer(&items, true),
                    Err(CoreError::BlockedTransfer(_))
                ),
                "{kind:?} must block even when approved=true"
            );
        }
    }

    fn item(kind: PassportItemKind, label: &str, sensitive: bool) -> PassportItem {
        PassportItem {
            kind,
            label: label.to_string(),
            included: true,
            sensitive,
        }
    }

    #[test]
    fn redact_projection_never_leaks_secret_label_and_marks_non_transferable() {
        let items = vec![
            item(PassportItemKind::MemorySnippet, "prefers rust", false),
            item(PassportItemKind::Summary, "weekly plan", false),
            item(
                PassportItemKind::ProviderSecret,
                "DEEPSEEK_API_KEY=sk-LEAK",
                true,
            ),
            item(PassportItemKind::RawToken, "Bearer eyJLEAK", false),
            item(PassportItemKind::File, "confidential.txt", true), // sensitive non-secret
        ];
        let proj = redact_passport_for_projection(&items);

        // ordinary non-sensitive items project their REAL label, transferable, not redacted.
        assert_eq!(proj[0].label, "prefers rust");
        assert!(proj[0].transferable && !proj[0].redacted);
        assert_eq!(proj[1].label, "weekly plan");

        // never-transferable kinds: label redacted + transferable=false + redacted=true.
        assert_eq!(proj[2].label, "[redacted: provider secret]");
        assert!(!proj[2].transferable && proj[2].redacted);
        assert_eq!(proj[3].label, "[redacted: raw token]");
        assert!(!proj[3].transferable && proj[3].redacted);

        // sensitive non-secret: label redacted + redacted=true, but still transferable (w/ approval).
        assert_eq!(proj[4].label, "[redacted: sensitive]");
        assert!(proj[4].transferable && proj[4].redacted);

        // ADVERSE: the projection's labels NEVER contain the raw secret material.
        for r in &proj {
            assert!(
                !r.label.contains("sk-LEAK"),
                "secret value leaked: {}",
                r.label
            );
            assert!(!r.label.contains("eyJLEAK"), "token leaked: {}", r.label);
            assert!(
                !r.label.contains("DEEPSEEK_API_KEY"),
                "secret label leaked: {}",
                r.label
            );
        }
    }

    #[test]
    fn redact_projection_transferable_matches_gate_transfer() {
        // a never-transferable kind is non-transferable in BOTH the projection and gate_transfer.
        let secret = vec![item(PassportItemKind::ProviderSecret, "k", true)];
        assert!(!redact_passport_for_projection(&secret)[0].transferable);
        assert!(matches!(
            gate_transfer(&secret, true),
            Err(CoreError::BlockedTransfer(_))
        ));
        // an ordinary item is transferable in both.
        let ok = vec![item(PassportItemKind::MemorySnippet, "x", false)];
        assert!(redact_passport_for_projection(&ok)[0].transferable);
        assert!(gate_transfer(&ok, false).is_ok());
    }
}
