//! Skills / plugins promotion-ladder state machine (PROOF-SKILLS-001 substrate).
//!
//! A PURE trust state machine — **no execution, no I/O**. An imported skill climbs
//! a one-rung-at-a-time ladder under EXPLICIT decisions; it is never auto-promoted
//! and never skips straight to `Runnable`. This mirrors the memory trust SM (a
//! candidate is not a fact until explicitly confirmed): an imported skill is not
//! runnable until it is explicitly reviewed up the ladder.
//!
//! Load-bearing invariants:
//! - **No skip-to-runnable** (`08`/file-58 PROOF-SKILLS-001): the only path to
//!   `Runnable` is `Candidate → Staged → Promoted → Runnable`, one rung per
//!   transition. A `Candidate` can NEVER jump to `Promoted`/`Runnable`.
//! - **Terminal decisions are final (no downgrade / no re-promote)**: `Rejected`
//!   and `RolledBack` are terminal — nothing transitions out of them.
//! - **Explicit rollback**: an installed skill (`Promoted`/`Runnable`) can be
//!   rolled back to the terminal `RolledBack`; a not-yet-installed one (`Candidate`/
//!   `Staged`) is `Rejected` instead.
//!
//! **HONEST SCOPE:** `Runnable` is an eligibility label, not execution. The Hub
//! owns the receipt bridge that records an operator-approved skill-run proof
//! against a Mission/WorkItem, but this core state machine still performs no I/O
//! and executes no imported skill code. A `Runnable` skill is "reviewed and
//! eligible for the gated run path", not "has run".
//!
//! **Where the no-skip invariant holds (future-wiring constraint):** the ladder
//! guarantee is a property of [`SkillState::try_transition`]/[`SkillState::next_rung`],
//! NOT of the type — like [`crate::WorkflowRunState`], the variants are public and so
//! `Runnable` is directly constructible. There is no caller, no executor, and no
//! deserialization/FFI reconstruction path today (nothing to harden yet). When that
//! wiring lands, a skill's state MUST originate at `Candidate` and advance ONLY
//! through the guarded API (a persisted/rehydrated state is data the writer is
//! responsible for having produced via the ladder) — direct assignment to a later
//! rung would bypass the no-skip review and must not be introduced.

use crate::error::CoreError;

/// A rung on the skill promotion ladder (or a terminal disposition).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillState {
    /// Freshly imported/discovered; not reviewed, not runnable.
    Candidate,
    /// Reviewed enough to stage (e.g. signed-import verified); still not runnable.
    Staged,
    /// Promoted (trusted) but not yet activated for running.
    Promoted,
    /// Eligible to run. INERT until a gate-routed executor exists (see module docs).
    Runnable,
    /// Terminal: refused before install (from `Candidate`/`Staged`).
    Rejected,
    /// Terminal: an installed skill (`Promoted`/`Runnable`) was rolled back.
    RolledBack,
}

impl SkillState {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkillState::Candidate => "candidate",
            SkillState::Staged => "staged",
            SkillState::Promoted => "promoted",
            SkillState::Runnable => "runnable",
            SkillState::Rejected => "rejected",
            SkillState::RolledBack => "rolled_back",
        }
    }

    /// A terminal disposition — no transition leaves it (no downgrade, no re-promote).
    pub fn is_terminal(&self) -> bool {
        matches!(self, SkillState::Rejected | SkillState::RolledBack)
    }

    /// Eligible for the gated run path. Reaching it does NOT mean the skill has run.
    pub fn is_runnable(&self) -> bool {
        matches!(self, SkillState::Runnable)
    }

    /// The allowed transitions. The promotion ladder advances exactly one rung at a
    /// time (`Candidate→Staged→Promoted→Runnable`); a pre-install state may be
    /// `Rejected`; an installed state may be `RolledBack`. No skips, no resurrection
    /// of a terminal state.
    pub fn can_transition_to(&self, next: SkillState) -> bool {
        use SkillState::*;
        matches!(
            (self, next),
            // one-rung promotion
            (Candidate, Staged)
                | (Staged, Promoted)
                | (Promoted, Runnable)
                // reject before install
                | (Candidate, Rejected)
                | (Staged, Rejected)
                // rollback after install
                | (Promoted, RolledBack)
                | (Runnable, RolledBack)
        )
    }

    /// Apply a transition or fail with [`CoreError::InvalidTransition`]. Refuses a
    /// skip-to-runnable, a backward move, and any transition out of a terminal state.
    pub fn try_transition(self, next: SkillState) -> Result<SkillState, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "skill",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }

    /// Advance exactly one rung up the promotion ladder (the non-terminal forward
    /// move), or `None` if there is no next rung (`Runnable` is the top; terminal
    /// states have none). This is the ONLY forward motion — there is no skip.
    pub fn next_rung(self) -> Option<SkillState> {
        match self {
            SkillState::Candidate => Some(SkillState::Staged),
            SkillState::Staged => Some(SkillState::Promoted),
            SkillState::Promoted => Some(SkillState::Runnable),
            SkillState::Runnable | SkillState::Rejected | SkillState::RolledBack => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ladder_advances_one_rung_only_no_skip() {
        // The full legitimate ladder, one rung at a time.
        let mut s = SkillState::Candidate;
        for rung in [
            SkillState::Staged,
            SkillState::Promoted,
            SkillState::Runnable,
        ] {
            s = s.try_transition(rung).expect("one-rung promotion allowed");
            assert_eq!(s, rung);
        }
        // NO skip-to-runnable / no rung-jumping.
        assert!(SkillState::Candidate
            .try_transition(SkillState::Runnable)
            .is_err());
        assert!(SkillState::Candidate
            .try_transition(SkillState::Promoted)
            .is_err());
        assert!(SkillState::Staged
            .try_transition(SkillState::Runnable)
            .is_err());
    }

    #[test]
    fn next_rung_matches_the_ladder_and_tops_out_at_runnable() {
        assert_eq!(SkillState::Candidate.next_rung(), Some(SkillState::Staged));
        assert_eq!(SkillState::Staged.next_rung(), Some(SkillState::Promoted));
        assert_eq!(SkillState::Promoted.next_rung(), Some(SkillState::Runnable));
        assert_eq!(SkillState::Runnable.next_rung(), None);
        assert_eq!(SkillState::Rejected.next_rung(), None);
        assert_eq!(SkillState::RolledBack.next_rung(), None);
    }

    #[test]
    fn reject_before_install_rollback_after_install() {
        // Reject is allowed pre-install (candidate/staged).
        assert!(SkillState::Candidate
            .try_transition(SkillState::Rejected)
            .is_ok());
        assert!(SkillState::Staged
            .try_transition(SkillState::Rejected)
            .is_ok());
        // Rollback is allowed post-install (promoted/runnable).
        assert!(SkillState::Promoted
            .try_transition(SkillState::RolledBack)
            .is_ok());
        assert!(SkillState::Runnable
            .try_transition(SkillState::RolledBack)
            .is_ok());
        // A not-yet-installed state cannot "rollback"; an installed one isn't "rejected".
        assert!(SkillState::Candidate
            .try_transition(SkillState::RolledBack)
            .is_err());
        assert!(SkillState::Runnable
            .try_transition(SkillState::Rejected)
            .is_err());
    }

    #[test]
    fn terminal_states_are_final_no_downgrade_no_repromote() {
        for terminal in [SkillState::Rejected, SkillState::RolledBack] {
            assert!(terminal.is_terminal());
            // nothing transitions OUT of a terminal state — incl. back to Runnable.
            for next in [
                SkillState::Candidate,
                SkillState::Staged,
                SkillState::Promoted,
                SkillState::Runnable,
                SkillState::Rejected,
                SkillState::RolledBack,
            ] {
                assert!(
                    terminal.try_transition(next).is_err(),
                    "{terminal:?} -> {next:?} must be refused (terminal is final)"
                );
            }
        }
    }

    #[test]
    fn runnable_is_eligibility_only_not_execution() {
        // Honest: Runnable is an eligibility label in core; the Hub receipt bridge
        // is still separate, so is_runnable() does not mean the skill has run.
        assert!(SkillState::Runnable.is_runnable());
        assert!(!SkillState::Promoted.is_runnable());
        assert!(!SkillState::Runnable.is_terminal());
    }

    #[test]
    fn no_backward_promotion() {
        assert!(SkillState::Promoted
            .try_transition(SkillState::Staged)
            .is_err());
        assert!(SkillState::Runnable
            .try_transition(SkillState::Promoted)
            .is_err());
        assert!(SkillState::Staged
            .try_transition(SkillState::Candidate)
            .is_err());
    }
}
