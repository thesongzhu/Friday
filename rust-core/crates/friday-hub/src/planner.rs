//! Step-5 substrate — the workflow PLANNER (decision layer) + a minimal,
//! gate-anchored workflow DEFINITION type.
//!
//! PURE: the planner decides, per step, whether Friday may **auto-advance** it or
//! must raise a **checkpoint** (`08` §4 "semi-automatic: Friday advances safe
//! steps; commands / provider sends / memory transfer / release-deploy /
//! destructive / high-risk require approval"). It does NOT execute anything —
//! execution is the deferred, operator-gated workflow engine.
//!
//! ## The discriminating constraint: the gate is the FLOOR (never a free flag)
//! "Safe to auto-advance" is NOT a field the template sets. A step's disposition is
//! anchored to the SAME classifier the agent tool loop uses
//! ([`crate::trusted_classify`] → `friday_core::gate`): a **mutating** or
//! **high-risk** (`>= Risk::High`) action ALWAYS checkpoints, regardless of the
//! template. The template's `force_checkpoint` may only **NARROW** (turn an
//! otherwise-auto step into a checkpoint), NEVER **widen** — it cannot mark a
//! mutating/destructive step "safe". An unregistered/unclassifiable action fails
//! **CLOSED** to a checkpoint. The model contributes only param strings; it can
//! never lower `mutating` or the risk floor (UNW-001/UNW-002 discipline).
//!
//! ## `AutoAdvance` is a PREVIEW, not an authorization
//! The planner is a decision/preview layer; it does NOT authorize. When the executor
//! runs a step it MUST still go through the full UNW-001 gate
//! (`authorize_mutating_action`), which applies the mutating-side escalations the
//! planner does not reproduce — bound-principal (an agent cannot self-execute an
//! approve/deny), local-guard `Deny` claims, and `derive_risk` raises. So any
//! planner-vs-gate divergence is fail-SAFE (the gate can only ADD approval at
//! execution, never remove it), and a plan `AutoAdvance` must never be treated as a
//! grant that lets the executor skip the gate.
//!
//! Sensitive resources (`#389`/`#494`): the planner screens the classifier's extracted
//! resource with `is_sensitive_resource`, so even a READ of a sensitive resource
//! (token/secret/key/.pem/…) checkpoints (`CheckpointReason::SensitiveResource`) rather
//! than auto-advancing. This closes the read-side gap at the planner for the workflow
//! path. (The broader model-driven `run_loop` dispatch still does not run the read-side
//! gate — that remains the `#494` enforcement gap for that path, a separate unit.)
//!
//! ## Anti-speculation
//! The definition models ONLY what the planner consumes: steps + each step's
//! classifiable action/params + the (narrow-only) checkpoint flag + an
//! `evidence_required` marker (`08` §6, carried for the deferred executor's
//! completion-verification). The other `08` §3 template fields (providers allowed,
//! permissions, model/tool requirements, rollback notes, acceptance criteria, …)
//! are inert until the executor exists and are deliberately NOT modeled here — the
//! executor's real needs should drive them later.

use crate::trusted_classify;
use friday_core::Risk;

/// One step of a workflow definition. Its `action`/`params` are a tool call the
/// planner can classify with the SAME trusted oracle the loop uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowStep {
    pub id: String,
    /// The tool action this step runs (e.g. `"read_file"`, `"write_file"`).
    pub action: String,
    pub params: Vec<(String, String)>,
    /// Template checkpoint policy. May ADD a checkpoint to an otherwise-auto step
    /// (NARROW). It can NEVER widen: a mutating/high-risk step checkpoints whether
    /// or not this is set.
    pub force_checkpoint: bool,
    /// Side-effect step needs evidence before it may be marked complete (`08` §6).
    /// Carried for the deferred executor's completion-verification; the planner
    /// records it but does not act on it (no execution here).
    pub evidence_required: bool,
}

/// A workflow definition — the minimal planner-consumed shape (see module docs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowDefinition {
    pub name: String,
    pub steps: Vec<WorkflowStep>,
}

/// Why a step requires a checkpoint (instead of auto-advancing).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointReason {
    /// The classifier marks the action mutating — the gate floor (cannot auto).
    Mutating,
    /// The action's risk is `>= High` (destructive / high-risk) — the gate floor.
    HighRisk,
    /// The action touches a SENSITIVE resource (token/secret/key/.pem/…) — even a
    /// read of a sensitive resource checkpoints (`#389`/`#494` applied at the planner;
    /// the gate floor, not template-overridable).
    SensitiveResource,
    /// Gate-safe, but the template's checkpoint policy requires a checkpoint (NARROW).
    TemplatePolicy,
    /// Unregistered/unclassifiable action — fail-closed (never auto-advance unknown).
    Unclassifiable,
}

impl CheckpointReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            CheckpointReason::Mutating => "mutating action (gate floor)",
            CheckpointReason::HighRisk => "high-risk action (gate floor)",
            CheckpointReason::SensitiveResource => "sensitive resource access (gate floor)",
            CheckpointReason::TemplatePolicy => "template checkpoint policy",
            CheckpointReason::Unclassifiable => "unclassifiable/unregistered action (fail-closed)",
        }
    }
}

/// What the planner decides for a single step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepDisposition {
    /// Friday may advance this step without a user checkpoint (read-only + low-risk
    /// + the template did not force a checkpoint).
    AutoAdvance,
    /// The step requires a user checkpoint/approval before it runs.
    Checkpoint(CheckpointReason),
}

impl StepDisposition {
    pub fn is_checkpoint(&self) -> bool {
        matches!(self, StepDisposition::Checkpoint(_))
    }
}

/// Decide a single step's disposition, anchored to the trusted classifier.
///
/// Order matters and encodes the floor: classify FIRST (the gate's verdict), and a
/// mutating action, a `>= High`-risk action, or a SENSITIVE-resource access
/// checkpoints unconditionally — the template flag is consulted ONLY after these
/// floors clear, so it can add but never remove a checkpoint. An unregistered action
/// is a fail-closed checkpoint.
pub fn plan_step(step: &WorkflowStep) -> StepDisposition {
    let classified = match trusted_classify(&step.action, &step.params) {
        Ok(c) => c,
        Err(_) => return StepDisposition::Checkpoint(CheckpointReason::Unclassifiable),
    };
    // The gate is the FLOOR — these cannot be overridden by the template.
    if classified.mutating() {
        return StepDisposition::Checkpoint(CheckpointReason::Mutating);
    }
    if matches!(classified.risk(), Some(r) if r >= Risk::High) {
        return StepDisposition::Checkpoint(CheckpointReason::HighRisk);
    }
    // Sensitive-resource floor (`#389`/`#494`): even a read of a token/secret/key/.pem
    // resource checkpoints — not template-overridable. The classifier already extracted
    // the resource from a path/target/file param; we screen it with the same detector
    // the read-side gate uses. (Closes the #505 gap for the workflow path.)
    if classified
        .resource()
        .is_some_and(friday_core::gate::is_sensitive_resource)
    {
        return StepDisposition::Checkpoint(CheckpointReason::SensitiveResource);
    }
    // Gate-safe (read-only, below High, non-sensitive). The template may NARROW only.
    if step.force_checkpoint {
        return StepDisposition::Checkpoint(CheckpointReason::TemplatePolicy);
    }
    StepDisposition::AutoAdvance
}

impl WorkflowDefinition {
    /// Per-step plan: each step id paired with its disposition. Pure preview — no
    /// step runs (execution is the deferred engine).
    pub fn plan(&self) -> Vec<(&str, StepDisposition)> {
        self.steps
            .iter()
            .map(|s| (s.id.as_str(), plan_step(s)))
            .collect()
    }

    /// Whether ANY step requires a checkpoint (so a fully-auto run is impossible).
    pub fn requires_any_checkpoint(&self) -> bool {
        self.steps.iter().any(|s| plan_step(s).is_checkpoint())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, action: &str, params: &[(&str, &str)], force: bool) -> WorkflowStep {
        WorkflowStep {
            id: id.to_string(),
            action: action.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            force_checkpoint: force,
            evidence_required: false,
        }
    }

    #[test]
    fn read_only_step_auto_advances() {
        assert_eq!(
            plan_step(&step("s", "read_file", &[("path", "a.txt")], false)),
            StepDisposition::AutoAdvance
        );
        assert_eq!(
            plan_step(&step("s", "list_dir", &[("path", "/")], false)),
            StepDisposition::AutoAdvance
        );
    }

    #[test]
    fn mutating_step_checkpoints_even_without_force_flag() {
        // The anti-WIDEN proof: a mutating step checkpoints regardless of the
        // template flag — the template cannot mark it "safe".
        assert_eq!(
            plan_step(&step(
                "s",
                "write_file",
                &[("path", "a.txt"), ("content", "x")],
                false
            )),
            StepDisposition::Checkpoint(CheckpointReason::Mutating)
        );
        // delete_file is mutating (and High); mutating is the floor reached first.
        assert_eq!(
            plan_step(&step("s", "delete_file", &[("path", "a.txt")], false)),
            StepDisposition::Checkpoint(CheckpointReason::Mutating)
        );
    }

    #[test]
    fn destructive_run_command_checkpoints() {
        // run_command is mutating → checkpoint (the destructive param would also
        // escalate risk, but mutating is the first floor).
        let d = plan_step(&step(
            "s",
            "run_command",
            &[("command", "rm -rf /tmp/x")],
            false,
        ));
        assert!(d.is_checkpoint());
    }

    #[test]
    fn read_of_a_sensitive_resource_checkpoints_not_auto_advance() {
        // Even a READ-ONLY step checkpoints when its resource is sensitive (#389/#494):
        // a workflow must not silently auto-read a secret/key/.pem.
        for path in [
            "secrets.pem",
            "id_rsa",
            "api_token.txt",
            "service.credential",
        ] {
            let d = plan_step(&step("s", "read_file", &[("path", path)], false));
            assert_eq!(
                d,
                StepDisposition::Checkpoint(CheckpointReason::SensitiveResource),
                "reading {path} must checkpoint"
            );
        }
        // a non-sensitive read still auto-advances.
        assert_eq!(
            plan_step(&step("s", "read_file", &[("path", "notes.txt")], false)),
            StepDisposition::AutoAdvance
        );
        // a read with NO resource param (e.g. search) is not sensitive → auto-advance.
        assert_eq!(
            plan_step(&step("s", "search", &[("query", "TODO")], false)),
            StepDisposition::AutoAdvance
        );
    }

    #[test]
    fn template_may_narrow_a_safe_step_to_a_checkpoint() {
        // force_checkpoint on a read-only step → checkpoint (template NARROWS).
        assert_eq!(
            plan_step(&step("s", "read_file", &[("path", "a.txt")], true)),
            StepDisposition::Checkpoint(CheckpointReason::TemplatePolicy)
        );
    }

    #[test]
    fn unknown_action_fails_closed_to_checkpoint() {
        assert_eq!(
            plan_step(&step("s", "frobnicate", &[], false)),
            StepDisposition::Checkpoint(CheckpointReason::Unclassifiable)
        );
        // even with force_checkpoint=false, an unknown action never auto-advances.
        assert!(plan_step(&step("s", "definitely_not_a_tool", &[], false)).is_checkpoint());
    }

    #[test]
    fn definition_plan_and_requires_any_checkpoint() {
        let def = WorkflowDefinition {
            name: "qa".to_string(),
            steps: vec![
                step("read", "read_file", &[("path", "a.txt")], false),
                step("search", "search", &[("query", "TODO")], false),
                step(
                    "write",
                    "write_file",
                    &[("path", "out"), ("content", "x")],
                    false,
                ),
            ],
        };
        let plan = def.plan();
        assert_eq!(plan[0], ("read", StepDisposition::AutoAdvance));
        assert_eq!(plan[1], ("search", StepDisposition::AutoAdvance));
        assert_eq!(plan[2].0, "write");
        assert!(plan[2].1.is_checkpoint());
        // a definition with a mutating step is never fully auto.
        assert!(def.requires_any_checkpoint());

        // an all-read-only definition can run fully auto.
        let ro = WorkflowDefinition {
            name: "research".to_string(),
            steps: vec![step("r", "read_file", &[("path", "a")], false)],
        };
        assert!(!ro.requires_any_checkpoint());
    }
}
