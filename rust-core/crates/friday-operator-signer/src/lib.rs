//! Desktop operator-signing helper — library half (GATE-AGENT-REPLACE D3 key-custody
//! bridge, the operator-chosen **desktop helper** option of the A2 key-custody decision).
//!
//! ## Truth label — OPERATOR SIDE, dark, proof-only
//!
//! This is the OFFLINE OPERATOR signer, like the S6c CLI ([`friday_operator_cli`]), with
//! exactly ONE thing swapped: the PRIVATE Ed25519 signing seed is sourced from the
//! **KEK-wrapped [`SecureStore`] the WS server already uses** (a 32-byte raw seed under a
//! namespaced id), instead of a plaintext hex file. The A2 design (decision 3c) chose this
//! desktop helper as the bridge for the first live S6-in-product proof precisely BECAUSE it
//! reuses the existing KEK plumbing and stays Ed25519-native — so the Hub's verify side
//! (`OperatorVerifyingKey`) needs no scheme change.
//!
//! It loads the seed, builds an [`OperatorSigningKey`], and produces an Ed25519
//! [`SignedApproval`] over the Hub-computed canonical action bytes — EXACTLY what
//! `friday_hub::resume::resume_with_approval` verifies. It NEVER mints out of thin air: it
//! signs the digest the Hub already computed (carried in the pending request), the operator
//! reviews the human-readable context, and the bytes are produced by the SAME
//! [`friday_operator_cli::sign_request_with_key`] path the file-based CLI uses, so the bytes
//! are byte-identical to what the Hub recomputes at verify time.
//!
//! ## Why the Hub holds only the verify key still holds (INV-1 / INV-6)
//!
//! This crate is the OPERATOR side. It deliberately depends on `friday-core` +
//! `friday-crypto` + `friday-operator-cli` and NEVER on `friday-hub` at runtime — the Hub
//! crate holds ONLY [`friday_crypto::OperatorVerifyingKey`] and (by the structural
//! `hub_crate_never_references_a_signing_key` test) contains NO code that turns the stored
//! seed bytes into a signer. The seed living in the KEK-wrapped SecureStore is safe FOR
//! THAT REASON: the Hub can read the bytes but has no `OperatorSigningKey` path to sign
//! with them; only this separate operator-run helper does.
//!
//! ## NEVER auto-invoked
//!
//! This helper is the operator's signer; it runs on the OPERATOR's machine, attended, and
//! is NEVER invoked automatically by the hub or any coordinator process. There is no
//! production route, no scheduler hook, no in-process caller — it is a one-shot CLI the
//! operator runs by hand to approve ONE specific paused mutation. PROOF-ONLY; NOT v1 GO.

use friday_core::gate::ApprovalDecision;
use friday_crypto::{FileSecureStore, Kek, OperatorSigningKey, SecureStore};
use friday_operator_cli::{sign_request_with_key, CliError, PendingRequest, SignedApproval};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroize;

/// Length of the operator's Ed25519 secret seed, in raw bytes (the value stored under
/// [`OPERATOR_SIGNING_SEED_SECURE_STORE_ID`]).
pub const SIGNING_SEED_LEN: usize = 32;

/// Master-key width in bytes — MUST equal `friday_hub::key_source::MASTER_KEY_LEN`. The
/// dev-dep KAT pins the whole KEK derivation to the server's, so a divergence here is
/// caught at test time.
pub const MASTER_KEY_LEN: usize = 32;

/// The `SecureStore` id under which the operator provisions their 32-byte RAW Ed25519
/// **signing seed**. Namespaced so it can NEVER collide with the verify-key id
/// (`friday_hub::operator_vk::OPERATOR_VK_SECURE_STORE_ID`), the KEK, or the peer-pubkey
/// allowlist (`friday_hub::key_source::PEER_PUBKEY_ALLOWLIST_ID`). The seed is the SECRET
/// half; it lives ONLY with the operator (this store, on the operator's machine), never on
/// the Hub.
pub const OPERATOR_SIGNING_SEED_SECURE_STORE_ID: &str =
    "friday.operator.approval.signing_seed.ed25519";

/// Env var carrying the hex-encoded master key (highest-priority source). MUST match
/// `friday_hub::key_source::MASTER_KEY_ENV` — the helper derives the SAME KEK the server
/// boots from, so it opens the SAME `FileSecureStore`.
pub const MASTER_KEY_ENV: &str = "FRIDAY_MASTER_KEY"; // pragma: allowlist secret

/// Path of the persisted master key file RELATIVE to `$HOME`. MUST match
/// `friday_hub::key_source`'s `MASTER_KEY_FILE_REL` (private there; re-derived here as the
/// operator side). RESIDUAL: this constant is hand-copied, not pinned by a KAT — but any
/// drift is FAIL-CLOSED, not silent-wrong-key: a different file path yields a different
/// master ⇒ a different KEK ⇒ `get()` returns `None` ⇒ `SeedUnprovisioned` (the helper
/// refuses to sign), exactly as `wrong_master_key_fails_closed` proves. It can never make
/// the helper sign the wrong thing.
const MASTER_KEY_FILE_REL: &str = ".friday/master.key";

/// The default `FileSecureStore` directory RELATIVE to `$HOME`. MUST match
/// `friday_hub::key_source::default_store_dir`'s `DEFAULT_STORE_DIR_REL` so the helper
/// reads the SAME store the server enrolled into. RESIDUAL (fail-closed, as above): a wrong
/// dir simply finds no seed entry ⇒ `SeedUnprovisioned`, never a wrong signature.
const DEFAULT_STORE_DIR_REL: &str = ".friday/agent-run-securestore";

/// Domain-separation tag for the `FileSecureStore` KEK derivation. MUST be byte-identical
/// to `friday_hub::key_source`'s `FILE_STORE_KEK_PURPOSE` (private there) so the derived
/// KEK opens the SAME store. This one IS pinned: a round-trip KAT
/// (`kek_derivation_matches_the_ws_server`) seals under the server's KEK and opens under
/// ours (Kek has no `Eq`), so a divergence is caught at test time. (And even unpinned it
/// would be fail-closed: a wrong tag ⇒ wrong KEK ⇒ `None` ⇒ `SeedUnprovisioned`.)
const FILE_STORE_KEK_PURPOSE: &[u8] = b"friday.rust.securestore.file.kek.v1";

/// A fail-closed error. **Carries no key bytes, no master key, no seed, no plaintext** —
/// only a structural category — so it is always safe to surface/log. The seed/master are
/// the secrets; they never appear in any variant.
#[derive(Debug, Error)]
pub enum SignerError {
    /// `$HOME` is unset and no explicit store dir / master path was given, so the default
    /// `~/.friday/...` locations cannot be resolved.
    #[error("HOME is not set; pass --store-dir and a master key explicitly")]
    HomeUnset,
    /// Neither `FRIDAY_MASTER_KEY` nor `~/.friday/master.key` is present. FAIL CLOSED — the
    /// helper NEVER auto-generates a master key (it must match the host's existing one).
    #[error("no master key: set FRIDAY_MASTER_KEY (hex) or provision ~/.friday/master.key")]
    MasterKeyMissing,
    /// The master key source was present but not valid 32-byte hex.
    #[error("master key is malformed (expected 64 hex chars = 32 bytes)")]
    MasterKeyMalformed,
    /// The SecureStore could not be opened (path/permissions). No secret content.
    #[error("secure store is unavailable")]
    StoreUnavailable,
    /// No operator signing seed is provisioned in the SecureStore under
    /// [`OPERATOR_SIGNING_SEED_SECURE_STORE_ID`] (absent, or present-but-unreadable —
    /// the fail-closed `SecureStore::get` collapses both to absent). FAIL CLOSED: with no
    /// operator key the helper signs NOTHING.
    #[error("operator signing seed is not provisioned in the secure store")]
    SeedUnprovisioned,
    /// The provisioned seed is not exactly [`SIGNING_SEED_LEN`] raw bytes.
    #[error("operator signing seed is malformed (expected 32 raw bytes)")]
    SeedMalformed,
    /// The pending request was malformed (bad decision / digest / approval_id / expiry).
    /// Wraps the S6c CLI's secret-free validation error.
    #[error("invalid pending request: {0}")]
    BadRequest(#[from] CliError),
}

/// Decode a 64-char hex string into exactly [`MASTER_KEY_LEN`] bytes. `None` for any
/// non-hex / odd-length / wrong-length input (fail-closed; never panics).
fn decode_master_hex(s: &str) -> Option<[u8; MASTER_KEY_LEN]> {
    let b = s.trim().as_bytes();
    if b.len() != MASTER_KEY_LEN * 2 {
        return None;
    }
    let mut out = [0u8; MASTER_KEY_LEN];
    for (i, pair) in b.chunks_exact(2).enumerate() {
        out[i] = (hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?;
    }
    Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `$HOME`-relative path, or [`SignerError::HomeUnset`] when `$HOME` is unset.
fn home_relative(rel: &str) -> Result<std::path::PathBuf, SignerError> {
    let home = std::env::var_os("HOME").ok_or(SignerError::HomeUnset)?;
    if home.is_empty() {
        return Err(SignerError::HomeUnset);
    }
    Ok(std::path::Path::new(&home).join(rel))
}

/// The default `FileSecureStore` directory (`~/.friday/agent-run-securestore`), matching
/// the WS server's `default_store_dir`.
pub fn default_store_dir() -> Result<std::path::PathBuf, SignerError> {
    home_relative(DEFAULT_STORE_DIR_REL)
}

/// Read the 32-byte master key, FAIL-CLOSED, mirroring the WS server's
/// `friday_hub::key_source::read_master_key` SOURCE order MINUS auto-generation:
///   1. `FRIDAY_MASTER_KEY` env (hex), if non-empty.
///   2. `~/.friday/master.key` (bytes -> UTF-8 -> trim -> hex-decode).
///   3. Neither present -> [`SignerError::MasterKeyMissing`]. NEVER creates the file.
///
/// The returned key is wrapped so it is wiped on drop; it never appears in any error.
fn read_master_key() -> Result<MasterKey, SignerError> {
    if let Some(env_val) = std::env::var_os(MASTER_KEY_ENV) {
        let env_str = env_val.to_string_lossy();
        if !env_str.is_empty() {
            return decode_master_hex(&env_str)
                .map(MasterKey)
                .ok_or(SignerError::MasterKeyMalformed);
        }
    }
    let path = home_relative(MASTER_KEY_FILE_REL)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            decode_master_hex(text.trim())
                .map(MasterKey)
                .ok_or(SignerError::MasterKeyMalformed)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(SignerError::MasterKeyMissing),
        // Any other IO error (e.g. EACCES on a present-but-unreadable file) is reported as
        // a malformed-source failure (secret-free), never silently "missing".
        Err(_) => Err(SignerError::MasterKeyMalformed),
    }
}

/// A master key that wipes its bytes on drop. The bytes are secret (they derive the KEK
/// that unwraps the signing seed); they are never printed, logged, or returned.
struct MasterKey([u8; MASTER_KEY_LEN]);

impl Drop for MasterKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Derive the `FileSecureStore` KEK from the master key:
/// `Kek::from_bytes(sha256(FILE_STORE_KEK_PURPOSE || master))`.
///
/// Byte-identical to `friday_hub::key_source::derive_file_store_kek` (pinned by the
/// dev-dep round-trip KAT in this crate's tests), so a store the WS server opens and a
/// store this helper opens use the SAME KEK and thus see the SAME entries.
fn derive_file_store_kek(master: &[u8; MASTER_KEY_LEN]) -> Kek {
    let mut hasher = Sha256::new();
    hasher.update(FILE_STORE_KEK_PURPOSE);
    hasher.update(master);
    let digest = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    Kek::from_bytes(bytes)
}

/// Load the operator's PRIVATE [`OperatorSigningKey`] from the KEK-wrapped SecureStore at
/// `store_dir`, using the host master key to derive the KEK. The 32 raw seed bytes are
/// read from [`OPERATOR_SIGNING_SEED_SECURE_STORE_ID`], built into a signing key, then the
/// transient seed buffer is zeroized.
///
/// Fail-closed: a missing master key, an unreadable store, an absent/unreadable seed entry,
/// or a wrong-length seed each return an `Err` and the helper signs nothing. The seed bytes
/// never appear in any error or log.
pub fn load_signing_key_from_store(
    store_dir: &std::path::Path,
) -> Result<OperatorSigningKey, SignerError> {
    let master = read_master_key()?;
    let kek = derive_file_store_kek(&master.0);
    drop(master); // wipe the master key as soon as the KEK is derived.

    let store = FileSecureStore::open(store_dir, kek).map_err(|_| SignerError::StoreUnavailable)?;
    // Fail-closed read: `SecureStore::get` collapses absent AND present-but-unreadable
    // (wrong KEK / tampered / malformed) to `None` — either way there is no operator key
    // and the helper refuses to sign.
    let mut seed_bytes = store
        .get(OPERATOR_SIGNING_SEED_SECURE_STORE_ID)
        .ok_or(SignerError::SeedUnprovisioned)?;

    // `mut` so the ORIGINAL binding is zeroized below (a shadowing `let mut x = x` would
    // COPY the `[u8; 32]` (it is `Copy`) and leave the original live + un-wiped).
    let mut seed_arr: [u8; SIGNING_SEED_LEN] = match seed_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => {
            seed_bytes.zeroize();
            return Err(SignerError::SeedMalformed);
        }
    };
    let sk = OperatorSigningKey::from_seed_bytes(&seed_arr);
    // Wipe the secret seed: the stack array we decoded AND the heap buffer it came from.
    // (`from_seed_bytes` copied the seed into the key, which zeroizes on drop.)
    seed_arr.zeroize();
    seed_bytes.zeroize();
    Ok(sk)
}

/// End-to-end: load the operator signing key from the SecureStore at `store_dir` and
/// produce an Ed25519 [`SignedApproval`] over the pending request's canonical bytes.
///
/// The signature is produced by [`friday_operator_cli::sign_request_with_key`] — the SAME
/// byte-producing path the file-based S6c CLI uses — so it is byte-identical to what the
/// Hub recomputes at verify time (`friday_hub::resume::resume_with_approval` ->
/// `authorize_mutating_action_ed25519` -> `canonical_approval_signature_bytes`). The
/// operator owns the digest semantics: the request's `action_digest` is the one the Hub
/// already computed and persisted; this helper only signs it.
pub fn sign_pending_from_store(
    store_dir: &std::path::Path,
    req: &PendingRequest,
) -> Result<SignedApproval, SignerError> {
    let sk = load_signing_key_from_store(store_dir)?;
    Ok(sign_request_with_key(&sk, req)?)
}

/// Provision (enroll) a 32-byte operator signing seed into the SecureStore at `store_dir`,
/// under the host master-key-derived KEK. OPERATOR-side only — used so the operator can put
/// their seed into the same KEK-wrapped store the helper later reads. The seed bytes are
/// wiped from the caller-supplied slice's responsibility (this fn does not retain them);
/// the value the SecureStore seals is the secret.
///
/// FAIL-CLOSED on a wrong-length seed (must be exactly [`SIGNING_SEED_LEN`]) so a truncated
/// seed is never enrolled. Returns `Ok(())` only after the entry is durably written.
pub fn provision_signing_seed_into_store(
    store_dir: &std::path::Path,
    seed: &[u8],
) -> Result<(), SignerError> {
    if seed.len() != SIGNING_SEED_LEN {
        return Err(SignerError::SeedMalformed);
    }
    let master = read_master_key()?;
    let kek = derive_file_store_kek(&master.0);
    drop(master);
    let mut store =
        FileSecureStore::open(store_dir, kek).map_err(|_| SignerError::StoreUnavailable)?;
    store
        .try_put(OPERATOR_SIGNING_SEED_SECURE_STORE_ID, seed)
        .map_err(|_| SignerError::StoreUnavailable)
}

/// Map a human decision string to the gate enum, for echoing the operator's choice in
/// context. Fail-closed: only the two exact spellings are accepted.
pub fn parse_decision(s: &str) -> Option<ApprovalDecision> {
    match s {
        "approved" => Some(ApprovalDecision::Approved),
        "denied" => Some(ApprovalDecision::Denied),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::OperatorVerifyingKey;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir {
        path: std::path::PathBuf,
    }
    impl TempDir {
        fn new(tag: &str) -> Self {
            static CTR: AtomicU64 = AtomicU64::new(0);
            let n = CTR.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "friday-operator-signer-test-{tag}-{}-{n}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
        fn child(&self, name: &str) -> std::path::PathBuf {
            self.path.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    const KAT_MASTER: [u8; MASTER_KEY_LEN] = [0x42u8; MASTER_KEY_LEN];

    fn sample_request(action_digest: &str) -> PendingRequest {
        PendingRequest {
            approval_id: "ap-nonce-signer-001".to_string(),
            action_digest: action_digest.to_string(),
            expires_at: 1_900_000_000_000,
            decision: "approved".to_string(),
            issuer: None,
            principal: Some("owner:operator".to_string()),
            action: Some("fs.write_file".to_string()),
            surface: Some("desktop".to_string()),
        }
    }

    /// LOAD-BEARING KAT: this crate's KEK derivation MUST be byte-identical to the WS
    /// server's (`friday_hub::key_source::derive_file_store_kek`). `Kek` has no `Eq`, so
    /// we prove equality by sealing under the SERVER's KEK and opening under OURS (and
    /// vice-versa) through a real `FileSecureStore`. A divergence here would mean the
    /// helper reads a DIFFERENT store than the server enrolled into — a silent
    /// fail-closed at the D3 proof.
    #[test]
    fn kek_derivation_matches_the_ws_server() {
        let td = TempDir::new("kek-parity");
        let dir = td.child("store");
        // Seal under the HUB/server's KEK derivation.
        {
            let server_kek = friday_hub::key_source::derive_file_store_kek(&KAT_MASTER);
            let mut s = FileSecureStore::open(&dir, server_kek).unwrap();
            s.try_put(
                OPERATOR_SIGNING_SEED_SECURE_STORE_ID,
                &[0x07u8; SIGNING_SEED_LEN],
            )
            .unwrap();
        }
        // Open under OUR KEK derivation — must read the same bytes.
        let our_kek = derive_file_store_kek(&KAT_MASTER);
        let s = FileSecureStore::open(&dir, our_kek).unwrap();
        assert_eq!(
            s.try_get(OPERATOR_SIGNING_SEED_SECURE_STORE_ID)
                .unwrap()
                .as_deref(),
            Some(&[0x07u8; SIGNING_SEED_LEN][..]),
            "the desktop signer's KEK must open a store the WS server sealed — a mismatch \
             means the helper reads a different store than the server enrolled into"
        );
        // And the symmetric direction: our seal opens under the server's KEK.
        let our_kek2 = derive_file_store_kek(&KAT_MASTER);
        let mut s2 = FileSecureStore::open(&dir, our_kek2).unwrap();
        s2.try_put(
            OPERATOR_SIGNING_SEED_SECURE_STORE_ID,
            &[0x09u8; SIGNING_SEED_LEN],
        )
        .unwrap();
        let server_kek2 = friday_hub::key_source::derive_file_store_kek(&KAT_MASTER);
        let s3 = FileSecureStore::open(&dir, server_kek2).unwrap();
        assert_eq!(
            s3.try_get(OPERATOR_SIGNING_SEED_SECURE_STORE_ID)
                .unwrap()
                .as_deref(),
            Some(&[0x09u8; SIGNING_SEED_LEN][..]),
        );
    }

    /// The seed id MUST be distinct from every other SecureStore id the system uses, so
    /// the signing seed can never collide with the verify key or the peer allowlist.
    #[test]
    fn signing_seed_id_is_distinct_from_other_secure_store_ids() {
        assert_ne!(
            OPERATOR_SIGNING_SEED_SECURE_STORE_ID,
            friday_hub::operator_vk::OPERATOR_VK_SECURE_STORE_ID
        );
        assert_ne!(
            OPERATOR_SIGNING_SEED_SECURE_STORE_ID,
            friday_hub::key_source::PEER_PUBKEY_ALLOWLIST_ID
        );
    }

    /// END-TO-END: provision a seed into the KEK-wrapped store, sign a pending request
    /// from it, and prove the emitted Ed25519 signature VERIFIES under the matching
    /// verify key over the EXACT canonical bytes — i.e. the Hub would accept it.
    #[test]
    fn store_sourced_signature_verifies_under_the_matching_verify_key() {
        use friday_core::gate::{CanonicalApproval, CANONICAL_GATE_ISSUER};
        let td = TempDir::new("e2e");
        let dir = td.child("store");

        // The operator generates a keypair off-Hub and provisions ONLY the private seed
        // into the KEK-wrapped store (the verify key would be provisioned into the Hub).
        let operator = OperatorSigningKey::generate();
        let vk = operator.verifying_key();
        let seed = operator.to_seed_bytes();

        // Provision under a known master (KAT_MASTER) by sealing with the server's KEK.
        {
            let kek = derive_file_store_kek(&KAT_MASTER);
            let mut s = FileSecureStore::open(&dir, kek).unwrap();
            s.try_put(OPERATOR_SIGNING_SEED_SECURE_STORE_ID, &seed)
                .unwrap();
        }

        // The helper loads the seed from the store (master via env) and signs.
        let digest = "b".repeat(64);
        let req = sample_request(&digest);
        let signed = with_master_env(&KAT_MASTER, || sign_pending_from_store(&dir, &req)).unwrap();

        // Reconstruct the EXACT bytes the Hub verifies over and check the signature.
        let approval = CanonicalApproval {
            decision: parse_decision(&signed.decision).unwrap(),
            approval_id: signed.approval_id.clone(),
            action_digest: signed.action_digest.clone(),
            expires_at: Some(signed.expires_at),
            issuer: Some(signed.issuer.clone()),
            signature: None,
        };
        let bytes = friday_core::gate::canonical_approval_signature_bytes(&approval);
        assert!(
            verify_signature(&bytes, &vk, &signed.signature),
            "the store-sourced signature must verify under the matching verify key over \
             the canonical approval bytes the Hub recomputes"
        );
        assert_eq!(signed.scheme, "ed25519");
        assert_eq!(signed.action_digest, digest);
        assert_eq!(signed.issuer, CANONICAL_GATE_ISSUER);
    }

    /// FAIL-CLOSED: an empty store (no seed provisioned) refuses to sign.
    #[test]
    fn unprovisioned_seed_fails_closed() {
        let td = TempDir::new("unprov");
        let dir = td.child("store");
        // Create the store dir (with the right KEK) but provision NO seed.
        {
            let kek = derive_file_store_kek(&KAT_MASTER);
            let _ = FileSecureStore::open(&dir, kek).unwrap();
        }
        let req = sample_request(&"c".repeat(64));
        let err = with_master_env(&KAT_MASTER, || sign_pending_from_store(&dir, &req)).unwrap_err();
        assert!(matches!(err, SignerError::SeedUnprovisioned));
    }

    /// FAIL-CLOSED: a wrong-length seed in the store is rejected (never built into a key).
    #[test]
    fn malformed_seed_fails_closed() {
        let td = TempDir::new("malformed");
        let dir = td.child("store");
        {
            let kek = derive_file_store_kek(&KAT_MASTER);
            let mut s = FileSecureStore::open(&dir, kek).unwrap();
            s.try_put(OPERATOR_SIGNING_SEED_SECURE_STORE_ID, &[0x01u8; 16]) // too short
                .unwrap();
        }
        // NB: `OperatorSigningKey` has no Debug (key bytes are never logged), so the Ok
        // arm cannot be unwrapped/printed — `matches!` the Err arm directly.
        let result = with_master_env(&KAT_MASTER, || load_signing_key_from_store(&dir));
        assert!(matches!(result, Err(SignerError::SeedMalformed)));
    }

    /// FAIL-CLOSED: a store opened under the WRONG master key (wrong KEK) cannot read the
    /// seed — the AEAD unwrap fails and `get` returns None → SeedUnprovisioned (never a
    /// silently-wrong key).
    #[test]
    fn wrong_master_key_fails_closed() {
        let td = TempDir::new("wrongkek");
        let dir = td.child("store");
        // Provision under master A.
        let master_a = [0x11u8; MASTER_KEY_LEN];
        {
            let kek = derive_file_store_kek(&master_a);
            let mut s = FileSecureStore::open(&dir, kek).unwrap();
            s.try_put(
                OPERATOR_SIGNING_SEED_SECURE_STORE_ID,
                &[0x05u8; SIGNING_SEED_LEN],
            )
            .unwrap();
        }
        // Try to load under master B (different KEK) → fail closed.
        let master_b = [0x22u8; MASTER_KEY_LEN];
        let result = with_master_env(&master_b, || load_signing_key_from_store(&dir));
        assert!(matches!(result, Err(SignerError::SeedUnprovisioned)));
    }

    #[test]
    fn provision_rejects_wrong_length_seed() {
        let td = TempDir::new("provlen");
        let dir = td.child("store");
        let err = with_master_env(&KAT_MASTER, || {
            provision_signing_seed_into_store(&dir, &[0u8; 31])
        })
        .unwrap_err();
        assert!(matches!(err, SignerError::SeedMalformed));
    }

    #[test]
    fn parse_decision_is_fail_closed() {
        assert_eq!(parse_decision("approved"), Some(ApprovalDecision::Approved));
        assert_eq!(parse_decision("denied"), Some(ApprovalDecision::Denied));
        assert_eq!(parse_decision("maybe"), None);
        assert_eq!(parse_decision(""), None);
    }

    fn verify_signature(bytes: &[u8], vk: &OperatorVerifyingKey, sig_hex: &str) -> bool {
        friday_crypto::verify_ed25519_approval_hex(bytes, &vk.to_bytes(), sig_hex)
    }

    /// Run `f` with `FRIDAY_MASTER_KEY` set to the hex of `master`, restoring the prior
    /// env afterward. These tests mutate process-global env, so they are serialized by
    /// running them all through this one helper under a single mutex.
    fn with_master_env<T>(master: &[u8; MASTER_KEY_LEN], f: impl FnOnce() -> T) -> T {
        use std::sync::Mutex;
        static ENV_LOCK: Mutex<()> = Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let saved = std::env::var_os(MASTER_KEY_ENV);
        let hex: String = master.iter().map(|b| format!("{b:02x}")).collect();
        // SAFETY: serialized by ENV_LOCK; restored before the guard drops.
        unsafe {
            std::env::set_var(MASTER_KEY_ENV, &hex);
        }
        let out = f();
        unsafe {
            match saved {
                Some(v) => std::env::set_var(MASTER_KEY_ENV, v),
                None => std::env::remove_var(MASTER_KEY_ENV),
            }
        }
        out
    }
}
