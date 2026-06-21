//! Process/workspace registry persistence. Hub-only ownership truth.
//!
//! Observed processes are evidence, not authority. A process/port/workspace is
//! controllable only after the Hub has a claim/lease row; safe release/stop is
//! represented with explicit proof refs so "acknowledged" cannot masquerade as
//! "closed".

use crate::error::{Result, StorageError};
use friday_core::{
    ClaimState, LeaseState, OwnershipStatus, ProcessKind, ProcessLease, ProcessObservation,
    WorkspaceClaim, WorkspaceClaimKind,
};
use rusqlite::{params, Connection, Params};

fn unsupported(message: impl Into<String>) -> StorageError {
    StorageError::Unsupported(message.into())
}

fn require_non_empty(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(unsupported(format!(
            "process registry {field} must not be empty"
        )))
    } else {
        Ok(())
    }
}

fn require_non_empty_optional(value: Option<&str>, field: &str) -> Result<()> {
    if let Some(value) = value {
        require_non_empty(value, field)?;
    }
    Ok(())
}

fn require_positive_optional(value: Option<i64>, field: &str) -> Result<()> {
    if let Some(value) = value {
        if value <= 0 {
            return Err(unsupported(format!(
                "process registry {field} must be positive"
            )));
        }
    }
    Ok(())
}

fn require_non_empty_vec(values: &[String], field: &str) -> Result<()> {
    for value in values {
        require_non_empty(value, field)?;
    }
    Ok(())
}

fn encode_vec(values: &[String], field: &str) -> Result<String> {
    serde_json::to_string(values)
        .map_err(|e| unsupported(format!("failed to encode {field} as json: {e}")))
}

fn decode_vec(value: String, field: &str) -> Result<Vec<String>> {
    serde_json::from_str(&value)
        .map_err(|e| unsupported(format!("failed to decode {field} json: {e}")))
}

fn parse_claim_kind(value: String) -> Result<WorkspaceClaimKind> {
    match value.as_str() {
        "workspace" => Ok(WorkspaceClaimKind::Workspace),
        "worktree" => Ok(WorkspaceClaimKind::Worktree),
        "port" => Ok(WorkspaceClaimKind::Port),
        "process" => Ok(WorkspaceClaimKind::Process),
        "provider_session" => Ok(WorkspaceClaimKind::ProviderSession),
        "design_server" => Ok(WorkspaceClaimKind::DesignServer),
        "friday_launchd_service" => Ok(WorkspaceClaimKind::FridayLaunchdService),
        _ => Err(unsupported(format!(
            "unknown workspace claim kind '{value}'"
        ))),
    }
}

fn parse_claim_state(value: String) -> Result<ClaimState> {
    match value.as_str() {
        "active" => Ok(ClaimState::Active),
        "pending_adoption" => Ok(ClaimState::PendingAdoption),
        "needs_owner_decision" => Ok(ClaimState::NeedsOwnerDecision),
        "released" => Ok(ClaimState::Released),
        "stale" => Ok(ClaimState::Stale),
        "blocked" => Ok(ClaimState::Blocked),
        _ => Err(unsupported(format!(
            "unknown workspace claim state '{value}'"
        ))),
    }
}

fn parse_process_kind(value: String) -> Result<ProcessKind> {
    match value.as_str() {
        "codex_cli" => Ok(ProcessKind::CodexCli),
        "codex_app_server" => Ok(ProcessKind::CodexAppServer),
        "claude" => Ok(ProcessKind::Claude),
        "friday_hub" => Ok(ProcessKind::FridayHub),
        "friday_companion" => Ok(ProcessKind::FridayCompanion),
        "design_save_server" => Ok(ProcessKind::DesignSaveServer),
        "dev_server" => Ok(ProcessKind::DevServer),
        "workflow_worker" => Ok(ProcessKind::WorkflowWorker),
        "other_observed" => Ok(ProcessKind::OtherObserved),
        _ => Err(unsupported(format!("unknown process kind '{value}'"))),
    }
}

fn parse_lease_state(value: String) -> Result<LeaseState> {
    match value.as_str() {
        "claimed" => Ok(LeaseState::Claimed),
        "running" => Ok(LeaseState::Running),
        "healthy" => Ok(LeaseState::Healthy),
        "needs_owner_decision" => Ok(LeaseState::NeedsOwnerDecision),
        "stopping_requested" => Ok(LeaseState::StoppingRequested),
        "stopped_with_proof" => Ok(LeaseState::StoppedWithProof),
        "stale" => Ok(LeaseState::Stale),
        "blocked" => Ok(LeaseState::Blocked),
        _ => Err(unsupported(format!(
            "unknown process lease state '{value}'"
        ))),
    }
}

fn parse_ownership_status(value: String) -> Result<OwnershipStatus> {
    match value.as_str() {
        "observed_unowned" => Ok(OwnershipStatus::ObservedUnowned),
        "unowned_agent_process" => Ok(OwnershipStatus::UnownedAgentProcess),
        "unowned_friday_process" => Ok(OwnershipStatus::UnownedFridayProcess),
        "friday_owned_launchd" => Ok(OwnershipStatus::FridayOwnedLaunchd),
        "friday_owned_claimed" => Ok(OwnershipStatus::FridayOwnedClaimed),
        _ => Err(unsupported(format!("unknown ownership status '{value}'"))),
    }
}

fn validate_claim(claim: &WorkspaceClaim) -> Result<()> {
    require_non_empty(&claim.claim_id, "claim_id")?;
    require_non_empty(&claim.mission_id, "claim.mission_id")?;
    require_non_empty_optional(claim.work_item_id.as_deref(), "claim.work_item_id")?;
    require_non_empty(&claim.owner_principal, "claim.owner_principal")?;
    require_non_empty(&claim.owner_agent, "claim.owner_agent")?;
    require_non_empty(&claim.workspace_ref, "claim.workspace_ref")?;
    require_non_empty(&claim.reason, "claim.reason")?;
    require_non_empty(&claim.safe_release_policy, "claim.safe_release_policy")?;
    if claim.proof_requirements.is_empty() {
        return Err(unsupported(format!(
            "workspace_claim '{}' requires proof_requirements",
            claim.claim_id
        )));
    }
    require_non_empty_vec(&claim.proof_requirements, "claim.proof_requirements")?;
    require_non_empty_vec(&claim.proof_refs, "claim.proof_refs")?;
    if claim.state == ClaimState::Released && !claim.release_is_proven() {
        return Err(unsupported(format!(
            "workspace_claim '{}' cannot be released without released_at_ms and proof_refs",
            claim.claim_id
        )));
    }
    Ok(())
}

fn validate_lease(lease: &ProcessLease) -> Result<()> {
    require_non_empty(&lease.lease_id, "lease_id")?;
    require_non_empty(&lease.claim_id, "lease.claim_id")?;
    require_non_empty(&lease.mission_id, "lease.mission_id")?;
    require_non_empty_optional(lease.work_item_id.as_deref(), "lease.work_item_id")?;
    require_positive_optional(lease.pid, "lease.pid")?;
    require_positive_optional(lease.process_group_id, "lease.process_group_id")?;
    require_non_empty_optional(lease.command_ref.as_deref(), "lease.command_ref")?;
    require_non_empty_optional(lease.command_hash.as_deref(), "lease.command_hash")?;
    require_non_empty(&lease.cwd_ref, "lease.cwd_ref")?;
    require_non_empty_vec(&lease.port_bindings, "lease.port_bindings")?;
    require_non_empty_optional(
        lease.started_by_surface_thread_id.as_deref(),
        "lease.started_by_surface_thread_id",
    )?;
    require_non_empty_optional(
        lease.started_by_provider_session_id.as_deref(),
        "lease.started_by_provider_session_id",
    )?;
    require_non_empty_optional(lease.health_check_ref.as_deref(), "lease.health_check_ref")?;
    require_non_empty_optional(lease.safe_stop_ref.as_deref(), "lease.safe_stop_ref")?;
    require_positive_optional(lease.last_observed_at_ms, "lease.last_observed_at_ms")?;
    require_positive_optional(lease.stale_after_ms, "lease.stale_after_ms")?;
    require_non_empty_vec(&lease.proof_refs, "lease.proof_refs")?;
    if lease.state == LeaseState::StoppingRequested
        && lease
            .safe_stop_ref
            .as_deref()
            .map_or(true, |r| r.trim().is_empty())
    {
        return Err(unsupported(format!(
            "process_lease '{}' cannot request stop without safe_stop_ref",
            lease.lease_id
        )));
    }
    if lease.state == LeaseState::StoppedWithProof && !lease.stopped_is_proven() {
        return Err(unsupported(format!(
            "process_lease '{}' cannot be stopped_with_proof without proof_refs",
            lease.lease_id
        )));
    }
    Ok(())
}

fn validate_observation(observation: &ProcessObservation) -> Result<()> {
    require_non_empty(&observation.observation_id, "observation_id")?;
    if observation.pid <= 0 {
        return Err(unsupported(format!(
            "process_observation '{}' requires a positive pid",
            observation.observation_id
        )));
    }
    require_positive_optional(observation.ppid, "observation.ppid")?;
    require_non_empty(&observation.cwd_ref, "observation.cwd_ref")?;
    require_non_empty_vec(&observation.port_bindings, "observation.port_bindings")?;
    require_non_empty_optional(
        observation.command_hash.as_deref(),
        "observation.command_hash",
    )?;
    require_non_empty_optional(
        observation.matched_claim_id.as_deref(),
        "observation.matched_claim_id",
    )?;
    if observation.ownership_status == OwnershipStatus::FridayOwnedClaimed
        && observation
            .matched_claim_id
            .as_deref()
            .map_or(true, |id| id.trim().is_empty())
    {
        return Err(unsupported(format!(
            "process_observation '{}' cannot be friday_owned_claimed without matched_claim_id",
            observation.observation_id
        )));
    }
    Ok(())
}

pub fn upsert_workspace_claim(conn: &Connection, claim: &WorkspaceClaim) -> Result<()> {
    validate_claim(claim)?;
    conn.execute(
        "INSERT INTO workspace_claim
            (claim_id, mission_id, work_item_id, owner_principal, owner_agent,
             workspace_ref, claim_kind, state, reason, safe_release_policy,
             proof_requirements, proof_refs, created_at_ms, updated_at_ms, released_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(claim_id) DO UPDATE SET
            mission_id = excluded.mission_id,
            work_item_id = excluded.work_item_id,
            owner_principal = excluded.owner_principal,
            owner_agent = excluded.owner_agent,
            workspace_ref = excluded.workspace_ref,
            claim_kind = excluded.claim_kind,
            state = excluded.state,
            reason = excluded.reason,
            safe_release_policy = excluded.safe_release_policy,
            proof_requirements = excluded.proof_requirements,
            proof_refs = excluded.proof_refs,
            updated_at_ms = excluded.updated_at_ms,
            released_at_ms = excluded.released_at_ms",
        params![
            claim.claim_id,
            claim.mission_id,
            claim.work_item_id,
            claim.owner_principal,
            claim.owner_agent,
            claim.workspace_ref,
            claim.claim_kind.as_str(),
            claim.state.as_str(),
            claim.reason,
            claim.safe_release_policy,
            encode_vec(&claim.proof_requirements, "claim.proof_requirements")?,
            encode_vec(&claim.proof_refs, "claim.proof_refs")?,
            claim.created_at_ms,
            claim.updated_at_ms,
            claim.released_at_ms,
        ],
    )?;
    Ok(())
}

pub fn get_workspace_claim(conn: &Connection, claim_id: &str) -> Result<Option<WorkspaceClaim>> {
    workspace_claims_by_sql(
        conn,
        "SELECT claim_id, mission_id, work_item_id, owner_principal, owner_agent,
                workspace_ref, claim_kind, state, reason, safe_release_policy,
                proof_requirements, proof_refs, created_at_ms, updated_at_ms, released_at_ms
         FROM workspace_claim
         WHERE claim_id = ?1",
        [claim_id],
    )
    .map(|mut rows| rows.pop())
}

pub fn list_active_workspace_claims(conn: &Connection) -> Result<Vec<WorkspaceClaim>> {
    workspace_claims_by_sql(
        conn,
        "SELECT claim_id, mission_id, work_item_id, owner_principal, owner_agent,
                workspace_ref, claim_kind, state, reason, safe_release_policy,
                proof_requirements, proof_refs, created_at_ms, updated_at_ms, released_at_ms
         FROM workspace_claim
         WHERE state <> 'released'
         ORDER BY updated_at_ms DESC, claim_id",
        [],
    )
}

pub fn find_active_workspace_conflict(
    conn: &Connection,
    workspace_ref: &str,
) -> Result<Option<WorkspaceClaim>> {
    workspace_claims_by_sql(
        conn,
        "SELECT claim_id, mission_id, work_item_id, owner_principal, owner_agent,
                workspace_ref, claim_kind, state, reason, safe_release_policy,
                proof_requirements, proof_refs, created_at_ms, updated_at_ms, released_at_ms
         FROM workspace_claim
         WHERE workspace_ref = ?1 AND state <> 'released'
         ORDER BY updated_at_ms DESC, claim_id
         LIMIT 1",
        [workspace_ref],
    )
    .map(|mut rows| rows.pop())
}

fn workspace_claims_by_sql<P>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<WorkspaceClaim>>
where
    P: Params,
{
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, String>(11)?,
            r.get::<_, i64>(12)?,
            r.get::<_, i64>(13)?,
            r.get::<_, Option<i64>>(14)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            claim_id,
            mission_id,
            work_item_id,
            owner_principal,
            owner_agent,
            workspace_ref,
            claim_kind,
            state,
            reason,
            safe_release_policy,
            proof_requirements,
            proof_refs,
            created_at_ms,
            updated_at_ms,
            released_at_ms,
        ) = row?;
        out.push(WorkspaceClaim {
            claim_id,
            mission_id,
            work_item_id,
            owner_principal,
            owner_agent,
            workspace_ref,
            claim_kind: parse_claim_kind(claim_kind)?,
            state: parse_claim_state(state)?,
            reason,
            safe_release_policy,
            proof_requirements: decode_vec(proof_requirements, "claim.proof_requirements")?,
            proof_refs: decode_vec(proof_refs, "claim.proof_refs")?,
            created_at_ms,
            updated_at_ms,
            released_at_ms,
        });
    }
    Ok(out)
}

pub fn upsert_process_lease(conn: &Connection, lease: &ProcessLease) -> Result<()> {
    validate_lease(lease)?;
    conn.execute(
        "INSERT INTO process_lease
            (lease_id, claim_id, mission_id, work_item_id, pid, process_group_id,
             process_kind, command_ref, command_hash, cwd_ref, port_bindings,
             started_by_surface_thread_id, started_by_provider_session_id,
             health_check_ref, safe_stop_ref, last_observed_at_ms, stale_after_ms,
             state, proof_refs, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
         ON CONFLICT(lease_id) DO UPDATE SET
            claim_id = excluded.claim_id,
            mission_id = excluded.mission_id,
            work_item_id = excluded.work_item_id,
            pid = excluded.pid,
            process_group_id = excluded.process_group_id,
            process_kind = excluded.process_kind,
            command_ref = excluded.command_ref,
            command_hash = excluded.command_hash,
            cwd_ref = excluded.cwd_ref,
            port_bindings = excluded.port_bindings,
            started_by_surface_thread_id = excluded.started_by_surface_thread_id,
            started_by_provider_session_id = excluded.started_by_provider_session_id,
            health_check_ref = excluded.health_check_ref,
            safe_stop_ref = excluded.safe_stop_ref,
            last_observed_at_ms = excluded.last_observed_at_ms,
            stale_after_ms = excluded.stale_after_ms,
            state = excluded.state,
            proof_refs = excluded.proof_refs,
            updated_at_ms = excluded.updated_at_ms",
        params![
            lease.lease_id,
            lease.claim_id,
            lease.mission_id,
            lease.work_item_id,
            lease.pid,
            lease.process_group_id,
            lease.process_kind.as_str(),
            lease.command_ref,
            lease.command_hash,
            lease.cwd_ref,
            encode_vec(&lease.port_bindings, "lease.port_bindings")?,
            lease.started_by_surface_thread_id,
            lease.started_by_provider_session_id,
            lease.health_check_ref,
            lease.safe_stop_ref,
            lease.last_observed_at_ms,
            lease.stale_after_ms,
            lease.state.as_str(),
            encode_vec(&lease.proof_refs, "lease.proof_refs")?,
            lease.created_at_ms,
            lease.updated_at_ms,
        ],
    )?;
    Ok(())
}

pub fn get_process_lease(conn: &Connection, lease_id: &str) -> Result<Option<ProcessLease>> {
    process_leases_by_sql(
        conn,
        "SELECT lease_id, claim_id, mission_id, work_item_id, pid, process_group_id,
                process_kind, command_ref, command_hash, cwd_ref, port_bindings,
                started_by_surface_thread_id, started_by_provider_session_id,
                health_check_ref, safe_stop_ref, last_observed_at_ms, stale_after_ms,
                state, proof_refs, created_at_ms, updated_at_ms
         FROM process_lease
         WHERE lease_id = ?1",
        [lease_id],
    )
    .map(|mut rows| rows.pop())
}

pub fn list_active_process_leases(conn: &Connection) -> Result<Vec<ProcessLease>> {
    process_leases_by_sql(
        conn,
        "SELECT lease_id, claim_id, mission_id, work_item_id, pid, process_group_id,
                process_kind, command_ref, command_hash, cwd_ref, port_bindings,
                started_by_surface_thread_id, started_by_provider_session_id,
                health_check_ref, safe_stop_ref, last_observed_at_ms, stale_after_ms,
                state, proof_refs, created_at_ms, updated_at_ms
         FROM process_lease
         WHERE state NOT IN ('stopped_with_proof', 'blocked')
         ORDER BY updated_at_ms DESC, lease_id",
        [],
    )
}

pub fn find_active_port_conflict(
    conn: &Connection,
    port_binding: &str,
) -> Result<Option<ProcessLease>> {
    require_non_empty(port_binding, "port_binding")?;
    Ok(list_active_process_leases(conn)?
        .into_iter()
        .find(|lease| lease.port_bindings.iter().any(|p| p == port_binding)))
}

pub fn request_process_stop(
    conn: &Connection,
    lease_id: &str,
    now_ms: i64,
) -> Result<ProcessLease> {
    require_non_empty(lease_id, "lease_id")?;
    let mut lease = get_process_lease(conn, lease_id)?
        .ok_or_else(|| unsupported(format!("process lease '{lease_id}' not found")))?;
    if !lease.can_request_stop() {
        return Err(unsupported(format!(
            "process lease '{lease_id}' cannot request stop without active state and safe_stop_ref"
        )));
    }
    lease.state = LeaseState::StoppingRequested;
    lease.updated_at_ms = now_ms;
    upsert_process_lease(conn, &lease)?;
    Ok(lease)
}

pub fn record_process_stopped_with_proof(
    conn: &Connection,
    lease_id: &str,
    proof_ref: &str,
    now_ms: i64,
) -> Result<ProcessLease> {
    require_non_empty(lease_id, "lease_id")?;
    require_non_empty(proof_ref, "proof_ref")?;
    let mut lease = get_process_lease(conn, lease_id)?
        .ok_or_else(|| unsupported(format!("process lease '{lease_id}' not found")))?;
    if !matches!(
        lease.state,
        LeaseState::StoppingRequested
            | LeaseState::Running
            | LeaseState::Healthy
            | LeaseState::Stale
    ) {
        return Err(unsupported(format!(
            "process lease '{lease_id}' cannot be stopped from state '{}'",
            lease.state.as_str()
        )));
    }
    if lease
        .safe_stop_ref
        .as_deref()
        .map_or(true, |r| r.trim().is_empty())
    {
        return Err(unsupported(format!(
            "process lease '{lease_id}' cannot be stopped without safe_stop_ref"
        )));
    }
    if !lease
        .proof_refs
        .iter()
        .any(|existing| existing == proof_ref)
    {
        lease.proof_refs.push(proof_ref.to_string());
    }
    lease.state = LeaseState::StoppedWithProof;
    lease.updated_at_ms = now_ms;
    upsert_process_lease(conn, &lease)?;
    Ok(lease)
}

fn process_leases_by_sql<P>(conn: &Connection, sql: &str, params: P) -> Result<Vec<ProcessLease>>
where
    P: Params,
{
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, String>(9)?,
            r.get::<_, String>(10)?,
            r.get::<_, Option<String>>(11)?,
            r.get::<_, Option<String>>(12)?,
            r.get::<_, Option<String>>(13)?,
            r.get::<_, Option<String>>(14)?,
            r.get::<_, Option<i64>>(15)?,
            r.get::<_, Option<i64>>(16)?,
            r.get::<_, String>(17)?,
            r.get::<_, String>(18)?,
            r.get::<_, i64>(19)?,
            r.get::<_, i64>(20)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            lease_id,
            claim_id,
            mission_id,
            work_item_id,
            pid,
            process_group_id,
            process_kind,
            command_ref,
            command_hash,
            cwd_ref,
            port_bindings,
            started_by_surface_thread_id,
            started_by_provider_session_id,
            health_check_ref,
            safe_stop_ref,
            last_observed_at_ms,
            stale_after_ms,
            state,
            proof_refs,
            created_at_ms,
            updated_at_ms,
        ) = row?;
        out.push(ProcessLease {
            lease_id,
            claim_id,
            mission_id,
            work_item_id,
            pid,
            process_group_id,
            process_kind: parse_process_kind(process_kind)?,
            command_ref,
            command_hash,
            cwd_ref,
            port_bindings: decode_vec(port_bindings, "lease.port_bindings")?,
            started_by_surface_thread_id,
            started_by_provider_session_id,
            health_check_ref,
            safe_stop_ref,
            last_observed_at_ms,
            stale_after_ms,
            state: parse_lease_state(state)?,
            proof_refs: decode_vec(proof_refs, "lease.proof_refs")?,
            created_at_ms,
            updated_at_ms,
        });
    }
    Ok(out)
}

pub fn upsert_process_observation(
    conn: &Connection,
    observation: &ProcessObservation,
) -> Result<()> {
    validate_observation(observation)?;
    conn.execute(
        "INSERT INTO process_observation
            (observation_id, pid, ppid, process_kind, cwd_ref, port_bindings,
             command_hash, observed_at_ms, matched_claim_id, ownership_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(observation_id) DO UPDATE SET
            pid = excluded.pid,
            ppid = excluded.ppid,
            process_kind = excluded.process_kind,
            cwd_ref = excluded.cwd_ref,
            port_bindings = excluded.port_bindings,
            command_hash = excluded.command_hash,
            observed_at_ms = excluded.observed_at_ms,
            matched_claim_id = excluded.matched_claim_id,
            ownership_status = excluded.ownership_status",
        params![
            observation.observation_id,
            observation.pid,
            observation.ppid,
            observation.process_kind.as_str(),
            observation.cwd_ref,
            encode_vec(&observation.port_bindings, "observation.port_bindings")?,
            observation.command_hash,
            observation.observed_at_ms,
            observation.matched_claim_id,
            observation.ownership_status.as_str(),
        ],
    )?;
    Ok(())
}

pub fn get_process_observation(
    conn: &Connection,
    observation_id: &str,
) -> Result<Option<ProcessObservation>> {
    process_observations_by_sql(
        conn,
        "SELECT observation_id, pid, ppid, process_kind, cwd_ref, port_bindings,
                command_hash, observed_at_ms, matched_claim_id, ownership_status
         FROM process_observation
         WHERE observation_id = ?1",
        [observation_id],
    )
    .map(|mut rows| rows.pop())
}

pub fn list_process_observations(conn: &Connection) -> Result<Vec<ProcessObservation>> {
    process_observations_by_sql(
        conn,
        "SELECT observation_id, pid, ppid, process_kind, cwd_ref, port_bindings,
                command_hash, observed_at_ms, matched_claim_id, ownership_status
         FROM process_observation
         ORDER BY observed_at_ms DESC, observation_id",
        [],
    )
}

fn process_observations_by_sql<P>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<ProcessObservation>>
where
    P: Params,
{
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, String>(9)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            observation_id,
            pid,
            ppid,
            process_kind,
            cwd_ref,
            port_bindings,
            command_hash,
            observed_at_ms,
            matched_claim_id,
            ownership_status,
        ) = row?;
        out.push(ProcessObservation {
            observation_id,
            pid,
            ppid,
            process_kind: parse_process_kind(process_kind)?,
            cwd_ref,
            port_bindings: decode_vec(port_bindings, "observation.port_bindings")?,
            command_hash,
            observed_at_ms,
            matched_claim_id,
            ownership_status: parse_ownership_status(ownership_status)?,
        });
    }
    Ok(out)
}
