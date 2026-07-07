//! Mission Spine domain objects (`FridayConversation -> Mission -> WorkItem`).
//!
//! This is the product-level spine for Friday as a long-lived global secretary.
//! Provider sessions, channel threads, workflow runs, memory decisions, and handoff
//! artifacts attach to this graph; they do not become the user's canonical
//! conversation by themselves.
//!
//! Load-bearing invariants:
//! - Provider thread ids, channel chat ids, and frontend-local ids are not Friday
//!   conversation ids.
//! - A Mission is the anti-pinned-chat-debt object; a WorkItem is the routed work.
//! - Hub/provider acknowledgement states do not complete a WorkItem.
//! - Candidate memory attached to a Mission is not confirmed memory.
//! - Cross-agent/provider sensitive context transfer requires a Context Passport.
//! - Handoffs must carry judgment memory, not just task facts.

use crate::error::CoreError;
use crate::tool_policy::Risk;

/// Canonical deferred-option label for native UI work that is already represented
/// by the product UI layer and must not be treated as a materializable follow-up.
pub const MISSION_NATIVE_UI_IMPLEMENTATION_DEFERRED_OPTION: &str = "native UI implementation";

/// Truth label for Mission Spine projections. This mirrors Friday's product
/// honesty vocabulary: a projection may be designed or wired without being a
/// proven runtime-ready surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TruthStatus {
    Proven,
    DesignProof,
    WiredRegistry,
    NoGo,
    OperatorGated,
    ExternalBlocked,
    Historical,
}

impl TruthStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TruthStatus::Proven => "proven",
            TruthStatus::DesignProof => "design_proof",
            TruthStatus::WiredRegistry => "wired_registry",
            TruthStatus::NoGo => "NO-GO",
            TruthStatus::OperatorGated => "operator_gated",
            TruthStatus::ExternalBlocked => "external_blocked",
            TruthStatus::Historical => "historical",
        }
    }
}

/// Lifecycle of the user's goal. `Merged` is terminal and preserves history while
/// preventing duplicate pinned-chat debt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissionStatus {
    Active,
    WaitingForUser,
    Blocked,
    Paused,
    Done,
    Archived,
    Merged,
}

impl MissionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            MissionStatus::Active => "active",
            MissionStatus::WaitingForUser => "waiting_for_user",
            MissionStatus::Blocked => "blocked",
            MissionStatus::Paused => "paused",
            MissionStatus::Done => "done",
            MissionStatus::Archived => "archived",
            MissionStatus::Merged => "merged",
        }
    }

    pub fn is_active_like(&self) -> bool {
        matches!(
            self,
            MissionStatus::Active
                | MissionStatus::WaitingForUser
                | MissionStatus::Blocked
                | MissionStatus::Paused
        )
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            MissionStatus::Done | MissionStatus::Archived | MissionStatus::Merged
        )
    }

    pub fn can_transition_to(&self, next: MissionStatus) -> bool {
        use MissionStatus::*;
        matches!(
            (self, next),
            (Active, WaitingForUser)
                | (Active, Blocked)
                | (Active, Paused)
                | (Active, Done)
                | (Active, Archived)
                | (Active, Merged)
                | (WaitingForUser, Active)
                | (WaitingForUser, Blocked)
                | (WaitingForUser, Paused)
                | (WaitingForUser, Archived)
                | (WaitingForUser, Merged)
                | (Blocked, Active)
                | (Blocked, WaitingForUser)
                | (Blocked, Paused)
                | (Blocked, Archived)
                | (Blocked, Merged)
                | (Paused, Active)
                | (Paused, Archived)
                | (Paused, Merged)
                | (Done, Archived)
        )
    }

    pub fn try_transition(self, next: MissionStatus) -> Result<MissionStatus, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "mission",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

/// Where a WorkItem is routed. This is the target lane, not the user's product
/// identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkLane {
    FridayHub,
    Codex,
    Claude,
    DeepSeek,
    Workflow,
    Channel,
    Human,
    FutureApi,
}

impl WorkLane {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkLane::FridayHub => "friday_hub",
            WorkLane::Codex => "codex",
            WorkLane::Claude => "claude",
            WorkLane::DeepSeek => "deepseek",
            WorkLane::Workflow => "workflow",
            WorkLane::Channel => "channel",
            WorkLane::Human => "human",
            WorkLane::FutureApi => "future_api",
        }
    }

    pub fn is_external_context_destination(&self) -> bool {
        matches!(
            self,
            WorkLane::Codex
                | WorkLane::Claude
                | WorkLane::DeepSeek
                | WorkLane::Workflow
                | WorkLane::Channel
                | WorkLane::FutureApi
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalState {
    NotRequired,
    Required,
    Approved,
    Rejected,
}

impl ApprovalState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApprovalState::NotRequired => "not_required",
            ApprovalState::Required => "required",
            ApprovalState::Approved => "approved",
            ApprovalState::Rejected => "rejected",
        }
    }
}

/// Lifecycle of a routed unit of work. Hub ack and provider routing states are
/// intentionally distinct from `CompletedWithProof`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkItemStatus {
    Draft,
    PreflightBlocked,
    WaitingForUser,
    ReadyToDispatch,
    Dispatched,
    HubAccepted,
    ProviderRouted,
    ProviderWaiting,
    CompletedWithProof,
    FailedRetryable,
    FailedTerminal,
    Cancelled,
    Merged,
    Archived,
}

impl WorkItemStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkItemStatus::Draft => "draft",
            WorkItemStatus::PreflightBlocked => "preflight_blocked",
            WorkItemStatus::WaitingForUser => "waiting_for_user",
            WorkItemStatus::ReadyToDispatch => "ready_to_dispatch",
            WorkItemStatus::Dispatched => "dispatched",
            WorkItemStatus::HubAccepted => "hub_accepted",
            WorkItemStatus::ProviderRouted => "provider_routed",
            WorkItemStatus::ProviderWaiting => "provider_waiting",
            WorkItemStatus::CompletedWithProof => "completed_with_proof",
            WorkItemStatus::FailedRetryable => "failed_retryable",
            WorkItemStatus::FailedTerminal => "failed_terminal",
            WorkItemStatus::Cancelled => "cancelled",
            WorkItemStatus::Merged => "merged",
            WorkItemStatus::Archived => "archived",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            WorkItemStatus::CompletedWithProof
                | WorkItemStatus::FailedTerminal
                | WorkItemStatus::Cancelled
                | WorkItemStatus::Merged
                | WorkItemStatus::Archived
        )
    }

    pub fn can_transition_to(&self, next: WorkItemStatus) -> bool {
        use WorkItemStatus::*;
        matches!(
            (self, next),
            (Draft, PreflightBlocked)
                | (Draft, WaitingForUser)
                | (Draft, ReadyToDispatch)
                | (Draft, Merged)
                | (PreflightBlocked, Draft)
                | (PreflightBlocked, WaitingForUser)
                | (PreflightBlocked, Cancelled)
                | (WaitingForUser, ReadyToDispatch)
                | (WaitingForUser, Cancelled)
                | (ReadyToDispatch, Dispatched)
                | (ReadyToDispatch, Cancelled)
                // (#24b crash-recovery) A mission-bound run executes the agent loop while its
                // WorkItem rests at `ReadyToDispatch` (the binding to `ProviderRouted` happens
                // AFTER the loop returns). A process that DIES mid-model-call therefore leaves the
                // row at `ReadyToDispatch` with a stale durable `executing` marker; boot
                // crash-recovery PASS-2 reconciles exactly that crash to `FailedTerminal`. This is
                // an ADDITIVE terminal edge for the crash case ONLY — the happy path
                // (`ReadyToDispatch -> Dispatched`) is unchanged, and a NON-crashed
                // `ReadyToDispatch` row (no `executing` marker) is never reconciled, so dispatch's
                // ownership of the normal path is untouched.
                | (ReadyToDispatch, FailedTerminal)
                | (Dispatched, HubAccepted)
                | (Dispatched, FailedRetryable)
                | (Dispatched, FailedTerminal)
                | (Dispatched, Cancelled)
                | (HubAccepted, ProviderRouted)
                | (HubAccepted, FailedRetryable)
                | (HubAccepted, FailedTerminal)
                | (HubAccepted, Cancelled)
                | (ProviderRouted, ProviderWaiting)
                | (ProviderRouted, FailedRetryable)
                | (ProviderRouted, FailedTerminal)
                | (ProviderWaiting, CompletedWithProof)
                | (ProviderWaiting, FailedRetryable)
                | (ProviderWaiting, FailedTerminal)
                | (FailedRetryable, ReadyToDispatch)
                | (FailedRetryable, FailedTerminal)
                | (FailedRetryable, Cancelled)
                | (CompletedWithProof, Archived)
        )
    }

    pub fn try_transition(self, next: WorkItemStatus) -> Result<WorkItemStatus, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "work_item",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceKind {
    Mobile,
    Desktop,
    Telegram,
    Discord,
    Lark,
    WebChat,
    ProviderWorkspace,
    FutureChannel,
}

impl SurfaceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SurfaceKind::Mobile => "mobile",
            SurfaceKind::Desktop => "desktop",
            SurfaceKind::Telegram => "telegram",
            SurfaceKind::Discord => "discord",
            SurfaceKind::Lark => "lark",
            SurfaceKind::WebChat => "web_chat",
            SurfaceKind::ProviderWorkspace => "provider_workspace",
            SurfaceKind::FutureChannel => "future_channel",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VisibilityPolicy {
    Compact,
    RichProof,
    StatusOnly,
    HiddenTraceOnly,
}

impl VisibilityPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            VisibilityPolicy::Compact => "compact",
            VisibilityPolicy::RichProof => "rich_proof",
            VisibilityPolicy::StatusOnly => "status_only",
            VisibilityPolicy::HiddenTraceOnly => "hidden_trace_only",
        }
    }
}

/// A user-visible Mission event source/kind. These are product events in Friday's
/// Mission timeline, not raw provider/channel transcripts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceEventKind {
    UserMessage,
    FridayReply,
    SystemStatus,
    ChannelInbound,
    ProviderTrace,
    ProofReceipt,
    MemoryDecision,
    NeedsMe,
    Handoff,
}

impl SurfaceEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SurfaceEventKind::UserMessage => "user_message",
            SurfaceEventKind::FridayReply => "friday_reply",
            SurfaceEventKind::SystemStatus => "system_status",
            SurfaceEventKind::ChannelInbound => "channel_inbound",
            SurfaceEventKind::ProviderTrace => "provider_trace",
            SurfaceEventKind::ProofReceipt => "proof_receipt",
            SurfaceEventKind::MemoryDecision => "memory_decision",
            SurfaceEventKind::NeedsMe => "needs_me",
            SurfaceEventKind::Handoff => "handoff",
        }
    }
}

/// Refs-only event in one Mission timeline. A mobile message, desktop reply, or
/// channel inbound should attach here so surfaces share Mission truth without
/// copying raw chat/provider ids into separate product conversations.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurfaceEvent {
    pub surface_event_id: String,
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub work_item_id: Option<String>,
    pub surface_thread_id: String,
    pub source_surface: SurfaceKind,
    pub event_kind: SurfaceEventKind,
    pub body_ref: Option<String>,
    pub visibility_policy: VisibilityPolicy,
    pub proof_ref: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FridayConversation {
    pub friday_conversation_id: String,
    pub owner_principal: String,
    pub title: String,
    pub current_focus_summary: String,
    pub active_mission_ids: Vec<String>,
    pub surface_thread_ids: Vec<String>,
    pub memory_scope_ref: Option<String>,
    pub truth_status: TruthStatus,
    pub proof_refs: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mission {
    pub mission_id: String,
    pub friday_conversation_id: String,
    pub title: String,
    pub intent: String,
    pub status: MissionStatus,
    pub why_now: String,
    pub decision_path_summary: String,
    pub considered_options: Vec<String>,
    pub deferred_options: Vec<String>,
    pub known_pitfalls: Vec<String>,
    pub handoff_inheritance: Vec<String>,
    pub work_item_ids: Vec<String>,
    pub memory_candidate_refs: Vec<String>,
    pub context_passport_refs: Vec<String>,
    pub proof_refs: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandoffJudgmentMemory {
    pub task: String,
    pub current_blocker: Option<String>,
    pub target_lane_thread_agent_provider: String,
    pub read_first_files: Vec<String>,
    pub required_output: String,
    pub done_criteria: Vec<String>,
    pub red_lines: Vec<String>,
    pub why_this_route: String,
    pub considered_options: Vec<String>,
    pub deferred_options: Vec<String>,
    pub previous_pitfalls: Vec<String>,
    pub inheritable_context: Vec<String>,
    pub proof_requirements: Vec<String>,
    pub ownership_claim_ids: Vec<String>,
}

impl HandoffJudgmentMemory {
    pub fn validate(&self) -> Result<(), MissionSpineError> {
        if self.task.trim().is_empty() {
            return Err(MissionSpineError::MissingJudgmentField("task"));
        }
        if self.target_lane_thread_agent_provider.trim().is_empty() {
            return Err(MissionSpineError::MissingJudgmentField(
                "target_lane_thread_agent_provider",
            ));
        }
        if self.required_output.trim().is_empty() {
            return Err(MissionSpineError::MissingJudgmentField("required_output"));
        }
        if self.done_criteria.is_empty() {
            return Err(MissionSpineError::MissingJudgmentField("done_criteria"));
        }
        if self.red_lines.is_empty() {
            return Err(MissionSpineError::MissingJudgmentField("red_lines"));
        }
        if self.why_this_route.trim().is_empty() {
            return Err(MissionSpineError::MissingJudgmentField("why_this_route"));
        }
        if self.considered_options.is_empty() {
            return Err(MissionSpineError::MissingJudgmentField(
                "considered_options",
            ));
        }
        if self.deferred_options.is_empty() {
            return Err(MissionSpineError::MissingJudgmentField("deferred_options"));
        }
        if self.previous_pitfalls.is_empty() {
            return Err(MissionSpineError::MissingJudgmentField("previous_pitfalls"));
        }
        if self.inheritable_context.is_empty() {
            return Err(MissionSpineError::MissingJudgmentField(
                "inheritable_context",
            ));
        }
        if self.proof_requirements.is_empty() {
            return Err(MissionSpineError::MissingJudgmentField(
                "proof_requirements",
            ));
        }
        Ok(())
    }
}

pub const OUTCOME_CHECKED_PROOF_FLAG: &str = "FRIDAY_OUTCOME_CHECKED_PROOF";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProofRequirementKind {
    AnswerProduced,
    ToolsExecuted,
    AnswerFingerprintMatches,
    TestsPassed,
    ServerBooted,
    ArtifactDiff,
    FileContentMatches,
}

impl ProofRequirementKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProofRequirementKind::AnswerProduced => "AnswerProduced",
            ProofRequirementKind::ToolsExecuted => "ToolsExecuted",
            ProofRequirementKind::AnswerFingerprintMatches => "AnswerFingerprintMatches",
            ProofRequirementKind::TestsPassed => "TestsPassed",
            ProofRequirementKind::ServerBooted => "ServerBooted",
            ProofRequirementKind::ArtifactDiff => "ArtifactDiff",
            ProofRequirementKind::FileContentMatches => "FileContentMatches",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "AnswerProduced" => Some(ProofRequirementKind::AnswerProduced),
            "ToolsExecuted" => Some(ProofRequirementKind::ToolsExecuted),
            "AnswerFingerprintMatches" => Some(ProofRequirementKind::AnswerFingerprintMatches),
            "TestsPassed" => Some(ProofRequirementKind::TestsPassed),
            "ServerBooted" => Some(ProofRequirementKind::ServerBooted),
            "ArtifactDiff" => Some(ProofRequirementKind::ArtifactDiff),
            "FileContentMatches" => Some(ProofRequirementKind::FileContentMatches),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofRequirementSpec {
    pub kind: ProofRequirementKind,
    pub expectation: String,
}

impl ProofRequirementSpec {
    pub fn parse(value: &str) -> Option<Self> {
        let body = value.trim().strip_prefix("outcome:")?;
        let (kind, expectation) = body.split_once(':')?;
        let kind = ProofRequirementKind::parse(kind)?;
        let expectation = expectation.trim();
        if expectation.is_empty() {
            return None;
        }
        Some(Self {
            kind,
            expectation: expectation.to_string(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutcomeProofReceipt {
    pub kind: ProofRequirementKind,
    pub run_id: String,
    pub signal: String,
}

pub fn parse_outcome_receipt(value: &str) -> Option<OutcomeProofReceipt> {
    let body = value.trim().strip_prefix("proof://outcome/")?;
    let (path, query) = body.split_once('?')?;
    let (kind, run_id) = path.split_once('/')?;
    let kind = ProofRequirementKind::parse(kind)?;
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return None;
    }
    let signal = query
        .split('&')
        .find_map(|part| part.strip_prefix("signal="))?
        .trim();
    if signal.is_empty() {
        return None;
    }
    Some(OutcomeProofReceipt {
        kind,
        run_id: run_id.to_string(),
        signal: signal.to_string(),
    })
}

pub fn outcome_checked_proof_enabled_from(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

pub fn outcome_checked_proof_enabled() -> bool {
    match std::env::var(OUTCOME_CHECKED_PROOF_FLAG) {
        Ok(value) => outcome_checked_proof_enabled_from(Some(&value)),
        Err(_) => false,
    }
}

fn numeric_signal(value: &str) -> Option<i64> {
    let value = value.trim();
    if let Ok(parsed) = value.parse::<i64>() {
        return Some(parsed);
    }
    let suffix: String = value
        .chars()
        .rev()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if suffix.is_empty() {
        None
    } else {
        suffix.parse::<i64>().ok()
    }
}

fn outcome_signal_satisfies(expectation: &str, signal: &str) -> bool {
    let expectation = expectation.trim();
    let signal = signal.trim();
    if signal.is_empty() {
        return false;
    }
    if matches!(expectation, "*" | "nonempty" | "present") {
        return true;
    }
    if let Some(expected) = expectation.strip_prefix(">=") {
        let expected = expected.trim().parse::<i64>().ok();
        let actual = numeric_signal(signal);
        return matches!((actual, expected), (Some(actual), Some(expected)) if actual >= expected);
    }
    if let Some(expected) = expectation.strip_prefix('>') {
        let expected = expected.trim().parse::<i64>().ok();
        let actual = numeric_signal(signal);
        return matches!((actual, expected), (Some(actual), Some(expected)) if actual > expected);
    }
    for op in ["==", "="] {
        if let Some(expected) = expectation.strip_prefix(op) {
            let expected = expected.trim().parse::<i64>().ok();
            let actual = numeric_signal(signal);
            return matches!((actual, expected), (Some(actual), Some(expected)) if actual == expected);
        }
    }
    signal == expectation
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkItem {
    pub work_item_id: String,
    pub mission_id: String,
    pub lane: WorkLane,
    pub target_provider_or_agent: Option<String>,
    pub status: WorkItemStatus,
    pub owner_claim_ids: Vec<String>,
    pub workspace_refs: Vec<String>,
    pub capability_id: Option<String>,
    pub risk_level: Risk,
    pub approval_state: ApprovalState,
    pub blocking_reason: Option<String>,
    pub input_refs: Vec<String>,
    pub output_refs: Vec<String>,
    pub proof_requirements: Vec<String>,
    pub proof_receipts: Vec<String>,
    pub judgment_memory: HandoffJudgmentMemory,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// D20 W1 plan-as-action-list item attached to a route decision.
///
/// This is a planning/display record, not an authorization decision. The W2
/// trust-dial slice will replace the provisional reversibility label with the
/// authoritative `classify()` output before any auto-allow logic exists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteActionItem {
    pub description: String,
    pub target_kind: RouteActionTargetKind,
    pub target_ref: String,
    pub reversibility: RouteActionReversibility,
    pub assigned_lane: WorkLane,
    pub assigned_provider_or_agent: Option<String>,
    pub route_reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteActionTargetKind {
    File,
    Command,
    Subtask,
}

impl RouteActionTargetKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RouteActionTargetKind::File => "file",
            RouteActionTargetKind::Command => "command",
            RouteActionTargetKind::Subtask => "subtask",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteActionReversibility {
    ReversibleGitWorktree,
    OperatorGateRequired,
    PendingClassify,
}

impl RouteActionReversibility {
    pub fn as_str(&self) -> &'static str {
        match self {
            RouteActionReversibility::ReversibleGitWorktree => "reversible_git_worktree",
            RouteActionReversibility::OperatorGateRequired => "operator_gate_required",
            RouteActionReversibility::PendingClassify => "pending_classify",
        }
    }
}

impl WorkItem {
    pub fn is_active_like(&self) -> bool {
        !self.status.is_terminal()
    }

    /// A workspace/process-touching WorkItem needs an ownership claim before
    /// dispatch. Read-only tasks may have no workspace refs.
    pub fn has_required_ownership_for_workspace_touch(&self) -> bool {
        self.workspace_refs.is_empty() || !self.owner_claim_ids.is_empty()
    }

    /// "Completed" is trustworthy only when the terminal status is paired with
    /// at least one proof receipt.
    pub fn completion_is_proven(&self) -> bool {
        self.status == WorkItemStatus::CompletedWithProof && !self.proof_receipts.is_empty()
    }

    pub fn outcome_requirement_specs(&self) -> Vec<ProofRequirementSpec> {
        self.proof_requirements
            .iter()
            .filter_map(|requirement| ProofRequirementSpec::parse(requirement))
            .collect()
    }

    pub fn has_outcome_proof_requirements(&self) -> bool {
        self.proof_requirements
            .iter()
            .any(|requirement| ProofRequirementSpec::parse(requirement).is_some())
    }

    pub fn completion_outcome_is_proven(&self) -> bool {
        if !self.completion_is_proven() {
            return false;
        }
        let requirements = self.outcome_requirement_specs();
        if requirements.is_empty() {
            return false;
        }
        requirements.iter().all(|requirement| {
            self.proof_receipts.iter().any(|receipt| {
                let Some(receipt) = parse_outcome_receipt(receipt) else {
                    return false;
                };
                receipt.kind == requirement.kind
                    && outcome_signal_satisfies(&requirement.expectation, &receipt.signal)
            })
        })
    }
}

/// Surface-safe route judgment for a WorkItem. This is not durable memory and
/// not a transcript summary: it is the auditable "why this lane/agent now" card
/// that prevents cross-thread handoffs from losing the previous judgment path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteDecisionCard {
    pub decision_id: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub selected_lane: WorkLane,
    pub selected_provider_or_agent: Option<String>,
    pub why_this_route: String,
    pub considered_options: Vec<String>,
    pub deferred_options: Vec<String>,
    pub previous_pitfalls: Vec<String>,
    pub inheritable_context: Vec<String>,
    pub conflict_refs: Vec<String>,
    pub proof_requirements: Vec<String>,
    pub ownership_claim_ids: Vec<String>,
    pub trace_refs: Vec<String>,
    pub action_items: Vec<RouteActionItem>,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

/// Redacted route judgment for surfaces and agent handoff dashboards. This
/// carries the "why" and inherited judgment path without raw channel/chat trace
/// refs. Hub-internal code can read the full `RouteDecisionCard` when it needs
/// exact refs for proof linking.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteDecisionProjection {
    pub route_decision_ref: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub selected_lane: WorkLane,
    pub selected_target_label: Option<String>,
    pub why_this_route: String,
    pub considered_options: Vec<String>,
    pub deferred_options: Vec<String>,
    pub previous_pitfalls: Vec<String>,
    pub inheritable_context: Vec<String>,
    pub conflict_ref_count: usize,
    pub proof_requirements: Vec<String>,
    pub ownership_claim_count: usize,
    pub trace_ref_count: usize,
    pub action_items: Vec<RouteActionItem>,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

impl RouteDecisionCard {
    pub fn from_work_item(
        decision_id: String,
        item: &WorkItem,
        trace_refs: Vec<String>,
        created_at_ms: i64,
        expires_at_ms: Option<i64>,
    ) -> Self {
        let conflict_refs = item
            .blocking_reason
            .as_ref()
            .map(|reason| vec![format!("blocker:{reason}")])
            .unwrap_or_default();
        Self {
            decision_id,
            mission_id: item.mission_id.clone(),
            work_item_id: item.work_item_id.clone(),
            selected_lane: item.lane,
            selected_provider_or_agent: item.target_provider_or_agent.clone(),
            why_this_route: item.judgment_memory.why_this_route.clone(),
            considered_options: item.judgment_memory.considered_options.clone(),
            deferred_options: item.judgment_memory.deferred_options.clone(),
            previous_pitfalls: item.judgment_memory.previous_pitfalls.clone(),
            inheritable_context: item.judgment_memory.inheritable_context.clone(),
            conflict_refs,
            proof_requirements: item.judgment_memory.proof_requirements.clone(),
            ownership_claim_ids: item.judgment_memory.ownership_claim_ids.clone(),
            trace_refs,
            action_items: Vec::new(),
            created_at_ms,
            expires_at_ms,
        }
    }

    pub fn from_work_item_flagged(
        decision_id: String,
        item: &WorkItem,
        trace_refs: Vec<String>,
        created_at_ms: i64,
        expires_at_ms: Option<i64>,
        action_list_enabled: bool,
    ) -> Self {
        let card =
            Self::from_work_item(decision_id, item, trace_refs, created_at_ms, expires_at_ms);
        if action_list_enabled {
            card.with_action_items(vec![Self::action_item_from_work_item(item)])
        } else {
            card
        }
    }

    pub fn with_action_items(mut self, action_items: Vec<RouteActionItem>) -> Self {
        self.action_items = action_items;
        self
    }

    pub fn action_item_from_work_item(item: &WorkItem) -> RouteActionItem {
        let (target_kind, target_ref) = item
            .judgment_memory
            .read_first_files
            .first()
            .map(|path| (RouteActionTargetKind::File, path.clone()))
            .unwrap_or_else(|| {
                (
                    RouteActionTargetKind::Subtask,
                    format!("friday://work-item/{}", item.work_item_id),
                )
            });

        RouteActionItem {
            description: item.judgment_memory.task.clone(),
            target_kind,
            target_ref,
            reversibility: action_reversibility_for_work_item(item),
            assigned_lane: item.lane,
            assigned_provider_or_agent: item.target_provider_or_agent.clone(),
            route_reason: item.judgment_memory.why_this_route.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), MissionSpineError> {
        require_non_empty_decision(&self.decision_id, "decision_id")?;
        require_non_empty_decision(&self.mission_id, "mission_id")?;
        require_non_empty_decision(&self.work_item_id, "work_item_id")?;
        if let Some(target) = self.selected_provider_or_agent.as_deref() {
            require_non_empty_decision(target, "selected_provider_or_agent")?;
        }
        require_non_empty_decision(&self.why_this_route, "why_this_route")?;
        require_non_empty_required_vec(&self.considered_options, "considered_options")?;
        require_non_empty_required_vec(&self.deferred_options, "deferred_options")?;
        require_non_empty_required_vec(&self.previous_pitfalls, "previous_pitfalls")?;
        require_non_empty_required_vec(&self.inheritable_context, "inheritable_context")?;
        require_non_empty_required_vec(&self.proof_requirements, "proof_requirements")?;
        require_non_empty_decision_vec(&self.conflict_refs, "conflict_refs")?;
        require_non_empty_decision_vec(&self.ownership_claim_ids, "ownership_claim_ids")?;
        require_non_empty_decision_vec(&self.trace_refs, "trace_refs")?;
        for item in &self.action_items {
            item.validate()?;
        }
        Ok(())
    }

    pub fn route_decision_ref(&self) -> String {
        format!("friday://route-decision/{}", self.decision_id)
    }

    pub fn to_projection(&self) -> RouteDecisionProjection {
        RouteDecisionProjection {
            route_decision_ref: self.route_decision_projection_ref(),
            mission_id: self.mission_id.clone(),
            work_item_id: self.work_item_id.clone(),
            selected_lane: self.selected_lane,
            selected_target_label: self.selected_target_label(),
            why_this_route: self.why_this_route.clone(),
            considered_options: self.considered_options.clone(),
            deferred_options: self.deferred_options.clone(),
            previous_pitfalls: self.previous_pitfalls.clone(),
            inheritable_context: self.inheritable_context.clone(),
            conflict_ref_count: self.conflict_refs.len(),
            proof_requirements: self.proof_requirements.clone(),
            ownership_claim_count: self.ownership_claim_ids.len(),
            trace_ref_count: self.trace_refs.len(),
            action_items: self
                .action_items
                .iter()
                .map(project_route_action_item)
                .collect(),
            created_at_ms: self.created_at_ms,
            expires_at_ms: self.expires_at_ms,
        }
    }

    fn route_decision_projection_ref(&self) -> String {
        format!(
            "friday://route-decision-projection/{}/{}/{}",
            self.mission_id, self.work_item_id, self.created_at_ms
        )
    }

    fn selected_target_label(&self) -> Option<String> {
        self.selected_provider_or_agent.as_ref().map(|target| {
            if self.selected_lane == WorkLane::Channel {
                "bound_channel".to_string()
            } else {
                target.clone()
            }
        })
    }
}

fn project_route_action_item(item: &RouteActionItem) -> RouteActionItem {
    let mut projected = item.clone();
    if projected.assigned_lane == WorkLane::Channel {
        projected.assigned_provider_or_agent = Some("bound_channel".to_string());
    }
    projected.target_ref = match projected.target_kind {
        RouteActionTargetKind::File => redacted_file_target(&projected.target_ref),
        RouteActionTargetKind::Command => "command://redacted".to_string(),
        RouteActionTargetKind::Subtask => projected.target_ref,
    };
    projected
}

fn redacted_file_target(value: &str) -> String {
    let Some(last) = value
        .rsplit(['/', '\\'])
        .find(|part| !part.trim().is_empty())
    else {
        return "file://redacted".to_string();
    };
    format!("file://redacted/{last}")
}

impl RouteActionItem {
    pub fn validate(&self) -> Result<(), MissionSpineError> {
        require_non_empty_decision(&self.description, "action_item.description")?;
        require_non_empty_decision(&self.target_ref, "action_item.target_ref")?;
        if let Some(target) = self.assigned_provider_or_agent.as_deref() {
            require_non_empty_decision(target, "action_item.assigned_provider_or_agent")?;
        }
        require_non_empty_decision(&self.route_reason, "action_item.route_reason")?;
        Ok(())
    }
}

fn action_reversibility_for_work_item(item: &WorkItem) -> RouteActionReversibility {
    if item.approval_state == ApprovalState::Required || item.risk_level >= Risk::High {
        RouteActionReversibility::OperatorGateRequired
    } else if !item.workspace_refs.is_empty() {
        RouteActionReversibility::ReversibleGitWorktree
    } else {
        RouteActionReversibility::PendingClassify
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SurfaceThread {
    pub surface_thread_id: String,
    pub friday_conversation_id: String,
    pub mission_id: Option<String>,
    pub surface_kind: SurfaceKind,
    pub channel_binding_id: Option<String>,
    pub delivery_route: String,
    pub visibility_policy: VisibilityPolicy,
    pub allowed_actions: Vec<String>,
    pub last_seen_at_ms: Option<i64>,
    pub last_delivered_event_seq: Option<u64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Surface-safe projection of a Mission. Mobile, desktop, and channel UIs can
/// render this without raw provider ids, raw channel chat ids, cwd, or secrets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionSurfaceProjection {
    pub surface_thread_id: String,
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub surface_kind: SurfaceKind,
    pub visibility_policy: VisibilityPolicy,
    pub title: String,
    pub status: MissionStatus,
    pub truth_status: TruthStatus,
    pub current_focus_summary: String,
    pub proof_refs: Vec<String>,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissionLinkKind {
    RouteDecision,
    ProviderSession,
    ProviderTimeline,
    ChannelInbound,
    WorkflowRun,
    MemoryCandidate,
    MemoryDecision,
    ConfirmedMemory,
    ContextPassport,
    ProofReceipt,
    WorkspaceClaim,
    HandoffArtifact,
}

impl MissionLinkKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MissionLinkKind::RouteDecision => "route_decision",
            MissionLinkKind::ProviderSession => "provider_session",
            MissionLinkKind::ProviderTimeline => "provider_timeline",
            MissionLinkKind::ChannelInbound => "channel_inbound",
            MissionLinkKind::WorkflowRun => "workflow_run",
            MissionLinkKind::MemoryCandidate => "memory_candidate",
            MissionLinkKind::MemoryDecision => "memory_decision",
            MissionLinkKind::ConfirmedMemory => "confirmed_memory",
            MissionLinkKind::ContextPassport => "context_passport",
            MissionLinkKind::ProofReceipt => "proof_receipt",
            MissionLinkKind::WorkspaceClaim => "workspace_claim",
            MissionLinkKind::HandoffArtifact => "handoff_artifact",
        }
    }

    pub fn grants_memory_authority(&self) -> bool {
        matches!(self, MissionLinkKind::ConfirmedMemory)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MissionLink {
    pub link_id: String,
    pub mission_id: String,
    pub work_item_id: Option<String>,
    pub link_kind: MissionLinkKind,
    pub target_ref: String,
    pub proof_ref: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MissionSpineError {
    #[error("non-canonical Friday conversation id: {0}")]
    NonCanonicalConversationId(String),
    #[error("missing handoff judgment field: {0}")]
    MissingJudgmentField(&'static str),
    #[error("missing route decision field: {0}")]
    MissingRouteDecisionField(&'static str),
}

/// Friday-owned conversation ids use a product prefix. This intentionally rejects
/// raw provider ids, channel ids, and frontend-local ids.
pub fn validate_friday_conversation_id(id: &str) -> Result<(), MissionSpineError> {
    let trimmed = id.trim();
    if trimmed.starts_with("fconv_") && trimmed.len() > "fconv_".len() {
        Ok(())
    } else {
        Err(MissionSpineError::NonCanonicalConversationId(
            id.to_string(),
        ))
    }
}

fn require_non_empty_decision(value: &str, field: &'static str) -> Result<(), MissionSpineError> {
    if value.trim().is_empty() {
        Err(MissionSpineError::MissingRouteDecisionField(field))
    } else {
        Ok(())
    }
}

fn require_non_empty_decision_vec(
    values: &[String],
    field: &'static str,
) -> Result<(), MissionSpineError> {
    for value in values {
        require_non_empty_decision(value, field)?;
    }
    Ok(())
}

fn require_non_empty_required_vec(
    values: &[String],
    field: &'static str,
) -> Result<(), MissionSpineError> {
    if values.is_empty() {
        return Err(MissionSpineError::MissingRouteDecisionField(field));
    }
    require_non_empty_decision_vec(values, field)
}

/// A sensitive context transfer out of the Hub must be mediated by Context
/// Passport. Friday-internal bookkeeping does not need a passport.
pub fn requires_context_passport(lane: WorkLane, includes_sensitive_context: bool) -> bool {
    includes_sensitive_context && lane.is_external_context_destination()
}

/// Find an active duplicate Mission in the same Friday conversation. The first
/// slice uses exact intent equality; later slices can replace this with a richer
/// intent fingerprint without changing the invariant.
pub fn find_duplicate_mission<'a>(
    candidate: &Mission,
    existing: &'a [Mission],
) -> Option<&'a Mission> {
    existing.iter().find(|mission| {
        mission.status.is_active_like()
            && mission.friday_conversation_id == candidate.friday_conversation_id
            && mission.intent == candidate.intent
    })
}

/// Find an active duplicate for a candidate WorkItem. This is deliberately simple
/// and deterministic for the first slice: same Mission + lane + target + active
/// status is duplicate work unless the existing item is terminal.
pub fn find_duplicate_work_item<'a>(
    candidate: &WorkItem,
    existing: &'a [WorkItem],
) -> Option<&'a WorkItem> {
    existing.iter().find(|item| {
        item.is_active_like()
            && item.mission_id == candidate.mission_id
            && item.lane == candidate.lane
            && item.target_provider_or_agent == candidate.target_provider_or_agent
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Implement Mission Spine domain types".into(),
            current_blocker: Some("Rust graph missing".into()),
            target_lane_thread_agent_provider: "rust-core".into(),
            read_first_files: vec!["rust-core/crates/friday-core/src/lib.rs".into()],
            required_output: "domain types and invariant tests".into(),
            done_criteria: vec!["tests pass".into()],
            red_lines: vec!["do not make provider thread id canonical".into()],
            why_this_route: "Rust Hub must own product truth before UI wiring".into(),
            considered_options: vec!["frontend-only projection".into()],
            deferred_options: vec!["storage and protocol wire".into()],
            previous_pitfalls: vec!["provider timeline is not the Mission".into()],
            inheritable_context: vec!["TS task ledger is migration input only".into()],
            proof_requirements: vec!["cargo test -p friday-core mission".into()],
            ownership_claim_ids: vec!["own-test".into()],
        }
    }

    fn work(id: &str, status: WorkItemStatus) -> WorkItem {
        WorkItem {
            work_item_id: id.into(),
            mission_id: "mission-1".into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some("codex".into()),
            status,
            owner_claim_ids: vec!["own-test".into()],
            workspace_refs: vec!["/tmp/friday".into()],
            capability_id: Some("provider.codex.turn".into()),
            risk_level: Risk::Medium,
            approval_state: ApprovalState::Required,
            blocking_reason: None,
            input_refs: vec!["input-ref".into()],
            output_refs: vec![],
            proof_requirements: vec!["provider completion receipt".into()],
            proof_receipts: if status == WorkItemStatus::CompletedWithProof {
                vec!["proof-ref".into()]
            } else {
                vec![]
            },
            judgment_memory: judgment(),
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    fn mission(id: &str, status: MissionStatus, intent: &str) -> Mission {
        Mission {
            mission_id: id.into(),
            friday_conversation_id: "fconv_20260604_abcd".into(),
            title: "Mission Spine".into(),
            intent: intent.into(),
            status,
            why_now: "prevent thread/task debt".into(),
            decision_path_summary: "Rust Hub owns product truth".into(),
            considered_options: vec!["frontend-only".into()],
            deferred_options: vec!["UI wiring".into()],
            known_pitfalls: vec!["provider timeline is not mission".into()],
            handoff_inheritance: vec!["TS task ledger reference".into()],
            work_item_ids: vec![],
            memory_candidate_refs: vec![],
            context_passport_refs: vec![],
            proof_refs: vec![],
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn mission_status_machine_preserves_active_and_terminal_boundaries() {
        let s = MissionStatus::Active
            .try_transition(MissionStatus::WaitingForUser)
            .unwrap()
            .try_transition(MissionStatus::Blocked)
            .unwrap()
            .try_transition(MissionStatus::Paused)
            .unwrap()
            .try_transition(MissionStatus::Active)
            .unwrap()
            .try_transition(MissionStatus::Done)
            .unwrap();
        assert!(s.is_terminal());
        assert!(MissionStatus::Done
            .try_transition(MissionStatus::Active)
            .is_err());
        assert!(MissionStatus::Active.is_active_like());
        assert!(!MissionStatus::Archived.is_active_like());
    }

    #[test]
    fn work_item_ack_states_do_not_complete() {
        let s = WorkItemStatus::Draft
            .try_transition(WorkItemStatus::ReadyToDispatch)
            .unwrap()
            .try_transition(WorkItemStatus::Dispatched)
            .unwrap()
            .try_transition(WorkItemStatus::HubAccepted)
            .unwrap();
        assert_eq!(s, WorkItemStatus::HubAccepted);
        assert!(!s.is_terminal());
        assert!(s
            .try_transition(WorkItemStatus::CompletedWithProof)
            .is_err());

        let completed = s
            .try_transition(WorkItemStatus::ProviderRouted)
            .unwrap()
            .try_transition(WorkItemStatus::ProviderWaiting)
            .unwrap()
            .try_transition(WorkItemStatus::CompletedWithProof)
            .unwrap();
        assert!(completed.is_terminal());
    }

    #[test]
    fn provider_thread_and_channel_ids_are_not_conversation_ids() {
        assert!(validate_friday_conversation_id("fconv_20260604_abcd").is_ok());
        for bad in [
            "provider-thread-hidden",
            "thread_abc123",
            "telegram:123",
            "discord:456",
            "chat-frontend-local",
            "",
        ] {
            assert_eq!(
                validate_friday_conversation_id(bad),
                Err(MissionSpineError::NonCanonicalConversationId(
                    bad.to_string()
                ))
            );
        }
    }

    #[test]
    fn candidate_memory_link_is_not_authority() {
        assert!(!MissionLinkKind::RouteDecision.grants_memory_authority());
        assert!(!MissionLinkKind::MemoryCandidate.grants_memory_authority());
        assert!(!MissionLinkKind::MemoryDecision.grants_memory_authority());
        assert!(MissionLinkKind::ConfirmedMemory.grants_memory_authority());
    }

    #[test]
    fn sensitive_external_transfer_requires_context_passport() {
        assert!(requires_context_passport(WorkLane::Codex, true));
        assert!(requires_context_passport(WorkLane::Claude, true));
        assert!(requires_context_passport(WorkLane::Channel, true));
        assert!(!requires_context_passport(WorkLane::FridayHub, true));
        assert!(!requires_context_passport(WorkLane::Codex, false));
    }

    #[test]
    fn handoff_judgment_memory_requires_why_and_pitfalls() {
        assert!(judgment().validate().is_ok());

        let mut missing_why = judgment();
        missing_why.why_this_route.clear();
        assert_eq!(
            missing_why.validate(),
            Err(MissionSpineError::MissingJudgmentField("why_this_route"))
        );

        let mut missing_pitfalls = judgment();
        missing_pitfalls.previous_pitfalls.clear();
        assert_eq!(
            missing_pitfalls.validate(),
            Err(MissionSpineError::MissingJudgmentField("previous_pitfalls"))
        );

        let mut missing_considered = judgment();
        missing_considered.considered_options.clear();
        assert_eq!(
            missing_considered.validate(),
            Err(MissionSpineError::MissingJudgmentField(
                "considered_options"
            ))
        );

        let mut missing_inheritable = judgment();
        missing_inheritable.inheritable_context.clear();
        assert_eq!(
            missing_inheritable.validate(),
            Err(MissionSpineError::MissingJudgmentField(
                "inheritable_context"
            ))
        );
    }

    #[test]
    fn route_decision_card_preserves_judgment_path() {
        let item = work("wi-route", WorkItemStatus::ReadyToDispatch);
        let card = RouteDecisionCard::from_work_item(
            "route-decision-1".into(),
            &item,
            vec!["friday://trace/route-decision-1".into()],
            10,
            Some(20),
        );

        assert!(card.validate().is_ok());
        assert_eq!(card.mission_id, "mission-1");
        assert_eq!(card.work_item_id, "wi-route");
        assert_eq!(card.selected_lane, WorkLane::Codex);
        assert_eq!(card.selected_provider_or_agent.as_deref(), Some("codex"));
        assert_eq!(
            card.why_this_route,
            "Rust Hub must own product truth before UI wiring"
        );
        assert_eq!(card.considered_options, vec!["frontend-only projection"]);
        assert_eq!(
            card.previous_pitfalls,
            vec!["provider timeline is not the Mission"]
        );
        assert_eq!(
            card.inheritable_context,
            vec!["TS task ledger is migration input only"]
        );
        assert_eq!(
            card.route_decision_ref(),
            "friday://route-decision/route-decision-1"
        );

        let projection = card.to_projection();
        assert_eq!(projection.selected_target_label.as_deref(), Some("codex"));
        assert_eq!(projection.trace_ref_count, 1);
        assert_eq!(projection.why_this_route, card.why_this_route);
        assert!(projection.action_items.is_empty());
    }

    #[test]
    fn route_decision_card_flagged_builds_plan_action_item() {
        let item = work("wi-route", WorkItemStatus::ReadyToDispatch);
        let card = RouteDecisionCard::from_work_item_flagged(
            "route-decision-1".into(),
            &item,
            vec!["friday://trace/route-decision-1".into()],
            10,
            None,
            true,
        );

        assert!(card.validate().is_ok());
        assert_eq!(card.action_items.len(), 1);
        let action = &card.action_items[0];
        assert_eq!(action.description, "Implement Mission Spine domain types");
        assert_eq!(action.target_kind, RouteActionTargetKind::File);
        assert_eq!(action.target_ref, "rust-core/crates/friday-core/src/lib.rs");
        assert_eq!(
            action.reversibility,
            RouteActionReversibility::OperatorGateRequired
        );
        assert_eq!(action.assigned_lane, WorkLane::Codex);
        assert_eq!(action.assigned_provider_or_agent.as_deref(), Some("codex"));
        assert_eq!(
            action.route_reason,
            "Rust Hub must own product truth before UI wiring"
        );
    }

    #[test]
    fn route_decision_card_rejects_missing_judgment_reason() {
        let mut item = work("wi-route", WorkItemStatus::ReadyToDispatch);
        item.judgment_memory.why_this_route.clear();
        let card =
            RouteDecisionCard::from_work_item("route-decision-1".into(), &item, vec![], 10, None);

        assert_eq!(
            card.validate(),
            Err(MissionSpineError::MissingRouteDecisionField(
                "why_this_route"
            ))
        );

        let mut missing_considered = RouteDecisionCard::from_work_item(
            "route-decision-2".into(),
            &work("wi-route-2", WorkItemStatus::ReadyToDispatch),
            vec![],
            10,
            None,
        );
        missing_considered.considered_options.clear();
        assert_eq!(
            missing_considered.validate(),
            Err(MissionSpineError::MissingRouteDecisionField(
                "considered_options"
            ))
        );
    }

    #[test]
    fn active_duplicate_mission_is_detected_before_new_task_debt() {
        let existing = vec![
            mission("mission-existing", MissionStatus::Active, "mission-spine"),
            mission("mission-done", MissionStatus::Done, "mission-spine"),
        ];
        let candidate = mission("mission-new", MissionStatus::Active, "mission-spine");
        assert_eq!(
            find_duplicate_mission(&candidate, &existing).map(|m| m.mission_id.as_str()),
            Some("mission-existing")
        );

        let only_terminal = vec![mission(
            "mission-done",
            MissionStatus::Done,
            "mission-spine",
        )];
        assert!(find_duplicate_mission(&candidate, &only_terminal).is_none());
    }

    #[test]
    fn active_duplicate_work_item_is_detected_before_dispatch() {
        let existing = vec![
            work("wi-existing", WorkItemStatus::ProviderWaiting),
            work("wi-done", WorkItemStatus::CompletedWithProof),
        ];
        let candidate = work("wi-new", WorkItemStatus::Draft);
        assert_eq!(
            find_duplicate_work_item(&candidate, &existing).map(|item| item.work_item_id.as_str()),
            Some("wi-existing")
        );

        let only_terminal = vec![work("wi-done", WorkItemStatus::CompletedWithProof)];
        assert!(find_duplicate_work_item(&candidate, &only_terminal).is_none());
    }

    #[test]
    fn workspace_touch_requires_ownership_and_completion_requires_proof() {
        let mut touching = work("wi-touching", WorkItemStatus::ReadyToDispatch);
        touching.owner_claim_ids.clear();
        assert!(!touching.has_required_ownership_for_workspace_touch());

        let mut read_only = touching.clone();
        read_only.workspace_refs.clear();
        assert!(read_only.has_required_ownership_for_workspace_touch());

        let mut done = work("wi-done", WorkItemStatus::CompletedWithProof);
        assert!(done.completion_is_proven());
        done.proof_receipts.clear();
        assert!(!done.completion_is_proven());
    }

    #[test]
    fn outcome_specs_parse_and_require_matching_typed_signal() {
        let spec = ProofRequirementSpec::parse("outcome:ToolsExecuted:>=1").unwrap();
        assert_eq!(spec.kind, ProofRequirementKind::ToolsExecuted);
        assert_eq!(spec.expectation, ">=1");
        assert!(ProofRequirementSpec::parse("provider completion receipt").is_none());

        let receipt =
            parse_outcome_receipt("proof://outcome/ToolsExecuted/run-1?signal=executed_tools=2")
                .unwrap();
        assert_eq!(receipt.kind, ProofRequirementKind::ToolsExecuted);
        assert_eq!(receipt.run_id, "run-1");
        assert_eq!(receipt.signal, "executed_tools=2");
        assert!(parse_outcome_receipt("proof://outcome/ToolsExecuted/run-1").is_none());
        assert!(parse_outcome_receipt("proof://outcome/ToolsExecuted/run-1?signal=").is_none());

        let mut done = work("wi-outcome", WorkItemStatus::CompletedWithProof);
        done.proof_requirements = vec!["outcome:ToolsExecuted:>=1".into()];
        done.proof_receipts =
            vec!["proof://outcome/ToolsExecuted/run-1?signal=executed_tools=2".into()];
        assert!(done.has_outcome_proof_requirements());
        assert!(done.completion_outcome_is_proven());

        done.proof_receipts = vec!["proof://outcome/ToolsExecuted/run-1?signal=0".into()];
        assert!(!done.completion_outcome_is_proven());

        done.proof_receipts = vec!["proof://provider-free-text".into()];
        assert!(!done.completion_outcome_is_proven());

        done.proof_requirements = vec![
            "outcome:ToolsExecuted:>=1".into(),
            "outcome:TestsPassed:>=1".into(),
        ];
        done.proof_receipts =
            vec!["proof://outcome/ToolsExecuted/run-1?signal=executed_tools=2".into()];
        assert!(!done.completion_outcome_is_proven());
        done.proof_receipts
            .push("proof://outcome/TestsPassed/run-1?signal=passed_tests=12".into());
        assert!(done.completion_outcome_is_proven());
    }

    #[test]
    fn legacy_requirements_remain_floor_only_for_outcome_predicate() {
        let mut done = work("wi-legacy", WorkItemStatus::CompletedWithProof);
        done.proof_receipts = vec!["proof://provider/free-text-receipt".into()];
        assert!(!done.has_outcome_proof_requirements());
        assert!(done.completion_is_proven());
        assert!(
            !done.completion_outcome_is_proven(),
            "outcome-specific proof must not be true when there are no typed outcome requirements"
        );
        assert!(outcome_checked_proof_enabled_from(Some("1")));
        assert!(!outcome_checked_proof_enabled_from(Some("true")));
        assert!(!outcome_checked_proof_enabled_from(None));
    }
}
