//! S6d — operator-controlled provisioning of the approval **verify** key.
//!
//! The linchpin of the asymmetric approval spine: the Hub authorizes a protected
//! (mutating) action against the operator's Ed25519 PUBLIC verify key
//! ([`friday_crypto::OperatorVerifyingKey`]). For that guarantee to mean anything, the
//! Hub MUST load that key from a source the OPERATOR controls — and MUST NOT be able to
//! generate, derive, or substitute its own keypair as the operator key. If it could, it
//! would sign with its own private key and verify with its own public key (full
//! self-mint), defeating the entire "the agent can never self-approve" property.
//!
//! ## The key-substitution defense (structural, not a runtime check)
//! This module only ever PARSES operator-supplied bytes via
//! [`friday_crypto::OperatorVerifyingKey::from_bytes`]. It never references
//! [`friday_crypto::OperatorSigningKey`] — there is no keygen here, so there is no path
//! by which the Hub produces the key it then verifies against. The provisioning input is
//! always external:
//!   - a 64-hex-char file the operator wrote from the S6c CLI `keygen` output
//!     ([`load_operator_vk_from_path`]), or
//!   - a 32-raw-byte entry the operator provisioned into OS secure storage
//!     ([`friday_crypto::SecureStore`], [`load_operator_vk_from_store`]).
//! A source-scan test ([`tests::hub_crate_never_references_a_signing_key`]) asserts the
//! whole `friday-hub` source tree contains no `OperatorSigningKey`, so the absence of a
//! mint path is enforced, not merely asserted in prose.
//!
//! ## Fail-closed when unprovisioned
//! "No operator key" is `Ok(None)` at the call site (the env / store / path is simply
//! absent) and the loop then treats every protected action as a Pause (DenyAll-
//! equivalent) — never an Allow. A source that IS configured but malformed is a hard
//! [`OperatorVkError`] (a clear failure), so a broken provisioning never silently
//! degrades to "no key" and the operator notices.
//!
//! Truth label: this is the load-from-operator-controlled-source MECHANISM. The KEY
//! VALUE itself is set by the operator at S6e (the key-custody gate). PROOF-ONLY; the
//! live mutating-completion proof with a real operator-held key is S6e. NOT v1 GO.

use std::path::Path;

use friday_crypto::ed25519_approval::VERIFYING_KEY_LEN;
use friday_crypto::{OperatorVerifyingKey, SecureStore};

/// The `SecureStore` id under which the operator provisions their 32-byte public verify
/// key (raw bytes). Namespaced so it cannot collide with KEK / pairing entries.
pub const OPERATOR_VK_SECURE_STORE_ID: &str = "friday.operator.approval.verify_key.ed25519";

/// The env var naming an operator-controlled FILE that holds the 64-hex public verify
/// key (the `keygen` stdout from the S6c CLI). UNSET ⇒ no operator key provisioned ⇒
/// fail-closed (protected actions Pause). SET-but-unreadable/malformed ⇒ a hard error.
pub const OPERATOR_VK_PATH_ENV: &str = "FRIDAY_OPERATOR_VK_PATH";

/// Why provisioning the operator verify key failed. Fail-closed: never substitutes a
/// Hub-generated key, never panics on malformed input. The error is deliberately coarse
/// (no bytes echoed) — the public key is not secret, but keeping errors content-free
/// matches the rest of the crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperatorVkError {
    /// The configured source file could not be read (absent/permissions/IO). Distinct
    /// from "no source configured" (which is `Ok(None)` at the call site, fail-closed).
    Read,
    /// The provisioned bytes are not a 32-byte hex string / not 32 raw bytes, or are not
    /// a valid Ed25519 public key point.
    Malformed,
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Decode a hex string into exactly [`VERIFYING_KEY_LEN`] bytes. `None` for any non-hex,
/// odd-length, or wrong-length input (fail-closed; never panics).
fn decode_vk_hex(s: &str) -> Option<[u8; VERIFYING_KEY_LEN]> {
    let b = s.trim().as_bytes();
    if b.len() != VERIFYING_KEY_LEN * 2 {
        return None;
    }
    let mut out = [0u8; VERIFYING_KEY_LEN];
    for (i, pair) in b.chunks_exact(2).enumerate() {
        out[i] = (hex_val(pair[0])? << 4) | hex_val(pair[1])?;
    }
    Some(out)
}

/// Parse a 32-byte verify key from raw bytes, failing closed for the wrong length or a
/// non-canonical Ed25519 point.
fn vk_from_raw(bytes: &[u8]) -> Result<OperatorVerifyingKey, OperatorVkError> {
    let arr: [u8; VERIFYING_KEY_LEN] = bytes.try_into().map_err(|_| OperatorVkError::Malformed)?;
    OperatorVerifyingKey::from_bytes(&arr).map_err(|_| OperatorVkError::Malformed)
}

/// Load the operator's PUBLIC verify key from an operator-controlled FILE holding the
/// 64-hex `keygen` output. The Hub only ever PARSES these bytes — it never generates a
/// keypair — so there is no path by which the Hub produces the key it verifies against.
///
/// Fail-closed: unreadable ⇒ [`OperatorVkError::Read`]; not 64-hex / not a valid Ed25519
/// point ⇒ [`OperatorVkError::Malformed`]. Never panics.
pub fn load_operator_vk_from_path(path: &Path) -> Result<OperatorVerifyingKey, OperatorVkError> {
    let contents = std::fs::read_to_string(path).map_err(|_| OperatorVkError::Read)?;
    let bytes = decode_vk_hex(&contents).ok_or(OperatorVkError::Malformed)?;
    OperatorVerifyingKey::from_bytes(&bytes).map_err(|_| OperatorVkError::Malformed)
}

/// Load the operator's PUBLIC verify key from an operator-provisioned [`SecureStore`]
/// entry (32 RAW bytes under [`OPERATOR_VK_SECURE_STORE_ID`]). Same structural guarantee
/// as the path loader: parse-only, never keygen.
///
/// `Ok(None)` when the entry is ABSENT (no operator key provisioned ⇒ fail-closed Pause).
/// `Err(Malformed)` when present but not a valid 32-byte Ed25519 public key.
pub fn load_operator_vk_from_store(
    store: &dyn SecureStore,
    id: &str,
) -> Result<Option<OperatorVerifyingKey>, OperatorVkError> {
    match store.get(id) {
        None => Ok(None),
        Some(bytes) => vk_from_raw(&bytes).map(Some),
    }
}

/// Resolve the operator verify key from the standard operator-controlled source: the
/// [`OPERATOR_VK_PATH_ENV`] file path.
///
/// - env UNSET ⇒ `Ok(None)` — NO operator key provisioned ⇒ the loop fail-closes
///   (protected actions Pause, never Allow).
/// - env SET ⇒ load the file; a read/parse failure is a hard `Err` (a clear failure, so a
///   broken provisioning never silently degrades to "no key").
///
/// This is the ONLY env read; it names a FILE the operator writes (the public key is not
/// secret, but it is operator-controlled), never the key bytes inline.
pub fn provision_operator_vk_from_env() -> Result<Option<OperatorVerifyingKey>, OperatorVkError> {
    match std::env::var(OPERATOR_VK_PATH_ENV) {
        Err(_) => Ok(None),
        Ok(path) if path.trim().is_empty() => Ok(None),
        Ok(path) => load_operator_vk_from_path(Path::new(path.trim())).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::{InMemorySecureStore, OperatorSigningKey};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "friday-operator-vk-{}-{}-{}",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn vk_hex(vk: &OperatorVerifyingKey) -> String {
        vk.to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    }

    #[test]
    fn round_trips_an_operator_keygen_public_key_from_a_file() {
        // The OPERATOR generates the keypair (off-Hub, here standing in for the S6c CLI)
        // and writes ONLY the public key hex. The Hub loads it back and it matches.
        let sk = OperatorSigningKey::generate();
        let vk = sk.verifying_key();
        let path = tmp("ok.vk");
        std::fs::write(&path, format!("{}\n", vk_hex(&vk))).unwrap();

        let loaded = load_operator_vk_from_path(&path).unwrap();
        assert_eq!(loaded.to_bytes(), vk.to_bytes());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_is_read_error_and_malformed_is_malformed() {
        // NB: `OperatorVerifyingKey` deliberately has no `Debug`/`PartialEq` (key bytes are
        // never logged/compared), so we `matches!` the error rather than `unwrap_err()`.
        assert!(matches!(
            load_operator_vk_from_path(&tmp("absent.vk")),
            Err(OperatorVkError::Read)
        ));
        let p = tmp("bad.vk");
        std::fs::write(&p, b"not-hex").unwrap();
        assert!(matches!(
            load_operator_vk_from_path(&p),
            Err(OperatorVkError::Malformed)
        ));
        // An HMAC-length (64-byte / 128-hex) value is NOT a 32-byte verify key ⇒ malformed.
        let p2 = tmp("len.vk");
        std::fs::write(&p2, "ab".repeat(64)).unwrap();
        assert!(matches!(
            load_operator_vk_from_path(&p2),
            Err(OperatorVkError::Malformed)
        ));
        std::fs::remove_file(&p).ok();
        std::fs::remove_file(&p2).ok();
    }

    #[test]
    fn secure_store_absent_is_none_present_round_trips() {
        let mut store = InMemorySecureStore::new();
        // Absent ⇒ None (fail-closed: no operator key provisioned).
        assert!(matches!(
            load_operator_vk_from_store(&store, OPERATOR_VK_SECURE_STORE_ID),
            Ok(None)
        ));
        // The operator provisions the 32 RAW public-key bytes.
        let vk = OperatorSigningKey::generate().verifying_key();
        store.put(OPERATOR_VK_SECURE_STORE_ID, &vk.to_bytes());
        let loaded = match load_operator_vk_from_store(&store, OPERATOR_VK_SECURE_STORE_ID) {
            Ok(Some(k)) => k,
            _ => panic!("a provisioned key must load"),
        };
        assert_eq!(loaded.to_bytes(), vk.to_bytes());
        // A malformed entry (wrong length) is a hard error, never silently None.
        store.put(OPERATOR_VK_SECURE_STORE_ID, b"too-short");
        assert!(matches!(
            load_operator_vk_from_store(&store, OPERATOR_VK_SECURE_STORE_ID),
            Err(OperatorVkError::Malformed)
        ));
    }

    /// NO-DEGRADE PROOF for the env wrapper the LIVE WS server (`hub_agent_run_server`)
    /// delegates to at boot. The path loader's three states are proven above; this proves
    /// the env-resolved wrapper that the serve path calls inherits them EXACTLY:
    ///   - `FRIDAY_OPERATOR_VK_PATH` UNSET ⇒ `Ok(None)` (byte-identical Pause behavior — the
    ///     runtime's `operator_vk()` is then `None`, so every protected action fail-closes);
    ///   - SET to a valid 64-hex verify-key file ⇒ `Ok(Some(_))` (loadable, so B4/C1 can verify);
    ///   - SET to a malformed file ⇒ a HARD `Err` (never silently `None` — the server REFUSES TO
    ///     BOOT rather than degrade to "no key").
    ///
    /// This test mutates a PROCESS env var, so it must not run concurrently with another reader of
    /// `FRIDAY_OPERATOR_VK_PATH`; no other test in this crate reads it (server tests drive a MOCK
    /// `HubRuntime::new` that never resolves the env). It restores the prior value on exit.
    #[test]
    fn env_wrapper_unset_is_none_valid_is_some_malformed_is_hard_error() {
        let prior = std::env::var(OPERATOR_VK_PATH_ENV).ok();

        // (1) UNSET ⇒ None ⇒ byte-identical fail-closed Pause (today's behavior).
        std::env::remove_var(OPERATOR_VK_PATH_ENV);
        assert!(matches!(provision_operator_vk_from_env(), Ok(None)));

        // Empty/whitespace is treated as unset (still fail-closed None), not a Read error.
        std::env::set_var(OPERATOR_VK_PATH_ENV, "   ");
        assert!(matches!(provision_operator_vk_from_env(), Ok(None)));

        // (2) SET to a valid operator-keygen public key file ⇒ Some (loadable ⇒ verify can run).
        let vk = OperatorSigningKey::generate().verifying_key();
        let good = tmp("env-ok.vk");
        std::fs::write(&good, format!("{}\n", vk_hex(&vk))).unwrap();
        std::env::set_var(OPERATOR_VK_PATH_ENV, &good);
        let loaded = match provision_operator_vk_from_env() {
            Ok(Some(k)) => k,
            _ => panic!("a valid env-configured vk file must load to Some"),
        };
        assert_eq!(loaded.to_bytes(), vk.to_bytes());

        // (3) SET to a malformed file ⇒ a HARD Err (NOT a silent degrade to None).
        let bad = tmp("env-bad.vk");
        std::fs::write(&bad, b"not-a-valid-verify-key").unwrap();
        std::env::set_var(OPERATOR_VK_PATH_ENV, &bad);
        assert!(matches!(
            provision_operator_vk_from_env(),
            Err(OperatorVkError::Malformed)
        ));

        // Restore the prior env so a parallel test that *adds* an env read later is unaffected.
        match prior {
            Some(v) => std::env::set_var(OPERATOR_VK_PATH_ENV, v),
            None => std::env::remove_var(OPERATOR_VK_PATH_ENV),
        }
        std::fs::remove_file(&good).ok();
        std::fs::remove_file(&bad).ok();
    }

    /// KEY-SUBSTITUTION DEFENSE (structural): the entire `friday-hub` source tree must
    /// never reference `OperatorSigningKey`. The Hub holds ONLY a verify key; if any Hub
    /// code could construct/derive a signing key, it could mint the very approvals it
    /// verifies (self-mint). We cannot runtime-prove the absence of a mint path, but we
    /// CAN prove the type that produces signatures is never named in the Hub crate.
    #[test]
    fn hub_crate_never_references_a_signing_key() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        scan_for(&src, "OperatorSigningKey", &mut offenders);
        assert!(
            offenders.is_empty(),
            "friday-hub must never reference OperatorSigningKey (a Hub-generated operator \
             key would be full self-mint); found in: {offenders:?}"
        );
    }

    fn scan_for(dir: &std::path::Path, needle: &str, offenders: &mut Vec<String>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                scan_for(&path, needle, offenders);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                // Skip THIS file — it names the type only in this defensive test/docs.
                if path.file_name().and_then(|n| n.to_str()) == Some("operator_vk.rs") {
                    continue;
                }
                if let Ok(contents) = std::fs::read_to_string(&path) {
                    if contents.contains(needle) {
                        offenders.push(path.display().to_string());
                    }
                }
            }
        }
    }
}
