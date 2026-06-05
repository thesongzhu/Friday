//! Skill/capability catalog and advisor bridge domain records.
//!
//! A skill being discovered, installed, adopted, or runnable is not the same as
//! executing it. Execution remains a separate gate-routed action with a receipt.

use crate::{SkillState, WorkGraphTruthLabel};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillCatalogSource {
    ManagedLocal,
    BuiltInCapability,
    PluginPackage,
    McpConnector,
    ExternalObserved,
}

impl SkillCatalogSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkillCatalogSource::ManagedLocal => "managed_local",
            SkillCatalogSource::BuiltInCapability => "built_in_capability",
            SkillCatalogSource::PluginPackage => "plugin_package",
            SkillCatalogSource::McpConnector => "mcp_connector",
            SkillCatalogSource::ExternalObserved => "external_observed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCatalogEntry {
    pub skill_ref: String,
    pub skill_id: String,
    pub safe_name: String,
    pub source: SkillCatalogSource,
    pub truth_label: WorkGraphTruthLabel,
    pub state: SkillState,
    pub runtime_kind: String,
    pub intent_keys: Vec<String>,
    pub phrase_count: usize,
    pub capability_ids: Vec<String>,
    pub priority: i64,
    pub requires_operator_approval: bool,
    pub approval_blockers: Vec<String>,
    pub proof_refs: Vec<String>,
    pub run_refs: Vec<String>,
    pub updated_at_ms: i64,
}

impl SkillCatalogEntry {
    pub fn can_be_recommended(&self) -> bool {
        matches!(
            self.truth_label,
            WorkGraphTruthLabel::FridayOwned | WorkGraphTruthLabel::FridayAdopted
        ) && self.state.is_runnable()
            && self.approval_blockers.is_empty()
    }

    pub fn needs_operator_before_run(&self) -> bool {
        self.requires_operator_approval
            || !self.state.is_runnable()
            || !matches!(
                self.truth_label,
                WorkGraphTruthLabel::FridayOwned | WorkGraphTruthLabel::FridayAdopted
            )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCatalogSnapshot {
    pub generated_at_ms: i64,
    pub entries: Vec<SkillCatalogEntry>,
    pub no_go: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillAdvisorRequest {
    pub intent_key: String,
    pub operator_approved_first_run: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillAdvisorRecommendationKind {
    RecommendRunnableSkill,
    RecommendAfterOperatorApproval,
    KeepObservedOnly,
    NoMatchingSkill,
}

impl SkillAdvisorRecommendationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SkillAdvisorRecommendationKind::RecommendRunnableSkill => "recommend_runnable_skill",
            SkillAdvisorRecommendationKind::RecommendAfterOperatorApproval => {
                "recommend_after_operator_approval"
            }
            SkillAdvisorRecommendationKind::KeepObservedOnly => "keep_observed_only",
            SkillAdvisorRecommendationKind::NoMatchingSkill => "no_matching_skill",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillAdvisorDecision {
    pub recommendation: SkillAdvisorRecommendationKind,
    pub skill_ref: Option<String>,
    pub skill_id: Option<String>,
    pub truth_label: WorkGraphTruthLabel,
    pub blockers: Vec<String>,
    pub proof_requirements: Vec<String>,
    pub run_allowed: bool,
}

pub fn advise_skill(
    snapshot: &SkillCatalogSnapshot,
    request: &SkillAdvisorRequest,
) -> SkillAdvisorDecision {
    let mut matches: Vec<&SkillCatalogEntry> = snapshot
        .entries
        .iter()
        .filter(|entry| {
            !entry.state.is_terminal()
                && entry
                    .intent_keys
                    .iter()
                    .any(|intent| intent == &request.intent_key)
        })
        .collect();
    let terminal_match = snapshot.entries.iter().any(|entry| {
        entry.state.is_terminal()
            && entry
                .intent_keys
                .iter()
                .any(|intent| intent == &request.intent_key)
    });
    matches.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then(a.skill_id.cmp(&b.skill_id))
    });

    let Some(entry) = matches.first() else {
        let mut blockers = vec!["no_matching_skill_or_capability".to_string()];
        if terminal_match {
            blockers.push("rejected_or_rolled_back_skill_cannot_be_selected".to_string());
        }
        return SkillAdvisorDecision {
            recommendation: SkillAdvisorRecommendationKind::NoMatchingSkill,
            skill_ref: None,
            skill_id: None,
            truth_label: WorkGraphTruthLabel::Unknown,
            blockers,
            proof_requirements: vec!["install_or_create_skill_candidate".to_string()],
            run_allowed: false,
        };
    };

    let skill_ref = Some(entry.skill_ref.clone());
    let skill_id = Some(entry.skill_id.clone());
    if entry.can_be_recommended() {
        return SkillAdvisorDecision {
            recommendation: SkillAdvisorRecommendationKind::RecommendRunnableSkill,
            skill_ref,
            skill_id,
            truth_label: entry.truth_label,
            blockers: Vec::new(),
            proof_requirements: vec!["skill_run_receipt".to_string()],
            run_allowed: true,
        };
    }

    if matches!(
        entry.truth_label,
        WorkGraphTruthLabel::ObservedOnly
            | WorkGraphTruthLabel::LinkedOnly
            | WorkGraphTruthLabel::Unknown
    ) {
        return SkillAdvisorDecision {
            recommendation: SkillAdvisorRecommendationKind::KeepObservedOnly,
            skill_ref,
            skill_id,
            truth_label: entry.truth_label,
            blockers: vec!["operator_adoption_required_before_skill_run".to_string()],
            proof_requirements: vec!["operator_confirmation_ref".to_string()],
            run_allowed: false,
        };
    }

    let mut blockers = entry.approval_blockers.clone();
    if entry.state != SkillState::Runnable {
        blockers.push("skill_not_runnable_ladder_state".to_string());
    }
    if entry.requires_operator_approval && !request.operator_approved_first_run {
        blockers.push("operator_approval_required_before_first_or_high_risk_run".to_string());
    }
    SkillAdvisorDecision {
        recommendation: SkillAdvisorRecommendationKind::RecommendAfterOperatorApproval,
        skill_ref,
        skill_id,
        truth_label: entry.truth_label,
        blockers,
        proof_requirements: vec![
            "operator_approval_ref".to_string(),
            "skill_run_receipt".to_string(),
        ],
        run_allowed: request.operator_approved_first_run
            && entry.state == SkillState::Runnable
            && matches!(
                entry.truth_label,
                WorkGraphTruthLabel::FridayOwned | WorkGraphTruthLabel::FridayAdopted
            ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        skill_id: &str,
        truth_label: WorkGraphTruthLabel,
        state: SkillState,
        approval: bool,
        priority: i64,
    ) -> SkillCatalogEntry {
        SkillCatalogEntry {
            skill_ref: format!("friday://skill/{skill_id}"),
            skill_id: skill_id.to_string(),
            safe_name: skill_id.to_string(),
            source: SkillCatalogSource::ManagedLocal,
            truth_label,
            state,
            runtime_kind: "shell".to_string(),
            intent_keys: vec!["current_datetime".to_string()],
            phrase_count: 1,
            capability_ids: Vec::new(),
            priority,
            requires_operator_approval: approval,
            approval_blockers: if approval {
                vec!["operator_approval_required_before_first_or_high_risk_run".to_string()]
            } else {
                Vec::new()
            },
            proof_refs: Vec::new(),
            run_refs: Vec::new(),
            updated_at_ms: 1,
        }
    }

    #[test]
    fn observed_skill_is_not_runnable_even_when_it_matches_intent() {
        let snapshot = SkillCatalogSnapshot {
            generated_at_ms: 1,
            entries: vec![entry(
                "time",
                WorkGraphTruthLabel::ObservedOnly,
                SkillState::Candidate,
                false,
                50,
            )],
            no_go: Vec::new(),
        };
        let decision = advise_skill(
            &snapshot,
            &SkillAdvisorRequest {
                intent_key: "current_datetime".to_string(),
                operator_approved_first_run: false,
            },
        );
        assert_eq!(
            decision.recommendation,
            SkillAdvisorRecommendationKind::KeepObservedOnly
        );
        assert!(!decision.run_allowed);
    }

    #[test]
    fn adopted_runnable_skill_can_be_recommended_after_gate_policy_is_clear() {
        let snapshot = SkillCatalogSnapshot {
            generated_at_ms: 1,
            entries: vec![entry(
                "time",
                WorkGraphTruthLabel::FridayAdopted,
                SkillState::Runnable,
                false,
                50,
            )],
            no_go: Vec::new(),
        };
        let decision = advise_skill(
            &snapshot,
            &SkillAdvisorRequest {
                intent_key: "current_datetime".to_string(),
                operator_approved_first_run: true,
            },
        );
        assert_eq!(
            decision.recommendation,
            SkillAdvisorRecommendationKind::RecommendRunnableSkill
        );
        assert!(decision.run_allowed);
        assert_eq!(decision.skill_id.as_deref(), Some("time"));
    }

    #[test]
    fn higher_priority_skill_wins_but_still_needs_approval() {
        let snapshot = SkillCatalogSnapshot {
            generated_at_ms: 1,
            entries: vec![
                entry(
                    "low",
                    WorkGraphTruthLabel::FridayAdopted,
                    SkillState::Runnable,
                    false,
                    10,
                ),
                entry(
                    "high",
                    WorkGraphTruthLabel::FridayAdopted,
                    SkillState::Runnable,
                    true,
                    90,
                ),
            ],
            no_go: Vec::new(),
        };
        let decision = advise_skill(
            &snapshot,
            &SkillAdvisorRequest {
                intent_key: "current_datetime".to_string(),
                operator_approved_first_run: false,
            },
        );
        assert_eq!(decision.skill_id.as_deref(), Some("high"));
        assert_eq!(
            decision.recommendation,
            SkillAdvisorRecommendationKind::RecommendAfterOperatorApproval
        );
        assert!(!decision.run_allowed);
    }

    #[test]
    fn rejected_or_rolled_back_skills_are_not_selected_even_when_high_priority() {
        let snapshot = SkillCatalogSnapshot {
            generated_at_ms: 1,
            entries: vec![
                entry(
                    "rejected",
                    WorkGraphTruthLabel::FridayAdopted,
                    SkillState::Rejected,
                    false,
                    100,
                ),
                entry(
                    "rolled-back",
                    WorkGraphTruthLabel::FridayAdopted,
                    SkillState::RolledBack,
                    false,
                    90,
                ),
                entry(
                    "safe",
                    WorkGraphTruthLabel::FridayAdopted,
                    SkillState::Runnable,
                    false,
                    10,
                ),
            ],
            no_go: Vec::new(),
        };
        let decision = advise_skill(
            &snapshot,
            &SkillAdvisorRequest {
                intent_key: "current_datetime".to_string(),
                operator_approved_first_run: true,
            },
        );
        assert_eq!(decision.skill_id.as_deref(), Some("safe"));
        assert!(decision.run_allowed);
    }

    #[test]
    fn terminal_only_skill_match_returns_no_matching_runnable_skill() {
        let snapshot = SkillCatalogSnapshot {
            generated_at_ms: 1,
            entries: vec![entry(
                "rolled-back",
                WorkGraphTruthLabel::FridayAdopted,
                SkillState::RolledBack,
                false,
                90,
            )],
            no_go: Vec::new(),
        };
        let decision = advise_skill(
            &snapshot,
            &SkillAdvisorRequest {
                intent_key: "current_datetime".to_string(),
                operator_approved_first_run: true,
            },
        );
        assert_eq!(
            decision.recommendation,
            SkillAdvisorRecommendationKind::NoMatchingSkill
        );
        assert!(!decision.run_allowed);
        assert!(decision
            .blockers
            .contains(&"rejected_or_rolled_back_skill_cannot_be_selected".to_string()));
    }
}
