//! `friday-operator-sign` — the DESKTOP operator-signing helper (GATE-AGENT-REPLACE D3
//! key-custody bridge; the operator-chosen desktop-helper option of the A2 key-custody
//! decision). This REPLACES the file-key dev path for real operator custody.
//!
//! ## What it is
//!
//! The OFFLINE OPERATOR signer. Like the S6c CLI (`friday-operator-approve`) it produces an
//! Ed25519-signed `CanonicalApproval` over the Hub-computed canonical action digest — EXACTLY
//! what `friday_hub::resume::resume_with_approval` verifies under `OperatorVerifyingKey`. The
//! ONE difference: the operator's PRIVATE signing seed is read from the **KEK-wrapped
//! `FileSecureStore` the WS server already uses** (KEK derived from the host master key),
//! instead of a plaintext hex file. Ed25519-native, so the Hub verify side needs no scheme
//! change.
//!
//! ## DARK — NOT wired into prod, NEVER auto-run
//!
//! This is a standalone helper. It registers NO production route, has NO scheduler hook, and
//! is NEVER invoked automatically by the hub or any coordinator process. It runs ON THE
//! OPERATOR'S MACHINE, ATTENDED — the operator runs it by hand to approve ONE specific paused
//! mutation for the D3 live proof. PROOF-ONLY; NOT a v1 GO.
//!
//! ## Key-custody invariants this helper upholds
//!
//! - INV-1 (no self-mint): the HUB crate holds ONLY `OperatorVerifyingKey` and (by the
//!   structural `hub_crate_never_references_a_signing_key` test) has NO code that turns the
//!   stored seed bytes into a signer. This helper lives in a SEPARATE crate
//!   (`friday-operator-signer`) on the operator side; it adds NO signing path to the hub. The
//!   seed living in the KEK-wrapped SecureStore is safe FOR THAT REASON.
//! - INV-6 (real operator key, off-box): the SIGNING seed lives with the operator, in the
//!   operator's SecureStore on the operator's machine; this helper is the operator's signer
//!   and is never run by the hub/coordinator.
//!
//! ## Subcommands
//!
//! ```text
//! friday-operator-sign provision --seed-hex <64-hex> [--store-dir <dir>]
//!     Enroll the operator's 32-byte Ed25519 signing seed (hex) into the KEK-wrapped
//!     SecureStore (KEK derived from the host master key). The seed is the SECRET; it is
//!     never printed. Run ONCE on the operator's machine. (Prefer feeding the seed via
//!     --seed-stdin so it never appears in argv / shell history.)
//!
//! friday-operator-sign sign --request <pending.json> [--store-dir <dir>]
//!     Read a pending request (the fields the Hub persists when a mutating action Pauses:
//!     approval_id nonce + the Hub-computed action_digest + expiry + decision), load the
//!     PRIVATE seed from the SecureStore, and emit an Ed25519-signed CanonicalApproval (JSON)
//!     to stdout. The seed never appears in the output; the SignedApproval is what the Hub's
//!     resume ingestion verifies.
//! ```
//!
//! The master key is sourced exactly as the WS server sources it: `FRIDAY_MASTER_KEY` (hex)
//! or `~/.friday/master.key`. NEVER auto-generated. The store dir defaults to
//! `~/.friday/agent-run-securestore` (the server's default).

use std::process::ExitCode;

use friday_operator_cli::PendingRequest;
use friday_operator_signer::{
    default_store_dir, provision_signing_seed_into_store, sign_pending_from_store, SIGNING_SEED_LEN,
};

const USAGE: &str = "\
friday-operator-sign — desktop operator-signing helper (GATE-AGENT-REPLACE D3 bridge)

USAGE:
    friday-operator-sign provision --seed-hex <64-hex> [--store-dir <dir>]
    friday-operator-sign provision --seed-stdin        [--store-dir <dir>]
    friday-operator-sign sign --request <pending-request.json> [--store-dir <dir>]

provision enrolls the operator's 32-byte Ed25519 signing seed into the KEK-wrapped
SecureStore (KEK derived from the host master key). The seed is the SECRET and is never
printed. Prefer --seed-stdin so the seed never appears in argv / shell history.

sign reads a pending request JSON, loads the PRIVATE seed from the SecureStore, and emits
an Ed25519-signed CanonicalApproval (JSON) to stdout for the Hub's resume ingestion. The
private seed never appears in the output.

The master key is sourced from FRIDAY_MASTER_KEY (hex) or ~/.friday/master.key (never
auto-generated). --store-dir defaults to ~/.friday/agent-run-securestore.

DARK / PROOF-ONLY: this helper is NOT wired into prod, registers no route, and is NEVER
invoked automatically by the hub or any coordinator process. The operator runs it by hand.";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            // The error category is secret-free by construction (SignerError / CliError
            // carry no seed / master / plaintext); safe to print.
            eprintln!("friday-operator-sign: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("provision") => cmd_provision(&args[2..]),
        Some("sign") => cmd_sign(&args[2..]),
        Some("help") | Some("--help") | Some("-h") | None => {
            println!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(format!("unknown subcommand {other:?}\n\n{USAGE}")),
    }
}

fn resolve_store_dir(args: &[String]) -> Result<std::path::PathBuf, String> {
    match arg_value(args, "--store-dir") {
        Some(p) => Ok(std::path::PathBuf::from(p)),
        None => default_store_dir().map_err(|e| e.to_string()),
    }
}

fn cmd_provision(args: &[String]) -> Result<(), String> {
    let store_dir = resolve_store_dir(args)?;

    // The seed is the SECRET. Prefer stdin (never in argv / shell history); --seed-hex is
    // a convenience that DOES land in argv, so it is flagged in the usage text.
    let seed_hex = if args.iter().any(|a| a == "--seed-stdin") {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|_| "could not read seed from stdin".to_string())?;
        buf.trim().to_string()
    } else {
        arg_value(args, "--seed-hex").ok_or_else(|| {
            format!("provision requires --seed-hex <64-hex> or --seed-stdin\n\n{USAGE}")
        })?
    };

    let seed = decode_seed_hex(&seed_hex)
        .ok_or_else(|| "seed must be exactly 64 hex chars (32 bytes)".to_string())?;
    let result = provision_signing_seed_into_store(&store_dir, &seed).map_err(|e| e.to_string());
    // Wipe the decoded seed copy regardless of outcome.
    let mut seed = seed;
    zeroize_vec(&mut seed);
    result?;

    // The seed bytes never appear here — only a non-secret confirmation to stderr.
    eprintln!(
        "operator signing seed provisioned into the SecureStore at {} (KEK-wrapped under the host master key).",
        store_dir.display()
    );
    Ok(())
}

fn cmd_sign(args: &[String]) -> Result<(), String> {
    let store_dir = resolve_store_dir(args)?;
    let request = arg_value(args, "--request")
        .ok_or_else(|| format!("sign requires --request <pending-request.json>\n\n{USAGE}"))?;
    let json = std::fs::read_to_string(&request)
        .map_err(|_| format!("could not read request file {request}"))?;
    let req: PendingRequest =
        serde_json::from_str(&json).map_err(|e| format!("invalid request JSON: {e}"))?;

    let signed = sign_pending_from_store(&store_dir, &req).map_err(|e| e.to_string())?;
    // The signed approval -> stdout. The private seed is never part of this output (it is
    // the OPERATOR side's secret; only the public signature + the Hub-computed digest the
    // operator signed are emitted).
    println!(
        "{}",
        serde_json::to_string_pretty(&signed).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// Decode exactly [`SIGNING_SEED_LEN`] bytes of hex. `None` for any non-hex / wrong-length
/// input (fail-closed; never panics).
fn decode_seed_hex(s: &str) -> Option<Vec<u8>> {
    let b = s.trim().as_bytes();
    if b.len() != SIGNING_SEED_LEN * 2 {
        return None;
    }
    let mut out = Vec::with_capacity(SIGNING_SEED_LEN);
    for pair in b.chunks_exact(2) {
        out.push((hex_nibble(pair[0])? << 4) | hex_nibble(pair[1])?);
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

/// Best-effort wipe of a secret byte buffer (the decoded seed) before it drops.
fn zeroize_vec(v: &mut [u8]) {
    use zeroize::Zeroize;
    v.zeroize();
}

/// `--name value` or `--name=value`. Mirrors the existing Hub / operator-cli bins.
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
    fn decode_seed_hex_is_fail_closed() {
        assert!(decode_seed_hex(&"a".repeat(64)).is_some());
        assert!(decode_seed_hex(&"A".repeat(64)).is_some()); // uppercase ok
        assert!(decode_seed_hex(&"a".repeat(62)).is_none()); // too short
        assert!(decode_seed_hex(&"a".repeat(66)).is_none()); // too long
        assert!(decode_seed_hex(&"z".repeat(64)).is_none()); // non-hex
        assert!(decode_seed_hex("").is_none());
    }

    #[test]
    fn arg_value_supports_both_forms() {
        let args = vec![
            "--store-dir".to_string(),
            "/tmp/x".to_string(),
            "--request=/tmp/r.json".to_string(),
        ];
        assert_eq!(arg_value(&args, "--store-dir"), Some("/tmp/x".to_string()));
        assert_eq!(
            arg_value(&args, "--request"),
            Some("/tmp/r.json".to_string())
        );
        assert_eq!(arg_value(&args, "--missing"), None);
    }
}
