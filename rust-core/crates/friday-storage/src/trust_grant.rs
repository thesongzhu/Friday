//! Trust-grant persistence + the restrictive agent-action compose (loop closure
//! commit 3; Hub-only).
//!
//! Persists a [`TrustGrant`] (issue/revoke, each in ONE transaction with a
//! hash-chained audit row) and looks up the active grant for an agent. The composing
//! [`authorize_agent_action`] is the KEY correctness surface: it AND-gates the trust
//! grant with the existing mutating-action gate, and is RESTRICTIVE-ONLY — a grant
//! `Allow` means "no trust objection", never an upgrade, so a mutating action that the
//! gate would make `RequiresApproval` STAYS `RequiresApproval`.
//!
//! Boundaries are stored as a JSON TEXT blob. `friday-core` is serde-free (its domain
//! types use manual `as_str`), so the `TrustBoundaries` <-> JSON map lives HERE (the
//! storage boundary), hand-built with `serde_json`.
//!
//! DEFERRED (honest): `token_ceiling` / `max_runs` are STORED but NOT enforced (no live
//! ledger/run-state counter — no fake counter). Nothing in production CALLS
//! `authorize_agent_action` yet (the runtime call-site wiring is a deferred AC).

use crate::error::{Result, StorageError};
use friday_core::gate::{
    self, CanonicalApproval, GateDecision, GateEvidenceRecord, MutatingActionRequest,
};
use friday_core::{check_grant, GrantCheck, Risk, TrustBoundaries, TrustGrant};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn unsupported(message: impl Into<String>) -> StorageError {
    StorageError::Unsupported(message.into())
}

fn risk_as_str(risk: Risk) -> &'static str {
    risk.as_str()
}

fn parse_risk(value: &str) -> Result<Risk> {
    match value {
        "read_only" => Ok(Risk::ReadOnly),
        "low" => Ok(Risk::Low),
        "medium" => Ok(Risk::Medium),
        "high" => Ok(Risk::High),
        "critical" => Ok(Risk::Critical),
        other => Err(unsupported(format!("unknown risk '{other}'"))),
    }
}

fn encode_boundaries(b: &TrustBoundaries) -> Result<String> {
    let v = json!({
        "workspace": b.workspace,
        "risk_ceiling": risk_as_str(b.risk_ceiling),
        "token_ceiling": b.token_ceiling,
        "max_runs": b.max_runs,
        "allowed_channels": b.allowed_channels,
        "allowed_providers": b.allowed_providers,
        "allowed_tools": b.allowed_tools,
        "allowed_workflow_families": b.allowed_workflow_families,
        "allowed_skill_families": b.allowed_skill_families,
    });
    serde_json::to_string(&v).map_err(|e| unsupported(format!("encode boundaries: {e}")))
}

fn decode_string_vec(v: &Value, field: &str) -> Result<Vec<String>> {
    match v {
        Value::Array(items) => items
            .iter()
            .map(|i| {
                i.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| unsupported(format!("{field} entry not a string")))
            })
            .collect(),
        Value::Null => Ok(Vec::new()),
        _ => Err(unsupported(format!("{field} not an array"))),
    }
}

fn decode_opt_i64(v: &Value, field: &str) -> Result<Option<i64>> {
    match v {
        Value::Null => Ok(None),
        Value::Number(n) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| unsupported(format!("{field} not an i64"))),
        _ => Err(unsupported(format!("{field} not a number/null"))),
    }
}

fn decode_opt_string(v: &Value, field: &str) -> Result<Option<String>> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(unsupported(format!("{field} not a string/null"))),
    }
}

fn decode_boundaries(blob: &str) -> Result<TrustBoundaries> {
    let v: Value =
        serde_json::from_str(blob).map_err(|e| unsupported(format!("decode boundaries: {e}")))?;
    let risk_ceiling = v
        .get("risk_ceiling")
        .and_then(Value::as_str)
        .ok_or_else(|| unsupported("boundaries.risk_ceiling missing"))?;
    Ok(TrustBoundaries {
        workspace: decode_opt_string(v.get("workspace").unwrap_or(&Value::Null), "workspace")?,
        risk_ceiling: parse_risk(risk_ceiling)?,
        token_ceiling: decode_opt_i64(
            v.get("token_ceiling").unwrap_or(&Value::Null),
            "token_ceiling",
        )?,
        max_runs: decode_opt_i64(v.get("max_runs").unwrap_or(&Value::Null), "max_runs")?,
        allowed_channels: decode_string_vec(
            v.get("allowed_channels").unwrap_or(&Value::Null),
            "allowed_channels",
        )?,
        allowed_providers: decode_string_vec(
            v.get("allowed_providers").unwrap_or(&Value::Null),
            "allowed_providers",
        )?,
        allowed_tools: decode_string_vec(
            v.get("allowed_tools").unwrap_or(&Value::Null),
            "allowed_tools",
        )?,
        allowed_workflow_families: decode_string_vec(
            v.get("allowed_workflow_families").unwrap_or(&Value::Null),
            "allowed_workflow_families",
        )?,
        allowed_skill_families: decode_string_vec(
            v.get("allowed_skill_families").unwrap_or(&Value::Null),
            "allowed_skill_families",
        )?,
    })
}

/// Issue a trust grant. ONE transaction: the insert + the `trust.grant` audit row
/// (payload_ref = grant_id) commit together so a granted authority always has its
/// hash-chained receipt.
pub fn grant_trust(conn: &Connection, grant: &TrustGrant, now_ms: i64) -> Result<()> {
    if grant.grant_id.trim().is_empty() {
        return Err(unsupported("trust_grant grant_id must not be empty"));
    }
    if grant.agent_id.trim().is_empty() {
        return Err(unsupported("trust_grant agent_id must not be empty"));
    }
    let boundaries = encode_boundaries(&grant.boundaries)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO trust_grant
            (grant_id, agent_id, granted_at, expires_at, revoked, revoked_at, boundaries)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(grant_id) DO UPDATE SET
            agent_id = excluded.agent_id,
            granted_at = excluded.granted_at,
            expires_at = excluded.expires_at,
            revoked = excluded.revoked,
            revoked_at = excluded.revoked_at,
            boundaries = excluded.boundaries",
        params![
            grant.grant_id,
            grant.agent_id,
            grant.granted_at,
            grant.expires_at,
            i64::from(grant.revoked),
            grant.revoked_at,
            boundaries,
        ],
    )?;
    crate::audit::append_audit(
        &tx,
        &format!("trust_grant:{}:{now_ms}", grant.grant_id),
        &grant.agent_id,
        "trust.grant",
        Some(&grant.grant_id),
        now_ms,
    )?;
    tx.commit()?;
    Ok(())
}

/// Revoke a trust grant. ONE transaction: the `revoked = 1` update + the `trust.revoke`
/// audit row commit together. Revoking a missing grant errors (fail-closed — there is
/// no silent no-op that would look like a successful revoke).
pub fn revoke_trust(conn: &Connection, grant_id: &str, now_ms: i64) -> Result<()> {
    if grant_id.trim().is_empty() {
        return Err(unsupported("trust_grant grant_id must not be empty"));
    }
    let agent_id: Option<String> = conn
        .query_row(
            "SELECT agent_id FROM trust_grant WHERE grant_id = ?1",
            params![grant_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(agent_id) = agent_id else {
        return Err(unsupported(format!(
            "trust_grant '{grant_id}' not found for revoke"
        )));
    };
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE trust_grant SET revoked = 1, revoked_at = ?2 WHERE grant_id = ?1",
        params![grant_id, now_ms],
    )?;
    crate::audit::append_audit(
        &tx,
        &format!("trust_revoke:{grant_id}:{now_ms}"),
        &agent_id,
        "trust.revoke",
        Some(grant_id),
        now_ms,
    )?;
    tx.commit()?;
    Ok(())
}

/// The raw `trust_grant` row (pre-boundaries-decode).
struct GrantRow {
    grant_id: String,
    granted_at: i64,
    expires_at: Option<i64>,
    revoked: i64,
    revoked_at: Option<i64>,
    boundaries: String,
}

fn row_to_grant(agent_id: &str, row: GrantRow) -> Result<TrustGrant> {
    Ok(TrustGrant {
        grant_id: row.grant_id,
        agent_id: agent_id.to_string(),
        granted_at: row.granted_at,
        expires_at: row.expires_at,
        revoked: row.revoked != 0,
        revoked_at: row.revoked_at,
        boundaries: decode_boundaries(&row.boundaries)?,
    })
}

fn read_grant_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<GrantRow> {
    Ok(GrantRow {
        grant_id: r.get(0)?,
        granted_at: r.get(1)?,
        expires_at: r.get(2)?,
        revoked: r.get(3)?,
        revoked_at: r.get(4)?,
        boundaries: r.get(5)?,
    })
}

/// The newest currently-active grant for `agent_id` (`revoked = 0` AND not expired at
/// `now`), or `None`. A `None` is the caller's signal to fail closed (no active grant
/// => no agent authority).
pub fn active_grant(conn: &Connection, agent_id: &str, now: i64) -> Result<Option<TrustGrant>> {
    let row: Option<GrantRow> = conn
        .query_row(
            "SELECT grant_id, granted_at, expires_at, revoked, revoked_at, boundaries
             FROM trust_grant
             WHERE agent_id = ?1 AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?2)
             ORDER BY granted_at DESC LIMIT 1",
            params![agent_id, now],
            read_grant_row,
        )
        .optional()?;
    row.map(|row| row_to_grant(agent_id, row)).transpose()
}

/// The newest grant for `agent_id` regardless of revoked/expired state, or `None` when
/// the agent has NO grant row at all. Used by `authorize_agent_action` to distinguish a
/// REVOKED/EXPIRED authority (a meaningful audit signal — `check_grant` then reports
/// `trust_grant_revoked` / `trust_grant_expired`) from one that was NEVER granted
/// (`trust_no_active_grant`).
pub fn latest_grant_any_state(conn: &Connection, agent_id: &str) -> Result<Option<TrustGrant>> {
    let row: Option<GrantRow> = conn
        .query_row(
            "SELECT grant_id, granted_at, expires_at, revoked, revoked_at, boundaries
             FROM trust_grant
             WHERE agent_id = ?1
             ORDER BY granted_at DESC LIMIT 1",
            params![agent_id],
            read_grant_row,
        )
        .optional()?;
    row.map(|row| row_to_grant(agent_id, row)).transpose()
}

/// The non-risk action dimensions for the trust check. `effective_risk` is NOT here —
/// it is taken from the gate's derived `.risk` inside `authorize_agent_action` (never
/// re-derived).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentActionContext {
    pub agent_id: String,
    pub workspace: Option<String>,
    pub tool: Option<String>,
    pub provider: Option<String>,
    pub channel: Option<String>,
    pub workflow_family: Option<String>,
    pub skill_family: Option<String>,
}

/// Compose the trust grant with the mutating-action gate — RESTRICTIVE AND-gate (the
/// KEY correctness surface). Order: (1) load the active grant; if NONE, distinguish a
/// REVOKED/EXPIRED authority (run `check_grant` on the latest grant row so the audit
/// reason is `trust_grant_revoked` / `trust_grant_expired`) from one that was NEVER
/// granted (`trust_no_active_grant`) — both fail closed. (2) `gate::evaluate(request)`
/// for the PUBLIC effective `.risk`. (3) a `check_grant` `Deny` short-circuits with the
/// grant's reason. (4) grant OK => fall through to `authorize_mutating_action`
/// UNCHANGED, which may still return `RequiresApproval`/`Deny`. A grant `Allow` NEVER
/// upgrades `RequiresApproval` to `Allow`: step 4 never sees the grant decision, it just
/// runs the existing gate compose.
pub fn authorize_agent_action(
    conn: &Connection,
    request: &MutatingActionRequest,
    ctx: &AgentActionContext,
    approval: Option<&CanonicalApproval>,
    secret: &[u8],
    now: i64,
) -> Result<GateEvidenceRecord> {
    let denied = |reason: String, base: &GateEvidenceRecord| GateEvidenceRecord {
        decision: GateDecision::Deny,
        reason,
        risk: base.risk,
        approval_required: base.approval_required,
        denied_by: Some("trust_grant".to_string()),
    };

    // (1) No ACTIVE grant => deny (fail-closed). But surface WHY: a latest grant that is
    // revoked/expired reports its own `check_grant` reason (the operator-meaningful
    // "authority revoked/expired" signal); only a total absence of any grant row reports
    // `trust_no_active_grant`. An agent with no authority acts on nothing either way.
    let Some(grant) = active_grant(conn, &ctx.agent_id, now)? else {
        let base = gate::evaluate(request);
        return match latest_grant_any_state(conn, &ctx.agent_id)? {
            Some(stale) => {
                let check = grant_check(ctx, now, base.risk);
                let (_decision, reason) = check_grant(&stale, &check);
                // The stale grant is revoked or expired (active_grant excluded it), so
                // `check_grant` denies with that reason; defend with a fallback label if a
                // future state ever slips through.
                let reason = if reason == "trust_grant_within_boundaries" {
                    "trust_no_active_grant"
                } else {
                    reason
                };
                Ok(denied(reason.to_string(), &base))
            }
            None => Ok(denied("trust_no_active_grant".to_string(), &base)),
        };
    };

    // (2) The gate's derived effective risk is the trust check's risk input.
    let base = gate::evaluate(request);
    let check = grant_check(ctx, now, base.risk);

    // (3) A trust deny short-circuits with the grant's reason.
    let (decision, reason) = check_grant(&grant, &check);
    if decision == GateDecision::Deny {
        return Ok(denied(reason.to_string(), &base));
    }

    // (4) Grant OK ("no trust objection") => run the EXISTING mutating-action compose
    // verbatim. It alone decides Allow/RequiresApproval/Deny — the grant cannot upgrade
    // a RequiresApproval here (this branch never passes the grant decision down).
    crate::authorize::authorize_mutating_action(conn, request, approval, secret, now)
}

/// Build the `GrantCheck` from the action context + the gate's derived effective risk.
fn grant_check(ctx: &AgentActionContext, now: i64, effective_risk: Risk) -> GrantCheck {
    GrantCheck {
        agent_id: ctx.agent_id.clone(),
        now,
        effective_risk,
        workspace: ctx.workspace.clone(),
        tool: ctx.tool.clone(),
        provider: ctx.provider.clone(),
        channel: ctx.channel.clone(),
        workflow_family: ctx.workflow_family.clone(),
        skill_family: ctx.skill_family.clone(),
    }
}
