//! Process/workspace registry domain objects.
//!
//! This is the OS/process-truth layer that Mission Spine needs before Friday can
//! honestly supervise long-running Codex/Claude/dev-server work across isolated
//! conversation threads. Observed processes are inspect-only until a Hub-owned
//! claim/lease with safe-stop proof exists.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceClaimKind {
    Workspace,
    Worktree,
    Port,
    Process,
    ProviderSession,
    DesignServer,
    FridayLaunchdService,
}

impl WorkspaceClaimKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkspaceClaimKind::Workspace => "workspace",
            WorkspaceClaimKind::Worktree => "worktree",
            WorkspaceClaimKind::Port => "port",
            WorkspaceClaimKind::Process => "process",
            WorkspaceClaimKind::ProviderSession => "provider_session",
            WorkspaceClaimKind::DesignServer => "design_server",
            WorkspaceClaimKind::FridayLaunchdService => "friday_launchd_service",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimState {
    Active,
    PendingAdoption,
    NeedsOwnerDecision,
    Released,
    Stale,
    Blocked,
}

impl ClaimState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ClaimState::Active => "active",
            ClaimState::PendingAdoption => "pending_adoption",
            ClaimState::NeedsOwnerDecision => "needs_owner_decision",
            ClaimState::Released => "released",
            ClaimState::Stale => "stale",
            ClaimState::Blocked => "blocked",
        }
    }

    pub fn blocks_new_work(&self) -> bool {
        !matches!(self, ClaimState::Released)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceClaim {
    pub claim_id: String,
    pub mission_id: String,
    pub work_item_id: Option<String>,
    pub owner_principal: String,
    pub owner_agent: String,
    pub workspace_ref: String,
    pub claim_kind: WorkspaceClaimKind,
    pub state: ClaimState,
    pub reason: String,
    pub safe_release_policy: String,
    pub proof_requirements: Vec<String>,
    pub proof_refs: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub released_at_ms: Option<i64>,
}

impl WorkspaceClaim {
    pub fn blocks_new_work(&self) -> bool {
        self.state.blocks_new_work()
    }

    pub fn release_is_proven(&self) -> bool {
        self.state == ClaimState::Released
            && self.released_at_ms.is_some()
            && !self.proof_refs.is_empty()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessKind {
    CodexCli,
    CodexAppServer,
    Claude,
    FridayHub,
    FridayCompanion,
    DesignSaveServer,
    DevServer,
    WorkflowWorker,
    OtherObserved,
}

impl ProcessKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProcessKind::CodexCli => "codex_cli",
            ProcessKind::CodexAppServer => "codex_app_server",
            ProcessKind::Claude => "claude",
            ProcessKind::FridayHub => "friday_hub",
            ProcessKind::FridayCompanion => "friday_companion",
            ProcessKind::DesignSaveServer => "design_save_server",
            ProcessKind::DevServer => "dev_server",
            ProcessKind::WorkflowWorker => "workflow_worker",
            ProcessKind::OtherObserved => "other_observed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseState {
    Claimed,
    Running,
    Healthy,
    NeedsOwnerDecision,
    StoppingRequested,
    StoppedWithProof,
    Stale,
    Blocked,
}

impl LeaseState {
    pub fn as_str(&self) -> &'static str {
        match self {
            LeaseState::Claimed => "claimed",
            LeaseState::Running => "running",
            LeaseState::Healthy => "healthy",
            LeaseState::NeedsOwnerDecision => "needs_owner_decision",
            LeaseState::StoppingRequested => "stopping_requested",
            LeaseState::StoppedWithProof => "stopped_with_proof",
            LeaseState::Stale => "stale",
            LeaseState::Blocked => "blocked",
        }
    }

    pub fn blocks_new_work(&self) -> bool {
        !matches!(self, LeaseState::StoppedWithProof | LeaseState::Blocked)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessLease {
    pub lease_id: String,
    pub claim_id: String,
    pub mission_id: String,
    pub work_item_id: Option<String>,
    pub pid: Option<i64>,
    pub process_group_id: Option<i64>,
    pub process_kind: ProcessKind,
    pub command_ref: Option<String>,
    pub command_hash: Option<String>,
    pub cwd_ref: String,
    pub port_bindings: Vec<String>,
    pub started_by_surface_thread_id: Option<String>,
    pub started_by_provider_session_id: Option<String>,
    pub health_check_ref: Option<String>,
    pub safe_stop_ref: Option<String>,
    pub last_observed_at_ms: Option<i64>,
    pub stale_after_ms: Option<i64>,
    pub state: LeaseState,
    pub proof_refs: Vec<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl ProcessLease {
    pub fn can_request_stop(&self) -> bool {
        matches!(
            self.state,
            LeaseState::Claimed
                | LeaseState::Running
                | LeaseState::Healthy
                | LeaseState::NeedsOwnerDecision
                | LeaseState::Stale
        ) && !self.claim_id.trim().is_empty()
            && self
                .safe_stop_ref
                .as_deref()
                .is_some_and(|r| !r.trim().is_empty())
    }

    pub fn stopped_is_proven(&self) -> bool {
        self.state == LeaseState::StoppedWithProof && !self.proof_refs.is_empty()
    }

    pub fn blocks_new_work(&self) -> bool {
        self.state.blocks_new_work()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnershipStatus {
    ObservedUnowned,
    UnownedAgentProcess,
    UnownedFridayProcess,
    FridayOwnedLaunchd,
    FridayOwnedClaimed,
}

impl OwnershipStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OwnershipStatus::ObservedUnowned => "observed_unowned",
            OwnershipStatus::UnownedAgentProcess => "unowned_agent_process",
            OwnershipStatus::UnownedFridayProcess => "unowned_friday_process",
            OwnershipStatus::FridayOwnedLaunchd => "friday_owned_launchd",
            OwnershipStatus::FridayOwnedClaimed => "friday_owned_claimed",
        }
    }

    pub fn is_controllable_without_adoption(&self) -> bool {
        matches!(self, OwnershipStatus::FridayOwnedClaimed)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessObservation {
    pub observation_id: String,
    pub pid: i64,
    pub ppid: Option<i64>,
    pub process_kind: ProcessKind,
    pub cwd_ref: String,
    pub port_bindings: Vec<String>,
    pub command_hash: Option<String>,
    pub observed_at_ms: i64,
    pub matched_claim_id: Option<String>,
    pub ownership_status: OwnershipStatus,
}

impl ProcessObservation {
    pub fn is_control_allowed_without_adoption(&self) -> bool {
        self.ownership_status.is_controllable_without_adoption()
            && self
                .matched_claim_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(
        state: LeaseState,
        safe_stop_ref: Option<String>,
        proof_refs: Vec<String>,
    ) -> ProcessLease {
        ProcessLease {
            lease_id: "lease-1".into(),
            claim_id: "claim-1".into(),
            mission_id: "mission-1".into(),
            work_item_id: Some("work-1".into()),
            pid: Some(123),
            process_group_id: None,
            process_kind: ProcessKind::DevServer,
            command_ref: Some("friday://command/1".into()),
            command_hash: Some("sha256:abc".into()),
            cwd_ref: "/tmp/friday".into(),
            port_bindings: vec!["127.0.0.1:3000".into()],
            started_by_surface_thread_id: None,
            started_by_provider_session_id: None,
            health_check_ref: None,
            safe_stop_ref,
            last_observed_at_ms: Some(10),
            stale_after_ms: Some(60_000),
            state,
            proof_refs,
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    #[test]
    fn unowned_observation_is_inspect_only_until_claimed() {
        let observed = ProcessObservation {
            observation_id: "obs-1".into(),
            pid: 999,
            ppid: None,
            process_kind: ProcessKind::CodexCli,
            cwd_ref: "/Users/jarvis".into(),
            port_bindings: Vec::new(),
            command_hash: Some("sha256:redacted".into()),
            observed_at_ms: 1,
            matched_claim_id: None,
            ownership_status: OwnershipStatus::UnownedAgentProcess,
        };
        assert!(!observed.is_control_allowed_without_adoption());

        let claimed = ProcessObservation {
            matched_claim_id: Some("claim-1".into()),
            ownership_status: OwnershipStatus::FridayOwnedClaimed,
            ..observed
        };
        assert!(claimed.is_control_allowed_without_adoption());
    }

    #[test]
    fn process_stop_requires_safe_stop_and_stop_proof() {
        assert!(!lease(LeaseState::Running, None, vec![]).can_request_stop());
        assert!(lease(
            LeaseState::Running,
            Some("friday://safe-stop/dev-server".into()),
            vec![]
        )
        .can_request_stop());
        assert!(!lease(LeaseState::StoppedWithProof, None, vec![]).stopped_is_proven());
        assert!(lease(
            LeaseState::StoppedWithProof,
            None,
            vec!["proof://stopped".into()]
        )
        .stopped_is_proven());
    }

    #[test]
    fn released_claim_and_stopped_lease_stop_blocking_new_work() {
        let mut claim = WorkspaceClaim {
            claim_id: "claim-1".into(),
            mission_id: "mission-1".into(),
            work_item_id: Some("work-1".into()),
            owner_principal: "operator:jarvis".into(),
            owner_agent: "codex".into(),
            workspace_ref: "/tmp/friday".into(),
            claim_kind: WorkspaceClaimKind::Workspace,
            state: ClaimState::Active,
            reason: "own workspace".into(),
            safe_release_policy: "operator proof required".into(),
            proof_requirements: vec!["release proof".into()],
            proof_refs: vec![],
            created_at_ms: 1,
            updated_at_ms: 2,
            released_at_ms: None,
        };
        assert!(claim.blocks_new_work());
        claim.state = ClaimState::Released;
        claim.released_at_ms = Some(3);
        claim.proof_refs.push("proof://released".into());
        assert!(!claim.blocks_new_work());
        assert!(claim.release_is_proven());

        assert!(lease(LeaseState::Running, None, vec![]).blocks_new_work());
        assert!(!lease(
            LeaseState::StoppedWithProof,
            None,
            vec!["proof://stopped".into()]
        )
        .blocks_new_work());
    }
}
