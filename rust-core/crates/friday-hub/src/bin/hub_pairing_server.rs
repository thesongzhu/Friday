//! **J1/J2** — `hub_pairing_server`: the loopback-only QR-pairing server + the pairing→read-seam
//! enroll bridge. **DEFAULT-OFF / DARK: no LaunchAgent, no production caller — it exists, but is
//! only reachable when explicitly run; the production flip is a separate operator gate.**
//!
//! ## What it does (the missing hub-side bridge)
//! QR pairing ([`friday_hub::pair_runtime::PairingListener`]) and the read-seam multi-peer enroll
//! ([`friday_hub::read_seam_enroll`]) already existed but were DISJOINT. This bin connects them:
//!
//! 1. **Runs QR pairing live.** It wraps [`PairingListener`] in a long-lived loopback accept loop so
//!    a phone that scanned the QR (carrying THIS hub's pubkey + the short-lived pairing secret) can
//!    actually pair against this Mac's hub over a sealed WebSocket — the thing that was previously
//!    test-only (no bin).
//! 2. **On a SUCCESSFUL pair, enrolls the device's read pubkey.** A valid `Pair` (correct
//!    `pairing_proof = HMAC(qr_secret, device_pubkey)`, UNEXPIRED, non-replay) writes a
//!    `trusted_device` row AND THEN — and only then — appends that device's pubkey to the read-seam
//!    allowlist ([`friday_hub::key_source::READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID`]) so that device can
//!    read (:48751). An invalid / replayed / expired / revoked pair enrolls NOTHING (fail-closed).
//!
//! ## Security (this bin GRANTS READ enrollment — built defensively)
//! * **Only a VALID pairing enrolls.** The enroll is bound to a `PairAck { accepted: true }`, which
//!   the [`PairingHub`] returns ONLY when `complete_qr_pairing` returned `Ok(())` — the proof is
//!   verified INSIDE `pair_device` over EXACTLY the `device_pubkey` we then enroll (no TOCTOU). See
//!   [`friday_hub::pair_runtime::PairingListener::accept_one_live`].
//! * **No eviction / additive only.** Enroll goes through the shared
//!   [`friday_hub::read_seam_enroll::enroll_read_seam_peer_additive`] (APPEND-only, idempotent), so
//!   the existing desktop master peer + any other enrolled device SURVIVE.
//! * **The WRITE seam is untouched.** Pairing grants READ enrollment only — it NEVER writes the
//!   write server's single-peer `PEER_PUBKEY_ALLOWLIST_ID`; this bin never names it.
//! * **Loopback-only.** Binds `127.0.0.1` (the "this Mac only" guarantee) — nothing routable off-box.
//! * **Owner-scoped.** The pairing + enroll happen under the host master key (the store is sealed
//!   under the host master KEK) and the operator-supplied `--owner` (echoed for audit parity with
//!   the read server). v1 is single-OWNER — per-PRINCIPAL pubkey→owner binding is the SAME deferred
//!   read-seam ceiling (FIX-Q3b), matched here, not re-invented. See the PR body.
//! * **No model/provider call.** The pairing channel refuses `AskFridayRequest` (no hidden model
//!   path); this bin builds NO `HubRuntime`, NO `DeepSeekClient`, holds NO provider credential.
//! * **No secret in logs, no panic path.** Coarse error categories only; the pairing secret + the
//!   master key + device pubkey bytes are NEVER printed (only counts / fingerprints).
//!
//! ## Atomicity (HONEST): the `trusted_device` DB txn and the read-seam FileSecureStore are SEPARATE
//! stores; a "trust written, enroll failed" window exists. It is surfaced LOUDLY (a stderr line) so
//! the operator can re-run `hub_read_seam_enroll --pubkey … --add`; acceptable for this DARK bin.
//!
//! ## DARK / default-off — NOT a live flip
//! There is NO LaunchAgent entry and NO production caller. The bin serves only when explicitly run.
//! Activating live pairing in production (provision a LaunchAgent + the QR/pairing-secret flow + the
//! actual on-device QR scan) is an OPERATOR gate — NOT this bin. Built ≠ flipped; NOT v1 GO.
//!
//! ## Usage
//! ```text
//! hub_pairing_server --db <path> --pairing-secret <≥16 chars> --hub-id <id> --pairing-id <id>
//!                    --display-name <name> --expires-at-ms <epoch_ms>
//!                    [--store-dir <path>] [--owner <principal>] [--port <port>] [--once]
//! ```
//! The pairing secret + hub/pairing ids + display name + expiry are the QR-payload fields the phone
//! scanned; they MUST match the QR shown to the device. `--once` serves exactly one connection (the
//! integration KAT path) then exits; the default is a long-lived accept loop.

use std::env;

use friday_core::{
    FridayPairPayload, PairAuthority, PairTransportHint, PairTransportKind,
    CURRENT_PAIR_PAYLOAD_VERSION,
};
use friday_crypto::{DeviceKeypair, FileSecureStore};
use friday_hub::pair_runtime::{PairOutcome, PairingHub, PairingListener};
use friday_storage::Db;

/// The sealed-WS AAD binding every pairing envelope to this pairing protocol/version. Fixed, public,
/// non-secret. The phone seals/opens under the SAME AAD.
const PAIRING_AAD: &[u8] = b"friday:pairing:ws:j1:qr-pair-session:aad:v1";

/// A boot/serve failure category. Coarse + safe — the raw detail is NOT surfaced so a storage/init
/// error cannot leak a path, the pairing secret, or a key.
#[derive(Debug)]
enum ServerError {
    BadArgs(&'static str),
    /// The QR payload (secret/ids/expiry) was invalid — the pairing secret is too short, an id is
    /// blank, or the payload is already expired. Coarse only (never the secret).
    BadPayload,
    Bind,
    /// The hub DB could not be opened read-WRITE (pairing WRITES `trusted_device` + audit).
    DbUnavailable,
    /// The master key is absent/unreadable ⇒ REFUSE TO BOOT (never auto-generated). The master key
    /// is for the read-seam store KEK — NOT the pairing ECDH (that key rides the QR/preamble).
    MasterKeyUnavailable,
    /// The read-seam FileSecureStore cannot be resolved/opened ⇒ FAIL CLOSED. Never the path. (We do
    /// NOT enforce a non-empty allowlist at boot: the pairing server's JOB is to POPULATE a possibly
    /// -empty allowlist, so a fresh host with zero enrolled devices must still boot.)
    StoreUnavailable,
}

fn main() {
    if let Err(err) = run() {
        // NAME the specific bad-arg (operator diagnosability), then the coarse closed-vocab kind.
        if let ServerError::BadArgs(detail) = &err {
            eprintln!("hub_pairing_server: leg=args error_kind=bad_args detail={detail}");
        }
        eprintln!("hub_pairing_server_unavailable: {}", boot_error_kind(&err));
        std::process::exit(2);
    }
}

/// The coarse, closed-vocabulary `error_kind` token for each boot failure (pure; shared with tests).
fn boot_error_kind(err: &ServerError) -> &'static str {
    match err {
        ServerError::BadArgs(_) => "bad_args",
        ServerError::BadPayload => "bad_pairing_payload",
        ServerError::Bind => "bind_failed",
        ServerError::DbUnavailable => "db_unavailable",
        ServerError::MasterKeyUnavailable => "master_key_unavailable",
        ServerError::StoreUnavailable => "secure_store_unavailable",
    }
}

fn run() -> Result<(), ServerError> {
    let args: Vec<String> = env::args().collect();

    let db_path = arg_value(&args, "--db").ok_or(ServerError::BadArgs("--db is required"))?;
    let port: u16 = arg_value(&args, "--port")
        .map(|p| {
            p.parse::<u16>()
                .map_err(|_| ServerError::BadArgs("--port must be a u16"))
        })
        .transpose()?
        .unwrap_or(0);
    let once = args.iter().any(|a| a == "--once");

    // The Hub OWNER (v1 = single configured owner). HUB-SUPPLIED (operator arg), echoed for audit
    // parity with the read server. v1 is single-OWNER, so this is the ceiling — per-principal
    // pubkey→owner binding is the deferred read-seam ceiling (NOT re-invented here).
    let owner = arg_value(&args, "--owner")
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty());

    // (0) Build the QR payload from the operator-supplied fields (the SAME fields the QR conveyed to
    // the phone). `FridayPairPayload::new` validates the secret length (≥16) + non-provider-looking
    // secret + expiry — a bad payload FAILS CLOSED before we bind anything.
    let payload = build_payload(&args)?;

    // (1) Open the hub DB READ-WRITE — pairing WRITES `trusted_device` + audit_ledger (this is the
    // ONE place this bin differs from the read-projection server, which opens read-only).
    let mut db = Db::open_hub(&db_path).map_err(|_| ServerError::DbUnavailable)?;

    // (2) Open the read-seam FileSecureStore (sealed under the host master KEK) so a successful pair
    // can APPEND the device pubkey. We do NOT load/enforce a non-empty allowlist here: the server's
    // job is to POPULATE it, so a fresh host with zero devices must still boot. Master key absent ⇒
    // REFUSE (never auto-generate).
    let master =
        friday_hub::key_source::read_master_key().map_err(|_| ServerError::MasterKeyUnavailable)?;
    let kek = friday_hub::key_source::derive_file_store_kek(&master);
    drop(master); // `Zeroizing` ⇒ master wiped now; only the KEK survives.
    let store_dir = match arg_value(&args, "--store-dir") {
        Some(d) => std::path::PathBuf::from(d),
        None => friday_hub::key_source::default_store_dir()
            .map_err(|_| ServerError::StoreUnavailable)?,
    };
    let mut enroll_store =
        FileSecureStore::open(&store_dir, kek).map_err(|_| ServerError::StoreUnavailable)?;

    // (3) The hub's OWN long-lived pairing keypair. Its PUBLIC half is what the QR conveyed to the
    // phone; the phone's pubkey arrives over the wire. Fresh per-process `generate()` (NOT master-
    // derived) — the only `generate()` in this bin's non-test code.
    let server_kp = DeviceKeypair::generate();

    let hub = PairingHub::new(payload, vec!["pairing".into(), "read_seam_enroll".into()]);
    let listener = PairingListener::bind_loopback(hub, port).map_err(|_| ServerError::Bind)?;
    let addr = listener.local_addr().map_err(|_| ServerError::Bind)?;
    eprintln!(
        "hub_pairing_server: listening (loopback-only) on {addr} owner={} — DARK (J1 pairing + J2 \
         read-seam enroll bridge, no LaunchAgent, no production caller)",
        owner.as_deref().unwrap_or("<none>")
    );

    // (4) Accept loop. Each connection: derive the pairing session, handle one sealed pairing
    // message, and — on a VALID pair ONLY — enroll the device pubkey into the read-seam allowlist.
    loop {
        match listener.accept_one_live(&mut db, &mut enroll_store, &server_kp, PAIRING_AAD) {
            Ok(outcome) => report_outcome(&outcome),
            // A bad handshake / dropped connection ENDS that connection only — keep serving (unless
            // --once). Never panic; never leak the error detail.
            Err(_e) => {
                if once {
                    return Ok(());
                }
                continue;
            }
        }
        if once {
            return Ok(());
        }
    }
}

/// Report one pairing outcome to stderr — counts + booleans ONLY, never a key or the secret.
fn report_outcome(outcome: &PairOutcome) {
    if outcome.accepted {
        match (&outcome.enroll_outcome, &outcome.enroll_error) {
            (Some(o), _) => eprintln!(
                "hub_pairing_server: pair ACCEPTED — read-seam enroll ok (peers={}, newly_added={})",
                o.total_peers, o.newly_added
            ),
            (None, Some(e)) => eprintln!(
                "hub_pairing_server: pair ACCEPTED but read-seam enroll FAILED ({e}). Trust is \
                 committed; re-run `hub_read_seam_enroll --pubkey <device-hex> --add` to grant read."
            ),
            (None, None) => eprintln!(
                "hub_pairing_server: pair ACCEPTED (no enroll outcome — unreachable)"
            ),
        }
    } else {
        eprintln!("hub_pairing_server: pair DENIED — nothing enrolled (fail-closed)");
    }
}

/// Build + validate the QR pairing payload from the operator args. A loopback `ws://127.0.0.1:<port>`
/// transport hint is synthesized (the phone scanned the same endpoint). Fails closed on a bad secret
/// / blank id / past expiry.
fn build_payload(args: &[String]) -> Result<FridayPairPayload, ServerError> {
    let pairing_secret = arg_value(args, "--pairing-secret")
        .ok_or(ServerError::BadArgs("--pairing-secret is required"))?;
    let hub_id = arg_value(args, "--hub-id").ok_or(ServerError::BadArgs("--hub-id is required"))?;
    let pairing_id =
        arg_value(args, "--pairing-id").ok_or(ServerError::BadArgs("--pairing-id is required"))?;
    let display_name = arg_value(args, "--display-name")
        .ok_or(ServerError::BadArgs("--display-name is required"))?;
    let expires_at_ms: i64 = arg_value(args, "--expires-at-ms")
        .ok_or(ServerError::BadArgs("--expires-at-ms is required"))?
        .parse()
        .map_err(|_| ServerError::BadArgs("--expires-at-ms must be epoch-millis"))?;
    let endpoint = arg_value(args, "--endpoint").unwrap_or_else(|| "ws://127.0.0.1:0".into());

    let hint = PairTransportHint::new(PairTransportKind::LanWebSocket, endpoint, "LAN WebSocket")
        .map_err(|_| ServerError::BadPayload)?;
    FridayPairPayload::new(
        CURRENT_PAIR_PAYLOAD_VERSION,
        hub_id,
        pairing_id,
        pairing_secret,
        display_name,
        vec![hint],
        expires_at_ms,
        vec![PairAuthority::StatusOnly],
    )
    .map_err(|_| ServerError::BadPayload)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_error_kinds_are_stable_tokens() {
        assert_eq!(boot_error_kind(&ServerError::BadArgs("x")), "bad_args");
        assert_eq!(
            boot_error_kind(&ServerError::BadPayload),
            "bad_pairing_payload"
        );
        assert_eq!(boot_error_kind(&ServerError::Bind), "bind_failed");
        assert_eq!(
            boot_error_kind(&ServerError::DbUnavailable),
            "db_unavailable"
        );
        assert_eq!(
            boot_error_kind(&ServerError::MasterKeyUnavailable),
            "master_key_unavailable"
        );
        assert_eq!(
            boot_error_kind(&ServerError::StoreUnavailable),
            "secure_store_unavailable"
        );
    }

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args: Vec<String> = ["--db", "/tmp/x.sqlite", "--port=4477"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/x.sqlite"));
        assert_eq!(arg_value(&args, "--port").as_deref(), Some("4477"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn build_payload_fails_closed_on_short_secret() {
        let args: Vec<String> = [
            "--pairing-secret",
            "tooshort", // < 16 chars
            "--hub-id",
            "hub-1",
            "--pairing-id",
            "pair-1",
            "--display-name",
            "Mac",
            "--expires-at-ms",
            "9999999999999",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert!(matches!(build_payload(&args), Err(ServerError::BadPayload)));
    }

    #[test]
    fn build_payload_ok_with_valid_fields() {
        let args: Vec<String> = [
            "--pairing-secret",
            "friday-pairing-secret-32-bytes",
            "--hub-id",
            "hub-1",
            "--pairing-id",
            "pair-1",
            "--display-name",
            "Mac",
            "--expires-at-ms",
            "9999999999999",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let payload = build_payload(&args).unwrap();
        assert_eq!(payload.hub_id, "hub-1");
        assert_eq!(payload.expires_at, 9999999999999);
    }
}
