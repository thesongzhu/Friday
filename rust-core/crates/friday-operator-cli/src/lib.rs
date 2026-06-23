//! Friday operator-signing CLI — library half (slice S6c of the asymmetric
//! approval spine).
//!
//! Truth label: this is the OFFLINE OPERATOR side. It holds the operator's PRIVATE
//! Ed25519 signing key (loaded from a file the operator keeps OUTSIDE the Hub) and
//! produces an operator-signed `CanonicalApproval`. The HUB holds ONLY the matching
//! PUBLIC verify key (S6b verify-only policy), so the Hub — where the agent runs —
//! can VERIFY an approval but can NEVER MINT one. This is the cryptographic half of
//! the operator's hard rule "the agent must never self-approve."
//!
//! Scope: the operator-signing half of this crate adds the keygen + sign tool ONLY.
//! It does NOT wire into the live gate/resume (that is S6d), does NOT edit
//! `friday-core::gate` or `friday-storage` (S6b owns them), and does NOT decide key
//! CUSTODY (who generates / holds the operator key for the S6e proof — a Directive-0d
//! operator gate). It merely loads a key from a path and signs. No network.
//! PROOF-ONLY; NOT v1 GO.
//!
//! ## NS-3: Hub-side trust-grant issuance/revoke (the OTHER half — see [`trust_grant`])
//!
//! `friday_storage::grant_trust` / `revoke_trust` had ZERO callers — so an enforced
//! trust check (NS-2, a separate PR, default-OFF) would deny EVERY mutating action
//! closed (`trust_no_active_grant`) because no issuance path could ever mint a
//! `TrustGrant`. NS-3 adds that issuance path as an OPERATOR POLICY action: the
//! [`trust_grant`] module mints / revokes a `TrustGrant` for an `agent_id` with its
//! boundaries (risk ceiling, workspace / tool / provider / channel / family scopes,
//! expiry) by calling `friday_storage::grant_trust` / `revoke_trust` against the Hub DB.
//!
//! This half links `friday-storage` (the only reason this crate now touches the Hub's
//! storage graph; the keygen/sign path above stays storage-free). It is DARK: issuance
//! is an operator action invoked from the CLI, NOT wired into the live run loop, and it
//! does NOT enable enforcement (NS-2 owns the enforce flag, default-OFF). It is purely
//! ADDITIVE — the keygen/sign behavior and output are unchanged.
//!
//! ## The crypto contract (why the Hub will accept what this emits)
//!
//! The signed bytes are produced by exactly ONE path —
//! [`canonical_bytes`] — which builds a `friday_core::gate::CanonicalApproval` and
//! calls the REAL `friday_core::gate::canonical_approval_signature_bytes`. Because
//! sign-time and verify-time both go through that same gate function, the bytes the
//! Hub recomputes are byte-identical to what this crate signed — divergence is
//! impossible by construction. The signature is then produced with S6a's
//! [`friday_crypto::OperatorSigningKey::sign`] and verifies with
//! [`friday_crypto::verify_ed25519_approval`].
//!
//! Principal / action / surface / resource / parameters are bound TRANSITIVELY
//! through `action_digest` (the gate hashes them into it). This CLI therefore takes
//! the `action_digest` the Hub already computed (carried in S6b's pending request)
//! rather than recomputing it — the operator signs the digest the Hub will compare
//! against. The human-readable context fields are echoed for operator review and
//! are explicitly NOT part of the signature.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use friday_core::gate::{
    canonical_action_bytes, canonical_approval_batch_signature_bytes,
    canonical_approval_signature_bytes, Actor, ActorKind, ApprovalDecision, CanonicalApproval,
    CanonicalApprovalBatch, LocalClaim, MutatingActionRequest, Reversibility,
    CANONICAL_GATE_ISSUER,
};
use friday_core::Risk;
use friday_crypto::ed25519_approval::{SEED_LEN, VERIFYING_KEY_LEN};
use friday_crypto::{action_digest, OperatorSigningKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

/// The asymmetric scheme tag carried in emitted approvals (mirrors S6a's
/// `ApprovalScheme::Ed25519`).
pub const SCHEME_ED25519: &str = "ed25519";

/// Failures are fail-closed and never echo key material. Error messages are
/// deliberately generic about the key file so a malformed file's bytes (which
/// contain the secret seed) are never logged.
#[derive(Debug, Error)]
pub enum CliError {
    #[error("operator key file already exists; refusing to overwrite (delete it first to re-key)")]
    KeyFileExists,
    #[error("could not write operator key file")]
    WriteKeyFile,
    #[error("could not read operator key file")]
    ReadKeyFile,
    #[error("invalid operator key file: expected a 64-char hex Ed25519 seed (32 bytes)")]
    BadKeyFile,
    #[error("invalid request: {0}")]
    BadRequest(String),
    #[error("invalid decision {0:?}: expected \"approved\" or \"denied\"")]
    BadDecision(String),
    #[error("invalid action_digest: expected 64 lowercase hex chars (a SHA-256 digest)")]
    BadActionDigest,
    // ---- NS-3 trust-grant issuance/revoke ----
    #[error("invalid trust grant: {0}")]
    BadGrant(String),
    #[error("could not open Hub database at {0}")]
    OpenDb(String),
    #[error("trust-grant storage error: {0}")]
    Storage(String),
}

/// The pending-request the operator signs. Shaped to match what S6b persists when a
/// mutating action Pauses (the fields needed to reconstruct the approval's canonical
/// bytes), plus optional human-readable context for operator review. Unknown fields
/// are tolerated so a richer S6b pending-request can be fed in unchanged.
#[derive(Debug, Clone, Deserialize)]
pub struct PendingRequest {
    /// Single-use nonce — the gate's `approval_id` / replay key.
    pub approval_id: String,
    /// Hex SHA-256 of the live request's canonical action bytes, as the Hub computed
    /// it. Principal/action/surface/resource/parameters are bound TRANSITIVELY here.
    pub action_digest: String,
    /// Epoch ms after which the approval is expired. Required — the gate rejects an
    /// approval with no expiry (fail-closed).
    pub expires_at: i64,
    /// Operator's decision: `"approved"` or `"denied"`.
    pub decision: String,
    /// Issuer string; defaults to the canonical gate issuer when omitted.
    #[serde(default)]
    pub issuer: Option<String>,

    // ---- context-only (operator review); NOT part of the signature ----
    /// Principal the action runs as (review only — bound via `action_digest`).
    #[serde(default)]
    pub principal: Option<String>,
    /// Action verb (review only — bound via `action_digest`).
    #[serde(default)]
    pub action: Option<String>,
    /// Surface (review only — bound via `action_digest`).
    #[serde(default)]
    pub surface: Option<String>,
}

/// A pending batch request the operator signs for D20 W2. It binds one operator
/// decision to an exact list of action digests. Unknown fields are tolerated so the
/// operator surface can include richer review context without changing signed bytes.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PendingBatchRequest {
    /// Batch replay namespace. Each member spends `(batch_sign_id, action_digest)`.
    pub batch_sign_id: String,
    /// Exact action digest members the operator reviewed.
    pub action_digests: Vec<String>,
    /// Epoch ms after which the batch approval is expired.
    pub expires_at: i64,
    /// Operator's decision: `"approved"` or `"denied"`.
    pub decision: String,
    /// Issuer string; defaults to the canonical gate issuer when omitted.
    #[serde(default)]
    pub issuer: Option<String>,

    // ---- context-only (operator review); NOT part of the signature ----
    #[serde(default)]
    pub plan_label: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
}

/// Operator-side input for producing a D20 W2 pending batch from canonical action
/// specs. This CLI does NOT sign or execute the actions; it computes the exact
/// digests that a later operator-held-key `sign-batch` decision may cover.
#[derive(Debug, Clone, Deserialize)]
pub struct PrepareBatchRequest {
    pub batch_sign_id: String,
    pub expires_at: i64,
    pub decision: String,
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub plan_label: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    pub actions: Vec<BatchActionSpec>,
}

/// One action candidate to include in an operator batch. `mutating`, `base_risk`,
/// and reversibility are never accepted from JSON; they come from the built-in
/// registry mirror below and are recomputed by `friday_core::gate::classify`.
#[derive(Debug, Clone, Deserialize)]
pub struct BatchActionSpec {
    pub action: String,
    pub actor_kind: String,
    pub actor_id: String,
    #[serde(default)]
    pub principal_id: Option<String>,
    pub surface: String,
    #[serde(default)]
    pub params: Vec<ActionParam>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub plan_digest: Option<String>,
}

/// Ordered action parameter entry. Order is preserved in both classification and the
/// opaque canonical parameter string that is bound into the digest.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ActionParam {
    pub key: String,
    pub value: String,
}

/// The operator-signed approval emitted to stdout. JSON the Hub-side S6d ingestion
/// will parse; the `signature` is an Ed25519 signature (hex) over [`canonical_bytes`].
/// The PUBLIC verify key is deliberately NOT carried here — the Hub MUST verify
/// against its own provisioned key (from `keygen`), never one supplied alongside the
/// signature.
#[derive(Debug, Clone, Serialize)]
pub struct SignedApproval {
    /// Always `"ed25519"` (operator-signed / Hub-verify-only).
    pub scheme: String,
    /// `"approved"` or `"denied"` (normalized).
    pub decision: String,
    pub approval_id: String,
    pub action_digest: String,
    pub expires_at: i64,
    pub issuer: String,
    /// Hex Ed25519 signature (64 bytes -> 128 hex chars) over the canonical bytes.
    pub signature: String,
}

/// Operator-signed D20 W2 batch approval emitted to stdout. The Hub verifies this
/// under its provisioned operator public key; the private key is never carried here.
#[derive(Debug, Clone, Serialize)]
pub struct SignedApprovalBatch {
    /// Always `"ed25519"`.
    pub scheme: String,
    /// `"approved"` or `"denied"` (normalized).
    pub decision: String,
    pub batch_sign_id: String,
    pub action_digests: Vec<String>,
    pub expires_at: i64,
    pub issuer: String,
    /// Hex Ed25519 signature over the canonical batch bytes.
    pub signature: String,
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = hex_val(b[i])?;
        let lo = hex_val(b[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

/// Parse the operator decision string into the gate enum. Fail-closed: only the two
/// exact spellings are accepted.
pub fn parse_decision(s: &str) -> Result<ApprovalDecision, CliError> {
    match s {
        "approved" => Ok(ApprovalDecision::Approved),
        "denied" => Ok(ApprovalDecision::Denied),
        other => Err(CliError::BadDecision(other.to_string())),
    }
}

fn decision_str(d: ApprovalDecision) -> &'static str {
    match d {
        ApprovalDecision::Approved => "approved",
        ApprovalDecision::Denied => "denied",
    }
}

fn parse_actor_kind(s: &str) -> Result<ActorKind, CliError> {
    match s {
        "owner" => Ok(ActorKind::Owner),
        "agent" => Ok(ActorKind::Agent),
        "api" => Ok(ActorKind::Api),
        "channel" => Ok(ActorKind::Channel),
        other => Err(CliError::BadRequest(format!(
            "unknown actor_kind {other:?}: expected owner|agent|api|channel"
        ))),
    }
}

#[derive(Clone, Copy, Debug)]
struct BuiltinToolSpec {
    mutating: bool,
    base_risk: Risk,
    base_reversibility: Reversibility,
}

fn builtin_tool_spec(
    action: &str,
    params: &[(String, String)],
) -> Result<BuiltinToolSpec, CliError> {
    let mut spec = match action {
        "read_file" | "list_dir" | "stat_file" | "search" | "web_search" | "memory_recall"
        | "memory_store" => BuiltinToolSpec {
            mutating: false,
            base_risk: Risk::ReadOnly,
            base_reversibility: Reversibility::Reversible,
        },
        "write_file" | "edit_file" | "append_file" => BuiltinToolSpec {
            mutating: true,
            base_risk: Risk::Medium,
            base_reversibility: Reversibility::ReversibleInWorkspace,
        },
        "delete_file" | "move_file" | "run_command" => BuiltinToolSpec {
            mutating: true,
            base_risk: Risk::High,
            base_reversibility: Reversibility::Irreversible,
        },
        "web_fetch" => BuiltinToolSpec {
            mutating: false,
            base_risk: Risk::ReadOnly,
            base_reversibility: Reversibility::Reversible,
        },
        "image_analysis" => BuiltinToolSpec {
            mutating: false,
            base_risk: Risk::ReadOnly,
            base_reversibility: Reversibility::Reversible,
        },
        "subagent" => BuiltinToolSpec {
            mutating: true,
            base_risk: Risk::Medium,
            base_reversibility: Reversibility::Irreversible,
        },
        other => {
            return Err(CliError::BadRequest(format!(
                "unknown built-in action {other:?}; prepare-batch only supports default Hub tools"
            )))
        }
    };
    if (action == "web_fetch" && web_fetch_is_egress_mutating(params))
        || (action == "image_analysis" && image_analysis_has_url_image(params))
    {
        spec.mutating = true;
        spec.base_reversibility = Reversibility::Irreversible;
    }
    Ok(spec)
}

fn param_value<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn web_fetch_is_egress_mutating(params: &[(String, String)]) -> bool {
    let method = param_value(params, "method")
        .unwrap_or("GET")
        .to_uppercase();
    let has_body = param_value(params, "body").is_some_and(|body| !body.is_empty());
    method != "GET" || has_body
}

fn image_analysis_has_url_image(params: &[(String, String)]) -> bool {
    let Some(images_raw) = param_value(params, "images") else {
        return false;
    };
    images_raw
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|spec| spec.starts_with("http://") || spec.starts_with("https://"))
}

fn canonical_params(pairs: &[(String, String)]) -> String {
    let mut sorted = pairs.to_vec();
    sorted.sort();
    let mut out = String::new();
    for (key, value) in &sorted {
        out.push_str(&key.len().to_string());
        out.push(':');
        out.push_str(key);
        out.push('=');
        out.push_str(&value.len().to_string());
        out.push(':');
        out.push_str(value);
        out.push(';');
    }
    out
}

fn validate_action_digest(s: &str) -> Result<(), CliError> {
    // The Hub's digest is lowercase 64-hex SHA-256 (friday_crypto::action_digest).
    // We must sign the EXACT form the Hub compares against, so require lowercase.
    let ok = s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    if ok {
        Ok(())
    } else {
        Err(CliError::BadActionDigest)
    }
}

fn validate_nonempty_field(value: &str, field: &str) -> Result<(), CliError> {
    if value.trim().is_empty() {
        Err(CliError::BadRequest(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

fn validate_batch_digests(digests: &[String]) -> Result<(), CliError> {
    if digests.is_empty() {
        return Err(CliError::BadRequest(
            "action_digests must not be empty".to_string(),
        ));
    }
    let mut seen = HashSet::with_capacity(digests.len());
    for digest in digests {
        validate_action_digest(digest)?;
        if !seen.insert(digest) {
            return Err(CliError::BadRequest(
                "action_digests must not contain duplicates".to_string(),
            ));
        }
    }
    Ok(())
}

/// The single shared path that produces the bytes a signature covers. Builds a
/// `CanonicalApproval` (with `signature: None` — the gate function does not read it)
/// and calls the REAL gate serializer, so these are byte-identical to what the Hub
/// recomputes at verify time.
pub fn canonical_bytes(
    decision: ApprovalDecision,
    approval_id: &str,
    action_digest: &str,
    expires_at: i64,
    issuer: &str,
) -> Vec<u8> {
    let approval = CanonicalApproval {
        decision,
        approval_id: approval_id.to_string(),
        action_digest: action_digest.to_string(),
        expires_at: Some(expires_at),
        issuer: Some(issuer.to_string()),
        signature: None,
    };
    canonical_approval_signature_bytes(&approval)
}

/// The single shared path that produces the bytes a batch signature covers.
/// Builds a `CanonicalApprovalBatch` with `signature: None` and calls the REAL gate
/// serializer, so sign-time and verify-time bytes are identical by construction.
pub fn canonical_batch_bytes(
    decision: ApprovalDecision,
    batch_sign_id: &str,
    action_digests: &[String],
    expires_at: i64,
    issuer: &str,
) -> Vec<u8> {
    let batch = CanonicalApprovalBatch {
        decision,
        batch_sign_id: batch_sign_id.to_string(),
        action_digests: action_digests.to_vec(),
        expires_at: Some(expires_at),
        issuer: Some(issuer.to_string()),
        signature: None,
    };
    canonical_approval_batch_signature_bytes(&batch)
}

/// Produce a signable D20 W2 pending batch from action specs, without reading an
/// operator key, signing, executing, or touching live state. Irreversible actions are
/// fail-closed here so a batch signature can never become a path around the per-action
/// manual gate for hard-excluded operations.
pub fn prepare_batch_request(req: &PrepareBatchRequest) -> Result<PendingBatchRequest, CliError> {
    let decision = parse_decision(&req.decision)?;
    validate_nonempty_field(&req.batch_sign_id, "batch_sign_id")?;
    if req.expires_at <= 0 {
        return Err(CliError::BadRequest(
            "expires_at must be a positive epoch-ms".to_string(),
        ));
    }
    if req.actions.is_empty() {
        return Err(CliError::BadRequest(
            "actions must not be empty".to_string(),
        ));
    }
    let issuer = req
        .issuer
        .clone()
        .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string());
    validate_nonempty_field(&issuer, "issuer")?;

    let mut action_digests = Vec::with_capacity(req.actions.len());
    for spec in &req.actions {
        let request = build_prepared_action_request(spec)?;
        action_digests.push(action_digest(&canonical_action_bytes(&request)));
    }
    validate_batch_digests(&action_digests)?;

    Ok(PendingBatchRequest {
        batch_sign_id: req.batch_sign_id.clone(),
        action_digests,
        expires_at: req.expires_at,
        decision: decision_str(decision).to_string(),
        issuer: Some(issuer),
        plan_label: req.plan_label.clone(),
        worktree: req.worktree.clone(),
    })
}

/// Build the same canonical request shape that the Hub will authorize for the supplied
/// action spec: registry-owned mutating/risk/reversibility, sorted length-prefixed
/// params, and caller-supplied actor/surface identity.
pub fn build_prepared_action_request(
    spec: &BatchActionSpec,
) -> Result<MutatingActionRequest, CliError> {
    validate_nonempty_field(&spec.action, "action")?;
    validate_nonempty_field(&spec.actor_id, "actor_id")?;
    validate_nonempty_field(&spec.surface, "surface")?;
    if let Some(principal_id) = &spec.principal_id {
        validate_nonempty_field(principal_id, "principal_id")?;
    }
    if let Some(idempotency_key) = &spec.idempotency_key {
        validate_nonempty_field(idempotency_key, "idempotency_key")?;
    }
    if let Some(plan_digest) = &spec.plan_digest {
        validate_nonempty_field(plan_digest, "plan_digest")?;
    }

    let actor_kind = parse_actor_kind(&spec.actor_kind)?;
    let mut param_pairs = Vec::with_capacity(spec.params.len());
    for param in &spec.params {
        validate_nonempty_field(&param.key, "param.key")?;
        param_pairs.push((param.key.clone(), param.value.clone()));
    }

    let tool_spec = builtin_tool_spec(&spec.action, &param_pairs)?;
    let classification = friday_core::gate::classify_with_reversibility(
        tool_spec.mutating,
        tool_spec.base_risk,
        tool_spec.base_reversibility,
        &spec.action,
        &param_pairs,
    );
    if classification.reversibility() == Reversibility::Irreversible {
        return Err(CliError::BadRequest(format!(
            "batch action classified irreversible: {}",
            spec.action
        )));
    }

    let parameters = if spec.params.is_empty() {
        None
    } else {
        Some(canonical_params(&param_pairs))
    };
    Ok(MutatingActionRequest::from_classification(
        classification,
        spec.action.clone(),
        Actor {
            kind: actor_kind,
            id: spec.actor_id.clone(),
            principal_id: spec.principal_id.clone(),
        },
        spec.surface.clone(),
        Vec::<LocalClaim>::new(),
        parameters,
        spec.idempotency_key.clone(),
        spec.plan_digest.clone(),
    ))
}

/// Write the operator's PRIVATE seed (hex) to `path`, created fresh with `0o600`
/// perms. `create_new` both refuses to clobber an existing key and guarantees the
/// restrictive mode is applied at creation (no umask race, no chmod-after-write
/// window). The seed/hex buffers are zeroized after the write.
fn write_private_seed(path: &Path, seed: &[u8; SEED_LEN]) -> Result<(), CliError> {
    let mut hex = to_hex(seed);
    hex.push('\n');
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    CliError::KeyFileExists
                } else {
                    CliError::WriteKeyFile
                }
            })?;
        f.write_all(hex.as_bytes())
            .map_err(|_| CliError::WriteKeyFile)?;
        f.flush().map_err(|_| CliError::WriteKeyFile)
    })();
    hex.zeroize();
    result
}

/// Load the operator's PRIVATE signing key from `path`. Transient secret buffers
/// (file contents, decoded bytes, seed array) are zeroized before returning. The
/// error path NEVER includes the file's bytes.
fn read_signing_key(path: &Path) -> Result<OperatorSigningKey, CliError> {
    let mut contents = fs::read_to_string(path).map_err(|_| CliError::ReadKeyFile)?;
    let mut bytes = match from_hex(contents.trim()) {
        Some(b) => b,
        None => {
            contents.zeroize();
            return Err(CliError::BadKeyFile);
        }
    };
    let result = match <[u8; SEED_LEN]>::try_from(bytes.as_slice()) {
        Ok(mut seed) => {
            let sk = OperatorSigningKey::from_seed_bytes(&seed);
            seed.zeroize();
            Ok(sk)
        }
        Err(_) => Err(CliError::BadKeyFile),
    };
    bytes.zeroize();
    contents.zeroize();
    result
}

/// keygen: generate an operator keypair, persist the PRIVATE seed to `key_path`
/// (`0o600`), and RETURN the PUBLIC verifying key as hex (the only half handed to
/// the Hub). The private key is never returned, printed, or logged.
pub fn keygen_to_path(key_path: &Path) -> Result<String, CliError> {
    let sk = OperatorSigningKey::generate();
    let vk_hex = to_hex(&sk.verifying_key().to_bytes());
    let mut seed = sk.to_seed_bytes();
    let result = write_private_seed(key_path, &seed);
    seed.zeroize();
    result.map(|()| vk_hex)
}

/// sign: validate the pending request, load the PRIVATE key from `key_path`,
/// reconstruct the canonical bytes, Ed25519-sign them, and return the signed
/// approval. Fail-closed on every malformed input; never panics; never leaks the key.
pub fn sign_request(key_path: &Path, req: &PendingRequest) -> Result<SignedApproval, CliError> {
    let sk = read_signing_key(key_path)?;
    sign_request_with_key(&sk, req)
}

/// sign-batch: validate a D20 W2 pending batch, load the PRIVATE key from
/// `key_path`, reconstruct the canonical batch bytes, Ed25519-sign them, and return
/// the signed batch approval.
pub fn sign_batch_request(
    key_path: &Path,
    req: &PendingBatchRequest,
) -> Result<SignedApprovalBatch, CliError> {
    let sk = read_signing_key(key_path)?;
    sign_batch_request_with_key(&sk, req)
}

/// sign with an ALREADY-LOADED operator signing key: validate the pending request,
/// reconstruct the canonical bytes, Ed25519-sign them, and return the signed approval.
///
/// This is the byte-producing core that [`sign_request`] (file-sourced key) and any
/// OTHER operator-controlled key source (e.g. a KEK-wrapped `SecureStore` seed) MUST
/// both route through, so every signature is produced over the IDENTICAL
/// [`canonical_bytes`] the Hub recomputes at verify time
/// (`friday_core::gate::canonical_approval_signature_bytes`). Producing the bytes any
/// other way is the one error that silently yields a signature the Hub rejects; reusing
/// this function makes byte-identity true by construction.
///
/// The caller owns key custody (how the [`OperatorSigningKey`] was obtained); this
/// function never reads a key source and never leaks key material (the signature is the
/// only key-derived output, and a signature is public by construction). Fail-closed on
/// every malformed field; never panics.
pub fn sign_request_with_key(
    sk: &OperatorSigningKey,
    req: &PendingRequest,
) -> Result<SignedApproval, CliError> {
    let decision = parse_decision(&req.decision)?;
    if req.approval_id.trim().is_empty() {
        return Err(CliError::BadRequest(
            "approval_id must not be empty".to_string(),
        ));
    }
    validate_action_digest(&req.action_digest)?;
    if req.expires_at <= 0 {
        return Err(CliError::BadRequest(
            "expires_at must be a positive epoch-ms".to_string(),
        ));
    }
    let issuer = req
        .issuer
        .clone()
        .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string());
    if issuer.trim().is_empty() {
        return Err(CliError::BadRequest("issuer must not be empty".to_string()));
    }

    let bytes = canonical_bytes(
        decision,
        &req.approval_id,
        &req.action_digest,
        req.expires_at,
        &issuer,
    );
    let sig = sk.sign(&bytes);

    Ok(SignedApproval {
        scheme: SCHEME_ED25519.to_string(),
        decision: decision_str(decision).to_string(),
        approval_id: req.approval_id.clone(),
        action_digest: req.action_digest.clone(),
        expires_at: req.expires_at,
        issuer,
        signature: to_hex(&sig.to_bytes()),
    })
}

/// Sign with an already-loaded operator signing key, for operator-controlled key
/// sources. The caller owns key custody; this function only validates and signs the
/// canonical batch bytes.
pub fn sign_batch_request_with_key(
    sk: &OperatorSigningKey,
    req: &PendingBatchRequest,
) -> Result<SignedApprovalBatch, CliError> {
    let decision = parse_decision(&req.decision)?;
    if req.batch_sign_id.trim().is_empty() {
        return Err(CliError::BadRequest(
            "batch_sign_id must not be empty".to_string(),
        ));
    }
    validate_batch_digests(&req.action_digests)?;
    if req.expires_at <= 0 {
        return Err(CliError::BadRequest(
            "expires_at must be a positive epoch-ms".to_string(),
        ));
    }
    let issuer = req
        .issuer
        .clone()
        .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string());
    if issuer.trim().is_empty() {
        return Err(CliError::BadRequest("issuer must not be empty".to_string()));
    }

    let bytes = canonical_batch_bytes(
        decision,
        &req.batch_sign_id,
        &req.action_digests,
        req.expires_at,
        &issuer,
    );
    let sig = sk.sign(&bytes);

    Ok(SignedApprovalBatch {
        scheme: SCHEME_ED25519.to_string(),
        decision: decision_str(decision).to_string(),
        batch_sign_id: req.batch_sign_id.clone(),
        action_digests: req.action_digests.clone(),
        expires_at: req.expires_at,
        issuer,
        signature: to_hex(&sig.to_bytes()),
    })
}

/// Decode a `VERIFYING_KEY_LEN`-byte hex verifying key emitted by `keygen` (used by
/// callers/tests that verify an emitted approval). `None` on any malformed input.
pub fn decode_verifying_key_hex(hex: &str) -> Option<[u8; VERIFYING_KEY_LEN]> {
    let bytes = from_hex(hex.trim())?;
    <[u8; VERIFYING_KEY_LEN]>::try_from(bytes.as_slice()).ok()
}

/// Decode a 64-byte hex signature emitted in [`SignedApproval::signature`].
pub fn decode_signature_hex(hex: &str) -> Option<Vec<u8>> {
    from_hex(hex.trim())
}

/// NS-3 — Hub-side trust-grant issuance/revoke (the operator POLICY action).
///
/// This module is the call-site that mints / revokes a `friday_core::TrustGrant`
/// through `friday_storage::grant_trust` / `revoke_trust` — the storage functions that
/// otherwise had ZERO callers, so NS-2's enforced trust check could never be satisfied
/// (it would deny every mutating action closed with `trust_no_active_grant`). It links
/// `friday-storage` (the only Hub-storage coupling in this crate). It is DARK: invoked
/// from the operator CLI, NOT from the live run loop, and it does NOT enable enforcement
/// (NS-2 owns the enforce flag, default-OFF).
pub mod trust_grant {
    use super::CliError;
    use friday_core::{Risk, TrustBoundaries, TrustGrant};
    use friday_storage::Db;

    /// Operator-supplied parameters for an issuance. Bundled into ONE struct (rather
    /// than a wide function signature) so the boundary fields stay grouped and the
    /// issuance call does not trip `clippy::too_many_arguments`. Every `Vec` allowlist
    /// is fail-closed: EMPTY = DENY-ALL for that dimension (mirrors `check_grant`).
    #[derive(Debug, Clone, Default)]
    pub struct TrustGrantSpec {
        /// Stable id for the grant row (e.g. `g-friday-2026`). Required, non-empty.
        pub grant_id: String,
        /// The agent the grant authorizes: `friday` | `codex` | `claude` |
        /// `workflow:<id>` | `skill:<id>`. Required, non-empty.
        pub agent_id: String,
        /// Maximum effective risk an action may carry under this grant.
        pub risk_ceiling: Risk,
        /// `None` = no expiry; otherwise epoch-ms after which the grant is dead.
        pub expires_at: Option<i64>,
        /// Optional workspace path PREFIX the grant is confined to (`None` = any path).
        pub workspace: Option<String>,
        /// DEFERRED in storage (stored, NOT enforced — no live ledger/run counter).
        pub token_ceiling: Option<i64>,
        /// DEFERRED in storage (stored, NOT enforced).
        pub max_runs: Option<i64>,
        /// D20 W2-S2 DARK metadata: operator-owned reversible auto-allow ceiling.
        /// Stored and echoed only; the Hub does not consume it as authorization.
        pub auto_allow_reversible_ceiling: Option<Risk>,
        pub allowed_channels: Vec<String>,
        pub allowed_providers: Vec<String>,
        pub allowed_tools: Vec<String>,
        pub allowed_workflow_families: Vec<String>,
        pub allowed_skill_families: Vec<String>,
    }

    impl TrustGrantSpec {
        /// Compose the `TrustGrant` this spec describes, granted at `now_ms`. Pure (no
        /// I/O) — the persistence is done by [`issue`].
        fn to_grant(&self, now_ms: i64) -> TrustGrant {
            TrustGrant {
                grant_id: self.grant_id.clone(),
                agent_id: self.agent_id.clone(),
                granted_at: now_ms,
                expires_at: self.expires_at,
                revoked: false,
                revoked_at: None,
                boundaries: TrustBoundaries {
                    workspace: self.workspace.clone(),
                    risk_ceiling: self.risk_ceiling,
                    token_ceiling: self.token_ceiling,
                    max_runs: self.max_runs,
                    auto_allow_reversible_ceiling: self.auto_allow_reversible_ceiling,
                    allowed_channels: self.allowed_channels.clone(),
                    allowed_providers: self.allowed_providers.clone(),
                    allowed_tools: self.allowed_tools.clone(),
                    allowed_workflow_families: self.allowed_workflow_families.clone(),
                    allowed_skill_families: self.allowed_skill_families.clone(),
                },
            }
        }
    }

    /// Parse an operator-supplied risk string into the gate enum. Fail-closed: only the
    /// five canonical spellings are accepted (matches `Risk::as_str`).
    pub fn parse_risk(s: &str) -> Result<Risk, CliError> {
        match s {
            "read_only" => Ok(Risk::ReadOnly),
            "low" => Ok(Risk::Low),
            "medium" => Ok(Risk::Medium),
            "high" => Ok(Risk::High),
            "critical" => Ok(Risk::Critical),
            other => Err(CliError::BadGrant(format!(
                "unknown risk_ceiling {other:?}: expected one of \
                 read_only|low|medium|high|critical"
            ))),
        }
    }

    /// Parse a comma-separated allowlist (e.g. `--tools read_file,write_file`) into a
    /// `Vec<String>`. `None`/empty input yields an EMPTY vec — which `check_grant`
    /// treats as DENY-ALL for that dimension (fail-closed). Surrounding whitespace is
    /// trimmed; empty segments (e.g. a trailing comma) are dropped.
    pub fn parse_csv(value: Option<&str>) -> Vec<String> {
        match value {
            None => Vec::new(),
            Some(raw) => raw
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
        }
    }

    /// Build the issuance spec from already-parsed parts. Validates the two required
    /// non-empty identifiers (fail-closed) so an empty `grant_id`/`agent_id` is caught
    /// here rather than as an opaque storage error.
    #[allow(clippy::too_many_arguments)]
    pub fn build_spec(
        grant_id: String,
        agent_id: String,
        risk_ceiling: Risk,
        expires_at: Option<i64>,
        workspace: Option<String>,
        token_ceiling: Option<i64>,
        max_runs: Option<i64>,
        auto_allow_reversible_ceiling: Option<Risk>,
        allowed_channels: Vec<String>,
        allowed_providers: Vec<String>,
        allowed_tools: Vec<String>,
        allowed_workflow_families: Vec<String>,
        allowed_skill_families: Vec<String>,
    ) -> Result<TrustGrantSpec, CliError> {
        if grant_id.trim().is_empty() {
            return Err(CliError::BadGrant("grant_id must not be empty".to_string()));
        }
        if agent_id.trim().is_empty() {
            return Err(CliError::BadGrant("agent_id must not be empty".to_string()));
        }
        Ok(TrustGrantSpec {
            grant_id,
            agent_id,
            risk_ceiling,
            expires_at,
            workspace,
            token_ceiling,
            max_runs,
            auto_allow_reversible_ceiling,
            allowed_channels,
            allowed_providers,
            allowed_tools,
            allowed_workflow_families,
            allowed_skill_families,
        })
    }

    /// Issue (mint) the trust grant `spec` describes against the OPEN Hub `db`, granted
    /// at `now_ms`. Routes through `friday_storage::grant_trust`, so the grant + its
    /// hash-chained `trust.grant` audit row commit together. Returns the persisted
    /// `TrustGrant` (so the caller can echo it / a test can assert the round-trip).
    ///
    /// `now_ms` is an argument (not read from a clock here) so a test can pin it; the
    /// CLI supplies `SystemTime::now`.
    pub fn issue(db: &Db, spec: &TrustGrantSpec, now_ms: i64) -> Result<TrustGrant, CliError> {
        let grant = spec.to_grant(now_ms);
        friday_storage::grant_trust(db.conn(), &grant, now_ms)
            .map_err(|e| CliError::Storage(e.to_string()))?;
        Ok(grant)
    }

    /// Revoke the grant `grant_id` against the OPEN Hub `db` at `now_ms`. Routes through
    /// `friday_storage::revoke_trust`, so the `revoked=1` update + its `trust.revoke`
    /// audit row commit together. Revoking a missing grant is a fail-closed error (the
    /// storage layer returns one — no silent no-op that would look like a revoke).
    pub fn revoke(db: &Db, grant_id: &str, now_ms: i64) -> Result<(), CliError> {
        if grant_id.trim().is_empty() {
            return Err(CliError::BadGrant("grant_id must not be empty".to_string()));
        }
        friday_storage::revoke_trust(db.conn(), grant_id, now_ms)
            .map_err(|e| CliError::Storage(e.to_string()))
    }

    /// Open the Hub DB at `path` for an issuance/revoke. Wraps `Db::open_hub` so the
    /// error is a clean `CliError::OpenDb` (the path is not secret; this never echoes
    /// DB contents).
    pub fn open_hub(path: &str) -> Result<Db, CliError> {
        Db::open_hub(path).map_err(|_| CliError::OpenDb(path.to_string()))
    }
}

/// Operator-side Context Passport ceremony.
///
/// This is deliberately an operator CLI path, not a Hub/app/agent mint endpoint. It builds
/// a destination-bound passport through the same fail-closed core constructor used by
/// Hub preflight, persists the object, binds it to the Mission refs, and records a
/// MissionLink so the existing preflight gate can satisfy a sensitive external transfer.
pub mod context_passport {
    use super::CliError;
    use friday_core::{
        build_context_passport, MissionLink, MissionLinkKind, PassportItem, PassportItemKind,
        WorkLane,
    };
    use friday_storage::Db;

    #[derive(Debug, Clone)]
    pub struct PassportSpec {
        pub passport_id: String,
        pub mission_id: String,
        pub work_item_id: Option<String>,
        pub destination_lane: WorkLane,
        pub destination_target: Option<String>,
        pub items: Vec<PassportItem>,
        pub approved_sensitive: bool,
    }

    #[derive(Debug, Clone)]
    pub struct MintedPassport {
        pub passport_id: String,
        pub mission_id: String,
        pub work_item_id: Option<String>,
        pub destination_lane: WorkLane,
        pub destination_target: Option<String>,
        pub shared_item_count: usize,
        pub mission_ref_count: usize,
        pub link_id: String,
    }

    pub fn parse_lane(value: &str) -> Result<WorkLane, CliError> {
        match value {
            "friday_hub" => Ok(WorkLane::FridayHub),
            "codex" => Ok(WorkLane::Codex),
            "claude" => Ok(WorkLane::Claude),
            "deepseek" => Ok(WorkLane::DeepSeek),
            "workflow" => Ok(WorkLane::Workflow),
            "channel" => Ok(WorkLane::Channel),
            "human" => Ok(WorkLane::Human),
            "future_api" => Ok(WorkLane::FutureApi),
            other => Err(CliError::BadGrant(format!(
                "unknown destination lane {other:?}: expected one of \
                 friday_hub|codex|claude|deepseek|workflow|channel|human|future_api"
            ))),
        }
    }

    pub fn parse_item_kind(value: &str) -> Result<PassportItemKind, CliError> {
        match value {
            "memory_snippet" => Ok(PassportItemKind::MemorySnippet),
            "summary" => Ok(PassportItemKind::Summary),
            "file" => Ok(PassportItemKind::File),
            "screenshot" => Ok(PassportItemKind::Screenshot),
            "attachment" => Ok(PassportItemKind::Attachment),
            "provider_secret" => Ok(PassportItemKind::ProviderSecret), // pragma: allowlist secret
            "raw_token" => Ok(PassportItemKind::RawToken),
            other => Err(CliError::BadGrant(format!(
                "unknown passport item kind {other:?}: expected one of \
                 memory_snippet|summary|file|screenshot|attachment|provider_secret|raw_token"
            ))),
        }
    }

    pub fn open_hub(path: &str) -> Result<Db, CliError> {
        Db::open_hub(path).map_err(|_| CliError::OpenDb(path.to_string()))
    }

    pub fn mint(db: &Db, spec: &PassportSpec, now_ms: i64) -> Result<MintedPassport, CliError> {
        if spec.passport_id.trim().is_empty() {
            return Err(CliError::BadGrant(
                "passport_id must not be empty".to_string(),
            ));
        }
        if spec.mission_id.trim().is_empty() {
            return Err(CliError::BadGrant(
                "mission_id must not be empty".to_string(),
            ));
        }
        if spec.items.is_empty() {
            return Err(CliError::BadGrant(
                "context passport requires at least one item".to_string(),
            ));
        }

        let mut mission = db
            .get_mission(&spec.mission_id)
            .map_err(|e| CliError::Storage(e.to_string()))?
            .ok_or_else(|| {
                CliError::BadGrant(format!(
                    "mission {:?} not found; create/stage the Mission before minting a passport",
                    spec.mission_id
                ))
            })?;
        if let Some(work_item_id) = &spec.work_item_id {
            let work_item = db
                .get_work_item(work_item_id)
                .map_err(|e| CliError::Storage(e.to_string()))?
                .ok_or_else(|| {
                    CliError::BadGrant(format!(
                        "work item {work_item_id:?} not found; omit --work-item-id for a \
                         mission-scoped passport or stage the WorkItem first"
                    ))
                })?;
            if work_item.mission_id != spec.mission_id {
                return Err(CliError::BadGrant(format!(
                    "work item {work_item_id:?} belongs to mission {:?}, not {:?}",
                    work_item.mission_id, spec.mission_id
                )));
            }
        }

        let passport = build_context_passport(
            spec.passport_id.clone(),
            spec.mission_id.clone(),
            spec.work_item_id.clone(),
            spec.destination_lane,
            spec.destination_target.clone(),
            spec.items.clone(),
            spec.approved_sensitive,
            now_ms,
        )
        .map_err(|e| CliError::BadGrant(format!("context_passport_blocked:{e}")))?;

        let link_id = format!(
            "context-passport-{}-{}",
            ref_id_part(&spec.passport_id),
            now_ms
        );
        db.upsert_context_passport(&passport)
            .map_err(|e| CliError::Storage(e.to_string()))?;
        db.upsert_mission_link(&MissionLink {
            link_id: link_id.clone(),
            mission_id: spec.mission_id.clone(),
            work_item_id: spec.work_item_id.clone(),
            link_kind: MissionLinkKind::ContextPassport,
            target_ref: format!("friday://context-passport/{}", spec.passport_id),
            proof_ref: Some(spec.passport_id.clone()),
            created_at_ms: now_ms,
        })
        .map_err(|e| CliError::Storage(e.to_string()))?;
        push_unique(&mut mission.context_passport_refs, spec.passport_id.clone());
        mission.updated_at_ms = now_ms;
        db.upsert_mission(&mission)
            .map_err(|e| CliError::Storage(e.to_string()))?;

        Ok(MintedPassport {
            passport_id: spec.passport_id.clone(),
            mission_id: spec.mission_id.clone(),
            work_item_id: spec.work_item_id.clone(),
            destination_lane: spec.destination_lane,
            destination_target: spec.destination_target.clone(),
            shared_item_count: passport.shared_items().len(),
            mission_ref_count: mission.context_passport_refs.len(),
            link_id,
        })
    }

    fn push_unique(values: &mut Vec<String>, value: String) {
        if !values.iter().any(|existing| existing == &value) {
            values.push(value);
        }
    }

    fn ref_id_part(value: &str) -> String {
        value
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::verify_ed25519_approval;

    fn sample_request() -> PendingRequest {
        PendingRequest {
            approval_id: "ap-nonce-001".to_string(),
            // 64 lowercase hex chars
            action_digest: "a".repeat(64),
            expires_at: 1_900_000_000_000,
            decision: "approved".to_string(),
            issuer: None,
            principal: Some("owner:alice".to_string()),
            action: Some("fs.delete".to_string()),
            surface: Some("desktop".to_string()),
        }
    }

    fn sample_batch_request() -> PendingBatchRequest {
        PendingBatchRequest {
            batch_sign_id: "batch-d20-001".to_string(),
            action_digests: vec!["a".repeat(64), "b".repeat(64)],
            expires_at: 1_900_000_000_000,
            decision: "approved".to_string(),
            issuer: None,
            plan_label: Some("D20 reversible batch".to_string()),
            worktree: Some("/tmp/friday-worktree".to_string()),
        }
    }

    #[test]
    fn keygen_then_sign_verifies() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("operator.key");
        let _ = std::fs::remove_file(&key_path);

        let vk_hex = keygen_to_path(&key_path).unwrap();
        let req = sample_request();
        let signed = sign_request(&key_path, &req).unwrap();

        let decision = parse_decision(&signed.decision).unwrap();
        let bytes = canonical_bytes(
            decision,
            &signed.approval_id,
            &signed.action_digest,
            signed.expires_at,
            &signed.issuer,
        );
        let vk = decode_verifying_key_hex(&vk_hex).unwrap();
        let sig = decode_signature_hex(&signed.signature).unwrap();
        assert!(
            verify_ed25519_approval(&bytes, &vk, &sig),
            "operator-signed approval must verify under the keygen public key"
        );
        // Default issuer is the canonical gate issuer.
        assert_eq!(signed.issuer, CANONICAL_GATE_ISSUER);
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn sign_request_and_with_key_are_byte_identical() {
        // The file-sourced `sign_request` and the already-loaded-key
        // `sign_request_with_key` MUST produce the IDENTICAL signed approval for the
        // same key + request — i.e. the split is a pure refactor and any other key
        // source (e.g. a KEK-wrapped SecureStore seed) that routes through
        // `sign_request_with_key` signs the same canonical bytes the Hub verifies.
        let dir = std::env::temp_dir().join(format!("op-cli-unit-eq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("operator.key");
        let _ = std::fs::remove_file(&key_path);
        keygen_to_path(&key_path).unwrap();

        let req = sample_request();
        let from_file = sign_request(&key_path, &req).unwrap();
        let sk = read_signing_key(&key_path).unwrap();
        let from_key = sign_request_with_key(&sk, &req).unwrap();

        assert_eq!(from_file.signature, from_key.signature);
        assert_eq!(from_file.action_digest, from_key.action_digest);
        assert_eq!(from_file.approval_id, from_key.approval_id);
        assert_eq!(from_file.issuer, from_key.issuer);
        assert_eq!(from_file.decision, from_key.decision);
        assert_eq!(from_file.scheme, from_key.scheme);
        assert_eq!(from_file.expires_at, from_key.expires_at);
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn keygen_then_sign_batch_verifies() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-batch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("operator.key");
        let _ = std::fs::remove_file(&key_path);

        let vk_hex = keygen_to_path(&key_path).unwrap();
        let req = sample_batch_request();
        let signed = sign_batch_request(&key_path, &req).unwrap();

        let decision = parse_decision(&signed.decision).unwrap();
        let bytes = canonical_batch_bytes(
            decision,
            &signed.batch_sign_id,
            &signed.action_digests,
            signed.expires_at,
            &signed.issuer,
        );
        let vk = decode_verifying_key_hex(&vk_hex).unwrap();
        let sig = decode_signature_hex(&signed.signature).unwrap();
        assert!(
            verify_ed25519_approval(&bytes, &vk, &sig),
            "operator-signed batch must verify under the keygen public key"
        );
        assert_eq!(signed.issuer, CANONICAL_GATE_ISSUER);
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn sign_batch_request_and_with_key_are_byte_identical() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-batch-eq-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("operator.key");
        let _ = std::fs::remove_file(&key_path);
        keygen_to_path(&key_path).unwrap();

        let req = sample_batch_request();
        let from_file = sign_batch_request(&key_path, &req).unwrap();
        let sk = read_signing_key(&key_path).unwrap();
        let from_key = sign_batch_request_with_key(&sk, &req).unwrap();

        assert_eq!(from_file.signature, from_key.signature);
        assert_eq!(from_file.batch_sign_id, from_key.batch_sign_id);
        assert_eq!(from_file.action_digests, from_key.action_digests);
        assert_eq!(from_file.issuer, from_key.issuer);
        assert_eq!(from_file.decision, from_key.decision);
        assert_eq!(from_file.scheme, from_key.scheme);
        assert_eq!(from_file.expires_at, from_key.expires_at);
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn keygen_refuses_to_overwrite() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-ow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("operator.key");
        let _ = std::fs::remove_file(&key_path);
        keygen_to_path(&key_path).unwrap();
        let err = keygen_to_path(&key_path).unwrap_err();
        assert!(matches!(err, CliError::KeyFileExists));
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn bad_key_file_is_a_clean_error() {
        let dir = std::env::temp_dir().join(format!("op-cli-unit-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("garbage.key");
        std::fs::write(&key_path, b"not-a-valid-hex-seed").unwrap();
        let err = sign_request(&key_path, &sample_request()).unwrap_err();
        assert!(matches!(err, CliError::BadKeyFile));
        std::fs::remove_file(&key_path).ok();
    }

    #[test]
    fn malformed_fields_fail_closed() {
        assert!(parse_decision("maybe").is_err());
        assert!(validate_action_digest(&"A".repeat(64)).is_err()); // uppercase rejected
        assert!(validate_action_digest("abc").is_err()); // wrong length
        assert!(validate_action_digest(&"g".repeat(64)).is_err()); // non-hex
        assert!(validate_batch_digests(&[]).is_err());
        assert!(validate_batch_digests(&["a".repeat(64), "a".repeat(64)]).is_err());
    }
}
