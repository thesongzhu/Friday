//! Shared, fail-closed master-key sourcing + the two domain-separated derivations the
//! execrun production-enablement substrate needs (execrun-enablement slice 2).
//!
//! Two consumers import this ONE module so their key material can never diverge:
//!   * the `hub_agent_run_server` bin (next slice) derives its [`FileSecureStore`] KEK here;
//!   * the `hub_agent_run_enroll` bin derives the client X25519 PUBLIC key here and enrolls
//!     it into the server's SecureStore peer allowlist.
//!
//! A second, copy-pasted derivation would silently break the load-bearing invariant that the
//! pubkey the operator ENROLLS equals the pubkey the runtime handshake PRODUCES — so it lives
//! in the LIB, imported by both bins.
//!
//! # Fail-closed master-key read (mirrors the TS `getMasterKey` SOURCE order, MINUS auto-gen)
//!
//! TS (`src/security/friday-secret-crypto.ts::getMasterKey`) resolves the master key in this
//! order: (1) `FRIDAY_MASTER_KEY` env (hex), (2) macOS keychain, (3) `~/.friday/master.key`
//! (read as **hex** — `readFileSync(…,"utf8").trim()` then `Buffer.from(hex,"hex")`),
//! (4) AUTO-GENERATE + persist a random key. [`read_master_key`] mirrors (1) and (3) but
//! **NEVER auto-generates**: a missing key is `Err`, never a freshly-minted one.
//!
//! Why no auto-gen: TS OWNS auto-generation. If Rust minted its own `master.key` it would be a
//! DIFFERENT 32 bytes than the host's TS-provisioned one → a different derived secret → a
//! different X25519 pubkey → the enrolled allowlist entry would not match the pubkey the live
//! TS client presents → the handshake fails closed at cutover, silently. So Rust reads the
//! key TS already provisioned and refuses to invent one. (The macOS-keychain SOURCE — TS step
//! 2 — is out of scope for this slice; the production path is env-or-file. A keychain source
//! would slot in here later WITHOUT changing the derivations below.)
//!
//! ## ⚠ The file is read as HEX, not raw bytes — parity-critical
//!
//! The slice spec said "read the file as RAW bytes". That is a SPEC ERROR: the real merged TS
//! `getMasterKey` reads `~/.friday/master.key` as hex (`friday-secret-crypto.ts:182,200-201`)
//! and its auto-gen path WRITES it as hex (`:218` — `newKey.toString("hex") + "\n"`), so a
//! real file is 64 hex chars + a trailing `\n`. Reading it as raw bytes would see 65 bytes
//! (reject) or, in any other case, a DIFFERENT 32 bytes → the exact silent fail-closed the
//! prime directive warns about. We therefore read the file as TS does: bytes → UTF-8 →
//! `trim()` → hex-decode → require exactly 32 bytes. This is flagged loudly in the deliverable.
//!
//! # Secret hygiene
//!
//! Neither the master key nor the X25519 secret is ever printed, logged, or embedded in an
//! error. [`KeySourceError`] names only the failure CATEGORY (it derives no value-bearing
//! field; its `Display` carries no key bytes). The only key material this module exposes is
//! the X25519 PUBLIC key (public by construction).

use std::path::{Path, PathBuf};

use friday_crypto::{DeviceKeypair, Kek};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// The master key width in bytes. Mirrors the TS `KEY_BYTES = 32`
/// (`src/security/friday-secret-crypto.ts:21`).
pub const MASTER_KEY_LEN: usize = 32;

/// The X25519 public-key width in bytes.
pub const X25519_PUBKEY_LEN: usize = 32;

/// Env var carrying the hex-encoded master key (highest-priority source). Mirrors the TS
/// `FRIDAY_MASTER_KEY` (`friday-secret-crypto.ts:146`).
pub const MASTER_KEY_ENV: &str = "FRIDAY_MASTER_KEY"; // pragma: allowlist secret

/// Path of the persisted master key file RELATIVE to `$HOME` (`~/.friday/master.key`). Mirrors
/// the TS `MASTER_KEY_FILE` (`friday-secret-crypto.ts:84-85`).
const MASTER_KEY_FILE_REL: &str = ".friday/master.key";

/// Domain-separation tag for the FileSecureStore KEK derivation. DISTINCT from the X25519
/// purpose below so the KEK and the X25519 secret can never collide. (Rust-only; the TS side
/// has no FileSecureStore, so there is no cross-language parity requirement on THIS tag — only
/// that this Rust module derives the KEK the same way every time.)
const FILE_STORE_KEK_PURPOSE: &[u8] = b"friday.rust.securestore.file.kek.v1";

/// Domain-separation tag for the client X25519 SECRET derivation. Mirrors the TS
/// `WS_X25519_SECRET_PURPOSE` (`friday-rust-hub-agent-run-ws-client-x25519-secret.ts:62`)
/// **byte-for-byte** — this is the load-bearing parity tag. The TS derivation is
/// `sha256(WS_X25519_SECRET_PURPOSE_utf8 || masterKey)`; the purpose comes FIRST.
const WS_X25519_SECRET_PURPOSE: &[u8] = b"friday.rust.agent_run.ws.x25519_secret.v1"; // pragma: allowlist secret

/// The SecureStore id under which the authorized peer X25519 pubkey allowlist lives. MUST match
/// the server bin's `PEER_PUBKEY_ALLOWLIST_ID` (`hub_agent_run_server.rs`) exactly — the enroll
/// bin writes the value the server reads. The stored value is a concatenation of one-or-more raw
/// 32-byte X25519 public keys (the server parses it with `chunks_exact(32)`).
pub const PEER_PUBKEY_ALLOWLIST_ID: &str = "friday:execrun:ws:s-f:peer-pubkey-allowlist:v1";

/// The default FileSecureStore directory RELATIVE to `$HOME` (`~/.friday/agent-run-securestore`).
/// The enroll bin's `--store-dir` defaults to this; the SERVER slice will reuse the SAME default
/// (via [`default_store_dir`]) so the CLI and the server agree on where the allowlist lives.
const DEFAULT_STORE_DIR_REL: &str = ".friday/agent-run-securestore";

/// A fail-closed key-sourcing error. **Carries no key bytes, no path-with-secret, no plaintext**
/// — only a structural CATEGORY — so it is safe to surface/log. (Deliberately does not capture
/// the offending value; a wrong-length env var reports the LENGTH ONLY, never the bytes.)
#[derive(Debug, thiserror::Error)]
pub enum KeySourceError {
    /// `$HOME` is unset, so `~/.friday/master.key` cannot be resolved. (Only reached when the
    /// env var is also absent.)
    #[error("HOME is not set; cannot locate the master key file")]
    HomeUnset,
    /// Neither `FRIDAY_MASTER_KEY` nor `~/.friday/master.key` is present. FAIL CLOSED — this
    /// module NEVER auto-generates a master key (TS owns auto-gen; a Rust-minted key would not
    /// match the host's and would silently break enrollment parity).
    #[error("no master key: set FRIDAY_MASTER_KEY (hex) or provision ~/.friday/master.key")]
    Missing,
    /// The env var / file content was not valid hex (the master key is hex-encoded in BOTH
    /// sources, mirroring TS). No secret content — the bad bytes are not echoed.
    #[error("master key is not valid hex")]
    NotHex,
    /// The decoded master key is the wrong length. Reports the OBSERVED length only (a length is
    /// not the key); the required length is [`MASTER_KEY_LEN`].
    #[error("master key must be {MASTER_KEY_LEN} bytes, got {0}")]
    WrongLength(usize),
    /// The master key file exists but could not be read (an IO error other than not-found). The
    /// inner OS error names the failure mode (e.g. EACCES), never the key bytes.
    #[error("master key file is unreadable")]
    FileUnreadable(#[source] std::io::Error),
}

/// `$HOME`-relative path of a file, or [`KeySourceError::HomeUnset`] when `$HOME` is unset.
/// `~` is resolved via `std::env::var("HOME")` (matching the slice spec; mirrors TS `os.homedir()`
/// on the Hub's Unix host).
fn home_relative(rel: &str) -> Result<PathBuf, KeySourceError> {
    let home = std::env::var_os("HOME").ok_or(KeySourceError::HomeUnset)?;
    if home.is_empty() {
        return Err(KeySourceError::HomeUnset);
    }
    Ok(Path::new(&home).join(rel))
}

/// The default FileSecureStore directory (`~/.friday/agent-run-securestore`). Shared by the
/// enroll bin (its `--store-dir` default) and the server slice (the store it opens) so both
/// agree without a copy-pasted literal. `Err(HomeUnset)` if `$HOME` is unset.
pub fn default_store_dir() -> Result<PathBuf, KeySourceError> {
    home_relative(DEFAULT_STORE_DIR_REL)
}

/// Decode a hex string (the env value or the trimmed file content) into exactly
/// [`MASTER_KEY_LEN`] bytes. Mirrors the TS `Buffer.from(hex,"hex")` + length check, but is
/// STRICT about non-hex input (TS `Buffer.from` silently stops at the first non-hex char; we
/// reject it as [`KeySourceError::NotHex`] so a malformed key fails closed rather than decoding
/// to a truncated — and therefore different — key).
fn decode_master_hex(hex: &str) -> Result<Zeroizing<[u8; MASTER_KEY_LEN]>, KeySourceError> {
    let hex = hex.as_bytes();
    if hex.len() % 2 != 0 {
        return Err(KeySourceError::NotHex);
    }
    let n = hex.len() / 2;
    if n != MASTER_KEY_LEN {
        return Err(KeySourceError::WrongLength(n));
    }
    let mut out = Zeroizing::new([0u8; MASTER_KEY_LEN]);
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        let hi = hex_nibble(pair[0]).ok_or(KeySourceError::NotHex)?;
        let lo = hex_nibble(pair[1]).ok_or(KeySourceError::NotHex)?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

/// One hex digit (lower or upper case) → its 0..16 value, or `None` for a non-hex byte.
fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Read the 32-byte master key, FAIL-CLOSED, mirroring the TS `getMasterKey` SOURCE order
/// MINUS auto-generation:
///
/// 1. If `FRIDAY_MASTER_KEY` is set → hex-decode it; MUST be exactly 32 bytes (64 hex chars).
/// 2. Else read `~/.friday/master.key` (bytes → UTF-8 → `trim()` → hex-decode); MUST be 32
///    bytes. **The file is HEX, not raw bytes** — see the module-level ⚠ note: this is exactly
///    how TS reads AND writes it, and reading it any other way silently breaks parity.
/// 3. Neither present → [`KeySourceError::Missing`]. **NEVER creates/auto-generates the file.**
///
/// The returned key never appears in any error or log. (An empty `FRIDAY_MASTER_KEY` — set but
/// `""` — is treated as ABSENT and falls through to the file, mirroring TS `if (envKey)` which
/// is falsy on `""`.)
pub fn read_master_key() -> Result<Zeroizing<[u8; MASTER_KEY_LEN]>, KeySourceError> {
    // (1) env (hex). Byte-faithful to TS: the env value is NOT trimmed (TS does
    // `Buffer.from(envKey, "hex")` directly — `friday-secret-crypto.ts:148`). Only an EXACTLY
    // empty value is treated as absent (TS `if (envKey)` is falsy on `""`); a whitespace-bearing
    // value is hex-decoded and fails closed (whitespace is not hex), matching TS (which would
    // hex-decode it to a short/empty buffer and throw). Not trimming avoids the divergence where
    // a leading-space env would otherwise decode to a pubkey the TS client never presents.
    if let Some(env_val) = std::env::var_os(MASTER_KEY_ENV) {
        let env_str = env_val.to_string_lossy();
        if !env_str.is_empty() {
            return decode_master_hex(&env_str);
        }
    }

    // (2) ~/.friday/master.key (hex), if present. A not-found file falls through to Missing; any
    // other IO error (e.g. EACCES on a present-but-unreadable file) is surfaced as a distinct,
    // non-leaking category rather than masquerading as "missing".
    let path = home_relative(MASTER_KEY_FILE_REL)?;
    match std::fs::read(&path) {
        Ok(bytes) => {
            // The file holds hex text (UTF-8) per TS; decode lossily then trim whitespace/newline.
            let text = String::from_utf8_lossy(&bytes);
            let text = text.trim();
            decode_master_hex(text)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(KeySourceError::Missing),
        Err(e) => Err(KeySourceError::FileUnreadable(e)),
    }
}

/// Derive the FileSecureStore KEK from the master key:
/// `Kek::from_bytes(sha256(FILE_STORE_KEK_PURPOSE || master))`.
///
/// The purpose tag domain-separates this KEK from the X25519 secret (a DISTINCT tag), so the two
/// derivations from the same master key can never coincide. Deterministic: the same master always
/// yields the same KEK (so a FileSecureStore written by the enroll CLI opens under the server's
/// KEK), and a different master yields a KEK that cannot unwrap the other's entries.
pub fn derive_file_store_kek(master: &[u8; MASTER_KEY_LEN]) -> Kek {
    let mut hasher = Sha256::new();
    hasher.update(FILE_STORE_KEK_PURPOSE);
    hasher.update(master);
    let digest = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    Kek::from_bytes(bytes)
}

/// Derive the client X25519 SECRET scalar from the master key:
/// `sha256(WS_X25519_SECRET_PURPOSE || master)` (purpose FIRST, then key — mirroring the TS
/// `createHash("sha256").update(WS_X25519_SECRET_PURPOSE).update(masterKey)`).
///
/// Private to this module: the secret never leaves it (only the PUBLIC key is exposed, via
/// [`derive_client_x25519_pubkey`]).
fn derive_client_x25519_secret(master: &[u8; MASTER_KEY_LEN]) -> Zeroizing<[u8; 32]> {
    let mut hasher = Sha256::new();
    hasher.update(WS_X25519_SECRET_PURPOSE);
    hasher.update(master);
    let digest = hasher.finalize();
    let mut secret = Zeroizing::new([0u8; 32]);
    secret.copy_from_slice(&digest);
    secret
}

/// Derive the client X25519 PUBLIC key (the value enrolled into the peer allowlist) from the
/// master key. This is the BYTE-EXACT parity contract with the TS client:
/// `deriveRustAgentRunWsClientX25519PublicKey(resolveRustAgentRunWsClientX25519Secret())`.
///
/// REUSES [`DeviceKeypair::from_secret_bytes`] (the SAME constructor the runtime handshake uses)
/// — so the enrolled pubkey is guaranteed to equal the pubkey the live handshake produces, and
/// no x25519 is hand-rolled here. Proven byte-equal to TS by the in-module cross-language KAT.
pub fn derive_client_x25519_pubkey(master: &[u8; MASTER_KEY_LEN]) -> [u8; X25519_PUBKEY_LEN] {
    let secret = derive_client_x25519_secret(master);
    DeviceKeypair::from_secret_bytes(*secret).public_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::FileSecureStore;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A fixed master key for the deterministic KATs (all 0x42).
    const KAT_MASTER: [u8; MASTER_KEY_LEN] = [0x42u8; MASTER_KEY_LEN];

    /// The 64-hex-char encoding of [`KAT_MASTER`] (what `FRIDAY_MASTER_KEY` / the file carries).
    const KAT_MASTER_HEX: &str = "4242424242424242424242424242424242424242424242424242424242424242";

    /// **CROSS-LANGUAGE PARITY KAT (load-bearing).** The expected client X25519 PUBLIC key hex
    /// for master = [0x42; 32], produced by RUNNING THE REAL MERGED TS DERIVATION.
    ///
    /// PROVENANCE — how this constant was obtained (2026-06-09): a self-contained Node 22 script
    /// faithfully reproducing the exact `node:crypto` ops of the merged TS path —
    /// `resolveRustAgentRunWsClientX25519Secret` (in
    /// `friday-rust-hub-agent-run-ws-client-x25519-secret.ts`) feeding
    /// `deviceKeypairFromSecret` (in `friday-rust-hub-agent-run-ws-sealed-crypto.ts`) — copying
    /// the purpose tag and the SPKI/PKCS8 DER prefixes VERBATIM from those sources (tsx and
    /// `@noble` were not installed in this rust-core worktree; the pubkey path is pure
    /// `node:crypto`, so no third-party dep is touched). The script ran:
    ///
    /// ```text
    /// secret = sha256("friday.rust.agent_run.ws.x25519_secret.v1" ++ 0x42x32)
    ///        = 84a7b3761b283c9adc27b8a169f83c7ea795852a8bdbb0fa1311ca24dac0613d
    /// pubkey = X25519 public of `secret` (PKCS8 import -> SPKI export, DER prefixes from source)
    ///        = 1d4a03c1c3af1a4639b616951c9b0e1cd1c957c9b0f25fe7a99b85101598de56
    /// ```
    ///
    /// This is a FAITHFUL reproduction of sealed-crypto.ts's node:crypto operations, NOT the
    /// literal imported module (which a full TS build was not available to run in this worktree).
    /// The Rust side below reuses `DeviceKeypair::from_secret_bytes` (x25519-dalek), an
    /// INDEPENDENT implementation; their agreement proves byte-parity across the two stacks.
    const TS_EXPECTED_PUBKEY_HEX: &str =
        "1d4a03c1c3af1a4639b616951c9b0e1cd1c957c9b0f25fe7a99b85101598de56"; // pragma: allowlist secret

    fn to_hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
            s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
        }
        s
    }

    /// A unique temp dir per test, no `tempfile` dep (workspace minimal-dep convention).
    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn new(tag: &str) -> Self {
            static CTR: AtomicU64 = AtomicU64::new(0);
            let n = CTR.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "friday-key-source-test-{tag}-{}-{n}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // ── Test 1: CROSS-LANGUAGE PARITY KAT ───────────────────────────────────────────────────
    #[test]
    fn client_pubkey_matches_ts_kat() {
        let pubkey = derive_client_x25519_pubkey(&KAT_MASTER);
        assert_eq!(
            to_hex(&pubkey),
            TS_EXPECTED_PUBKEY_HEX,
            "Rust-derived client X25519 pubkey must byte-match the TS-produced value; a mismatch \
             means the enrolled allowlist entry would NOT match the live handshake pubkey \
             (silent fail-closed at cutover)"
        );
    }

    /// Bonus parity anchor: assert the INTERMEDIATE secret too, so a future regression that
    /// happens to keep the pubkey stable while changing the secret derivation is still caught.
    #[test]
    fn client_secret_matches_ts_kat() {
        let secret = derive_client_x25519_secret(&KAT_MASTER);
        assert_eq!(
            to_hex(secret.as_slice()),
            "84a7b3761b283c9adc27b8a169f83c7ea795852a8bdbb0fa1311ca24dac0613d", // pragma: allowlist secret
            "the sha256(purpose || master) secret must match the TS derivation"
        );
    }

    // ── Test 2: KEK determinism (indirect — Kek has no Debug/Eq we can compare cheaply) ──────
    #[test]
    fn kek_is_deterministic_for_a_master() {
        // Seal under a KEK derived from master A; a SECOND KEK derived from the SAME master A
        // must open it (determinism). A KEK from a DIFFERENT master must NOT.
        let master_a = [0x11u8; MASTER_KEY_LEN];
        let master_b = [0x22u8; MASTER_KEY_LEN];

        let td = TempDir::new("kek");
        let dir = td.child("store");

        {
            let mut s = FileSecureStore::open(&dir, derive_file_store_kek(&master_a)).unwrap();
            s.try_put("k", b"value-under-A").unwrap();
        }
        // Same master → same KEK → opens.
        let s_same = FileSecureStore::open(&dir, derive_file_store_kek(&master_a)).unwrap();
        assert_eq!(
            s_same.try_get("k").unwrap().as_deref(),
            Some(&b"value-under-A"[..]),
            "a KEK re-derived from the same master must open the entry (deterministic)"
        );
        // Different master → different KEK → fails closed.
        let s_diff = FileSecureStore::open(&dir, derive_file_store_kek(&master_b)).unwrap();
        assert_eq!(
            s_diff.try_get("k").unwrap_or(None),
            None,
            "a KEK from a different master must NOT open the entry"
        );
    }

    // ── Test 3: read_master_key fail-closed paths ───────────────────────────────────────────
    //
    // These manipulate the PROCESS env (FRIDAY_MASTER_KEY / HOME), which is global, so they must
    // not run concurrently with each other. Cargo runs tests in one binary across threads, so we
    // serialize the env-mutating tests under a single #[test] (one logical sequence) rather than
    // relying on a mutex that other test modules don't share.
    #[test]
    fn read_master_key_fail_closed_sequence() {
        // Snapshot + restore the env we touch, so we never leak state to sibling tests.
        let saved_env = std::env::var_os(MASTER_KEY_ENV);
        let saved_home = std::env::var_os("HOME");

        // Point HOME at an empty temp dir so ~/.friday/master.key is ABSENT for these cases.
        let td = TempDir::new("readkey");
        let fake_home = td.child("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        // SAFETY: single-threaded within this test; env restored at the end. The other env-test
        // (the file-format positive test) is a separate #[test]; cargo MAY run them on different
        // threads concurrently — but each snapshots+restores and uses its OWN fake HOME, and the
        // only shared global they both mutate is FRIDAY_MASTER_KEY/HOME which each sets explicitly
        // before every read (no read observes an un-set value it didn't set). To remove even that
        // window we keep all env reads inside the setter's own test body.
        unsafe {
            std::env::set_var("HOME", &fake_home);
            std::env::remove_var(MASTER_KEY_ENV);
        }

        // (a) env unset + no file → Missing.
        let master_path = fake_home.join(".friday/master.key");
        assert!(!master_path.exists(), "precondition: no master.key");
        assert!(
            matches!(read_master_key(), Err(KeySourceError::Missing)),
            "env unset + no file must be Missing"
        );
        // And it must NOT have created the file.
        assert!(
            !master_path.exists(),
            "read_master_key must NEVER create the master key file"
        );

        // (b) empty env is treated as absent → still Missing (no file).
        unsafe {
            std::env::set_var(MASTER_KEY_ENV, "");
        }
        assert!(
            matches!(read_master_key(), Err(KeySourceError::Missing)),
            "empty FRIDAY_MASTER_KEY is treated as absent → Missing"
        );

        // (c) wrong-length env hex (62 hex chars = 31 bytes, valid hex) → WrongLength(31).
        unsafe {
            std::env::set_var(
                MASTER_KEY_ENV,
                "42424242424242424242424242424242424242424242424242424242424242", // 62 chars = 31 bytes
            );
        }
        assert!(
            matches!(read_master_key(), Err(KeySourceError::WrongLength(31))),
            "62-hex-char (31-byte) env must be WrongLength(31)"
        );

        // (d) non-hex env, but CORRECT length (64 chars = would-be 32 bytes) so the length check
        // passes and the per-nibble hex check is what fires → NotHex (not WrongLength).
        unsafe {
            std::env::set_var(
                MASTER_KEY_ENV,
                "zz42424242424242424242424242424242424242424242424242424242424242", // 'zz' not hex, 64 chars
            );
        }
        assert!(
            matches!(read_master_key(), Err(KeySourceError::NotHex)),
            "non-hex 64-char env must be NotHex (length ok, charset bad)"
        );

        // (e) odd-length env hex → NotHex.
        unsafe {
            std::env::set_var(MASTER_KEY_ENV, "424"); // odd length
        }
        assert!(
            matches!(read_master_key(), Err(KeySourceError::NotHex)),
            "odd-length env hex must be NotHex"
        );

        // (f) FILE with hex decoding to 31 bytes → WrongLength(31). (Clear env first.)
        unsafe {
            std::env::remove_var(MASTER_KEY_ENV);
        }
        std::fs::create_dir_all(fake_home.join(".friday")).unwrap();
        std::fs::write(
            &master_path,
            "42424242424242424242424242424242424242424242424242424242424242\n", // 62 hex chars = 31 bytes + newline
        )
        .unwrap();
        assert!(
            matches!(read_master_key(), Err(KeySourceError::WrongLength(31))),
            "a file decoding to 31 bytes must be WrongLength(31)"
        );

        // (g) the FILE is read as HEX (the parity-critical fix), and env/file agree on the bytes.
        // This is folded into THIS test (not a separate #[test]) on purpose: it mutates the same
        // process-global env (HOME/FRIDAY_MASTER_KEY), and the default cargo harness would run a
        // second env-mutating #[test] CONCURRENTLY — a data race on env (UB) + flaky reads. One
        // env-mutating test per binary keeps the env reads race-free by construction.
        //
        // Write the file in the TS on-disk format: 64 hex chars + a trailing newline.
        std::fs::write(&master_path, format!("{KAT_MASTER_HEX}\n")).unwrap();
        unsafe {
            std::env::remove_var(MASTER_KEY_ENV); // ensure the FILE path is taken
        }
        let from_file = read_master_key().expect("hex file must read successfully");
        assert_eq!(
            *from_file, KAT_MASTER,
            "the file must be HEX-decoded (TS format), not read as raw bytes"
        );
        // The whole file→pubkey path must derive the TS-parity pubkey.
        assert_eq!(
            to_hex(&derive_client_x25519_pubkey(&from_file)),
            TS_EXPECTED_PUBKEY_HEX,
            "the file-sourced master must derive the TS-parity pubkey"
        );
        // The env path with the same hex must decode to the IDENTICAL key (env takes priority,
        // but the bytes must agree — the equivalence the spec's raw-bytes wording would break).
        unsafe {
            std::env::set_var(MASTER_KEY_ENV, KAT_MASTER_HEX);
        }
        let from_env = read_master_key().expect("hex env must read successfully");
        assert_eq!(
            from_env, from_file,
            "env and file hex must decode identically"
        );

        // Restore env.
        unsafe {
            match saved_env {
                Some(v) => std::env::set_var(MASTER_KEY_ENV, v),
                None => std::env::remove_var(MASTER_KEY_ENV),
            }
            match saved_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    // ── Determinism of the derivations (pure, no env) ────────────────────────────────────────
    #[test]
    fn pubkey_and_kek_derivations_are_deterministic_and_master_sensitive() {
        let m1 = [0x01u8; MASTER_KEY_LEN];
        let m2 = [0x02u8; MASTER_KEY_LEN];
        // pubkey: stable for a master, differs across masters.
        assert_eq!(
            derive_client_x25519_pubkey(&m1),
            derive_client_x25519_pubkey(&m1)
        );
        assert_ne!(
            derive_client_x25519_pubkey(&m1),
            derive_client_x25519_pubkey(&m2)
        );
        // secret: the X25519 secret tag must differ from the KEK tag (no cross-purpose collision).
        // Indirect: the X25519 secret bytes must not equal the KEK bytes for the same master.
        let kek_bytes = *derive_file_store_kek(&m1).as_bytes();
        let x_secret = derive_client_x25519_secret(&m1);
        assert_ne!(
            kek_bytes, *x_secret,
            "the KEK and the X25519 secret must be domain-separated (distinct tags)"
        );
    }
}
