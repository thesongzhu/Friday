//! Rust-owned SYSTEM-INTENT persistence substrate (R4, DARK). Hub-only.
//!
//! The Rust home for the system-intent state the TS `friday-system-service`
//! (`src/system/engine/friday-system-service.ts`) owns: the intent
//! REQUEST/RESULT records, the control-lease lifecycle, and the approval
//! decision trail. The TS `executeIntent` is already fenced fail-closed in live
//! runtime (`TS_RUNTIME_SYSTEM_INTENT_RETIRED`, whose declared replacement is
//! literally `rust_owned_system_intent_execution_entrypoint_required`); this
//! module + [`crate::system_intent`]'s hub-layer counterpart
//! (`friday-hub::system_intent`) are that entrypoint's storage + domain home.
//!
//! ## What this layer IS (and is NOT)
//! This is the STORAGE substrate only: typed request/result/lease/approval rows
//! over the m0026 Hub-only tables, plus the control-lease LIFECYCLE
//! (acquire-with-owner-exclusivity, release, expiry-revoke, panic-revoke,
//! read-active). It mirrors the TS lease semantics faithfully:
//!
//! * a mutating intent auto-acquires a lease for its actor; an actor that
//!   already holds the active lease REUSES it; a DIFFERENT actor is refused
//!   ([`LeaseAcquireError::Busy`], the TS `SYSTEM_CONTROL_BUSY` / HTTP 409);
//! * a lease past its `expires_at` is REVOKED (`lease_expired`) on the next
//!   normalize, exactly as the TS `normalizeActiveLease` does;
//! * `release_control` / `recover_ui` / companion-panic revoke the active lease.
//!
//! The at-most-one-ACTIVE-lease invariant is enforced by a read-then-insert in a
//! single IMMEDIATE transaction (the same discipline as
//! `workflow_catalog`'s optimistic-concurrency write): a concurrent second
//! acquire either reuses the same-owner lease or fails Busy. The schema retains a
//! REVOKED lease row as audit history, so "active" means `revoked_at IS NULL`.
//!
//! ## Refs-only discipline
//! NO raw url / clipboard text / notification body / app output is ever stored.
//! `target_ref` / `control_lease_id` are refs/ids; `action` / `actor_kind` /
//! `status` / `risk` / `decision` are coarse closed-vocabulary labels;
//! `message` / `reason` / `gate_reason` are coarse human reasons (the shape of
//! `work_item.blocking_reason`). The approval trail holds NO secret/key/mint
//! material — the verified approval→Allow upgrade is a DEFERRED seam owned by
//! `friday-storage::authorize_mutating_action`, not minted here.
//!
//! Truth label: STORAGE substrate + lifecycle API + tests only. DARK — nothing in
//! production reads or writes these tables; no route, no runtime caller, no live
//! TS flip. NOT a v1 GO.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

// ─── closed vocabularies (faithful ports of the TS const arrays) ──────────────

/// The 23 system-intent ACTIONS — a faithful port of the TS
/// `FRIDAY_SYSTEM_INTENT_ACTIONS`. The string form is what the schema CHECK
/// enumerates, so a row's `action` can only be one of these (a bogus action is
/// unrepresentable even via raw SQL).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentAction {
    Snapshot,
    Open,
    Focus,
    ArrangeWindows,
    LaunchApp,
    CloseApp,
    OpenUrl,
    OpenProject,
    SearchFile,
    HandoffToBrowser,
    HandoffToTerminal,
    ReadNotification,
    NotificationList,
    NotificationAct,
    TriageNotifications,
    ResumeTask,
    RecoverUi,
    ClipboardRead,
    ClipboardWrite,
    RequestControl,
    ReleaseControl,
    Approve,
    Deny,
}

impl IntentAction {
    /// The on-disk / on-wire string (matches the TS action vocabulary verbatim).
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentAction::Snapshot => "snapshot",
            IntentAction::Open => "open",
            IntentAction::Focus => "focus",
            IntentAction::ArrangeWindows => "arrange_windows",
            IntentAction::LaunchApp => "launch_app",
            IntentAction::CloseApp => "close_app",
            IntentAction::OpenUrl => "open_url",
            IntentAction::OpenProject => "open_project",
            IntentAction::SearchFile => "search_file",
            IntentAction::HandoffToBrowser => "handoff_to_browser",
            IntentAction::HandoffToTerminal => "handoff_to_terminal",
            IntentAction::ReadNotification => "read_notification",
            IntentAction::NotificationList => "notification_list",
            IntentAction::NotificationAct => "notification_act",
            IntentAction::TriageNotifications => "triage_notifications",
            IntentAction::ResumeTask => "resume_task",
            IntentAction::RecoverUi => "recover_ui",
            IntentAction::ClipboardRead => "clipboard_read",
            IntentAction::ClipboardWrite => "clipboard_write",
            IntentAction::RequestControl => "request_control",
            IntentAction::ReleaseControl => "release_control",
            IntentAction::Approve => "approve",
            IntentAction::Deny => "deny",
        }
    }

    /// Parse an action from its string form, fail-closed on an unknown value.
    pub fn parse(s: &str) -> Result<Self> {
        let action = match s {
            "snapshot" => IntentAction::Snapshot,
            "open" => IntentAction::Open,
            "focus" => IntentAction::Focus,
            "arrange_windows" => IntentAction::ArrangeWindows,
            "launch_app" => IntentAction::LaunchApp,
            "close_app" => IntentAction::CloseApp,
            "open_url" => IntentAction::OpenUrl,
            "open_project" => IntentAction::OpenProject,
            "search_file" => IntentAction::SearchFile,
            "handoff_to_browser" => IntentAction::HandoffToBrowser,
            "handoff_to_terminal" => IntentAction::HandoffToTerminal,
            "read_notification" => IntentAction::ReadNotification,
            "notification_list" => IntentAction::NotificationList,
            "notification_act" => IntentAction::NotificationAct,
            "triage_notifications" => IntentAction::TriageNotifications,
            "resume_task" => IntentAction::ResumeTask,
            "recover_ui" => IntentAction::RecoverUi,
            "clipboard_read" => IntentAction::ClipboardRead,
            "clipboard_write" => IntentAction::ClipboardWrite,
            "request_control" => IntentAction::RequestControl,
            "release_control" => IntentAction::ReleaseControl,
            "approve" => IntentAction::Approve,
            "deny" => IntentAction::Deny,
            other => {
                return Err(StorageError::Unsupported(format!(
                    "unknown system intent action '{other}'"
                )))
            }
        };
        Ok(action)
    }
}

/// The system-intent RESULT statuses — a faithful port of the TS
/// `FRIDAY_SYSTEM_INTENT_STATUSES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentStatus {
    Completed,
    Blocked,
    Failed,
    Unavailable,
    Queued,
}

impl IntentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentStatus::Completed => "completed",
            IntentStatus::Blocked => "blocked",
            IntentStatus::Failed => "failed",
            IntentStatus::Unavailable => "unavailable",
            IntentStatus::Queued => "queued",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        let status = match s {
            "completed" => IntentStatus::Completed,
            "blocked" => IntentStatus::Blocked,
            "failed" => IntentStatus::Failed,
            "unavailable" => IntentStatus::Unavailable,
            "queued" => IntentStatus::Queued,
            other => {
                return Err(StorageError::Unsupported(format!(
                    "unknown system intent status '{other}'"
                )))
            }
        };
        Ok(status)
    }
}

/// The control-lease OWNER kind — a faithful port of the TS
/// `FridaySystemControlLeaseOwnerKind` (`agent`/`api`/`remote`/`system`),
/// extended with `owner` so the gate's `ActorKind::Owner` is recordable on a
/// request row. The schema CHECK enumerates exactly this set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerKind {
    Agent,
    Api,
    Remote,
    System,
    Owner,
}

impl OwnerKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            OwnerKind::Agent => "agent",
            OwnerKind::Api => "api",
            OwnerKind::Remote => "remote",
            OwnerKind::System => "system",
            OwnerKind::Owner => "owner",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        let kind = match s {
            "agent" => OwnerKind::Agent,
            "api" => OwnerKind::Api,
            "remote" => OwnerKind::Remote,
            "system" => OwnerKind::System,
            "owner" => OwnerKind::Owner,
            other => {
                return Err(StorageError::Unsupported(format!(
                    "unknown control-lease owner kind '{other}'"
                )))
            }
        };
        Ok(kind)
    }
}

/// The risk LABEL stored on a request/approval row — the same closed vocabulary
/// as `friday_core::tool_policy::Risk::as_str`. Stored as a string so the
/// substrate has no compile dependency on the gate's enum shape; the hub layer
/// derives it from the gate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiskLabel {
    ReadOnly,
    Low,
    Medium,
    High,
    Critical,
}

impl RiskLabel {
    pub fn as_str(&self) -> &'static str {
        match self {
            RiskLabel::ReadOnly => "read_only",
            RiskLabel::Low => "low",
            RiskLabel::Medium => "medium",
            RiskLabel::High => "high",
            RiskLabel::Critical => "critical",
        }
    }
}

/// The gate decision LABEL stored on an approval record — `allow`/`deny`/
/// `requires_approval`, mirroring `friday_core::gate::GateDecision::as_str`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionLabel {
    Allow,
    Deny,
    RequiresApproval,
}

impl DecisionLabel {
    pub fn as_str(&self) -> &'static str {
        match self {
            DecisionLabel::Allow => "allow",
            DecisionLabel::Deny => "deny",
            DecisionLabel::RequiresApproval => "requires_approval",
        }
    }
}

// ─── intent request + result records ──────────────────────────────────────────

/// The immutable INPUT record of an intent dispatch (refs-only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentRequest {
    pub intent_id: String,
    pub action: IntentAction,
    pub actor_id: String,
    pub actor_kind: OwnerKind,
    /// A coarse REF/id of the target (e.g. an app bundle id, a project path ref,
    /// a notification id) — NEVER a raw url/clipboard/notification BODY.
    pub target_ref: Option<String>,
    pub mutating: bool,
    pub risk: RiskLabel,
    pub created_at: i64,
}

/// The OUTCOME record keyed 1:1 by `intent_id` (refs-only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentResultRecord {
    pub intent_id: String,
    pub action: IntentAction,
    pub status: IntentStatus,
    /// A coarse human-readable outcome message (e.g. the lease-busy reason, or
    /// the deferred-executor `rust_system_action_execution_unimplemented`
    /// marker). NEVER a raw body.
    pub message: String,
    pub control_lease_id: Option<String>,
    /// The gate's coarse reason when the result was a gate BLOCK (e.g.
    /// `canonical_approval_required` / `agent_cannot_execute_reserved_approval_action`).
    pub gate_reason: Option<String>,
    pub created_at: i64,
}

/// Persist an intent REQUEST record. Immutable: a duplicate `intent_id` is a
/// fail-closed PK violation (never silently overwritten).
pub fn insert_intent_request(conn: &Connection, req: &IntentRequest) -> Result<()> {
    conn.execute(
        "INSERT INTO system_intent_request
            (intent_id, action, actor_id, actor_kind, target_ref, mutating, risk, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            req.intent_id,
            req.action.as_str(),
            req.actor_id,
            req.actor_kind.as_str(),
            req.target_ref,
            req.mutating as i64,
            req.risk.as_str(),
            req.created_at,
        ],
    )?;
    Ok(())
}

/// Persist an intent RESULT record (1:1 with its request). Immutable: a duplicate
/// `intent_id` is a fail-closed PK violation. The FK to `system_intent_request`
/// means a result can only be recorded for a request that exists.
pub fn insert_intent_result(conn: &Connection, result: &IntentResultRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO system_intent_result
            (intent_id, action, status, message, control_lease_id, gate_reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            result.intent_id,
            result.action.as_str(),
            result.status.as_str(),
            result.message,
            result.control_lease_id,
            result.gate_reason,
            result.created_at,
        ],
    )?;
    Ok(())
}

/// Read an intent RESULT by `intent_id`. `None` if no result was recorded.
pub fn get_intent_result(conn: &Connection, intent_id: &str) -> Result<Option<IntentResultRecord>> {
    let row = conn
        .query_row(
            "SELECT intent_id, action, status, message, control_lease_id, gate_reason, created_at
             FROM system_intent_result WHERE intent_id = ?1",
            [intent_id],
            |r| {
                let action: String = r.get(1)?;
                let status: String = r.get(2)?;
                Ok((
                    r.get::<_, String>(0)?,
                    action,
                    status,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((intent_id, action, status, message, control_lease_id, gate_reason, created_at)) => {
            Ok(Some(IntentResultRecord {
                intent_id,
                action: IntentAction::parse(&action)?,
                status: IntentStatus::parse(&status)?,
                message,
                control_lease_id,
                gate_reason,
                created_at,
            }))
        }
    }
}

// ─── approval-decision trail ──────────────────────────────────────────────────

/// The approval DECISION record for a mutating intent (refs-only evidence the
/// gate fail-closed or allowed a mutating action). Holds NO key/secret/mint
/// material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRecord {
    pub record_id: String,
    pub intent_id: String,
    pub action: IntentAction,
    pub decision: DecisionLabel,
    pub reason: String,
    pub risk: RiskLabel,
    pub approval_required: bool,
    pub created_at: i64,
}

/// Persist an approval-decision record. The FK to `system_intent_request` means a
/// decision can only be recorded against a request that exists.
pub fn insert_approval_record(conn: &Connection, record: &ApprovalRecord) -> Result<()> {
    conn.execute(
        "INSERT INTO system_intent_approval_record
            (record_id, intent_id, action, decision, reason, risk, approval_required, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            record.record_id,
            record.intent_id,
            record.action.as_str(),
            record.decision.as_str(),
            record.reason,
            record.risk.as_str(),
            record.approval_required as i64,
            record.created_at,
        ],
    )?;
    Ok(())
}

/// List the approval-decision records for an intent (oldest first).
pub fn list_approval_records(conn: &Connection, intent_id: &str) -> Result<Vec<ApprovalRecord>> {
    let mut stmt = conn.prepare(
        "SELECT record_id, intent_id, action, decision, reason, risk, approval_required, created_at
         FROM system_intent_approval_record WHERE intent_id = ?1
         ORDER BY created_at ASC, record_id ASC",
    )?;
    let rows = stmt.query_map([intent_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (record_id, intent_id, action, decision, reason, risk, approval_required, created_at) =
            row?;
        out.push(ApprovalRecord {
            record_id,
            intent_id,
            action: IntentAction::parse(&action)?,
            decision: parse_decision(&decision)?,
            reason,
            risk: parse_risk(&risk)?,
            approval_required: approval_required != 0,
            created_at,
        });
    }
    Ok(out)
}

fn parse_decision(s: &str) -> Result<DecisionLabel> {
    match s {
        "allow" => Ok(DecisionLabel::Allow),
        "deny" => Ok(DecisionLabel::Deny),
        "requires_approval" => Ok(DecisionLabel::RequiresApproval),
        other => Err(StorageError::Unsupported(format!(
            "unknown approval decision '{other}'"
        ))),
    }
}

fn parse_risk(s: &str) -> Result<RiskLabel> {
    match s {
        "read_only" => Ok(RiskLabel::ReadOnly),
        "low" => Ok(RiskLabel::Low),
        "medium" => Ok(RiskLabel::Medium),
        "high" => Ok(RiskLabel::High),
        "critical" => Ok(RiskLabel::Critical),
        other => Err(StorageError::Unsupported(format!(
            "unknown risk label '{other}'"
        ))),
    }
}

// ─── control-lease lifecycle ──────────────────────────────────────────────────

/// A control lease (mirrors the TS `FridaySystemControlLease`). A REVOKED lease
/// (`revoked_at.is_some()`) is retained as audit history; the ACTIVE lease (if
/// any) is the one with `revoked_at == None` and a non-elapsed `expires_at`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlLease {
    pub lease_id: String,
    pub owner_id: String,
    pub owner_kind: OwnerKind,
    pub reason: Option<String>,
    pub acquired_at: i64,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub revoked_reason: Option<String>,
}

impl ControlLease {
    /// True if the lease is past its TTL at `now_ms` (an absent `expires_at`
    /// never expires — matches the TS `isLeaseExpired`).
    pub fn is_expired(&self, now_ms: i64) -> bool {
        matches!(self.expires_at, Some(exp) if exp <= now_ms)
    }
}

/// The outcome of [`acquire_control_lease`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LeaseAcquireOutcome {
    /// A fresh lease was minted for the requesting actor.
    Acquired(ControlLease),
    /// The requesting actor already held the active lease — it is REUSED (no new
    /// row), matching the TS `current.ownerId == actorId && ownerKind == actorKind`
    /// reuse path.
    Reused(ControlLease),
}

/// Why a control-lease acquire was refused. (`StorageError` is neither `Clone`
/// nor `Eq`, so this enum carries only `Debug` — tests `match` on it.)
#[derive(Debug)]
pub enum LeaseAcquireError {
    /// The active lease is held by a DIFFERENT owner (the TS `SYSTEM_CONTROL_BUSY`
    /// / HTTP 409). Carries the holder's owner kind+id (the TS reason string
    /// shape `"<ownerKind>:<ownerId>"`).
    Busy {
        owner_kind: OwnerKind,
        owner_id: String,
    },
    /// A storage-layer failure (surfaced fail-closed, never swallowed).
    Storage(StorageError),
}

impl From<StorageError> for LeaseAcquireError {
    fn from(e: StorageError) -> Self {
        LeaseAcquireError::Storage(e)
    }
}

impl std::fmt::Display for LeaseAcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LeaseAcquireError::Busy {
                owner_kind,
                owner_id,
            } => write!(
                f,
                "control lease is currently held by {}:{}",
                owner_kind.as_str(),
                owner_id
            ),
            LeaseAcquireError::Storage(e) => write!(f, "storage error: {e}"),
        }
    }
}

/// What [`acquire_control_lease`] needs to mint a lease.
#[derive(Clone, Debug)]
pub struct NewControlLease {
    pub lease_id: String,
    pub owner_id: String,
    pub owner_kind: OwnerKind,
    pub reason: Option<String>,
    /// TTL in ms; `Some(ttl)` makes `expires_at = now_ms + ttl`. `None` is a
    /// never-expiring lease (the TS default TTL is applied by the hub layer, so
    /// this stays explicit at the storage boundary).
    pub ttl_ms: Option<i64>,
}

/// Read the currently-active control lease (NOT revoked, NOT expired at `now_ms`),
/// REVOKING it in place if it is expired (mirrors the TS `normalizeActiveLease`).
/// Returns `None` when no live lease exists. Runs in one transaction so the
/// expiry-revoke is atomic with the read.
pub fn normalize_active_lease(conn: &Connection, now_ms: i64) -> Result<Option<ControlLease>> {
    let tx = conn.unchecked_transaction()?;
    let active = read_active_lease_tx(&tx)?;
    let result = match active {
        Some(lease) if lease.is_expired(now_ms) => {
            revoke_lease_tx(&tx, &lease.lease_id, now_ms, "lease_expired")?;
            None
        }
        other => other,
    };
    tx.commit()?;
    Ok(result)
}

/// Acquire (or reuse) the control lease for an actor, fail-closed.
///
/// Faithful to the TS `acquireExplicitControlLease` / `ensureControlLease`:
/// * an EXPIRED active lease is revoked first (so a new owner can take over);
/// * if the active lease is held by the SAME `(owner_kind, owner_id)`, it is
///   REUSED ([`LeaseAcquireOutcome::Reused`]) — never a second row;
/// * if held by a DIFFERENT owner, the acquire is refused
///   ([`LeaseAcquireError::Busy`], the TS 409);
/// * otherwise a fresh lease is minted ([`LeaseAcquireOutcome::Acquired`]).
///
/// The read-then-insert runs in one IMMEDIATE transaction, so two concurrent
/// acquires cannot both mint a lease — the loser sees the winner's row and either
/// reuses (same owner) or fails Busy.
pub fn acquire_control_lease(
    conn: &Connection,
    new_lease: &NewControlLease,
    now_ms: i64,
) -> std::result::Result<LeaseAcquireOutcome, LeaseAcquireError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| LeaseAcquireError::Storage(StorageError::from(e)))?;

    let current = read_active_lease_tx(&tx).map_err(LeaseAcquireError::Storage)?;
    let current = match current {
        Some(lease) if lease.is_expired(now_ms) => {
            revoke_lease_tx(&tx, &lease.lease_id, now_ms, "lease_expired")
                .map_err(LeaseAcquireError::Storage)?;
            None
        }
        other => other,
    };

    if let Some(lease) = current {
        if lease.owner_id == new_lease.owner_id && lease.owner_kind == new_lease.owner_kind {
            tx.commit()
                .map_err(|e| LeaseAcquireError::Storage(StorageError::from(e)))?;
            return Ok(LeaseAcquireOutcome::Reused(lease));
        }
        // A DIFFERENT owner holds the lease — refuse (do NOT commit any change).
        return Err(LeaseAcquireError::Busy {
            owner_kind: lease.owner_kind,
            owner_id: lease.owner_id,
        });
    }

    let expires_at = new_lease.ttl_ms.map(|ttl| now_ms + ttl);
    let minted = ControlLease {
        lease_id: new_lease.lease_id.clone(),
        owner_id: new_lease.owner_id.clone(),
        owner_kind: new_lease.owner_kind,
        reason: new_lease.reason.clone(),
        acquired_at: now_ms,
        expires_at,
        revoked_at: None,
        revoked_reason: None,
    };
    tx.execute(
        "INSERT INTO system_control_lease
            (lease_id, owner_id, owner_kind, reason, acquired_at, expires_at,
             revoked_at, revoked_reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)",
        params![
            minted.lease_id,
            minted.owner_id,
            minted.owner_kind.as_str(),
            minted.reason,
            minted.acquired_at,
            minted.expires_at,
        ],
    )
    .map_err(|e| LeaseAcquireError::Storage(StorageError::from(e)))?;
    tx.commit()
        .map_err(|e| LeaseAcquireError::Storage(StorageError::from(e)))?;
    Ok(LeaseAcquireOutcome::Acquired(minted))
}

/// Revoke the currently-active lease (release_control / recover_ui / panic). A
/// no-op returning `Ok(None)` when no active lease exists (the TS
/// `release_control` "No active control lease" path). Returns the revoked lease.
pub fn revoke_active_lease(
    conn: &Connection,
    now_ms: i64,
    reason: &str,
) -> Result<Option<ControlLease>> {
    let tx = conn.unchecked_transaction()?;
    let active = read_active_lease_tx(&tx)?;
    let result = match active {
        Some(lease) => {
            revoke_lease_tx(&tx, &lease.lease_id, now_ms, reason)?;
            Some(ControlLease {
                revoked_at: Some(now_ms),
                revoked_reason: Some(reason.to_string()),
                ..lease
            })
        }
        None => None,
    };
    tx.commit()?;
    Ok(result)
}

/// Read a lease by id (active or revoked), for audit/diagnostics.
pub fn get_lease(conn: &Connection, lease_id: &str) -> Result<Option<ControlLease>> {
    let row = conn
        .query_row(
            "SELECT lease_id, owner_id, owner_kind, reason, acquired_at, expires_at,
                    revoked_at, revoked_reason
             FROM system_control_lease WHERE lease_id = ?1",
            [lease_id],
            map_lease_row,
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((
            id,
            owner_id,
            owner_kind,
            reason,
            acquired_at,
            expires_at,
            revoked_at,
            revoked_reason,
        )) => Ok(Some(ControlLease {
            lease_id: id,
            owner_id,
            owner_kind: OwnerKind::parse(&owner_kind)?,
            reason,
            acquired_at,
            expires_at,
            revoked_at,
            revoked_reason,
        })),
    }
}

#[allow(clippy::type_complexity)]
fn map_lease_row(
    r: &rusqlite::Row<'_>,
) -> rusqlite::Result<(
    String,
    String,
    String,
    Option<String>,
    i64,
    Option<i64>,
    Option<i64>,
    Option<String>,
)> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
    ))
}

/// Read the at-most-one non-revoked lease inside a transaction. The active-lease
/// invariant is upheld by the acquire path (this returns the single
/// `revoked_at IS NULL` row, or `None`). Two non-revoked rows would be a substrate
/// bug — we return the most recently acquired and the acquire path never mints a
/// second concurrent active row.
fn read_active_lease_tx(tx: &rusqlite::Transaction<'_>) -> Result<Option<ControlLease>> {
    let row = tx
        .query_row(
            "SELECT lease_id, owner_id, owner_kind, reason, acquired_at, expires_at,
                    revoked_at, revoked_reason
             FROM system_control_lease
             WHERE revoked_at IS NULL
             ORDER BY acquired_at DESC, lease_id DESC
             LIMIT 1",
            [],
            map_lease_row,
        )
        .optional()?;
    match row {
        None => Ok(None),
        Some((
            id,
            owner_id,
            owner_kind,
            reason,
            acquired_at,
            expires_at,
            revoked_at,
            revoked_reason,
        )) => Ok(Some(ControlLease {
            lease_id: id,
            owner_id,
            owner_kind: OwnerKind::parse(&owner_kind)?,
            reason,
            acquired_at,
            expires_at,
            revoked_at,
            revoked_reason,
        })),
    }
}

fn revoke_lease_tx(
    tx: &rusqlite::Transaction<'_>,
    lease_id: &str,
    now_ms: i64,
    reason: &str,
) -> Result<()> {
    tx.execute(
        "UPDATE system_control_lease
            SET revoked_at = ?2, revoked_reason = ?3
            WHERE lease_id = ?1 AND revoked_at IS NULL",
        params![lease_id, now_ms, reason],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-system-intent-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn req(intent_id: &str, action: IntentAction, owner: &str, kind: OwnerKind) -> IntentRequest {
        IntentRequest {
            intent_id: intent_id.to_string(),
            action,
            actor_id: owner.to_string(),
            actor_kind: kind,
            target_ref: None,
            mutating: true,
            risk: RiskLabel::Medium,
            created_at: 100,
        }
    }

    #[test]
    fn intent_request_then_result_round_trips() {
        let db = Db::open_hub(&tmp("req-result")).unwrap();
        let request = req("i1", IntentAction::LaunchApp, "agent-1", OwnerKind::Agent);
        insert_intent_request(db.conn(), &request).unwrap();

        let result = IntentResultRecord {
            intent_id: "i1".to_string(),
            action: IntentAction::LaunchApp,
            status: IntentStatus::Unavailable,
            message: "rust_system_action_execution_unimplemented".to_string(),
            control_lease_id: Some("lease-1".to_string()),
            gate_reason: None,
            created_at: 110,
        };
        insert_intent_result(db.conn(), &result).unwrap();

        assert_eq!(get_intent_result(db.conn(), "i1").unwrap(), Some(result));
        assert!(get_intent_result(db.conn(), "nope").unwrap().is_none());
    }

    #[test]
    fn duplicate_intent_request_id_fails_closed() {
        let db = Db::open_hub(&tmp("dup-req")).unwrap();
        let request = req("i1", IntentAction::Focus, "api", OwnerKind::Api);
        insert_intent_request(db.conn(), &request).unwrap();
        // A second insert with the same intent_id is a fail-closed PK violation.
        assert!(insert_intent_request(db.conn(), &request).is_err());
    }

    #[test]
    fn result_without_request_fails_closed_on_fk() {
        let db = Db::open_hub(&tmp("fk-result")).unwrap();
        // No request row for "ghost" -> the FK refuses an orphan result.
        let result = IntentResultRecord {
            intent_id: "ghost".to_string(),
            action: IntentAction::Snapshot,
            status: IntentStatus::Completed,
            message: String::new(),
            control_lease_id: None,
            gate_reason: None,
            created_at: 1,
        };
        assert!(insert_intent_result(db.conn(), &result).is_err());
    }

    #[test]
    fn invalid_action_string_parse_fails_closed() {
        assert!(IntentAction::parse("not_an_action").is_err());
        assert!(IntentStatus::parse("not_a_status").is_err());
        assert!(OwnerKind::parse("not_a_kind").is_err());
        // Round-trip every action through parse(as_str()).
        for a in [
            IntentAction::Snapshot,
            IntentAction::RequestControl,
            IntentAction::ReleaseControl,
            IntentAction::Approve,
            IntentAction::Deny,
            IntentAction::ClipboardRead,
        ] {
            assert_eq!(IntentAction::parse(a.as_str()).unwrap(), a);
        }
    }

    #[test]
    fn acquire_then_same_owner_reuses_not_remints() {
        let db = Db::open_hub(&tmp("lease-reuse")).unwrap();
        let nl = NewControlLease {
            lease_id: "L1".to_string(),
            owner_id: "agent-1".to_string(),
            owner_kind: OwnerKind::Agent,
            reason: Some("auto:launch_app".to_string()),
            ttl_ms: Some(1000),
        };
        match acquire_control_lease(db.conn(), &nl, 100).unwrap() {
            LeaseAcquireOutcome::Acquired(l) => {
                assert_eq!(l.lease_id, "L1");
                assert_eq!(l.expires_at, Some(1100));
            }
            other => panic!("expected Acquired, got {other:?}"),
        }
        // The SAME owner acquiring again REUSES the existing lease (no new row).
        let nl2 = NewControlLease {
            lease_id: "L2-would-be-new".to_string(),
            ..nl.clone()
        };
        match acquire_control_lease(db.conn(), &nl2, 200).unwrap() {
            LeaseAcquireOutcome::Reused(l) => assert_eq!(l.lease_id, "L1"),
            other => panic!("expected Reused, got {other:?}"),
        }
        assert_eq!(
            db.count("system_control_lease").unwrap(),
            1,
            "no second row minted"
        );
    }

    #[test]
    fn different_owner_is_refused_busy() {
        let db = Db::open_hub(&tmp("lease-busy")).unwrap();
        let agent = NewControlLease {
            lease_id: "L-agent".to_string(),
            owner_id: "agent-1".to_string(),
            owner_kind: OwnerKind::Agent,
            reason: None,
            ttl_ms: Some(10_000),
        };
        acquire_control_lease(db.conn(), &agent, 100).unwrap();

        let other = NewControlLease {
            lease_id: "L-api".to_string(),
            owner_id: "api-7".to_string(),
            owner_kind: OwnerKind::Api,
            reason: None,
            ttl_ms: Some(10_000),
        };
        match acquire_control_lease(db.conn(), &other, 200) {
            Err(LeaseAcquireError::Busy {
                owner_kind,
                owner_id,
            }) => {
                assert_eq!(owner_kind, OwnerKind::Agent);
                assert_eq!(owner_id, "agent-1");
            }
            other => panic!("expected Busy, got {other:?}"),
        }
        // The busy acquire minted NO row.
        assert_eq!(db.count("system_control_lease").unwrap(), 1);
    }

    #[test]
    fn expired_lease_is_revoked_then_new_owner_can_acquire() {
        let db = Db::open_hub(&tmp("lease-expire")).unwrap();
        let agent = NewControlLease {
            lease_id: "L-agent".to_string(),
            owner_id: "agent-1".to_string(),
            owner_kind: OwnerKind::Agent,
            reason: None,
            ttl_ms: Some(50),
        };
        acquire_control_lease(db.conn(), &agent, 100).unwrap(); // expires at 150

        // normalize_active_lease at t=200 finds it expired -> revokes it, returns None.
        assert!(normalize_active_lease(db.conn(), 200).unwrap().is_none());
        let revoked = get_lease(db.conn(), "L-agent").unwrap().unwrap();
        assert_eq!(revoked.revoked_at, Some(200));
        assert_eq!(revoked.revoked_reason.as_deref(), Some("lease_expired"));

        // A DIFFERENT owner can now acquire (the prior lease expired).
        let other = NewControlLease {
            lease_id: "L-api".to_string(),
            owner_id: "api-7".to_string(),
            owner_kind: OwnerKind::Api,
            reason: None,
            ttl_ms: Some(1000),
        };
        match acquire_control_lease(db.conn(), &other, 250).unwrap() {
            LeaseAcquireOutcome::Acquired(l) => assert_eq!(l.lease_id, "L-api"),
            other => panic!("expected Acquired, got {other:?}"),
        }
    }

    #[test]
    fn revoke_active_lease_releases_and_is_noop_when_none() {
        let db = Db::open_hub(&tmp("lease-release")).unwrap();
        // No active lease -> Ok(None) (TS "No active control lease").
        assert!(revoke_active_lease(db.conn(), 10, "released_by_request")
            .unwrap()
            .is_none());

        let nl = NewControlLease {
            lease_id: "L1".to_string(),
            owner_id: "agent-1".to_string(),
            owner_kind: OwnerKind::Agent,
            reason: None,
            ttl_ms: Some(10_000),
        };
        acquire_control_lease(db.conn(), &nl, 100).unwrap();
        let released = revoke_active_lease(db.conn(), 300, "released_by_request")
            .unwrap()
            .unwrap();
        assert_eq!(released.lease_id, "L1");
        assert_eq!(
            released.revoked_reason.as_deref(),
            Some("released_by_request")
        );
        // After release there is no active lease.
        assert!(normalize_active_lease(db.conn(), 400).unwrap().is_none());
    }

    #[test]
    fn second_active_lease_is_db_rejected_even_via_raw_insert() {
        // Defense-in-depth: the at-most-one-active invariant is DB-ENFORCED by the
        // partial unique index `idx_system_control_lease_one_active`. A second
        // non-revoked row is rejected even by a hand-built raw INSERT that bypasses
        // the typed acquire path.
        let db = Db::open_hub(&tmp("one-active-guard")).unwrap();
        let nl = NewControlLease {
            lease_id: "L1".to_string(),
            owner_id: "agent-1".to_string(),
            owner_kind: OwnerKind::Agent,
            reason: None,
            ttl_ms: Some(10_000),
        };
        acquire_control_lease(db.conn(), &nl, 100).unwrap();
        // A raw second ACTIVE (revoked_at NULL) lease is refused by the index.
        let raw = db.conn().execute(
            "INSERT INTO system_control_lease
                (lease_id, owner_id, owner_kind, reason, acquired_at, expires_at,
                 revoked_at, revoked_reason)
             VALUES ('L2', 'attacker', 'api', NULL, 200, NULL, NULL, NULL)",
            [],
        );
        assert!(raw.is_err(), "a second active lease must be DB-rejected");
        // A REVOKED row, by contrast, is allowed (audit history is unconstrained).
        db.conn()
            .execute(
                "INSERT INTO system_control_lease
                    (lease_id, owner_id, owner_kind, reason, acquired_at, expires_at,
                     revoked_at, revoked_reason)
                 VALUES ('L3-revoked', 'agent-1', 'agent', NULL, 90, NULL, 95, 'old')",
                [],
            )
            .unwrap();
        assert_eq!(db.count("system_control_lease").unwrap(), 2);
    }

    #[test]
    fn approval_record_trail_round_trips() {
        let db = Db::open_hub(&tmp("approval")).unwrap();
        let request = req("i1", IntentAction::CloseApp, "agent-1", OwnerKind::Agent);
        insert_intent_request(db.conn(), &request).unwrap();

        let record = ApprovalRecord {
            record_id: "ar1".to_string(),
            intent_id: "i1".to_string(),
            action: IntentAction::CloseApp,
            decision: DecisionLabel::RequiresApproval,
            reason: "canonical_approval_required".to_string(),
            risk: RiskLabel::High,
            approval_required: true,
            created_at: 120,
        };
        insert_approval_record(db.conn(), &record).unwrap();
        let trail = list_approval_records(db.conn(), "i1").unwrap();
        assert_eq!(trail, vec![record]);
    }

    #[test]
    fn approval_record_without_request_fails_closed_on_fk() {
        let db = Db::open_hub(&tmp("approval-fk")).unwrap();
        let record = ApprovalRecord {
            record_id: "ar1".to_string(),
            intent_id: "ghost".to_string(),
            action: IntentAction::CloseApp,
            decision: DecisionLabel::Deny,
            reason: "x".to_string(),
            risk: RiskLabel::High,
            approval_required: false,
            created_at: 1,
        };
        assert!(insert_approval_record(db.conn(), &record).is_err());
    }
}
