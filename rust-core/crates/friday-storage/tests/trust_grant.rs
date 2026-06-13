//! Trust-grant baseline KATs (loop closure, commit 3; migration v31). Real SQLite.
//!
//! Proves the per-agent capability envelope and — the KEY correctness surface — that
//! `authorize_agent_action` is a RESTRICTIVE AND-gate: it can only ADD a trust denial
//! ahead of the existing mutating-action gate, and a grant `Allow` NEVER upgrades a
//! `RequiresApproval` action to `Allow`. No creds.

mod common;

use common::temp_db_path;
use friday_core::gate::{classify, Actor, ActorKind, GateDecision, MutatingActionRequest};
use friday_core::{Risk, TrustBoundaries, TrustGrant};
use friday_storage::{
    active_grant, authorize_agent_action, grant_trust, revoke_trust, AgentActionContext, Db,
};

const SECRET: &[u8] = b"gate-signing-secret";

fn req(action: &str, mutating: bool, base_risk: Risk) -> MutatingActionRequest {
    MutatingActionRequest::from_classification(
        classify(mutating, base_risk, action, &[]),
        action.to_string(),
        Actor {
            kind: ActorKind::Agent,
            id: "friday".to_string(),
            principal_id: Some("p1".to_string()),
        },
        "system".to_string(),
        vec![],
        None,
        Some("idem-1".to_string()),
        None,
    )
}

fn boundaries(tools: &[&str], risk_ceiling: Risk) -> TrustBoundaries {
    TrustBoundaries {
        workspace: None,
        risk_ceiling,
        token_ceiling: Some(1000), // STORED, DEFERRED-not-enforced
        max_runs: Some(5),         // STORED, DEFERRED-not-enforced
        allowed_channels: vec![],
        allowed_providers: vec![],
        allowed_tools: tools.iter().map(|s| s.to_string()).collect(),
        allowed_workflow_families: vec![],
        allowed_skill_families: vec![],
    }
}

fn grant_for(tools: &[&str], risk_ceiling: Risk, expires_at: Option<i64>) -> TrustGrant {
    TrustGrant {
        grant_id: "g-friday".into(),
        agent_id: "friday".into(),
        granted_at: 1,
        expires_at,
        revoked: false,
        revoked_at: None,
        boundaries: boundaries(tools, risk_ceiling),
    }
}

fn ctx(tool: &str) -> AgentActionContext {
    AgentActionContext {
        agent_id: "friday".into(),
        workspace: None,
        tool: Some(tool.into()),
        provider: None,
        channel: None,
        workflow_family: None,
        skill_family: None,
    }
}

fn audit_count(db: &Db) -> i64 {
    db.conn()
        .query_row("SELECT count(*) FROM audit_ledger", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn read_only_in_allowlist_within_risk_ceiling_allows() {
    let db = Db::open_hub(&temp_db_path("trust-allow")).unwrap();
    grant_trust(db.conn(), &grant_for(&["read_file"], Risk::Medium, None), 1).unwrap();

    // read_file is a non-mutating, read-only action -> the gate Allows, and the grant
    // permits the tool within the risk ceiling.
    let r = authorize_agent_action(
        db.conn(),
        &req("read_file", false, Risk::ReadOnly),
        &ctx("read_file"),
        None,
        SECRET,
        100,
    )
    .unwrap();
    assert_eq!(r.decision, GateDecision::Allow);
}

#[test]
fn tool_not_in_allowlist_denies() {
    let db = Db::open_hub(&temp_db_path("trust-tool")).unwrap();
    grant_trust(db.conn(), &grant_for(&["read_file"], Risk::Medium, None), 1).unwrap();

    let r = authorize_agent_action(
        db.conn(),
        &req("delete_file", true, Risk::Medium),
        &ctx("delete_file"),
        None,
        SECRET,
        100,
    )
    .unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "trust_grant_tool_not_allowed");
}

#[test]
fn grant_allow_never_upgrades_requires_approval() {
    // THE invariant: a mutating action that the gate makes RequiresApproval, whose tool
    // IS in the allowlist and whose risk is UNDER the ceiling, must STAY RequiresApproval
    // (the grant is restrictive-only; no canonical approval presented).
    let db = Db::open_hub(&temp_db_path("trust-no-upgrade")).unwrap();
    grant_trust(
        db.conn(),
        &grant_for(&["write_file"], Risk::Medium, None),
        1,
    )
    .unwrap();

    let r = authorize_agent_action(
        db.conn(),
        &req("write_file", true, Risk::Medium), // mutating -> gate RequiresApproval
        &ctx("write_file"),
        None, // no approval
        SECRET,
        100,
    )
    .unwrap();
    assert_eq!(
        r.decision,
        GateDecision::RequiresApproval,
        "a grant Allow must NEVER upgrade RequiresApproval to Allow"
    );
}

#[test]
fn revoked_grant_denies_and_no_grant_denies() {
    let db = Db::open_hub(&temp_db_path("trust-revoke")).unwrap();

    // No grant at all -> fail closed.
    let r = authorize_agent_action(
        db.conn(),
        &req("read_file", false, Risk::ReadOnly),
        &ctx("read_file"),
        None,
        SECRET,
        100,
    )
    .unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "trust_no_active_grant");

    // Grant then revoke -> revoked grant is not ACTIVE, but the compose DISTINGUISHES a
    // revoked authority from a never-granted one: it reports trust_grant_revoked (the
    // operator-meaningful "authority revoked" audit signal), NOT trust_no_active_grant.
    grant_trust(db.conn(), &grant_for(&["read_file"], Risk::Medium, None), 1).unwrap();
    revoke_trust(db.conn(), "g-friday", 50).unwrap();
    assert!(active_grant(db.conn(), "friday", 100).unwrap().is_none());

    let r = authorize_agent_action(
        db.conn(),
        &req("read_file", false, Risk::ReadOnly),
        &ctx("read_file"),
        None,
        SECRET,
        100,
    )
    .unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(
        r.reason, "trust_grant_revoked",
        "a revoked authority must report trust_grant_revoked, not the never-granted reason"
    );
}

#[test]
fn expired_grant_reports_expired_reason_through_the_real_path() {
    // The expired-authority audit distinction: an expired grant is not ACTIVE, but the
    // compose reports trust_grant_expired (via check_grant on the latest grant row), not
    // the never-granted reason.
    let db = Db::open_hub(&temp_db_path("trust-expired-reason")).unwrap();
    grant_trust(
        db.conn(),
        &grant_for(&["read_file"], Risk::Medium, Some(50)),
        1,
    )
    .unwrap();

    let r = authorize_agent_action(
        db.conn(),
        &req("read_file", false, Risk::ReadOnly),
        &ctx("read_file"),
        None,
        SECRET,
        100, // now >= expires_at(50)
    )
    .unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "trust_grant_expired");
}

#[test]
fn risk_over_ceiling_denies() {
    let db = Db::open_hub(&temp_db_path("trust-risk")).unwrap();
    // Ceiling is Low, but the action is a destructive run_command -> escalated to High.
    grant_trust(db.conn(), &grant_for(&["run_command"], Risk::Low, None), 1).unwrap();

    // A run_command whose base risk already exceeds the ceiling.
    let r = authorize_agent_action(
        db.conn(),
        &req("run_command", true, Risk::High),
        &ctx("run_command"),
        None,
        SECRET,
        100,
    )
    .unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "trust_grant_risk_over_ceiling");
}

#[test]
fn expired_grant_denies() {
    let db = Db::open_hub(&temp_db_path("trust-expired")).unwrap();
    grant_trust(
        db.conn(),
        &grant_for(&["read_file"], Risk::Medium, Some(50)),
        1,
    )
    .unwrap();

    // active_grant excludes the expired grant -> no ACTIVE grant at now=100, and the
    // compose denies (reporting the expired-authority reason via the latest-grant lookup).
    assert!(active_grant(db.conn(), "friday", 100).unwrap().is_none());
    let r = authorize_agent_action(
        db.conn(),
        &req("read_file", false, Risk::ReadOnly),
        &ctx("read_file"),
        None,
        SECRET,
        100,
    )
    .unwrap();
    assert_eq!(r.decision, GateDecision::Deny);
    assert_eq!(r.reason, "trust_grant_expired");
}

#[test]
fn grant_then_revoke_writes_exactly_two_audit_rows_and_chain_verifies() {
    let db = Db::open_hub(&temp_db_path("trust-audit")).unwrap();
    assert_eq!(audit_count(&db), 0);

    grant_trust(db.conn(), &grant_for(&["read_file"], Risk::Medium, None), 1).unwrap();
    revoke_trust(db.conn(), "g-friday", 50).unwrap();

    // Exactly two audit rows: trust.grant + trust.revoke.
    assert_eq!(audit_count(&db), 2);
    let actions: Vec<String> = {
        let mut stmt = db
            .conn()
            .prepare("SELECT action FROM audit_ledger ORDER BY rowid")
            .unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        rows
    };
    assert_eq!(actions, vec!["trust.grant", "trust.revoke"]);

    // The hash chain verifies (both rows appended inside their own tx).
    assert_eq!(
        friday_storage::audit::verify_audit_chain(db.conn()).unwrap(),
        2
    );
}
