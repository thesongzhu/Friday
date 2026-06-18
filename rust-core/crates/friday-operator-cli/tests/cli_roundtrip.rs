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

use friday_core::gate::ApprovalDecision;
use friday_crypto::verify_ed25519_approval;
use friday_operator_cli::{
    canonical_batch_bytes, canonical_bytes, decode_signature_hex, decode_verifying_key_hex,
    parse_decision,
};

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
