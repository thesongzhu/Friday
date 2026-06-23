//! End-to-end tests that drive the COMPILED `friday-operator-approve` binary
//! (slice S6c). They prove, against the real CLI:
//!
//! 1. round-trip: keygen -> sign a sample pending request -> the emitted approval
//!    VERIFIES with S6a's `friday_crypto::verify_ed25519_approval` using the public
//!    key from keygen.
//! 2. tamper: flipping ANY signed field (decision / approval_id / action_digest /
//!    expiry / issuer) breaks verification.
//! 3. key-isolation: the PUBLIC key alone cannot mint a verifiable approval; a
//!    garbage / wrong-length key file is a clean non-zero error (no panic, no leak).
//! 4. the operator PRIVATE key never appears in keygen/sign stdout OR stderr.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use friday_core::gate::canonical_action_bytes;
use friday_core::gate::ApprovalDecision;
use friday_core::{FridayConversation, Mission, MissionStatus, TruthStatus, WorkLane};
use friday_crypto::verify_ed25519_approval;
use friday_hub::{build_request, RawToolCall};
use friday_operator_cli::{
    build_prepared_action_request, canonical_batch_bytes, canonical_bytes, decode_signature_hex,
    decode_verifying_key_hex, parse_decision, ActionParam, BatchActionSpec,
};
use friday_storage::Db;

const BIN: &str = env!("CARGO_BIN_EXE_friday-operator-approve");

fn tmp_dir(tag: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(tag);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run_bin(args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .output()
        .expect("spawn friday-operator-approve")
}

fn conversation_for_passport(now: i64) -> FridayConversation {
    FridayConversation {
        friday_conversation_id: "fconv_cli_passport".into(),
        owner_principal: "owner-cli".into(),
        title: "CLI passport proof".into(),
        current_focus_summary: "Operator CLI passport ceremony proof.".into(),
        active_mission_ids: vec!["mission-cli-passport".into()],
        surface_thread_ids: vec![],
        memory_scope_ref: None,
        truth_status: TruthStatus::Proven,
        proof_refs: vec![],
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn mission_for_passport(now: i64) -> Mission {
    Mission {
        mission_id: "mission-cli-passport".into(),
        friday_conversation_id: "fconv_cli_passport".into(),
        title: "CLI passport proof".into(),
        intent: "Mint a context passport from the operator CLI.".into(),
        status: MissionStatus::Active,
        why_now: "T3 provisioning needs a real operator ceremony.".into(),
        decision_path_summary: "Use CLI ceremony, not app mint.".into(),
        considered_options: vec![],
        deferred_options: vec![],
        known_pitfalls: vec![],
        handoff_inheritance: vec![],
        work_item_ids: vec![],
        memory_candidate_refs: vec![],
        context_passport_refs: vec![],
        proof_refs: vec![],
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn sample_req() -> serde_json::Value {
    serde_json::json!({
        "approval_id": "ap-nonce-xyz",
        "action_digest": "a".repeat(64),
        "expires_at": 1_900_000_000_000i64,
        "decision": "approved",
        "principal": "owner:alice",
        "action": "fs.delete",
        "surface": "desktop"
    })
}

fn sample_batch_req() -> serde_json::Value {
    serde_json::json!({
        "batch_sign_id": "batch-d20-cli",
        "action_digests": ["a".repeat(64), "b".repeat(64)],
        "expires_at": 1_900_000_000_000i64,
        "decision": "approved",
        "plan_label": "D20 reversible batch",
        "worktree": "/tmp/friday-worktree"
    })
}

fn sample_prepare_batch_req(action: &str) -> serde_json::Value {
    serde_json::json!({
        "batch_sign_id": "batch-d20-prepared",
        "expires_at": 1_900_000_000_000i64,
        "decision": "approved",
        "plan_label": "D20 prepared reversible batch",
        "worktree": "/tmp/friday-worktree",
        "actions": [{
            "action": action,
            "actor_kind": "agent",
            "actor_id": "hub-agent",
            "surface": "agent",
            "params": [
                {"key": "path", "value": "/tmp/friday-worktree/out.txt"},
                {"key": "content", "value": "hello"}
            ]
        }]
    })
}

/// keygen + sign via the real binary; returns (public-key hex, parsed signed approval).
fn keygen_and_sign(tag: &str, req: &serde_json::Value) -> (String, serde_json::Value) {
    let dir = tmp_dir(tag);
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path); // CARGO_TARGET_TMPDIR persists across runs
    let kg = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(
        kg.status.success(),
        "keygen failed: {}",
        String::from_utf8_lossy(&kg.stderr)
    );
    let kg_json: serde_json::Value = serde_json::from_slice(&kg.stdout).unwrap();
    let vk_hex = kg_json["verifying_key"].as_str().unwrap().to_string();

    let req_path = dir.join("pending.json");
    std::fs::write(&req_path, serde_json::to_vec(req).unwrap()).unwrap();
    let sg = run_bin(&[
        "sign",
        "--key",
        key_path.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(
        sg.status.success(),
        "sign failed: {}",
        String::from_utf8_lossy(&sg.stderr)
    );
    let signed: serde_json::Value = serde_json::from_slice(&sg.stdout).unwrap();
    (vk_hex, signed)
}

fn rebuild_canonical_bytes(signed: &serde_json::Value) -> Vec<u8> {
    canonical_bytes(
        parse_decision(signed["decision"].as_str().unwrap()).unwrap(),
        signed["approval_id"].as_str().unwrap(),
        signed["action_digest"].as_str().unwrap(),
        signed["expires_at"].as_i64().unwrap(),
        signed["issuer"].as_str().unwrap(),
    )
}

fn rebuild_canonical_batch_bytes(signed: &serde_json::Value) -> Vec<u8> {
    let digests = signed["action_digests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    canonical_batch_bytes(
        parse_decision(signed["decision"].as_str().unwrap()).unwrap(),
        signed["batch_sign_id"].as_str().unwrap(),
        &digests,
        signed["expires_at"].as_i64().unwrap(),
        signed["issuer"].as_str().unwrap(),
    )
}

#[test]
fn prepared_action_digest_matches_hub_default_request() {
    let params = vec![
        ("content".to_string(), "hello".to_string()),
        (
            "path".to_string(),
            "/tmp/friday-worktree/out.txt".to_string(),
        ),
    ];
    let spec = BatchActionSpec {
        action: "write_file".to_string(),
        actor_kind: "agent".to_string(),
        actor_id: "hub-agent".to_string(),
        principal_id: None,
        surface: "agent".to_string(),
        params: params
            .iter()
            .map(|(key, value)| ActionParam {
                key: key.clone(),
                value: value.clone(),
            })
            .collect(),
        idempotency_key: None,
        plan_digest: None,
    };
    let prepared = build_prepared_action_request(&spec).unwrap();
    let hub = build_request(&RawToolCall {
        action: "write_file".to_string(),
        params,
    })
    .unwrap();

    assert_eq!(
        friday_crypto::action_digest(&canonical_action_bytes(&prepared)),
        friday_crypto::action_digest(&canonical_action_bytes(&hub)),
        "prepared batch digest must match the live Hub default request digest"
    );
}

#[test]
fn prepare_batch_then_sign_batch_roundtrip_verifies() {
    let dir = tmp_dir("prepare-batch-roundtrip");
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path);

    let kg = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(
        kg.status.success(),
        "keygen failed: {}",
        String::from_utf8_lossy(&kg.stderr)
    );
    let kg_json: serde_json::Value = serde_json::from_slice(&kg.stdout).unwrap();
    let vk_hex = kg_json["verifying_key"].as_str().unwrap().to_string();

    let actions_path = dir.join("batch-actions.json");
    std::fs::write(
        &actions_path,
        serde_json::to_vec(&sample_prepare_batch_req("write_file")).unwrap(),
    )
    .unwrap();
    let prepared = run_bin(&["prepare-batch", "--request", actions_path.to_str().unwrap()]);
    assert!(
        prepared.status.success(),
        "prepare-batch failed: {}",
        String::from_utf8_lossy(&prepared.stderr)
    );
    assert!(
        String::from_utf8_lossy(&prepared.stderr).trim().is_empty(),
        "prepare-batch should not print operator-key guidance or leak-like noise"
    );
    let pending: serde_json::Value = serde_json::from_slice(&prepared.stdout).unwrap();
    assert_eq!(pending["batch_sign_id"], "batch-d20-prepared");
    assert_eq!(pending["decision"], "approved");
    assert_eq!(pending["issuer"], "friday_canonical_gate");
    assert!(
        pending.get("signature").is_none(),
        "prepare-batch must not sign"
    );

    let digests = pending["action_digests"].as_array().unwrap();
    assert_eq!(digests.len(), 1);
    let digest = digests[0].as_str().unwrap();
    assert_eq!(digest.len(), 64);
    assert!(digest
        .bytes()
        .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')));

    let pending_path = dir.join("pending-batch.json");
    std::fs::write(&pending_path, serde_json::to_vec(&pending).unwrap()).unwrap();
    let signed = run_bin(&[
        "sign-batch",
        "--key",
        key_path.to_str().unwrap(),
        "--request",
        pending_path.to_str().unwrap(),
    ]);
    assert!(
        signed.status.success(),
        "sign-batch failed: {}",
        String::from_utf8_lossy(&signed.stderr)
    );
    let signed_json: serde_json::Value = serde_json::from_slice(&signed.stdout).unwrap();
    let bytes = rebuild_canonical_batch_bytes(&signed_json);
    let vk = decode_verifying_key_hex(&vk_hex).unwrap();
    let sig = decode_signature_hex(signed_json["signature"].as_str().unwrap()).unwrap();
    assert!(
        verify_ed25519_approval(&bytes, &vk, &sig),
        "prepared pending batch must sign and verify under the operator test key"
    );
}

#[test]
fn prepare_batch_rejects_logical_duplicate_after_param_sorting() {
    let dir = tmp_dir("prepare-batch-duplicate");
    let actions_path = dir.join("batch-actions.json");
    let req = serde_json::json!({
        "batch_sign_id": "batch-d20-dupe",
        "expires_at": 1_900_000_000_000i64,
        "decision": "approved",
        "actions": [
            {
                "action": "write_file",
                "actor_kind": "agent",
                "actor_id": "hub-agent",
                "surface": "agent",
                "params": [
                    {"key": "path", "value": "/tmp/friday-worktree/out.txt"},
                    {"key": "content", "value": "hello"}
                ]
            },
            {
                "action": "write_file",
                "actor_kind": "agent",
                "actor_id": "hub-agent",
                "surface": "agent",
                "params": [
                    {"key": "content", "value": "hello"},
                    {"key": "path", "value": "/tmp/friday-worktree/out.txt"}
                ]
            }
        ]
    });
    std::fs::write(&actions_path, serde_json::to_vec(&req).unwrap()).unwrap();

    let prepared = run_bin(&["prepare-batch", "--request", actions_path.to_str().unwrap()]);
    assert!(
        !prepared.status.success(),
        "same logical params in different order must collapse to a duplicate digest"
    );
    assert!(
        String::from_utf8_lossy(&prepared.stderr).contains("duplicates"),
        "expected duplicate digest error"
    );
}

#[test]
fn prepare_batch_rejects_irreversible_actions() {
    let dir = tmp_dir("prepare-batch-irreversible");
    let actions_path = dir.join("batch-actions.json");
    std::fs::write(
        &actions_path,
        serde_json::to_vec(&sample_prepare_batch_req("run_command")).unwrap(),
    )
    .unwrap();

    let prepared = run_bin(&["prepare-batch", "--request", actions_path.to_str().unwrap()]);
    assert!(
        !prepared.status.success(),
        "run_command must never enter a batch approval"
    );
    assert!(
        String::from_utf8_lossy(&prepared.stdout).trim().is_empty(),
        "no pending batch may be emitted on irreversible input"
    );
    assert!(
        String::from_utf8_lossy(&prepared.stderr).contains("irreversible"),
        "expected a clean irreversible-action error"
    );
}

#[test]
fn keygen_sign_roundtrip_verifies_and_never_leaks_private_key() {
    let dir = tmp_dir("roundtrip");
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path);

    let kg = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(
        kg.status.success(),
        "keygen failed: {}",
        String::from_utf8_lossy(&kg.stderr)
    );
    let kg_stdout = String::from_utf8(kg.stdout).unwrap();
    let kg_stderr = String::from_utf8(kg.stderr).unwrap();

    // The PRIVATE seed lives ONLY in the key file.
    let seed_hex = std::fs::read_to_string(&key_path)
        .unwrap()
        .trim()
        .to_string();
    assert_eq!(
        seed_hex.len(),
        64,
        "seed file must be 64 hex chars (32 bytes)"
    );

    // ---- no-leak: the private seed must not appear in stdout OR stderr ----
    assert!(
        !kg_stdout.contains(&seed_hex),
        "PRIVATE KEY LEAKED to keygen stdout"
    );
    assert!(
        !kg_stderr.contains(&seed_hex),
        "PRIVATE KEY LEAKED to keygen stderr"
    );

    // restrictive file perms
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "private key file must be mode 0600");
    }

    let kg_json: serde_json::Value = serde_json::from_str(&kg_stdout).unwrap();
    let vk_hex = kg_json["verifying_key"].as_str().unwrap().to_string();
    assert_eq!(kg_json["scheme"], "ed25519");
    assert_ne!(
        vk_hex, seed_hex,
        "public key must differ from the private seed"
    );

    // ---- sign ----
    let req_path = dir.join("pending.json");
    std::fs::write(&req_path, serde_json::to_vec(&sample_req()).unwrap()).unwrap();
    let sg = run_bin(&[
        "sign",
        "--key",
        key_path.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(
        sg.status.success(),
        "sign failed: {}",
        String::from_utf8_lossy(&sg.stderr)
    );
    let sg_stdout = String::from_utf8(sg.stdout).unwrap();
    let sg_stderr = String::from_utf8(sg.stderr).unwrap();
    assert!(
        !sg_stdout.contains(&seed_hex),
        "PRIVATE KEY LEAKED to sign stdout"
    );
    assert!(
        !sg_stderr.contains(&seed_hex),
        "PRIVATE KEY LEAKED to sign stderr"
    );

    let signed: serde_json::Value = serde_json::from_str(&sg_stdout).unwrap();
    assert_eq!(signed["scheme"], "ed25519");
    assert_eq!(signed["decision"], "approved");
    assert_eq!(signed["issuer"], "friday_canonical_gate");

    // ---- the emitted approval verifies with S6a's verify_ed25519_approval ----
    let bytes = rebuild_canonical_bytes(&signed);
    let vk = decode_verifying_key_hex(&vk_hex).unwrap();
    let sig = decode_signature_hex(signed["signature"].as_str().unwrap()).unwrap();
    assert!(
        verify_ed25519_approval(&bytes, &vk, &sig),
        "operator-signed approval must verify under the keygen public key"
    );
}

#[test]
fn keygen_sign_batch_roundtrip_verifies_and_never_leaks_private_key() {
    let dir = tmp_dir("batch-roundtrip");
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path);

    let kg = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(
        kg.status.success(),
        "keygen failed: {}",
        String::from_utf8_lossy(&kg.stderr)
    );
    let kg_stdout = String::from_utf8(kg.stdout).unwrap();
    let kg_stderr = String::from_utf8(kg.stderr).unwrap();
    let seed_hex = std::fs::read_to_string(&key_path)
        .unwrap()
        .trim()
        .to_string();
    assert!(!kg_stdout.contains(&seed_hex));
    assert!(!kg_stderr.contains(&seed_hex));
    let kg_json: serde_json::Value = serde_json::from_str(&kg_stdout).unwrap();
    let vk_hex = kg_json["verifying_key"].as_str().unwrap().to_string();

    let req_path = dir.join("pending-batch.json");
    std::fs::write(&req_path, serde_json::to_vec(&sample_batch_req()).unwrap()).unwrap();
    let sg = run_bin(&[
        "sign-batch",
        "--key",
        key_path.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(
        sg.status.success(),
        "sign-batch failed: {}",
        String::from_utf8_lossy(&sg.stderr)
    );
    let sg_stdout = String::from_utf8(sg.stdout).unwrap();
    let sg_stderr = String::from_utf8(sg.stderr).unwrap();
    assert!(
        !sg_stdout.contains(&seed_hex),
        "PRIVATE KEY LEAKED to sign-batch stdout"
    );
    assert!(
        !sg_stderr.contains(&seed_hex),
        "PRIVATE KEY LEAKED to sign-batch stderr"
    );

    let signed: serde_json::Value = serde_json::from_str(&sg_stdout).unwrap();
    assert_eq!(signed["scheme"], "ed25519");
    assert_eq!(signed["decision"], "approved");
    assert_eq!(signed["issuer"], "friday_canonical_gate");
    assert_eq!(signed["action_digests"].as_array().unwrap().len(), 2);

    let bytes = rebuild_canonical_batch_bytes(&signed);
    let vk = decode_verifying_key_hex(&vk_hex).unwrap();
    let sig = decode_signature_hex(signed["signature"].as_str().unwrap()).unwrap();
    assert!(
        verify_ed25519_approval(&bytes, &vk, &sig),
        "operator-signed batch must verify under the keygen public key"
    );
}

#[test]
fn any_signed_field_tamper_breaks_verification() {
    let (vk_hex, signed) = keygen_and_sign("tamper", &sample_req());
    let vk = decode_verifying_key_hex(&vk_hex).unwrap();
    let sig = decode_signature_hex(signed["signature"].as_str().unwrap()).unwrap();

    let decision = parse_decision(signed["decision"].as_str().unwrap()).unwrap();
    let approval_id = signed["approval_id"].as_str().unwrap();
    let action_digest = signed["action_digest"].as_str().unwrap();
    let expires_at = signed["expires_at"].as_i64().unwrap();
    let issuer = signed["issuer"].as_str().unwrap();

    // baseline: the untampered approval verifies
    assert!(verify_ed25519_approval(
        &canonical_bytes(decision, approval_id, action_digest, expires_at, issuer),
        &vk,
        &sig
    ));

    // flip decision
    let other = match decision {
        ApprovalDecision::Approved => ApprovalDecision::Denied,
        ApprovalDecision::Denied => ApprovalDecision::Approved,
    };
    assert!(!verify_ed25519_approval(
        &canonical_bytes(other, approval_id, action_digest, expires_at, issuer),
        &vk,
        &sig
    ));
    // flip approval_id (the single-use nonce)
    assert!(!verify_ed25519_approval(
        &canonical_bytes(decision, "ap-DIFFERENT", action_digest, expires_at, issuer),
        &vk,
        &sig
    ));
    // flip action_digest (binds principal/action/scope transitively)
    assert!(!verify_ed25519_approval(
        &canonical_bytes(decision, approval_id, &"b".repeat(64), expires_at, issuer),
        &vk,
        &sig
    ));
    // flip expiry
    assert!(!verify_ed25519_approval(
        &canonical_bytes(decision, approval_id, action_digest, expires_at + 1, issuer),
        &vk,
        &sig
    ));
    // flip issuer
    assert!(!verify_ed25519_approval(
        &canonical_bytes(
            decision,
            approval_id,
            action_digest,
            expires_at,
            "attacker_issuer"
        ),
        &vk,
        &sig
    ));
}

#[test]
fn any_signed_batch_field_tamper_breaks_verification() {
    let dir = tmp_dir("batch-tamper");
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path);
    let kg = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(kg.status.success());
    let kg_json: serde_json::Value = serde_json::from_slice(&kg.stdout).unwrap();
    let vk_hex = kg_json["verifying_key"].as_str().unwrap().to_string();

    let req_path = dir.join("pending-batch.json");
    std::fs::write(&req_path, serde_json::to_vec(&sample_batch_req()).unwrap()).unwrap();
    let sg = run_bin(&[
        "sign-batch",
        "--key",
        key_path.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(sg.status.success());
    let signed: serde_json::Value = serde_json::from_slice(&sg.stdout).unwrap();
    let vk = decode_verifying_key_hex(&vk_hex).unwrap();
    let sig = decode_signature_hex(signed["signature"].as_str().unwrap()).unwrap();
    let digests = signed["action_digests"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();

    assert!(verify_ed25519_approval(
        &canonical_batch_bytes(
            parse_decision(signed["decision"].as_str().unwrap()).unwrap(),
            signed["batch_sign_id"].as_str().unwrap(),
            &digests,
            signed["expires_at"].as_i64().unwrap(),
            signed["issuer"].as_str().unwrap(),
        ),
        &vk,
        &sig
    ));

    let mut flipped_digests = digests.clone();
    flipped_digests[0] = "c".repeat(64);
    assert!(!verify_ed25519_approval(
        &canonical_batch_bytes(
            ApprovalDecision::Approved,
            signed["batch_sign_id"].as_str().unwrap(),
            &flipped_digests,
            signed["expires_at"].as_i64().unwrap(),
            signed["issuer"].as_str().unwrap(),
        ),
        &vk,
        &sig
    ));
    assert!(!verify_ed25519_approval(
        &canonical_batch_bytes(
            ApprovalDecision::Denied,
            signed["batch_sign_id"].as_str().unwrap(),
            &digests,
            signed["expires_at"].as_i64().unwrap(),
            signed["issuer"].as_str().unwrap(),
        ),
        &vk,
        &sig
    ));
    assert!(!verify_ed25519_approval(
        &canonical_batch_bytes(
            ApprovalDecision::Approved,
            "batch-different",
            &digests,
            signed["expires_at"].as_i64().unwrap(),
            signed["issuer"].as_str().unwrap(),
        ),
        &vk,
        &sig
    ));
}

#[test]
fn public_key_alone_cannot_mint() {
    let dir = tmp_dir("isolation");
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path);
    let kg = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(kg.status.success());
    let kg_json: serde_json::Value = serde_json::from_slice(&kg.stdout).unwrap();
    let vk_hex = kg_json["verifying_key"].as_str().unwrap().to_string();

    // Treat the PUBLIC key hex as if it were a private key file. It is the same
    // 64-hex length, so it parses — but as an UNRELATED keypair's seed. A signature
    // produced this way must NOT verify under the real operator public key: holding
    // only the public key cannot mint an approval the Hub will accept.
    let pub_as_key = dir.join("public_as_key.key");
    let _ = std::fs::remove_file(&pub_as_key);
    std::fs::write(&pub_as_key, format!("{vk_hex}\n")).unwrap();

    let req_path = dir.join("pending.json");
    std::fs::write(&req_path, serde_json::to_vec(&sample_req()).unwrap()).unwrap();
    let sg = run_bin(&[
        "sign",
        "--key",
        pub_as_key.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(sg.status.success(), "any 32-byte seed signs syntactically");
    let signed: serde_json::Value = serde_json::from_slice(&sg.stdout).unwrap();

    let bytes = rebuild_canonical_bytes(&signed);
    let vk = decode_verifying_key_hex(&vk_hex).unwrap();
    let sig = decode_signature_hex(signed["signature"].as_str().unwrap()).unwrap();
    assert!(
        !verify_ed25519_approval(&bytes, &vk, &sig),
        "a signature minted from ONLY the public key must not verify under the real operator key"
    );
}

#[test]
fn garbage_or_wrong_length_key_fails_closed() {
    let dir = tmp_dir("garbage");
    let req_path = dir.join("pending.json");
    std::fs::write(&req_path, serde_json::to_vec(&sample_req()).unwrap()).unwrap();

    // non-hex garbage
    let bad = dir.join("garbage.key");
    std::fs::write(&bad, b"this is not a hex seed at all").unwrap();
    let sg = run_bin(&[
        "sign",
        "--key",
        bad.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(!sg.status.success(), "garbage key must exit non-zero");
    assert!(
        String::from_utf8_lossy(&sg.stdout).trim().is_empty(),
        "no approval may be emitted on error"
    );
    assert!(
        String::from_utf8_lossy(&sg.stderr).contains("invalid operator key file"),
        "expected a clean key-file error"
    );

    // valid hex but wrong length (3 bytes, not 32)
    let short = dir.join("short.key");
    std::fs::write(&short, "abcdef\n").unwrap();
    let sg2 = run_bin(&[
        "sign",
        "--key",
        short.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(!sg2.status.success(), "wrong-length key must exit non-zero");
}

#[test]
fn missing_request_field_fails_closed() {
    let dir = tmp_dir("missing");
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path);
    let kg = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(kg.status.success());

    let req_path = dir.join("pending.json");
    // missing action_digest
    std::fs::write(
        &req_path,
        br#"{"approval_id":"x","expires_at":1,"decision":"approved"}"#,
    )
    .unwrap();
    let sg = run_bin(&[
        "sign",
        "--key",
        key_path.to_str().unwrap(),
        "--request",
        req_path.to_str().unwrap(),
    ]);
    assert!(
        !sg.status.success(),
        "missing action_digest must exit non-zero"
    );
    assert!(String::from_utf8_lossy(&sg.stdout).trim().is_empty());
}

#[test]
fn keygen_refuses_to_overwrite_existing_key() {
    let dir = tmp_dir("overwrite");
    let key_path = dir.join("operator.key");
    let _ = std::fs::remove_file(&key_path);
    assert!(run_bin(&["keygen", "--out", key_path.to_str().unwrap()])
        .status
        .success());
    let again = run_bin(&["keygen", "--out", key_path.to_str().unwrap()]);
    assert!(
        !again.status.success(),
        "keygen must refuse to clobber an existing key file"
    );
    assert!(String::from_utf8_lossy(&again.stderr).contains("already exists"));
}

#[test]
fn passport_mint_cli_persists_mission_bound_passport_without_echoing_items() {
    let dir = tmp_dir("passport-mint-cli");
    let db_path = dir.join("hub.sqlite");
    let _ = std::fs::remove_file(&db_path);
    let db = Db::open_hub(db_path.to_str().unwrap()).unwrap();
    let now = 1_780_000_010_000i64;
    db.upsert_friday_conversation(&conversation_for_passport(now))
        .unwrap();
    db.upsert_mission(&mission_for_passport(now)).unwrap();

    let items_path = dir.join("items.json");
    std::fs::write(
        &items_path,
        br#"[{"kind":"summary","label":"approved operator summary","included":true,"sensitive":false}]"#,
    )
    .unwrap();
    let out = run_bin(&[
        "passport-mint",
        "--db",
        db_path.to_str().unwrap(),
        "--passport-id",
        "passport-cli-1",
        "--mission-id",
        "mission-cli-passport",
        "--destination-lane",
        "codex",
        "--destination-target",
        "codex",
        "--items",
        items_path.to_str().unwrap(),
    ]);
    assert!(
        out.status.success(),
        "passport-mint failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&out.stdout).contains("approved operator summary"),
        "receipt must not echo passport item labels"
    );
    let receipt: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(receipt["result"], "context_passport_minted");
    assert_eq!(
        receipt["truth_label"],
        "operator_cli_context_passport_ceremony_not_app_or_agent_mint"
    );
    assert_eq!(receipt["destination_lane"], WorkLane::Codex.as_str());
    assert_eq!(receipt["shared_item_count"], 1);

    let db = Db::open_hub(db_path.to_str().unwrap()).unwrap();
    let mission = db.get_mission("mission-cli-passport").unwrap().unwrap();
    assert_eq!(mission.context_passport_refs, vec!["passport-cli-1"]);
    assert!(db.get_context_passport("passport-cli-1").unwrap().is_some());
    assert!(db
        .list_mission_links("mission-cli-passport")
        .unwrap()
        .iter()
        .any(|link| link.proof_ref.as_deref() == Some("passport-cli-1")));
}
