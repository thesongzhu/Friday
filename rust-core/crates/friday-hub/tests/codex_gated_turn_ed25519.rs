//! Integration-tier KATs for the Ed25519 verify-only authorization of a gated Codex turn
//! ([`friday_hub::codex_gated_turn::run_codex_gated_turn`]). These are the relocated KAT (a)
//! tests: they REQUIRE a real operator key — signing an Ed25519 approval (positive parity) and
//! minting an HMAC approval (the downgrade defense). Naming an operator *signing* key is FORBIDDEN
//! anywhere under `friday-hub/src/` by the `hub_crate_never_references_a_signing_key` structural
//! guard (a Hub that could name a signing key could self-mint the approvals it verifies). The
//! integration tier (`tests/`) is a sibling of `src/` and is NOT scanned by that guard, so this is
//! where signing must live — exactly mirroring `friday-storage/tests/authorize_ed25519.rs`.
//!
//! These prove, against the REAL `JsonLineTransport` over recorded Codex byte-streams (NO live
//! codex), that the gated turn now authorizes protected actions via the IDENTICAL
//! `friday_storage::authorize_mutating_action_ed25519` the deepseek/claude routed loop uses:
//!   - an operator-Ed25519-signed approval Allows → the turn `accept`s → Finishes (parity);
//!   - an HMAC-signed approval over the SAME canonical bytes is REJECTED (the anti-mock-green
//!     downgrade canary — what the old Hub-held HMAC path WRONGLY accepted);
//!   - a provisioned key with NO approval still Pauses (a mutating action never auto-allows).

use std::sync::Mutex;

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_signature_bytes, ApprovalDecision,
    CanonicalApproval, MutatingActionRequest, CANONICAL_GATE_ISSUER,
};
use friday_core::Risk;
use friday_crypto::{OperatorSigningKey, OperatorVerifyingKey};
use friday_hub::codex_gated_turn::{run_codex_gated_turn, CodexTurnOutcome};
use friday_hub::{mint_approval, RunPolicy};
use friday_providers::codex_appserver::{
    CodexAppServerClient, CodexAppServerTransport, JsonLineTransport, FRIDAY_CODEX_MUTATING_GATE,
};
use friday_storage::{AgentActionContext, Db};

/// Serializes the gate-ON env mutation across this file's parallel test threads (cargo runs a
/// test binary's `#[test]`s on multiple threads). The codex_appserver crate's gate is env-read
/// (`FRIDAY_CODEX_MUTATING_GATE`); the `src` test module's `GATE_ENV_LOCK` is private, so we
/// hold our own here. Held for each test body's lifetime and the var is cleared on the way out.
static GATE_ENV_LOCK: Mutex<()> = Mutex::new(());

/// RAII gate-ON guard: sets `FRIDAY_CODEX_MUTATING_GATE=1` while held (under the lock), clears
/// it on drop. The flag-ON state is required for the handler (and thus the gate) to be consulted.
struct GateOn(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);

impl GateOn {
    fn on() -> Self {
        let guard = GATE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var(FRIDAY_CODEX_MUTATING_GATE, "1");
        GateOn(guard)
    }
}

impl Drop for GateOn {
    fn drop(&mut self) {
        std::env::remove_var(FRIDAY_CODEX_MUTATING_GATE);
    }
}

/// A fresh temp hub DB path, unique across runs AND processes.
fn temp_path(tag: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir();
    let pid = std::process::id();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    dir.join(format!(
        "friday-codex-ed25519-{pid}-{tag}-{n}-{nanos}.sqlite"
    ))
    .to_string_lossy()
    .into_owned()
}

/// A `CodexAppServerClient` over a recorded `&[u8]` byte stream (the REAL `JsonLineTransport`) —
/// NO live codex. Mirrors the `src` KATs' `client_over`.
fn client_over(
    stream: &'static str,
) -> CodexAppServerClient<JsonLineTransport<&'static [u8], Vec<u8>>> {
    CodexAppServerClient::new(JsonLineTransport::new(stream.as_bytes(), Vec::<u8>::new()))
}

/// A turn whose ONLY mid-turn event is the given commandExecution approval request, then (if
/// `complete`) an agent message + turn/completed. Shaped per the codex_appserver recorded stream.
fn command_turn(command: &str, complete: bool) -> String {
    let mut s = String::new();
    s.push_str(r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#);
    s.push('\n');
    s.push_str(&format!(
        r#"{{"id":77,"method":"item/commandExecution/requestApproval","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"i-1","approvalId":"ap-1","command":"{command}","cwd":"/work","startedAtMs":1}}}}"#
    ));
    s.push('\n');
    if complete {
        s.push_str(r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{"id":"a-1","type":"agentMessage","text":"done"}}}"#);
        s.push('\n');
        s.push_str(r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#);
        s.push('\n');
    }
    s
}

/// Insert an ACTIVE trust grant for `agent_id` (the EXISTING `grant_trust` path).
fn insert_grant(db: &Db, agent_id: &str, allowed_tools: &[&str], risk_ceiling: Risk) {
    let grant = friday_core::TrustGrant {
        grant_id: format!("g-{agent_id}"),
        agent_id: agent_id.to_string(),
        granted_at: 1,
        expires_at: None,
        revoked: false,
        revoked_at: None,
        boundaries: friday_core::TrustBoundaries {
            workspace: None,
            risk_ceiling,
            token_ceiling: None,
            max_runs: None,
            allowed_channels: vec![],
            allowed_providers: vec![],
            allowed_tools: allowed_tools.iter().map(|s| s.to_string()).collect(),
            allowed_workflow_families: vec![],
            allowed_skill_families: vec![],
        },
    };
    friday_storage::grant_trust(db.conn(), &grant, 1).expect("insert grant");
}

/// A policy bound to `agent_id` with an action-context (so the trust check finds the grant).
fn policy_for(agent_id: &str) -> RunPolicy {
    RunPolicy::new(Some(agent_id.to_string()), Vec::<String>::new(), false).with_action_context(
        AgentActionContext {
            agent_id: agent_id.to_string(),
            ..Default::default()
        },
    )
}

/// Build a correctly-signed, digest-bound, future-dated **Ed25519** approval for THIS exact
/// request — the operator's offline signature, the ONLY thing the verify-only gate accepts.
/// Mirrors the proven pattern in `friday-storage/tests/authorize_ed25519.rs`.
fn ed25519_approval(
    request: &MutatingActionRequest,
    sk: &OperatorSigningKey,
    approval_id: &str,
) -> CanonicalApproval {
    let digest = friday_crypto::action_digest(&canonical_action_bytes(request));
    let mut a = CanonicalApproval {
        decision: ApprovalDecision::Approved,
        approval_id: approval_id.to_string(),
        action_digest: digest,
        expires_at: Some(10_000),
        issuer: Some(CANONICAL_GATE_ISSUER.to_string()),
        signature: None,
    };
    a.signature = Some(sk.sign(&canonical_approval_signature_bytes(&a)).to_hex());
    a
}

/// Drive ONE gated turn with the given `operator_vk` + `approve_fn`.
#[allow(clippy::too_many_arguments)]
fn run<T: CodexAppServerTransport, F: Fn(&MutatingActionRequest) -> Option<CanonicalApproval>>(
    db: &Db,
    client: &mut CodexAppServerClient<T>,
    policy: &RunPolicy,
    operator_vk: Option<&OperatorVerifyingKey>,
    approve_fn: &F,
    text: &str,
) -> CodexTurnOutcome {
    run_codex_gated_turn(
        db.conn(),
        client,
        policy,
        operator_vk,
        approve_fn,
        "thread-1",
        None,
        text,
        "gpt-5-codex",
        "run-1",
        1_000,
    )
    .unwrap()
}

/// POSITIVE PARITY: an operator-Ed25519-signed approval bound to the EXACT request upgrades the
/// verify-only mutating gate's RequiresApproval to Allow → Codex `accept` → the turn Finishes.
/// This exercises the IDENTICAL `authorize_mutating_action_ed25519` the deepseek/claude loop uses.
#[test]
fn ed25519_signed_approval_continues_and_finishes() {
    let _gate = GateOn::on();
    let db = Db::open_hub(&temp_path("ed25519-pos")).unwrap();
    let policy = policy_for("agent-1");
    insert_grant(&db, "agent-1", &["run_command"], Risk::High);

    // A freshly generated operator key; the Hub holds ONLY the verifying half.
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    let approve = |req: &MutatingActionRequest| -> Option<CanonicalApproval> {
        Some(ed25519_approval(req, &sk, "ap-ed25519"))
    };
    let mut client = client_over(Box::leak(
        command_turn("cargo build", true).into_boxed_str(),
    ));
    let out = run(&db, &mut client, &policy, Some(&vk), &approve, "build it");
    match out {
        CodexTurnOutcome::Finished { answer, usage } => {
            assert_eq!(answer, "done");
            assert_eq!(usage.provider_kind, friday_core::ProviderKind::Codex);
            assert_eq!(usage.model, "gpt-5-codex");
        }
        other => panic!("expected Finished, got {other:?}"),
    }
    // The wire carries the `accept` decision (Allow).
    let written = String::from_utf8(client.into_transport().into_parts().1).unwrap();
    assert!(
        written.lines().any(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            v.get("result").and_then(|r| r.get("decision")) == Some(&serde_json::json!("accept"))
        }),
        "expected an accept decision on the wire: {written}"
    );
}

/// NEGATIVE DOWNGRADE DEFENSE (the anti-mock-green canary): the OLD code accepted an HMAC-signed
/// approval (the Hub-mintable `mint_approval`). The Ed25519 verify-only gate REJECTS it over the
/// SAME canonical bytes — an HMAC hex is not a valid Ed25519 signature under `operator_vk`. The
/// upgrade is Denied (`canonical_approval_signature_invalid`) → captured hard Deny → Errored. The
/// turn NEVER `accept`s. An approval the Hub could self-mint can no longer Allow a protected action.
#[test]
fn hmac_signed_approval_is_rejected_downgrade_defense() {
    let _gate = GateOn::on();
    let db = Db::open_hub(&temp_path("ed25519-neg")).unwrap();
    let policy = policy_for("agent-1");
    insert_grant(&db, "agent-1", &["run_command"], Risk::High);

    // A real operator key the gate verifies against; the approval below is NOT signed with it.
    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    // approve_fn mints the OLD HMAC-style approval over the SAME action (what a self-minting Hub
    // would produce). It is digest-bound and well-formed — only the SCHEME is wrong.
    let approve = |req: &MutatingActionRequest| -> Option<CanonicalApproval> {
        Some(mint_approval(req, "ap-hmac", b"test-secret", 10_000))
    };
    // `complete:false` — if (wrongly) accepted, the turn would continue; we assert it does NOT.
    let mut client = client_over(Box::leak(
        command_turn("cargo build", false).into_boxed_str(),
    ));
    let out = run(&db, &mut client, &policy, Some(&vk), &approve, "build it");
    match out {
        CodexTurnOutcome::Errored { reason } => {
            assert_eq!(reason, "canonical_approval_signature_invalid");
        }
        other => panic!("expected Errored(signature_invalid), got {other:?}"),
    }
    // The wire carries `cancel` (deny), NEVER `accept`.
    let written = String::from_utf8(client.into_transport().into_parts().1).unwrap();
    assert!(
        !written.lines().any(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| v.get("result").and_then(|r| r.get("decision")).cloned())
                == Some(serde_json::json!("accept"))
        }),
        "an HMAC-signed approval must NEVER produce accept on the wire: {written}"
    );
    assert!(
        written.contains(r#""decision":"cancel""#),
        "expected cancel (deny) on the wire: {written}"
    );
}

/// PROVISIONED but NO approval: a mutating action with `Some(&vk)` and no approval keeps the base
/// RequiresApproval (a mutating action never auto-allows without a bound, signature-valid operator
/// approval) → Pause + a persisted pending row. Complements the `None`-DenyAll Pause KAT in `src`.
#[test]
fn provisioned_but_unsigned_mutating_action_pauses() {
    let _gate = GateOn::on();
    let db = Db::open_hub(&temp_path("ed25519-pause")).unwrap();
    let policy = policy_for("agent-1");
    insert_grant(&db, "agent-1", &["run_command"], Risk::High);

    let sk = OperatorSigningKey::generate();
    let vk = sk.verifying_key();
    let no_approval = |_req: &MutatingActionRequest| -> Option<CanonicalApproval> { None };
    let mut client = client_over(Box::leak(
        command_turn("cargo build", false).into_boxed_str(),
    ));
    let out = run(
        &db,
        &mut client,
        &policy,
        Some(&vk),
        &no_approval,
        "build it",
    );
    let nonce = match out {
        CodexTurnOutcome::Paused {
            action,
            approval_nonce,
        } => {
            assert_eq!(action, "run_command");
            approval_nonce
        }
        other => panic!("expected Paused, got {other:?}"),
    };
    let count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM pending_approval_request WHERE run_id='run-1' AND approval_id=?1 AND action='run_command' AND status='pending'",
            [&nonce],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "exactly one pending row under the run+nonce");
    let written = String::from_utf8(client.into_transport().into_parts().1).unwrap();
    assert!(
        written.contains(r#""decision":"cancel""#),
        "expected cancel on the wire: {written}"
    );
}
