//! `hub_read_seam_enroll` — the UI **read-seam** peer-pubkey enrollment CLI (slice-6 live-activation
//! infra, DARK/staged).
//!
//! Enrolls a UI peer's X25519 PUBLIC key into the **read-projection** server's
//! [`friday_hub::key_source::PEER_PUBKEY_ALLOWLIST_ID`] SecureStore allowlist so the
//! [`hub_read_projection_server`] (slice S-R1) will admit that UI client's sealed-WS handshake.
//! It is the read-seam analog of [`hub_agent_run_enroll`] (the write-server enroll CLI) and shares
//! the SAME key source, the SAME store layout, and the SAME on-disk allowlist format — so the two
//! servers cannot drift in how the allowlist is provisioned.
//!
//! ## DARK / staged — NOT a live flip
//! Running this CLI only writes the peer allowlist entry into a SecureStore dir; it does NOT install
//! a LaunchAgent, restart a service, or route any traffic. Activating the read seam in production
//! (install the read-projection LaunchAgent + flip the prod flag) is the slice-6 OPERATOR gate
//! (G2, the FREEZE tripwire) — NOT this CLI. Built ≠ flipped.
//!
//! ## The two enrollment sources (one peer at a time — single-peer v1)
//! The read-projection server enforces [`friday_hub::sealed_ws::enforce_single_peer`] at boot, so
//! the allowlist v1 holds EXACTLY ONE peer pubkey. This CLI therefore enrolls ONE peer, REPLACING
//! whatever was there (idempotent — never appends a second key). Choose the source:
//!
//! * **`--from-master` (DEFAULT)** — derive the peer pubkey from THIS host's master key, exactly as
//!   [`hub_agent_run_enroll`] does (the same [`friday_hub::key_source::derive_client_x25519_pubkey`]
//!   parity). This is the **desktop UI** path: the SwiftUI console runs as the same OS user with
//!   `~/.friday/master.key` access, derives the SAME X25519 key, and is therefore already the
//!   write-peer — so a desktop UI pointed at its own master needs NO separate device key. (If the
//!   read store IS the shared `~/.friday/agent-run-securestore`, the value written equals the
//!   already-enrolled write peer; idempotent.)
//! * **`--pubkey <64-hex>`** — enroll an EXTERNALLY-generated X25519 public key (32 bytes / 64 hex).
//!   This is the path a **distinct device** (e.g. a paired mobile device that does NOT share the
//!   host master key) uses: the device generates its own keypair off-box and the operator enrolls
//!   its PUBLIC key here. Because the server is single-peer, this REPLACES the prior peer — the
//!   enrolled device becomes the SOLE allowlisted reader.
//!
//! ## Multi-peer (DESKTOP + a distinct mobile device CONCURRENTLY) — DEFERRED, not skipped
//! Admitting MORE THAN ONE peer at once (so a desktop master-derived peer AND a distinct mobile
//! device key are BOTH allowlisted) is gated by the read server's [`enforce_single_peer`] boot
//! invariant, which exists precisely because a multi-key allowlist needs the (currently UNBUILT)
//! tamper-evident pubkey→principal bindings that bind the AUTHENTICATED caller to the MATCHED
//! pubkey. The on-disk allowlist FORMAT already supports a concatenation of 32-byte keys (the
//! server parses it with `chunks_exact(32)`), so this CLI CAN write a multi-key value via
//! `--add` — but the server would refuse to boot on it today. So `--add` is gated behind an
//! explicit `--allow-multi-peer-unsupported-by-server` acknowledgment flag and prints a loud
//! warning. This is the EXPLICIT acceptance-criterion deferral the slice-6 runbook (B-2) names:
//! single-peer works now; concurrent multi-peer is a separate build-first lane (relax
//! `enforce_single_peer` for the read server + the principal bindings).
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
//! * `--add` — APPEND the pubkey to the existing allowlist (multi-peer) instead of REPLACING.
//!   Requires `--allow-multi-peer-unsupported-by-server` (the read server will refuse a >1 list).
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
    PEER_PUBKEY_ALLOWLIST_ID, X25519_PUBKEY_LEN,
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
    allow_multi_peer: bool,
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
    let mut allow_multi_peer = false;
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
            "--allow-multi-peer-unsupported-by-server" => allow_multi_peer = true,
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

    // --add (multi-peer) is gated: the read server refuses a >1 allowlist (enforce_single_peer).
    if add && !allow_multi_peer {
        return Err(EnrollError::BadArgs(
            "--add builds a MULTI-PEER allowlist, which the read-projection server REFUSES at boot \
             (enforce_single_peer). Pass --allow-multi-peer-unsupported-by-server to acknowledge \
             this is for a future server that relaxes that invariant, or drop --add to REPLACE \
             (single-peer)."
                .into(),
        ));
    }

    Ok(Opts {
        store_dir,
        source,
        add,
        allow_multi_peer,
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
             '{PEER_PUBKEY_ALLOWLIST_ID}' in store dir {} — NOT written (store not opened)",
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

    // (6) Build the value to write. REPLACE (single-peer v1) = exactly the 32 pubkey bytes. APPEND
    // (multi-peer, server-unsupported) = the existing allowlist bytes followed by the new 32 — but
    // only when the new key is not already present (idempotent), and with a LOUD warning.
    let value: Vec<u8> = if opts.add {
        let mut existing = store
            .try_get(PEER_PUBKEY_ALLOWLIST_ID)
            .map_err(|_| EnrollError::StoreRead)?
            .unwrap_or_default();
        // Idempotent: if the new pubkey is already an aligned 32-byte chunk, do not duplicate it.
        let already = existing.len() % X25519_PUBKEY_LEN == 0
            && existing
                .chunks_exact(X25519_PUBKEY_LEN)
                .any(|c| c == pubkey);
        if !already {
            existing.extend_from_slice(&pubkey);
        }
        eprintln!(
            "hub_read_seam_enroll: WARNING — APPEND mode wrote a MULTI-PEER allowlist \
             ({} peer(s)). The read-projection server enforces single-peer at boot and will \
             REFUSE to start on this allowlist until enforce_single_peer is relaxed + the \
             pubkey->principal bindings are built (DEFERRED, see runbook B-2).",
            existing.len() / X25519_PUBKEY_LEN
        );
        existing
    } else {
        pubkey.to_vec()
    };

    // (7) CHECKED enrollment write — the CLI must KNOW it landed.
    store
        .try_put(PEER_PUBKEY_ALLOWLIST_ID, &value)
        .map_err(|_| EnrollError::EnrollWrite)?;

    let mode = if opts.add {
        "appended"
    } else {
        "enrolled (REPLACE)"
    };
    let peers = value.len() / X25519_PUBKEY_LEN;
    let multi_note = if opts.allow_multi_peer && opts.add {
        " [SERVER-UNSUPPORTED multi-peer: read server will refuse >1 at boot]"
    } else {
        ""
    };
    println!(
        "OK: {mode} read-seam peer pubkey {pubkey_hex} under id '{PEER_PUBKEY_ALLOWLIST_ID}' \
         in store dir {} ({peers} peer(s) total){multi_note}",
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
    fn add_without_ack_is_rejected() {
        let hex = "22".repeat(32);
        assert!(matches!(
            parse_args(["--pubkey", &hex, "--add"].into_iter().map(String::from)),
            Err(EnrollError::BadArgs(_))
        ));
        // with the ack flag it parses
        let o = parse_args(
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
        assert!(o.add && o.allow_multi_peer);
    }

    #[test]
    fn unknown_flag_is_rejected() {
        assert!(matches!(
            parse_args(["--nope"].into_iter().map(String::from)),
            Err(EnrollError::BadArgs(_))
        ));
    }

    // ── enroll round-trip (REPLACE, single-peer): the external pubkey is the sole 32-byte chunk ─
    #[test]
    fn external_pubkey_replace_round_trips_single_peer() {
        let master = [0x42u8; 32];
        let td = TempDir::new("ext-replace");
        let dir = td.child("store");
        let external = [0xABu8; X25519_PUBKEY_LEN];

        // Mirror run()'s REPLACE path: open store under master KEK, try_put exactly the 32 bytes.
        let kek = derive_file_store_kek(&master);
        let mut store = FileSecureStore::open(&dir, kek).unwrap();
        store.try_put(PEER_PUBKEY_ALLOWLIST_ID, &external).unwrap();

        let store2 = FileSecureStore::open(&dir, derive_file_store_kek(&master)).unwrap();
        let stored = store2.try_get(PEER_PUBKEY_ALLOWLIST_ID).unwrap().unwrap();
        assert_eq!(stored.len(), X25519_PUBKEY_LEN, "single-peer = 32 bytes");
        assert_eq!(&stored[..], &external[..]);
        // The read server's load_peer_allowlist + enforce_single_peer would accept this (len==1).
        let allowlist =
            friday_hub::sealed_ws::load_peer_allowlist(&store2, PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert!(friday_hub::sealed_ws::enforce_single_peer(&allowlist).is_ok());
        assert!(friday_hub::sealed_ws::peer_is_allowlisted(
            &allowlist, &external
        ));
    }

    // ── --add APPEND idempotency + multi-peer is REFUSED by the server invariant ──────────────
    #[test]
    fn add_appends_then_idempotent_and_server_refuses_multi() {
        let master = [0x07u8; 32];
        let td = TempDir::new("add-multi");
        let dir = td.child("store");
        let pk_a = [0x01u8; X25519_PUBKEY_LEN];
        let pk_b = [0x02u8; X25519_PUBKEY_LEN];

        let kek = derive_file_store_kek(&master);
        let mut store = FileSecureStore::open(&dir, kek).unwrap();
        // enroll A (replace), then append B, then append B again (idempotent).
        store.try_put(PEER_PUBKEY_ALLOWLIST_ID, &pk_a).unwrap();

        let append = |store: &mut FileSecureStore, pk: &[u8; 32]| {
            let mut existing = store
                .try_get(PEER_PUBKEY_ALLOWLIST_ID)
                .unwrap()
                .unwrap_or_default();
            let already = existing.len() % X25519_PUBKEY_LEN == 0
                && existing.chunks_exact(X25519_PUBKEY_LEN).any(|c| c == pk);
            if !already {
                existing.extend_from_slice(pk);
            }
            store.try_put(PEER_PUBKEY_ALLOWLIST_ID, &existing).unwrap();
        };
        append(&mut store, &pk_b);
        append(&mut store, &pk_b); // idempotent: still 2 peers, not 3

        let store2 = FileSecureStore::open(&dir, derive_file_store_kek(&master)).unwrap();
        let stored = store2.try_get(PEER_PUBKEY_ALLOWLIST_ID).unwrap().unwrap();
        assert_eq!(stored.len(), 2 * X25519_PUBKEY_LEN, "two peers, idempotent");

        // The server parses 2 keys but enforce_single_peer REFUSES it (the deferred lane).
        let allowlist =
            friday_hub::sealed_ws::load_peer_allowlist(&store2, PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(allowlist.len(), 2);
        assert!(
            friday_hub::sealed_ws::enforce_single_peer(&allowlist).is_err(),
            "multi-peer is REFUSED by the read server boot invariant (deferred lane)"
        );
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
