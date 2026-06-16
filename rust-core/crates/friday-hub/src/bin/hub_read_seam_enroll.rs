//! `hub_read_seam_enroll` — the UI **read-seam** peer-pubkey enrollment CLI (slice-6 live-activation
//! infra, DARK/staged).
//!
//! Enrolls a UI peer's X25519 PUBLIC key into the **read-projection** server's
//! [`friday_hub::key_source::READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID`] SecureStore allowlist so the
//! [`hub_read_projection_server`] (slice S-R1) will admit that UI client's sealed-WS handshake.
//! It is the read-seam analog of [`hub_agent_run_enroll`] (the write-server enroll CLI) and shares
//! the SAME key source, the SAME store layout, and the SAME on-disk allowlist format — but a
//! DISTINCT SecureStore id (the read-seam id, NOT the write server's `PEER_PUBKEY_ALLOWLIST_ID`),
//! so the read multi-peer set never contaminates the write single-peer entry.
//!
//! ## DARK / staged — NOT a live flip
//! Running this CLI only writes the peer allowlist entry into a SecureStore dir; it does NOT install
//! a LaunchAgent, restart a service, or route any traffic. Activating the read seam in production
//! (install the read-projection LaunchAgent + flip the prod flag) is the slice-6 OPERATOR gate
//! (G2, the FREEZE tripwire) — NOT this CLI. Built ≠ flipped.
//!
//! ## The two enrollment sources (REPLACE one peer, or `--add` to build a multi-peer set)
//! The read-projection server enforces [`friday_hub::sealed_ws::enforce_peer_allowlist_nonempty`]
//! at boot, so the read allowlist may hold ONE OR MORE peer pubkeys. Without `--add` this CLI
//! REPLACES the allowlist with the single resolved peer (idempotent); with `--add` it APPENDS to
//! build a multi-peer set. Choose the source:
//!
//! * **`--from-master` (DEFAULT)** — derive the peer pubkey from THIS host's master key, exactly as
//!   [`hub_agent_run_enroll`] does (the same [`friday_hub::key_source::derive_client_x25519_pubkey`]
//!   parity). This is the **desktop UI** path: the SwiftUI console runs as the same OS user with
//!   `~/.friday/master.key` access, derives the SAME X25519 key, and is therefore already the
//!   write-peer — so a desktop UI pointed at its own master needs NO separate device key.
//! * **`--pubkey <64-hex>`** — enroll an EXTERNALLY-generated X25519 public key (32 bytes / 64 hex).
//!   This is the path a **distinct device** (e.g. a paired mobile device that does NOT share the
//!   host master key) uses: the device generates its own keypair off-box and the operator enrolls
//!   its PUBLIC key here. With `--add` it joins the existing reader(s); without `--add` it REPLACES.
//!
//! ## Multi-peer (DESKTOP + a distinct mobile device CONCURRENTLY) — BUILT (J2)
//! Admitting MORE THAN ONE peer at once (so a desktop master-derived peer AND a distinct mobile
//! device key are BOTH allowlisted) is now SUPPORTED for the read seam: the read-projection server
//! boots on the DISTINCT read-seam id and enforces `enforce_peer_allowlist_nonempty` (NOT
//! `enforce_single_peer`), so a non-empty multi-peer allowlist is admitted with NO eviction (the
//! per-handshake S-F gate checks the presented key against EVERY enrolled key). The on-disk
//! allowlist FORMAT is a concatenation of 32-byte keys (parsed with `chunks_exact(32)`); `--add`
//! writes that multi-key value (idempotent-append). HONEST CEILING: per-PRINCIPAL isolation — the
//! tamper-evident pubkey→principal binding that ties the AUTHENTICATED caller to the MATCHED
//! pubkey — is still UNBUILT/DEFERRED, so v1 is single-OWNER: multi-peer = "more than one DEVICE
//! for the one configured owner", NOT multi-tenant. The WRITE server is BYTE-UNTOUCHED (own id +
//! own single-peer guard).
//!
//! ## Usage
//! ```text
//! hub_read_seam_enroll [--store-dir <path>] [--from-master | --pubkey <64-hex>]
//!                      [--add] [--allow-multi-peer-unsupported-by-server]
//!                      [--print-pubkey] [--dry-run]
//! ```
//! * `--store-dir <path>` — the read-projection server's FileSecureStore dir. Defaults to the
//!   shared [`key_source::default_store_dir`] (`~/.friday/agent-run-securestore`), which is also the
//!   write server's store; the read server opens the SAME default. The store-dir MUST match the
//!   read-projection LaunchAgent's `--store-dir`.
//! * `--from-master` — (default) derive + enroll the master-derived desktop peer pubkey.
//! * `--pubkey <64-hex>` — enroll an externally-supplied X25519 pubkey (the device path). The
//!   device generates its OWN keypair OFF-BOX and hands over only its PUBLIC key — the private key
//!   never touches this host (and [`friday_crypto::DeviceKeypair`] deliberately never exposes a
//!   secret, so this CLI cannot and does not mint device secrets — that is the device's job).
//! * `--add` — APPEND the pubkey to the existing allowlist (build a multi-peer set) instead of
//!   REPLACING. SUPPORTED (J2): the read server admits a non-empty multi-peer allowlist. The legacy
//!   `--allow-multi-peer-unsupported-by-server` ack is a deprecated NO-OP (accepted, ignored).
//! * `--print-pubkey` — print the resolved pubkey hex and EXIT WITHOUT enrolling (verification).
//! * `--dry-run` — report what WOULD be enrolled and exit 0 WITHOUT touching the filesystem.
//!
//! ## Secret hygiene
//! NEVER prints the master key or any X25519 secret — it cannot, by construction: the master key
//! never leaves [`run`] and [`friday_crypto::DeviceKeypair`] exposes only its PUBLIC half. All
//! output is public-key hex + a non-secret status line. Errors are a coarse, non-leaking category.

use std::path::PathBuf;
use std::process::ExitCode;

use friday_crypto::FileSecureStore;
use friday_hub::key_source::{
    default_store_dir, derive_client_x25519_pubkey, derive_file_store_kek, read_master_key,
    READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, X25519_PUBKEY_LEN,
};

/// A coarse, non-leaking error category. Its `Display` never carries a key, a secret-bearing path,
/// or any plaintext — only a stable, safe classification + a fixed remediation hint.
#[derive(Debug)]
enum EnrollError {
    /// Bad CLI args (unknown flag, missing/duplicate value, conflicting sources).
    BadArgs(String),
    /// The master key could not be sourced (only on the `--from-master` path).
    MasterKey(friday_hub::key_source::KeySourceError),
    /// `--pubkey` was not exactly 64 lowercase/uppercase hex chars / not a valid 32-byte key.
    BadPubkey,
    /// `$HOME` is unset so the default store dir cannot be resolved (no `--store-dir`).
    NoStoreDir,
    /// Opening the FileSecureStore failed (IO/permissions). Secret-free.
    StoreOpen,
    /// Reading the existing allowlist (for `--add`) failed. Secret-free.
    StoreRead,
    /// The checked enrollment write (`try_put`) failed. Secret-free.
    EnrollWrite,
}

impl std::fmt::Display for EnrollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnrollError::BadArgs(msg) => write!(f, "bad arguments: {msg}"),
            EnrollError::MasterKey(e) => write!(f, "master key unavailable: {e}"),
            EnrollError::BadPubkey => write!(
                f,
                "--pubkey must be exactly 64 hex chars (a 32-byte X25519 public key)"
            ),
            EnrollError::NoStoreDir => write!(
                f,
                "HOME is not set; pass --store-dir explicitly to locate the SecureStore"
            ),
            EnrollError::StoreOpen => write!(f, "could not open the SecureStore directory"),
            EnrollError::StoreRead => write!(f, "could not read the existing peer allowlist"),
            EnrollError::EnrollWrite => write!(f, "enrollment write failed"),
        }
    }
}

/// The pubkey source the operator selected.
#[derive(Debug, PartialEq, Eq)]
enum Source {
    /// Derive from this host's master key (the desktop UI = the master-derived peer).
    FromMaster,
    /// Use an externally-supplied 32-byte X25519 public key (the device path).
    External([u8; X25519_PUBKEY_LEN]),
}

/// Parsed CLI options.
struct Opts {
    store_dir: Option<PathBuf>,
    source: Source,
    add: bool,
    print_pubkey: bool,
    dry_run: bool,
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

/// Decode a 64-char hex string into exactly 32 bytes. `None` for any non-hex / wrong-length input.
fn decode_pubkey_hex(s: &str) -> Option<[u8; X25519_PUBKEY_LEN]> {
    let b = s.trim().as_bytes();
    if b.len() != X25519_PUBKEY_LEN * 2 {
        return None;
    }
    let mut out = [0u8; X25519_PUBKEY_LEN];
    for (i, pair) in b.chunks_exact(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out[i] = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Opts, EnrollError> {
    let mut store_dir = None;
    let mut from_master = false;
    let mut pubkey: Option<[u8; X25519_PUBKEY_LEN]> = None;
    let mut add = false;
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
            "--from-master" => from_master = true,
            "--pubkey" => {
                let v = it.next().ok_or_else(|| {
                    EnrollError::BadArgs("--pubkey requires a 64-hex value".into())
                })?;
                pubkey = Some(decode_pubkey_hex(&v).ok_or(EnrollError::BadPubkey)?);
            }
            "--add" => add = true,
            // (J2) Deprecated NO-OP: the read seam now SUPPORTS a multi-peer allowlist, so this ack
            // is no longer required. Accepted (not an "unknown argument" error) for back-compat.
            "--allow-multi-peer-unsupported-by-server" => {}
            "--print-pubkey" => print_pubkey = true,
            "--dry-run" => dry_run = true,
            "-h" | "--help" => {
                return Err(EnrollError::BadArgs(
                    "usage: hub_read_seam_enroll [--store-dir <path>] \
                     [--from-master | --pubkey <64-hex>] [--add] \
                     [--allow-multi-peer-unsupported-by-server] [--print-pubkey] [--dry-run]"
                        .into(),
                ));
            }
            other => return Err(EnrollError::BadArgs(format!("unknown argument: {other}"))),
        }
    }

    // Exactly one source. Default = --from-master (the desktop path) when none is given.
    if from_master && pubkey.is_some() {
        return Err(EnrollError::BadArgs(
            "choose AT MOST ONE of --from-master, --pubkey".into(),
        ));
    }
    let source = if let Some(pk) = pubkey {
        Source::External(pk)
    } else {
        // from_master == true OR nothing selected → default to the master-derived desktop peer.
        Source::FromMaster
    };

    // (J2) --add (multi-peer) is NO LONGER gated for the read seam: the read-projection server now
    // boots on the READ-SEAM id and enforces `enforce_peer_allowlist_nonempty` (NOT
    // `enforce_single_peer`), so a MULTI-peer allowlist is SUPPORTED — a desktop master-derived
    // peer AND a distinct mobile device can both be enrolled and read concurrently, with no
    // eviction. The legacy `--allow-multi-peer-unsupported-by-server` ack is accepted as a
    // deprecated NO-OP (so an existing invocation does not break), but is no longer required.

    Ok(Opts {
        store_dir,
        source,
        add,
        print_pubkey,
        dry_run,
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("hub_read_seam_enroll: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), EnrollError> {
    let opts = parse_args(std::env::args().skip(1))?;

    // (1) Resolve the peer PUBLIC key from the selected source. Only the public key is ever
    // retained past this block; any secret is dropped (master) or printed-once-then-dropped (gen).
    let pubkey: [u8; X25519_PUBKEY_LEN] = match &opts.source {
        Source::FromMaster => {
            let master = read_master_key().map_err(EnrollError::MasterKey)?;
            derive_client_x25519_pubkey(&master)
        }
        Source::External(pk) => *pk,
    };
    let pubkey_hex = to_hex(&pubkey);

    // (2) --print-pubkey: print + EXIT WITHOUT enrolling (operator verification against the UI
    // client's own derived/declared pubkey).
    if opts.print_pubkey {
        println!("{pubkey_hex}");
        return Ok(());
    }

    // (3) Resolve the store dir (explicit arg, else the shared default — the SAME dir the read
    // server opens, also the write server's store).
    let store_dir = match opts.store_dir {
        Some(d) => d,
        None => default_store_dir().map_err(|_| EnrollError::NoStoreDir)?,
    };

    // (4) --dry-run: report what WOULD be enrolled WITHOUT touching the filesystem (store not even
    // opened, so no store dir is created).
    if opts.dry_run {
        let mode = if opts.add { "APPEND" } else { "REPLACE" };
        println!(
            "DRY-RUN: would {mode} peer pubkey {pubkey_hex} (32 bytes) under id \
             '{READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID}' in store dir {} — NOT written \
             (store not opened)",
            store_dir.display()
        );
        return Ok(());
    }

    // (5) Open the store under the master-derived KEK. NOTE: even on the --pubkey/--gen-keypair
    // paths the STORE itself is sealed under the host master key's KEK (it is THIS host's store) —
    // only the ENROLLED VALUE is an external pubkey. So we always need the master here.
    let master = read_master_key().map_err(EnrollError::MasterKey)?;
    let kek = derive_file_store_kek(&master);
    drop(master);
    let mut store = FileSecureStore::open(&store_dir, kek).map_err(|_| EnrollError::StoreOpen)?;

    // (6) Write the allowlist value. REPLACE (single-peer v1) = exactly the 32 pubkey bytes. APPEND
    // (multi-peer) DELEGATES to the SHARED `read_seam_enroll::enroll_read_seam_peer_additive` — the
    // SAME format-sensitive, idempotent, no-eviction append the `hub_pairing_server` bridge uses, so
    // the two callers can never drift on the on-disk format or the idempotency rule.
    let peers: usize = if opts.add {
        let outcome =
            friday_hub::read_seam_enroll::enroll_read_seam_peer_additive(&mut store, &pubkey)
                .map_err(|e| match e {
                    friday_hub::read_seam_enroll::ReadSeamEnrollError::StoreRead => {
                        EnrollError::StoreRead
                    }
                    // BadPubkeyLen is unreachable here (pubkey is a fixed [u8; 32]); StoreWrite ⇒ write.
                    _ => EnrollError::EnrollWrite,
                })?;
        eprintln!(
            "hub_read_seam_enroll: APPEND mode wrote a MULTI-PEER read-seam allowlist \
             ({} peer(s)). The read-projection server enforces enforce_peer_allowlist_nonempty at \
             boot, so it ADMITS this multi-peer list (no eviction). HONEST CEILING: per-PRINCIPAL \
             isolation (binding the authed caller to the matched pubkey) is still the deferred \
             pubkey->principal binding — v1 is single-OWNER, so multi-peer = multi-DEVICE for the \
             one owner.",
            outcome.total_peers
        );
        outcome.total_peers
    } else {
        // (7) CHECKED REPLACE write — the CLI must KNOW it landed.
        store
            .try_put(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, &pubkey)
            .map_err(|_| EnrollError::EnrollWrite)?;
        1
    };

    let mode = if opts.add {
        "appended"
    } else {
        "enrolled (REPLACE)"
    };
    let multi_note = if opts.add && peers > 1 {
        " [multi-peer SUPPORTED: read server admits a non-empty multi-peer allowlist — no eviction]"
    } else {
        ""
    };
    println!(
        "OK: {mode} read-seam peer pubkey {pubkey_hex} under id \
         '{READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID}' in store dir {} ({peers} peer(s) total){multi_note}",
        store_dir.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_hub::key_source::derive_file_store_kek;
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
                "friday-read-enroll-test-{tag}-{}-{n}",
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

    // ── arg parsing: source selection + default ──────────────────────────────────────────────
    #[test]
    fn default_source_is_from_master() {
        let o = parse_args(std::iter::empty()).unwrap();
        assert_eq!(o.source, Source::FromMaster);
        assert!(!o.add && !o.print_pubkey && !o.dry_run && o.store_dir.is_none());
    }

    #[test]
    fn pubkey_source_parses_64_hex() {
        let hex = "00".repeat(32);
        let o = parse_args(["--pubkey", &hex].into_iter().map(String::from)).unwrap();
        assert_eq!(o.source, Source::External([0u8; X25519_PUBKEY_LEN]));
    }

    #[test]
    fn bad_pubkey_len_is_rejected() {
        assert!(matches!(
            parse_args(["--pubkey", "abcd"].into_iter().map(String::from)),
            Err(EnrollError::BadPubkey)
        ));
        // non-hex char
        let bad = "zz".repeat(32);
        assert!(matches!(
            parse_args(["--pubkey", &bad].into_iter().map(String::from)),
            Err(EnrollError::BadPubkey)
        ));
    }

    #[test]
    fn two_sources_conflict() {
        let hex = "11".repeat(32);
        assert!(matches!(
            parse_args(
                ["--from-master", "--pubkey", &hex]
                    .into_iter()
                    .map(String::from)
            ),
            Err(EnrollError::BadArgs(_))
        ));
    }

    #[test]
    fn add_no_longer_requires_an_ack() {
        // (J2) The read seam now SUPPORTS multi-peer, so `--add` ALONE parses (no ack gate).
        let hex = "22".repeat(32);
        let o = parse_args(["--pubkey", &hex, "--add"].into_iter().map(String::from)).unwrap();
        assert!(o.add, "--add parses with no ack flag now");
        // The legacy ack flag is still accepted (deprecated NO-OP), not an "unknown argument".
        let o2 = parse_args(
            [
                "--pubkey",
                &hex,
                "--add",
                "--allow-multi-peer-unsupported-by-server",
            ]
            .into_iter()
            .map(String::from),
        )
        .unwrap();
        assert!(o2.add, "the deprecated ack flag is accepted as a no-op");
    }

    #[test]
    fn unknown_flag_is_rejected() {
        assert!(matches!(
            parse_args(["--nope"].into_iter().map(String::from)),
            Err(EnrollError::BadArgs(_))
        ));
    }

    // ── enroll round-trip (REPLACE): the external pubkey is the sole 32-byte chunk ───────────────
    #[test]
    fn external_pubkey_replace_round_trips_single_peer() {
        let master = [0x42u8; 32];
        let td = TempDir::new("ext-replace");
        let dir = td.child("store");
        let external = [0xABu8; X25519_PUBKEY_LEN];

        // Mirror run()'s REPLACE path: open store under master KEK, try_put exactly the 32 bytes.
        let kek = derive_file_store_kek(&master);
        let mut store = FileSecureStore::open(&dir, kek).unwrap();
        store
            .try_put(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, &external)
            .unwrap();

        let store2 = FileSecureStore::open(&dir, derive_file_store_kek(&master)).unwrap();
        let stored = store2
            .try_get(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
            .unwrap()
            .unwrap();
        assert_eq!(stored.len(), X25519_PUBKEY_LEN, "single-peer = 32 bytes");
        assert_eq!(&stored[..], &external[..]);
        // The read server's load_peer_allowlist + enforce_peer_allowlist_nonempty accepts this.
        let allowlist =
            friday_hub::sealed_ws::load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
                .unwrap();
        assert!(friday_hub::sealed_ws::enforce_peer_allowlist_nonempty(&allowlist).is_ok());
        assert!(friday_hub::sealed_ws::peer_is_allowlisted(
            &allowlist, &external
        ));
    }

    // ── (J2 KAT) --add A then B → stored len == 2*32, idempotent, and the read server ADMITS it ──
    #[test]
    fn add_appends_two_peers_idempotent_and_read_server_admits_multi() {
        let master = [0x07u8; 32];
        let td = TempDir::new("add-multi");
        let dir = td.child("store");
        let pk_a = [0x01u8; X25519_PUBKEY_LEN];
        let pk_b = [0x02u8; X25519_PUBKEY_LEN];

        let kek = derive_file_store_kek(&master);
        let mut store = FileSecureStore::open(&dir, kek).unwrap();
        // enroll A (replace), then append B, then append B again (idempotent).
        store
            .try_put(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, &pk_a)
            .unwrap();

        // Mirror run()'s --add APPEND path exactly (idempotent on an already-present aligned chunk).
        let append = |store: &mut FileSecureStore, pk: &[u8; 32]| {
            let mut existing = store
                .try_get(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
                .unwrap()
                .unwrap_or_default();
            let already = existing.len() % X25519_PUBKEY_LEN == 0
                && existing.chunks_exact(X25519_PUBKEY_LEN).any(|c| c == pk);
            if !already {
                existing.extend_from_slice(pk);
            }
            store
                .try_put(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, &existing)
                .unwrap();
        };
        append(&mut store, &pk_b);
        append(&mut store, &pk_b); // idempotent: still 2 peers, not 3

        let store2 = FileSecureStore::open(&dir, derive_file_store_kek(&master)).unwrap();
        let stored = store2
            .try_get(READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
            .unwrap()
            .unwrap();
        assert_eq!(stored.len(), 2 * X25519_PUBKEY_LEN, "two peers, idempotent");

        // (J2) The read server parses 2 keys and ADMITS them (enforce_peer_allowlist_nonempty Ok) —
        // the single-peer eviction trap is GONE. Both peers are allowlisted (no eviction).
        let allowlist =
            friday_hub::sealed_ws::load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
                .unwrap();
        assert_eq!(allowlist.len(), 2);
        assert!(
            friday_hub::sealed_ws::enforce_peer_allowlist_nonempty(&allowlist).is_ok(),
            "the read server ADMITS a 2-peer allowlist (J2 multi-peer, no eviction)"
        );
        assert!(friday_hub::sealed_ws::peer_is_allowlisted(
            &allowlist, &pk_a
        ));
        assert!(friday_hub::sealed_ws::peer_is_allowlisted(
            &allowlist, &pk_b
        ));
    }

    // ── --from-master derives the SAME pubkey the write enroll CLI + the handshake use ─────────
    #[test]
    fn from_master_matches_write_enroll_derivation() {
        let master = [0x42u8; 32];
        let pk = derive_client_x25519_pubkey(&master);
        // The desktop UI peer == the write peer (same derivation), so a read store that is the
        // shared agent-run store already holds this key.
        assert_eq!(pk.len(), X25519_PUBKEY_LEN);
        // Re-deriving is deterministic.
        assert_eq!(pk, derive_client_x25519_pubkey(&master));
    }

    #[test]
    fn pubkey_hex_round_trips() {
        let bytes = [0x9fu8; X25519_PUBKEY_LEN];
        let hex = to_hex(&bytes);
        assert_eq!(hex.len(), 64);
        assert_eq!(decode_pubkey_hex(&hex), Some(bytes));
        // uppercase tolerated
        assert_eq!(decode_pubkey_hex(&hex.to_uppercase()), Some(bytes));
    }
}
