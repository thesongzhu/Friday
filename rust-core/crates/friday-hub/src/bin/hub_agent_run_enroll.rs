//! `hub_agent_run_enroll` — the execrun peer-pubkey enrollment CLI (execrun-enablement slice 2).
//!
//! Enrolls THIS host's derived client X25519 PUBLIC key into the agent-run WS server's
//! SecureStore peer allowlist, so the server (next slice) will admit the live TS client's
//! handshake. The pubkey is derived from the SAME master key + SAME domain tag the runtime uses
//! (via [`friday_hub::key_source`]), guaranteeing the enrolled key equals the handshake key.
//!
//! ## Usage
//! ```text
//! hub_agent_run_enroll [--store-dir <path>] [--print-pubkey] [--dry-run]
//! ```
//! * `--store-dir <path>` — the FileSecureStore directory. Defaults to
//!   `~/.friday/agent-run-securestore` (the shared [`key_source::default_store_dir`]; the server
//!   slice opens the SAME default).
//! * `--print-pubkey` — derive + print the client pubkey hex and EXIT WITHOUT enrolling (for
//!   operator verification against the API host's `deriveRustAgentRunWsClientX25519PublicKey`).
//! * `--dry-run` — do everything EXCEPT the `try_put` (derive, open the store, report what WOULD
//!   be enrolled), then exit 0 without mutating the store.
//!
//! ## What it enrolls
//! The value stored under [`key_source::PEER_PUBKEY_ALLOWLIST_ID`] is a raw concatenation of
//! 32-byte X25519 pubkeys (the server parses it with `chunks_exact(32)`). For v1 there is a
//! SINGLE owner peer, so the value is exactly the 32 derived pubkey bytes. Re-running with the
//! same master key REPLACES (idempotent — never appends a duplicate); re-running after a master
//! key rotation REPLACES the old pubkey with the new one. A multi-peer allowlist (merge several
//! pubkeys) is OUT OF SCOPE for v1.
//!
//! ## NOT enrolled here
//! The OWNER principal is the server's `--owner` CLI arg (a later slice), NOT a store entry —
//! this CLI does not touch it.
//!
//! ## Secret hygiene
//! NEVER prints the master key or the X25519 secret. It prints the PUBLIC key hex (public by
//! construction) and a non-secret status line. No secret appears in any error or log; errors are
//! a coarse, non-leaking category.

use std::path::PathBuf;
use std::process::ExitCode;

use friday_crypto::FileSecureStore;
use friday_hub::key_source::{
    default_store_dir, derive_client_x25519_pubkey, derive_file_store_kek, read_master_key,
    PEER_PUBKEY_ALLOWLIST_ID,
};

/// A coarse, non-leaking error category. Its `Display` never carries a key, a path with secret
/// content, or any plaintext — only a stable, safe classification + a fixed remediation hint.
#[derive(Debug)]
enum EnrollError {
    /// Bad CLI args (unknown flag, missing value for `--store-dir`).
    BadArgs(String),
    /// The master key could not be sourced (missing / wrong length / not hex / unreadable).
    /// The underlying [`friday_hub::key_source::KeySourceError`] is itself secret-free.
    MasterKey(friday_hub::key_source::KeySourceError),
    /// `$HOME` is unset so the default store dir cannot be resolved (only when `--store-dir`
    /// was not given).
    NoStoreDir,
    /// Opening the FileSecureStore failed (IO/permissions). Secret-free.
    StoreOpen,
    /// The checked enrollment write (`try_put`) failed. Secret-free.
    EnrollWrite,
}

impl std::fmt::Display for EnrollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnrollError::BadArgs(msg) => write!(f, "bad arguments: {msg}"),
            EnrollError::MasterKey(e) => write!(f, "master key unavailable: {e}"),
            EnrollError::NoStoreDir => write!(
                f,
                "HOME is not set; pass --store-dir explicitly to locate the SecureStore"
            ),
            EnrollError::StoreOpen => write!(f, "could not open the SecureStore directory"),
            EnrollError::EnrollWrite => write!(f, "enrollment write failed"),
        }
    }
}

/// Parsed CLI options.
struct Opts {
    store_dir: Option<PathBuf>,
    print_pubkey: bool,
    dry_run: bool,
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Opts, EnrollError> {
    let mut store_dir = None;
    let mut print_pubkey = false;
    let mut dry_run = false;
    let mut it = args;
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--store-dir" => {
                let v = it
                    .next()
                    .ok_or_else(|| EnrollError::BadArgs("--store-dir requires a path".into()))?;
                store_dir = Some(PathBuf::from(v));
            }
            "--print-pubkey" => print_pubkey = true,
            "--dry-run" => dry_run = true,
            "-h" | "--help" => {
                return Err(EnrollError::BadArgs(
                    "usage: hub_agent_run_enroll [--store-dir <path>] [--print-pubkey] [--dry-run]"
                        .into(),
                ));
            }
            other => {
                return Err(EnrollError::BadArgs(format!("unknown argument: {other}")));
            }
        }
    }
    Ok(Opts {
        store_dir,
        print_pubkey,
        dry_run,
    })
}

/// Lowercase-hex encode a byte slice (no external dep).
fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // Secret-free category to stderr; nonzero exit so a caller/automation can detect it.
            eprintln!("hub_agent_run_enroll: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), EnrollError> {
    let opts = parse_args(std::env::args().skip(1))?;

    // (1) Source the master key, FAIL-CLOSED (never auto-generates). The key never leaves this
    // scope; it is consumed by the two derivations and dropped.
    let master = read_master_key().map_err(EnrollError::MasterKey)?;

    // (2) Derive the client PUBLIC key (the only key material printed — it is public).
    let pubkey = derive_client_x25519_pubkey(&master);
    let pubkey_hex = to_hex(&pubkey);

    // (3) --print-pubkey: print + EXIT WITHOUT enrolling (operator verification).
    if opts.print_pubkey {
        println!("{pubkey_hex}");
        return Ok(());
    }

    // (4) Resolve the store dir (explicit arg, else the shared default).
    let store_dir = match opts.store_dir {
        Some(d) => d,
        None => default_store_dir().map_err(|_| EnrollError::NoStoreDir)?,
    };

    // (5) Derive the FileSecureStore KEK from the SAME master key and open the store.
    let kek = derive_file_store_kek(&master);
    let mut store = FileSecureStore::open(&store_dir, kek).map_err(|_| EnrollError::StoreOpen)?;

    // The v1 allowlist value is exactly the 32-byte derived pubkey (single owner peer). Re-running
    // with the same master writes the identical bytes (idempotent REPLACE — try_put overwrites the
    // entry, it does not append); a rotated master writes the NEW pubkey, replacing the old.
    let value: &[u8] = &pubkey;

    if opts.dry_run {
        println!(
            "DRY-RUN: would enroll client pubkey {pubkey_hex} (32 bytes) under id \
             '{PEER_PUBKEY_ALLOWLIST_ID}' in store dir {} — NOT written",
            store_dir.display()
        );
        return Ok(());
    }

    // (6) CHECKED enrollment write — the CLI must KNOW it landed (try_put, not the infallible
    // trait `put`). On success the bytes are fsync'd + the rename durably committed.
    store
        .try_put(PEER_PUBKEY_ALLOWLIST_ID, value)
        .map_err(|_| EnrollError::EnrollWrite)?;

    println!(
        "OK: enrolled client pubkey {pubkey_hex} (1 peer, 32 bytes) under id \
         '{PEER_PUBKEY_ALLOWLIST_ID}' in store dir {}",
        store_dir.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_hub::key_source::{derive_file_store_kek, read_master_key, X25519_PUBKEY_LEN};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn new(tag: &str) -> Self {
            static CTR: AtomicU64 = AtomicU64::new(0);
            let n = CTR.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "friday-enroll-test-{tag}-{}-{n}",
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

    /// The enroll core, factored so tests drive it with an explicit master key + store dir
    /// (no process-env mutation). Mirrors `run()`'s enroll path exactly: derive pubkey, derive
    /// KEK from the same master, open the store, checked `try_put` of the raw 32-byte pubkey.
    fn enroll_with_master(master: &[u8; 32], dir: &PathBuf) -> [u8; X25519_PUBKEY_LEN] {
        let pubkey = derive_client_x25519_pubkey(master);
        let kek = derive_file_store_kek(master);
        let mut store = FileSecureStore::open(dir, kek).unwrap();
        store.try_put(PEER_PUBKEY_ALLOWLIST_ID, &pubkey).unwrap();
        pubkey
    }

    // ── Test 4: enroll round-trip — re-open the store and read the exact pubkey bytes ────────
    #[test]
    fn enroll_round_trip_stores_exactly_the_pubkey() {
        let master = [0x42u8; 32];
        let td = TempDir::new("roundtrip");
        let dir = td.child("store");

        let pubkey = enroll_with_master(&master, &dir);

        // Re-open under the SAME (re-derived) KEK and read the allowlist entry.
        let store = FileSecureStore::open(&dir, derive_file_store_kek(&master)).unwrap();
        let stored = store
            .try_get(PEER_PUBKEY_ALLOWLIST_ID)
            .unwrap()
            .expect("the allowlist entry must be present after enroll");

        // The server parses this with chunks_exact(32): a NONZERO multiple of 32, the derived
        // pubkey present as the first/only chunk.
        assert_eq!(stored.len(), X25519_PUBKEY_LEN, "v1 single-peer = 32 bytes");
        assert_eq!(
            stored.len() % X25519_PUBKEY_LEN,
            0,
            "must be a multiple of 32"
        );
        assert_eq!(&stored[..], &pubkey[..], "stored bytes == derived pubkey");
        // The derived pubkey is present as a chunk (the server's allowlist would contain it).
        let chunk_present = stored.chunks_exact(X25519_PUBKEY_LEN).any(|c| c == pubkey);
        assert!(
            chunk_present,
            "the derived pubkey must be an allowlist chunk"
        );
        // NOTE: the true end-to-end assertion — the server's private `load_peer_allowlist` +
        // `peer_is_allowlisted` ACCEPT this value — belongs to the NEXT (server-wiring) slice,
        // since those fns are private to the server bin. Here we assert only the on-disk format.
    }

    // ── Test 5: idempotent re-enroll — value stays 32 bytes, never 64 ────────────────────────
    #[test]
    fn idempotent_re_enroll_does_not_append() {
        let master = [0x07u8; 32];
        let td = TempDir::new("idempotent");
        let dir = td.child("store");

        let pk1 = enroll_with_master(&master, &dir);
        let pk2 = enroll_with_master(&master, &dir); // same master, again
        assert_eq!(pk1, pk2, "same master derives the same pubkey");

        let store = FileSecureStore::open(&dir, derive_file_store_kek(&master)).unwrap();
        let stored = store.try_get(PEER_PUBKEY_ALLOWLIST_ID).unwrap().unwrap();
        assert_eq!(
            stored.len(),
            X25519_PUBKEY_LEN,
            "re-enroll must REPLACE, not append (still 32 bytes, not 64)"
        );
        assert_eq!(&stored[..], &pk1[..]);
    }

    // ── Test 6: rotation — master B's pubkey REPLACES master A's ──────────────────────────────
    #[test]
    fn rotation_replaces_old_pubkey() {
        let master_a = [0xAAu8; 32];
        let master_b = [0xBBu8; 32];
        let td = TempDir::new("rotation");
        let dir = td.child("store");

        let pk_a = enroll_with_master(&master_a, &dir);
        let pk_b = enroll_with_master(&master_b, &dir);
        assert_ne!(pk_a, pk_b, "different masters derive different pubkeys");

        // After rotation the store opens under B's KEK (A's entries are unreadable under it, but
        // the allowlist id was overwritten with B's pubkey, sealed under B's KEK).
        let store = FileSecureStore::open(&dir, derive_file_store_kek(&master_b)).unwrap();
        let stored = store.try_get(PEER_PUBKEY_ALLOWLIST_ID).unwrap().unwrap();
        assert_eq!(stored.len(), X25519_PUBKEY_LEN);
        assert_eq!(
            &stored[..],
            &pk_b[..],
            "the value is B's pubkey after rotation"
        );
    }

    // ── CLI arg parsing ──────────────────────────────────────────────────────────────────────
    #[test]
    fn parse_args_handles_flags_and_rejects_unknown() {
        let o = parse_args(
            ["--store-dir", "/tmp/x", "--print-pubkey", "--dry-run"]
                .into_iter()
                .map(String::from),
        )
        .unwrap();
        assert_eq!(o.store_dir.as_deref(), Some(std::path::Path::new("/tmp/x")));
        assert!(o.print_pubkey);
        assert!(o.dry_run);

        // missing value for --store-dir
        assert!(matches!(
            parse_args(["--store-dir"].into_iter().map(String::from)),
            Err(EnrollError::BadArgs(_))
        ));
        // unknown flag
        assert!(matches!(
            parse_args(["--nope"].into_iter().map(String::from)),
            Err(EnrollError::BadArgs(_))
        ));
        // defaults
        let d = parse_args(std::iter::empty()).unwrap();
        assert!(d.store_dir.is_none() && !d.print_pubkey && !d.dry_run);
    }

    /// Defense-in-depth: the helper `read_master_key` is fail-closed (the CLI's only key source).
    /// This is covered exhaustively in key_source's tests; here we just assert the bin imports the
    /// fail-closed path (a missing key under a fake empty HOME is an Err, not a generated key).
    #[test]
    fn cli_uses_fail_closed_master_key() {
        let saved_env = std::env::var_os("FRIDAY_MASTER_KEY");
        let saved_home = std::env::var_os("HOME");
        let td = TempDir::new("failclosed");
        let fake_home = td.child("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        unsafe {
            std::env::set_var("HOME", &fake_home);
            std::env::remove_var("FRIDAY_MASTER_KEY");
        }
        assert!(
            read_master_key().is_err(),
            "no key must be an Err, never auto-gen"
        );
        assert!(
            !fake_home.join(".friday/master.key").exists(),
            "must not have created the master key file"
        );
        unsafe {
            match saved_env {
                Some(v) => std::env::set_var("FRIDAY_MASTER_KEY", v),
                None => std::env::remove_var("FRIDAY_MASTER_KEY"),
            }
            match saved_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
    }
}
