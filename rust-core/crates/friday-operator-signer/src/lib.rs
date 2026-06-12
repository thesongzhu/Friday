//! Desktop operator-signing helper — library half (GATE-AGENT-REPLACE D3 key-custody
//! bridge, the operator-chosen **desktop helper** option of the A2 key-custody decision).
//!
//! ## Truth label — OPERATOR SIDE, ISOLATED key custody, dark, proof-only
//!
//! This is the OFFLINE OPERATOR signer, like the S6c CLI ([`friday_operator_cli`]), with
//! exactly ONE thing swapped: the PRIVATE Ed25519 signing seed is sourced from a
//! **KEK-wrapped [`SecureStore`] the Hub CANNOT open** (a 32-byte raw seed under a
//! namespaced id), instead of a plaintext hex file. The A2 design (decision 3c) chose this
//! desktop helper as the bridge for the first live S6-in-product proof precisely BECAUSE it
//! stays Ed25519-native — so the Hub's verify side (`OperatorVerifyingKey`) needs no scheme
//! change.
//!
//! ### ISOLATION (operator decision "isolate now"): the seed is NOT co-resident with the Hub
//!
//! A security audit found that sealing the operator seed under the Hub's OWN store KEK
//! (same `FILE_STORE_KEK_PURPOSE`, same `DEFAULT_STORE_DIR_REL`, same master key) WEAKENED
//! INV-6: the Hub process could derive that KEK via
//! `friday_hub::key_source::derive_file_store_kek(master)` and open the seed store. This
//! crate now seals the seed under a KEK the Hub's existing derivation CANNOT produce,
//! achieving true isolation even on one box, by stacking THREE independent separations.
//!
//! ### Unconditional + KAT-proven: the Hub's existing `derive_file_store_kek` cannot open it
//!
//!   1. **Distinct KEK purpose tag** — [`SIGNER_SEED_KEK_PURPOSE`] is byte-DIFFERENT from
//!      the Hub's `FILE_STORE_KEK_PURPOSE`, so the Hub's hardcoded `derive_file_store_kek`
//!      cannot produce the seed KEK **even if it were fed the signer master** (the inverted
//!      KAT proves exactly this worst case).
//!   2. **Distinct store directory** — [`SIGNER_STORE_DIR_REL`] is NOT the Hub's
//!      `DEFAULT_STORE_DIR_REL`, so the seed never lands in the store the Hub enrolls into.
//!
//! These two hold REGARDLESS of the master values; the inverted KAT
//! [`hub_kek_cannot_open_the_operator_signer_seed`] PROVES the Hub's `derive_file_store_kek`
//! cannot unwrap the seed (asserting both the runtime `get()` → `None` and the explicit
//! `try_get()` → `Err(Crypto(Open))`).
//!
//! ### Operational (default-true, NOT KAT-covered): hub-underivable even with NEW hub code
//!
//!   3. **Distinct master/secret source** — the signer's KEK is derived from a SEPARATE
//!      operator-only master ([`SIGNER_MASTER_ENV`] / [`signer_master_file`]), NOT the Hub's
//!      `FRIDAY_MASTER_KEY` / `~/.friday/master.key`. The Hub never reads this source.
//!
//! Separation (3) is what would let the seed KEK stay hub-*underivable* even against ADDED
//! hub code (not just the existing derivation): such code would still need the signer
//! master VALUE, which the Hub never holds. This property is CONDITIONAL on the signer
//! master value DIFFERING from the Hub's master — which the separate source/file provides by
//! DEFAULT (distinct env + distinct file, each provisioned by the operator out of band). It
//! is NOT KAT-covered (no test exercises a hypothetical hub that hashes
//! `SIGNER_SEED_KEK_PURPOSE` with the signer master) and it DOES degrade if the operator
//! deliberately points both masters at the same bytes. The unconditional guarantee above
//! does not depend on it.
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
//! seed bytes into a signer. With the ISOLATION above the seed is doubly safe: the Hub has
//! no `OperatorSigningKey` path to sign with AND cannot even open the store the seed lives
//! in. Only this separate operator-run helper, with the operator-only master, can.
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

/// Master-key width in bytes. The signer's master is a SEPARATE 32-byte secret from the
/// Hub's (see [`SIGNER_MASTER_ENV`]); the width matches because both are 32-byte keys, but
/// the VALUE differs and the Hub never reads the signer's source.
pub const MASTER_KEY_LEN: usize = 32;

/// The `SecureStore` id under which the operator provisions their 32-byte RAW Ed25519
/// **signing seed**. Namespaced so it can NEVER collide with the verify-key id
/// (`friday_hub::operator_vk::OPERATOR_VK_SECURE_STORE_ID`), the KEK, or the peer-pubkey
/// allowlist (`friday_hub::key_source::PEER_PUBKEY_ALLOWLIST_ID`). The seed is the SECRET
/// half; it lives ONLY with the operator (this store, on the operator's machine), never on
/// the Hub.
pub const OPERATOR_SIGNING_SEED_SECURE_STORE_ID: &str =
    "friday.operator.approval.signing_seed.ed25519";

/// Env var carrying the hex-encoded **operator-signer master key** (highest-priority
/// source). DELIBERATELY DISTINCT from the Hub's `friday_hub::key_source::MASTER_KEY_ENV`
/// (`FRIDAY_MASTER_KEY`): this is the operator-only secret that derives the seed-store KEK.
/// The Hub process never reads this var. When its VALUE also differs from the Hub's master
/// (the default — a separate env/file the operator provisions out of band), the seed KEK
/// stays hub-underivable even against ADDED hub code, since such code would still lack the
/// signer master value. (The unconditional, KAT-proven isolation from the distinct purpose
/// tag + store dir does not depend on this.)
pub const SIGNER_MASTER_ENV: &str = "FRIDAY_OPERATOR_SIGNER_MASTER"; // pragma: allowlist secret

/// Path of the persisted **operator-signer master key** file RELATIVE to `$HOME`.
/// DELIBERATELY DISTINCT from the Hub's `~/.friday/master.key` so the two masters never
/// collide on disk. The Hub's `key_source` reads ONLY `~/.friday/master.key`; it never
/// reads this file — so even a Hub running as the same user, reading its own configured
/// sources, never obtains the signer master. (A missing source ⇒ fail-closed
/// `MasterKeyMissing`; the helper NEVER auto-generates a master.)
const SIGNER_MASTER_FILE_REL: &str = ".friday/operator-signer.key";

/// The signer's `FileSecureStore` directory RELATIVE to `$HOME`. DELIBERATELY DISTINCT from
/// `friday_hub::key_source::default_store_dir`'s `DEFAULT_STORE_DIR_REL`
/// (`~/.friday/agent-run-securestore`) so the operator seed NEVER lands in the store the Hub
/// enrolls into. The inverted KAT asserts `signer::default_store_dir() !=
/// friday_hub::key_source::default_store_dir()`.
const SIGNER_STORE_DIR_REL: &str = ".friday/operator-signer-securestore";

/// Domain-separation tag for the signer's seed-store KEK derivation. DELIBERATELY
/// BYTE-DIFFERENT from `friday_hub::key_source`'s `FILE_STORE_KEK_PURPOSE`
/// (`b"friday.rust.securestore.file.kek.v1"`), so the Hub's hardcoded `derive_file_store_kek`
/// CANNOT produce this KEK even if it were somehow fed the signer master. Pinned by the
/// inverted KAT (`hub_kek_cannot_open_the_operator_signer_seed`): a seed sealed under the
/// signer's KEK is UNOPENABLE under the Hub's KEK derivation (different tag AND, in practice,
/// a different master).
const SIGNER_SEED_KEK_PURPOSE: &[u8] = b"friday.operator.signer.seed.kek.v1"; // pragma: allowlist secret

/// A fail-closed error. **Carries no key bytes, no master key, no seed, no plaintext** —
/// only a structural category — so it is always safe to surface/log. The seed/master are
/// the secrets; they never appear in any variant.
#[derive(Debug, Error)]
pub enum SignerError {
    /// `$HOME` is unset and no explicit store dir / master path was given, so the default
    /// `~/.friday/...` locations cannot be resolved.
    #[error("HOME is not set; pass --store-dir and a master key explicitly")]
    HomeUnset,
    /// Neither `FRIDAY_OPERATOR_SIGNER_MASTER` nor `~/.friday/operator-signer.key` is
    /// present. FAIL CLOSED — the helper NEVER auto-generates a master key (the operator must
    /// provision their isolated signer master out of band).
    #[error(
        "no signer master: set FRIDAY_OPERATOR_SIGNER_MASTER (hex) or provision ~/.friday/operator-signer.key"
    )]
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

/// The signer's `FileSecureStore` directory (`~/.friday/operator-signer-securestore`),
/// DELIBERATELY DISTINCT from the Hub's `default_store_dir`
/// (`~/.friday/agent-run-securestore`) so the operator seed is never co-resident with the
/// Hub's store.
pub fn default_store_dir() -> Result<std::path::PathBuf, SignerError> {
    home_relative(SIGNER_STORE_DIR_REL)
}

/// The `$HOME`-relative path of the operator-signer master key file. Exposed (test-visible)
/// only to assert it differs from the Hub's master path; the file CONTENT is never read by
/// the Hub.
pub fn signer_master_file() -> Result<std::path::PathBuf, SignerError> {
    home_relative(SIGNER_MASTER_FILE_REL)
}

/// Read the 32-byte **operator-signer** master key, FAIL-CLOSED. This is the OPERATOR-ONLY
/// secret that derives the seed-store KEK; it is DISTINCT from the Hub's master and the Hub
/// never reads either of these sources:
///   1. `FRIDAY_OPERATOR_SIGNER_MASTER` env (hex), if non-empty.
///   2. `~/.friday/operator-signer.key` (bytes -> UTF-8 -> trim -> hex-decode).
///   3. Neither present -> [`SignerError::MasterKeyMissing`]. NEVER creates the file.
///
/// The returned key is wrapped so it is wiped on drop; it never appears in any error.
fn read_master_key() -> Result<MasterKey, SignerError> {
    if let Some(env_val) = std::env::var_os(SIGNER_MASTER_ENV) {
        let env_str = env_val.to_string_lossy();
        if !env_str.is_empty() {
            return decode_master_hex(&env_str)
                .map(MasterKey)
                .ok_or(SignerError::MasterKeyMalformed);
        }
    }
    let path = home_relative(SIGNER_MASTER_FILE_REL)?;
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

/// Derive the SIGNER's seed-store KEK from the **signer master key**:
/// `Kek::from_bytes(sha256(SIGNER_SEED_KEK_PURPOSE || master))`.
///
/// DELIBERATELY NOT byte-identical to `friday_hub::key_source::derive_file_store_kek`: the
/// purpose tag differs ([`SIGNER_SEED_KEK_PURPOSE`] vs the Hub's `FILE_STORE_KEK_PURPOSE`)
/// AND the master differs (the operator-only [`SIGNER_MASTER_ENV`]). The inverted KAT
/// `hub_kek_cannot_open_the_operator_signer_seed` proves the Hub's derivation cannot open a
/// store sealed under this KEK — true isolation even on one box.
fn derive_signer_seed_kek(master: &[u8; MASTER_KEY_LEN]) -> Kek {
    let mut hasher = Sha256::new();
    hasher.update(SIGNER_SEED_KEK_PURPOSE);
    hasher.update(master);
    let digest = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    Kek::from_bytes(bytes)
}

/// Load the operator's PRIVATE [`OperatorSigningKey`] from the ISOLATED KEK-wrapped
/// SecureStore at `store_dir`, using the OPERATOR-ONLY signer master key (the one the Hub
/// never reads) to derive the seed KEK. The 32 raw seed bytes are read from
/// [`OPERATOR_SIGNING_SEED_SECURE_STORE_ID`], built into a signing key, then the transient
/// seed buffer is zeroized.
///
/// Fail-closed: a missing master key, an unreadable store, an absent/unreadable seed entry,
/// or a wrong-length seed each return an `Err` and the helper signs nothing. The seed bytes
/// never appear in any error or log.
pub fn load_signing_key_from_store(
    store_dir: &std::path::Path,
) -> Result<OperatorSigningKey, SignerError> {
    let master = read_master_key()?;
    let kek = derive_signer_seed_kek(&master.0);
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
/// under the ISOLATED **signer-master-derived KEK** (a KEK the Hub cannot derive). OPERATOR-
/// side only — the operator puts their seed into the isolated KEK-wrapped store the helper
/// later reads. The seed bytes are wiped from the caller-supplied slice's responsibility
/// (this fn does not retain them); the value the SecureStore seals is the secret.
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
    let kek = derive_signer_seed_kek(&master.0);
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

    /// The operator-signer master used in the KATs (all 0x42). This is the SIGNER's master;
    /// it is what `read_master_key()` reads from `SIGNER_MASTER_ENV` in these tests.
    const KAT_MASTER: [u8; MASTER_KEY_LEN] = [0x42u8; MASTER_KEY_LEN];

    /// Seal the seed into a store at `dir` under the SIGNER's real seed-store KEK derivation
    /// (the SAME `derive_signer_seed_kek` the helper uses). This replaces the previous tests'
    /// habit of sealing under `friday_hub::key_source::derive_file_store_kek` — which is now
    /// exactly the derivation the seed must be UNopenable under.
    fn seal_seed_under_signer_kek(
        dir: &std::path::Path,
        master: &[u8; MASTER_KEY_LEN],
        seed: &[u8],
    ) {
        let kek = derive_signer_seed_kek(master);
        let mut s = FileSecureStore::open(dir, kek).unwrap();
        s.try_put(OPERATOR_SIGNING_SEED_SECURE_STORE_ID, seed)
            .unwrap();
    }

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

    /// INVERTED LOAD-BEARING KAT (the isolation smoking gun): the Hub's KEK derivation
    /// (`friday_hub::key_source::derive_file_store_kek`) MUST NOT be able to open a store the
    /// signer sealed the operator seed into. This is the EXACT OPPOSITE of the old
    /// `kek_derivation_matches_the_ws_server`, which proved the two KEKs were the same (the
    /// INV-6-weakening co-residency the audit flagged).
    ///
    /// We isolate the right variable: we give the Hub derivation BOTH masters it could
    /// plausibly hold — its OWN master AND (worst case) the signer master — and prove that in
    /// EITHER case its `derive_file_store_kek` (which hardcodes the Hub's `FILE_STORE_KEK_PURPOSE`)
    /// cannot unwrap the seed. The seed is sealed under the signer's real
    /// `derive_signer_seed_kek` (distinct purpose tag + operator-only master).
    ///
    /// `FileSecureStore::open` with a wrong KEK SUCCEEDS to open the dir, but the per-entry
    /// DataKey unwrap then fails the AEAD. We assert BOTH faces of that failure:
    ///   * the runtime-relevant infallible `SecureStore::get` (the method the Hub actually
    ///     calls through the trait) FAIL-CLOSES to `None` — the Hub sees NO seed; and
    ///   * the explicit `try_get` surfaces `Err(Crypto(Open))` — a cryptographic REFUSAL, not
    ///     a merely-absent entry — so the failure is unambiguously "could not decrypt", which
    ///     is the whole isolation claim.
    #[test]
    fn hub_kek_cannot_open_the_operator_signer_seed() {
        use friday_crypto::{CryptoError, FileStoreError};

        let td = TempDir::new("isolation");
        let dir = td.child("store");
        // The operator seals the seed under the SIGNER's KEK (signer master + distinct tag).
        let signer_master = KAT_MASTER;
        seal_seed_under_signer_kek(&dir, &signer_master, &[0x07u8; SIGNING_SEED_LEN]);

        // (1) The Hub holds its OWN master (which is a DIFFERENT secret from the signer's).
        //     Even if that master happened to equal the signer's (it does NOT in prod), the
        //     Hub's derivation uses a DIFFERENT purpose tag → a different KEK → cannot open.
        let hub_master = [0xABu8; MASTER_KEY_LEN];
        let hub_kek_own = friday_hub::key_source::derive_file_store_kek(&hub_master);
        let s_own = FileSecureStore::open(&dir, hub_kek_own).unwrap();
        // Runtime path: the infallible trait read fail-closes to None (the Hub sees no seed).
        assert_eq!(
            SecureStore::get(&s_own, OPERATOR_SIGNING_SEED_SECURE_STORE_ID),
            None,
            "the Hub's KEK (its own master) MUST NOT open the operator-signer seed store"
        );
        // Explicit path: the failure is a cryptographic OPEN failure (could not decrypt),
        // proving the Hub's KEK genuinely cannot unwrap the seed — not that it is absent.
        assert!(
            matches!(
                s_own.try_get(OPERATOR_SIGNING_SEED_SECURE_STORE_ID),
                Err(FileStoreError::Crypto(CryptoError::Open))
            ),
            "the Hub's KEK must FAIL the AEAD unwrap (Crypto(Open)), not find an absent entry"
        );

        // (2) WORST CASE — even if the Hub were somehow fed the SIGNER's master, its hardcoded
        //     `FILE_STORE_KEK_PURPOSE` (!= SIGNER_SEED_KEK_PURPOSE) yields a different KEK that
        //     STILL cannot open the seed. This isolates the PURPOSE-TAG separation specifically
        //     (so the test cannot pass merely because the masters differ — that is already
        //     covered by `wrong_master_key_fails_closed`).
        let hub_kek_signer_master = friday_hub::key_source::derive_file_store_kek(&signer_master);
        let s_worst = FileSecureStore::open(&dir, hub_kek_signer_master).unwrap();
        assert_eq!(
            SecureStore::get(&s_worst, OPERATOR_SIGNING_SEED_SECURE_STORE_ID),
            None,
            "even fed the SIGNER master, the Hub's distinct-purpose-tag KEK MUST NOT open the seed"
        );
        assert!(
            matches!(
                s_worst.try_get(OPERATOR_SIGNING_SEED_SECURE_STORE_ID),
                Err(FileStoreError::Crypto(CryptoError::Open))
            ),
            "fed the SIGNER master, the Hub's distinct-tag KEK must still FAIL the AEAD unwrap"
        );

        // (3) Positive control: the SIGNER's own KEK (same master + tag) DOES open it, proving
        //     the seed really is there and (1)/(2) failed for the RIGHT reason (wrong KEK),
        //     not because the store was empty.
        let signer_kek = derive_signer_seed_kek(&signer_master);
        let s_ok = FileSecureStore::open(&dir, signer_kek).unwrap();
        assert_eq!(
            s_ok.try_get(OPERATOR_SIGNING_SEED_SECURE_STORE_ID)
                .unwrap()
                .as_deref(),
            Some(&[0x07u8; SIGNING_SEED_LEN][..]),
            "the signer's own KEK must open the seed (control: the seed is present)"
        );
    }

    /// STRUCTURAL ISOLATION: the signer's default store directory MUST differ from the Hub's,
    /// so the operator seed is never co-resident with the Hub's enrolled store. (Uses the Hub's
    /// PUBLIC `default_store_dir`; `DEFAULT_STORE_DIR_REL` is private there.)
    #[test]
    fn signer_store_dir_differs_from_hub_store_dir() {
        // Both resolve `$HOME`-relative; run under a fixed HOME so the assertion is about the
        // RELATIVE component, not a transient env.
        with_home_env("/tmp/friday-isolation-home", || {
            let signer = default_store_dir().unwrap();
            let hub = friday_hub::key_source::default_store_dir().unwrap();
            assert_ne!(
                signer, hub,
                "the operator-signer store dir must NOT equal the Hub's default store dir"
            );
            // And the master sources differ too.
            let signer_master_path = signer_master_file().unwrap();
            assert!(
                signer_master_path.ends_with(".friday/operator-signer.key"),
                "the signer master file must be the isolated operator-signer.key, not the Hub's master.key"
            );
        });
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

        // Provision under a known signer master (KAT_MASTER) by sealing with the SIGNER's KEK.
        seal_seed_under_signer_kek(&dir, &KAT_MASTER, &seed);

        // The helper loads the seed from the store (signer master via env) and signs.
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
        // Create the store dir (with the right signer KEK) but provision NO seed.
        {
            let kek = derive_signer_seed_kek(&KAT_MASTER);
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
        seal_seed_under_signer_kek(&dir, &KAT_MASTER, &[0x01u8; 16]); // too short
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
        // Provision under signer master A.
        let master_a = [0x11u8; MASTER_KEY_LEN];
        seal_seed_under_signer_kek(&dir, &master_a, &[0x05u8; SIGNING_SEED_LEN]);
        // Try to load under signer master B (different KEK) → fail closed.
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

    /// A single process-global env lock shared by EVERY env-mutating test helper in this
    /// module (`with_master_env` + `with_home_env`), so two of them can never race on env
    /// (which is UB) regardless of which threads cargo runs them on.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::Mutex;
        static ENV_LOCK: Mutex<()> = Mutex::new(());
        ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Run `f` with the SIGNER master env (`FRIDAY_OPERATOR_SIGNER_MASTER`) set to the hex of
    /// `master`, restoring the prior env afterward. (The helper reads the SIGNER master, NOT
    /// the Hub's `FRIDAY_MASTER_KEY`.) Serialized under the shared [`env_lock`].
    fn with_master_env<T>(master: &[u8; MASTER_KEY_LEN], f: impl FnOnce() -> T) -> T {
        let _guard = env_lock();
        let saved = std::env::var_os(SIGNER_MASTER_ENV);
        let hex: String = master.iter().map(|b| format!("{b:02x}")).collect();
        // SAFETY: serialized by the shared env lock; restored before the guard drops.
        unsafe {
            std::env::set_var(SIGNER_MASTER_ENV, &hex);
        }
        let out = f();
        unsafe {
            match saved {
                Some(v) => std::env::set_var(SIGNER_MASTER_ENV, v),
                None => std::env::remove_var(SIGNER_MASTER_ENV),
            }
        }
        out
    }

    /// Run `f` with `HOME` set to `home`, restoring the prior value afterward. Serialized
    /// under the shared [`env_lock`] (HOME is process-global like the master env).
    fn with_home_env<T>(home: &str, f: impl FnOnce() -> T) -> T {
        let _guard = env_lock();
        let saved = std::env::var_os("HOME");
        // SAFETY: serialized by the shared env lock; restored before the guard drops.
        unsafe {
            std::env::set_var("HOME", home);
        }
        let out = f();
        unsafe {
            match saved {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
        out
    }
}
