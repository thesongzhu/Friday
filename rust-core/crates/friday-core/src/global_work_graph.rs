//! Global work graph truth labels and read-model records.
//!
//! The Hub uses these types to represent local/provider/channel/workflow signals
//! without pretending that every signal is owned or controllable. They are pure
//! domain records: no process scan, no provider sync, and no raw private ids.

use crate::mission::WorkLane;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkGraphTruthLabel {
    FridayOwned,
    FridayAdopted,
    ObservedOnly,
    LinkedOnly,
    Unknown,
}

impl WorkGraphTruthLabel {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkGraphTruthLabel::FridayOwned => "friday_owned",
            WorkGraphTruthLabel::FridayAdopted => "friday_adopted",
            WorkGraphTruthLabel::ObservedOnly => "observed_only",
            WorkGraphTruthLabel::LinkedOnly => "linked_only",
            WorkGraphTruthLabel::Unknown => "unknown",
        }
    }

    pub fn grants_control(&self) -> bool {
        matches!(self, WorkGraphTruthLabel::FridayOwned)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkGraphNodeKind {
    Mission,
    WorkItem,
    CodexSession,
    ClaudeSession,
    TerminalSession,
    WorkflowRun,
    ProviderAppSession,
    Worktree,
    Port,
    ChannelTask,
    Process,
    MemoryCandidate,
    ProofReceipt,
    Skill,
    Capability,
    Plugin,
    McpConnector,
    ToolPack,
    SkillRun,
    Unknown,
}

impl WorkGraphNodeKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkGraphNodeKind::Mission => "mission",
            WorkGraphNodeKind::WorkItem => "work_item",
            WorkGraphNodeKind::CodexSession => "codex_session",
            WorkGraphNodeKind::ClaudeSession => "claude_session",
            WorkGraphNodeKind::TerminalSession => "terminal_session",
            WorkGraphNodeKind::WorkflowRun => "workflow_run",
            WorkGraphNodeKind::ProviderAppSession => "provider_app_session",
            WorkGraphNodeKind::Worktree => "worktree",
            WorkGraphNodeKind::Port => "port",
            WorkGraphNodeKind::ChannelTask => "channel_task",
            WorkGraphNodeKind::Process => "process",
            WorkGraphNodeKind::MemoryCandidate => "memory_candidate",
            WorkGraphNodeKind::ProofReceipt => "proof_receipt",
            WorkGraphNodeKind::Skill => "skill",
            WorkGraphNodeKind::Capability => "capability",
            WorkGraphNodeKind::Plugin => "plugin",
            WorkGraphNodeKind::McpConnector => "mcp_connector",
            WorkGraphNodeKind::ToolPack => "tool_pack",
            WorkGraphNodeKind::SkillRun => "skill_run",
            WorkGraphNodeKind::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkGraphConflictKind {
    DuplicateMission,
    DuplicateWorkItem,
    WorkspaceClaim,
    WorktreeClaim,
    PortLease,
    ObservedPort,
    ProviderSession,
    ChannelBinding,
    WorkflowRun,
    MemoryCandidate,
    SkillCapability,
    UnknownSignal,
}

impl WorkGraphConflictKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkGraphConflictKind::DuplicateMission => "duplicate_mission",
            WorkGraphConflictKind::DuplicateWorkItem => "duplicate_work_item",
            WorkGraphConflictKind::WorkspaceClaim => "workspace_claim",
            WorkGraphConflictKind::WorktreeClaim => "worktree_claim",
            WorkGraphConflictKind::PortLease => "port_lease",
            WorkGraphConflictKind::ObservedPort => "observed_port",
            WorkGraphConflictKind::ProviderSession => "provider_session",
            WorkGraphConflictKind::ChannelBinding => "channel_binding",
            WorkGraphConflictKind::WorkflowRun => "workflow_run",
            WorkGraphConflictKind::MemoryCandidate => "memory_candidate",
            WorkGraphConflictKind::SkillCapability => "skill_capability",
            WorkGraphConflictKind::UnknownSignal => "unknown_signal",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkGraphConflictSeverity {
    Info,
    Ask,
    Block,
}

impl WorkGraphConflictSeverity {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkGraphConflictSeverity::Info => "info",
            WorkGraphConflictSeverity::Ask => "ask",
            WorkGraphConflictSeverity::Block => "block",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkGraphNode {
    pub node_ref: String,
    pub kind: WorkGraphNodeKind,
    pub truth_label: WorkGraphTruthLabel,
    pub mission_id: Option<String>,
    pub work_item_id: Option<String>,
    pub lane: Option<WorkLane>,
    pub safe_title: String,
    pub status_label: String,
    pub evidence_refs: Vec<String>,
    pub proof_refs: Vec<String>,
    pub blockers: Vec<String>,
    pub control_allowed: bool,
    pub updated_at_ms: i64,
}

impl WorkGraphNode {
    pub fn observed(node_ref: String, kind: WorkGraphNodeKind, updated_at_ms: i64) -> Self {
        Self {
            node_ref,
            kind,
            truth_label: WorkGraphTruthLabel::ObservedOnly,
            mission_id: None,
            work_item_id: None,
            lane: None,
            safe_title: kind.as_str().to_string(),
            status_label: "observed_only".to_string(),
            evidence_refs: Vec::new(),
            proof_refs: Vec::new(),
            blockers: vec!["observed_metadata_is_inspect_only".to_string()],
            control_allowed: false,
            updated_at_ms,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkGraphConflict {
    pub conflict_ref: String,
    pub conflict_kind: WorkGraphConflictKind,
    pub severity: WorkGraphConflictSeverity,
    pub existing_mission_id: Option<String>,
    pub existing_work_item_id: Option<String>,
    pub node_refs: Vec<String>,
    pub summary: String,
    pub proof_refs: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlobalWorkGraphSnapshot {
    pub generated_at_ms: i64,
    pub nodes: Vec<WorkGraphNode>,
    pub conflicts: Vec<WorkGraphConflict>,
    pub truth_labels: Vec<WorkGraphTruthLabel>,
    pub no_go: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdoptionProposalStatus {
    Proposed,
    Blocked,
}

impl AdoptionProposalStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AdoptionProposalStatus::Proposed => "proposed",
            AdoptionProposalStatus::Blocked => "blocked",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptionProposal {
    pub proposal_ref: String,
    pub observed_node_ref: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub status: AdoptionProposalStatus,
    pub truth_before: WorkGraphTruthLabel,
    pub proposed_truth_after: WorkGraphTruthLabel,
    pub why_may_belong: Vec<String>,
    pub required_operator_action: String,
    pub blockers: Vec<String>,
    pub proof_requirements: Vec<String>,
    pub control_granted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdoptionCommandStatus {
    Adopted,
    Blocked,
}

impl AdoptionCommandStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            AdoptionCommandStatus::Adopted => "adopted",
            AdoptionCommandStatus::Blocked => "blocked",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdoptionCommandResult {
    pub status: AdoptionCommandStatus,
    pub adoption_ref: Option<String>,
    pub mission_id: String,
    pub work_item_id: String,
    pub truth_label: WorkGraphTruthLabel,
    pub mission_link_ref: Option<String>,
    pub route_decision_ref: Option<String>,
    pub control_granted: bool,
    pub blockers: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvisorRecommendation {
    ContinueExistingMission,
    CreateNewMission,
    MergeOrAttachToExistingMission,
    AskClarifyingQuestion,
    Dispatch,
    BlockDueToConflict,
    RequireContextPassport,
    RequireOperatorApproval,
    KeepObservedOnly,
}

impl AdvisorRecommendation {
    pub fn as_str(&self) -> &'static str {
        match self {
            AdvisorRecommendation::ContinueExistingMission => "continue_existing_mission",
            AdvisorRecommendation::CreateNewMission => "create_new_mission",
            AdvisorRecommendation::MergeOrAttachToExistingMission => {
                "merge_or_attach_to_existing_mission"
            }
            AdvisorRecommendation::AskClarifyingQuestion => "ask_clarifying_question",
            AdvisorRecommendation::Dispatch => "dispatch",
            AdvisorRecommendation::BlockDueToConflict => "block_due_to_conflict",
            AdvisorRecommendation::RequireContextPassport => "require_context_passport",
            AdvisorRecommendation::RequireOperatorApproval => "require_operator_approval",
            AdvisorRecommendation::KeepObservedOnly => "keep_observed_only",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdvisorPreflight {
    pub recommendation: AdvisorRecommendation,
    pub mission_id: Option<String>,
    pub work_item_id: Option<String>,
    pub blockers: Vec<String>,
    pub questions: Vec<String>,
    pub conflict_refs: Vec<String>,
    pub duplicate_mission_id: Option<String>,
    pub duplicate_work_item_id: Option<String>,
    pub proof_requirements: Vec<String>,
    pub truth_summary: Vec<String>,
}
