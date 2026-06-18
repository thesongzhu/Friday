//! NS-3 — the DARK proof for the operator-CLI trust-grant issuance/revoke call-site.
//!
//! `friday_storage::grant_trust` / `revoke_trust` had ZERO callers, so NS-2's enforced
//! trust check (a separate PR, default-OFF) would deny EVERY mutating action closed
//! (`trust_no_active_grant`) because no path could ever mint a `TrustGrant`. NS-3 adds
//! that issuance path. This test is the dark proof: it drives the NEW call-site
//! (`friday_operator_cli::trust_grant::issue` / `revoke`) against a REAL temp SQLite Hub
//! DB and proves issuance ACTUALLY satisfies the check — not merely that a row was
//! written:
//!
//! 1. BEFORE issuance: `authorize_agent_action` for an in-boundary mutating action
//!    Denies with `trust_no_active_grant` (the check is unsatisfiable).
//! 2. issue via the new path -> `active_grant` returns the grant AND the boundary fields
//!    (risk ceiling / tool scope / workspace / expiry) round-trip.
//! 3. AFTER issuance: the SAME in-boundary mutating action NO LONGER returns
//!    `trust_no_active_grant`; the trust layer is transparent (`denied_by` is NOT
//!    `trust_grant`) and the result is the base gate's `RequiresApproval` — i.e. the
//!    grant is RESTRICTIVE-only and the check is now satisfiable (the safety prerequisite
//!    that lets NS-2's flag be turned on without bricking the run path).
//! 4. revoke via the new path -> `authorize_agent_action` reports `trust_grant_revoked`.
//!
//! DARK: this exercises the operator POLICY action; it does NOT enable enforcement
//! (NS-2 owns the enforce flag, default-OFF) and does NOT touch the live run loop.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use friday_core::gate::{classify, Actor, ActorKind, GateDecision, MutatingActionRequest};
use friday_core::Risk;
use friday_operator_cli::trust_grant::{self, TrustGrantSpec};
use friday_storage::{active_grant, authorize_agent_action, AgentActionContext, Db};

const SECRET: &[u8] = b"gate-signing-secret";
const AGENT: &str = "friday";
const GRANT_ID: &str = "g-friday-ns3";
const TOOL: &str = "write_file";
const WORKSPACE: &str = "/work/friday";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh on-disk SQLite path (a real file — the migration backup guard copies it).
fn temp_db_path(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "friday-ns3-cli-test-{tag}-{}-{nanos}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.push("db.sqlite");
    dir.to_string_lossy().to_string()
}

/// The spec the operator CLI would build for an in-boundary `write_file` grant:
/// risk_ceiling Medium, tool allowlisted, workspace-scoped, with an expiry far in the
/// future. Mirrors the comma-separated CLI parse via `parse_csv`.
fn in_boundary_spec(expires_at: Option<i64>) -> TrustGrantSpec {
    trust_grant::build_spec(
        GRANT_ID.to_string(),
        AGENT.to_string(),
        Risk::Medium,
        expires_at,
        Some(WORKSPACE.to_string()),
        Some(1000),      // token_ceiling — stored, DEFERRED-not-enforced
        Some(5),         // max_runs — stored, DEFERRED-not-enforced
        Some(Risk::Low), // D20 trust-dial metadata — stored, inert
        trust_grant::parse_csv(Some("telegram")),
        trust_grant::parse_csv(Some("deepseek")),
        trust_grant::parse_csv(Some("read_file,write_file")),
        Vec::new(),
        Vec::new(),
    )
    .expect("spec with non-empty ids is valid")
}

/// An in-boundary MUTATING `write_file` request + its action context: tool allowlisted,
/// effective risk (Medium) at/under the ceiling, workspace under the grant's prefix.
fn in_boundary_request() -> MutatingActionRequest {
    MutatingActionRequest::from_classification(
        classify(true, Risk::Medium, TOOL, &[]),
        TOOL.to_string(),
        Actor {
            kind: ActorKind::Agent,
            id: AGENT.to_string(),
            principal_id: Some("p1".to_string()),
        },
        "system".to_string(),
        vec![],
        None,
        Some("idem-ns3".to_string()),
        None,
    )
}

fn in_boundary_ctx() -> AgentActionContext {
    AgentActionContext {
        agent_id: AGENT.to_string(),
        workspace: Some(format!("{WORKSPACE}/src/main.rs")),
        tool: Some(TOOL.to_string()),
        provider: None,
        channel: None,
        workflow_family: None,
        skill_family: None,
        run_id: Some("operator-cli-test-run".to_string()),
    }
}

#[test]
fn issued_grant_satisfies_the_trust_check_then_revoke_reports_revoked() {
    let db = Db::open_hub(&temp_db_path("issue-revoke")).unwrap();
    let now = 100i64;

    // (1) BEFORE issuance: the check is UNSATISFIABLE — no active grant -> Deny with
    //     trust_no_active_grant. This is exactly the state that would brick every
    //     mutating action if NS-2's enforce flag were on with no issuance path.
    let before = authorize_agent_action(
        db.conn(),
        &in_boundary_request(),
        &in_boundary_ctx(),
        None,
        SECRET,
        now,
    )
    .unwrap();
    assert_eq!(before.decision, GateDecision::Deny);
    assert_eq!(before.reason, "trust_no_active_grant");
    assert_eq!(before.denied_by.as_deref(), Some("trust_grant"));

    // (2) Issue via the NEW operator-CLI call-site (NOT grant_trust directly).
    let issued = trust_grant::issue(&db, &in_boundary_spec(None), now).unwrap();
    assert_eq!(issued.grant_id, GRANT_ID);
    assert_eq!(issued.agent_id, AGENT);
    assert_eq!(issued.granted_at, now);

    // active_grant returns it, and the boundary fields ROUND-TRIP through storage.
    let active = active_grant(db.conn(), AGENT, now)
        .unwrap()
        .expect("active grant present after issuance");
    assert_eq!(active.grant_id, GRANT_ID);
    assert_eq!(active.expires_at, None);
    assert_eq!(active.boundaries.risk_ceiling, Risk::Medium);
    assert_eq!(active.boundaries.workspace.as_deref(), Some(WORKSPACE));
    assert_eq!(active.boundaries.token_ceiling, Some(1000));
    assert_eq!(active.boundaries.max_runs, Some(5));
    assert_eq!(
        active.boundaries.allowed_tools,
        vec!["read_file".to_string(), "write_file".to_string()]
    );
    assert_eq!(active.boundaries.allowed_providers, vec!["deepseek"]);
    assert_eq!(active.boundaries.allowed_channels, vec!["telegram"]);

    // (3) AFTER issuance: the SAME in-boundary mutating action no longer returns
    //     trust_no_active_grant. The grant is RESTRICTIVE-only — it does NOT upgrade the
    //     base gate's RequiresApproval to Allow; it just stops objecting (the trust layer
    //     is transparent: denied_by is NOT trust_grant). This is the proof that issuance
    //     ACTUALLY satisfies the check (the request falls through to the base gate),
    //     not merely that a row was written.
    let after = authorize_agent_action(
        db.conn(),
        &in_boundary_request(),
        &in_boundary_ctx(),
        None, // no canonical approval presented
        SECRET,
        now,
    )
    .unwrap();
    assert_ne!(
        after.reason, "trust_no_active_grant",
        "issuance must make the trust check satisfiable"
    );
    assert_ne!(
        after.denied_by.as_deref(),
        Some("trust_grant"),
        "an in-boundary action must not be denied BY the trust layer after issuance"
    );
    assert_eq!(
        after.decision,
        GateDecision::RequiresApproval,
        "a mutating action falls through to the base gate's RequiresApproval (the grant \
         is restrictive-only and never upgrades it to Allow)"
    );

    // (4) Revoke via the NEW operator-CLI call-site (NOT revoke_trust directly). The
    //     grant is no longer ACTIVE, and the compose reports the operator-meaningful
    //     trust_grant_revoked (NOT the never-granted reason).
    trust_grant::revoke(&db, GRANT_ID, 200).unwrap();
    assert!(active_grant(db.conn(), AGENT, 300).unwrap().is_none());

    let after_revoke = authorize_agent_action(
        db.conn(),
        &in_boundary_request(),
        &in_boundary_ctx(),
        None,
        SECRET,
        300,
    )
    .unwrap();
    assert_eq!(after_revoke.decision, GateDecision::Deny);
    assert_eq!(
        after_revoke.reason, "trust_grant_revoked",
        "a revoked authority must report trust_grant_revoked, not the never-granted reason"
    );
}

#[test]
fn expiry_round_trips_and_an_expired_grant_is_not_active() {
    // The expiry boundary round-trips through the issuance path: an issued grant with an
    // expiry is ACTIVE before it and not active at/after it.
    let db = Db::open_hub(&temp_db_path("expiry")).unwrap();
    let expires_at = 500i64;
    let issued = trust_grant::issue(&db, &in_boundary_spec(Some(expires_at)), 100).unwrap();
    assert_eq!(issued.expires_at, Some(expires_at));

    assert!(
        active_grant(db.conn(), AGENT, 100).unwrap().is_some(),
        "active before expiry"
    );
    assert!(
        active_grant(db.conn(), AGENT, expires_at)
            .unwrap()
            .is_none(),
        "not active at/after expiry"
    );
}

#[test]
fn empty_grant_id_and_empty_agent_fail_closed() {
    // The issuance call-site validates the required identifiers — an empty id is a clean
    // BadGrant error, never an opaque storage failure or a silent no-op.
    assert!(trust_grant::build_spec(
        String::new(),
        AGENT.to_string(),
        Risk::Low,
        None,
        None,
        None,
        None,
        None,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )
    .is_err());
    assert!(trust_grant::build_spec(
        GRANT_ID.to_string(),
        String::new(),
        Risk::Low,
        None,
        None,
        None,
        None,
        None,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )
    .is_err());

    let db = Db::open_hub(&temp_db_path("revoke-empty")).unwrap();
    assert!(
        trust_grant::revoke(&db, "  ", 1).is_err(),
        "revoking an empty grant_id is fail-closed"
    );
}

#[test]
fn parse_risk_and_csv_are_fail_closed() {
    assert_eq!(trust_grant::parse_risk("medium").unwrap(), Risk::Medium);
    assert_eq!(trust_grant::parse_risk("critical").unwrap(), Risk::Critical);
    assert!(
        trust_grant::parse_risk("MEDIUM").is_err(),
        "uppercase rejected"
    );
    assert!(
        trust_grant::parse_risk("severe").is_err(),
        "unknown rejected"
    );

    // CSV: trims, drops empty segments, None => empty (DENY-ALL for that dimension).
    assert_eq!(
        trust_grant::parse_csv(Some(" read_file , write_file ,")),
        vec!["read_file".to_string(), "write_file".to_string()]
    );
    assert!(trust_grant::parse_csv(None).is_empty());
    assert!(trust_grant::parse_csv(Some("")).is_empty());
}
