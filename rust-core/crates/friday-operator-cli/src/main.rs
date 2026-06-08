//! `friday-operator-approve` — the OFFLINE operator-signing CLI (slice S6c).
//!
//! Two subcommands:
//!
//! ```text
//! friday-operator-approve keygen --out <private-key-path>
//!     Generate an operator Ed25519 keypair. The PRIVATE seed is written to
//!     <private-key-path> (mode 0600); the PUBLIC verifying key is printed to
//!     stdout as JSON — provision THAT into the Hub's S6b verify-only policy. The
//!     private key is NEVER printed or logged.
//!
//! friday-operator-approve sign --key <private-key-path> --request <pending.json>
//!     Read a pending request (the fields S6b persists when a mutating action
//!     Pauses), load the PRIVATE key, and emit an Ed25519-signed CanonicalApproval
//!     as JSON to stdout. No network. The private key never appears in the output.
//! ```
//!
//! Truth label: offline operator-signing tool (operator-held private key; the Hub
//! holds only the public key). NOT wired to a live resume (S6d). PROOF-ONLY.

use std::path::Path;
use std::process::ExitCode;

use friday_operator_cli::{keygen_to_path, sign_request, PendingRequest};

const USAGE: &str = "\
friday-operator-approve — offline operator-signing CLI (S6c)

USAGE:
    friday-operator-approve keygen --out <private-key-path>
    friday-operator-approve sign  --key <private-key-path> --request <pending-request.json>

keygen writes the operator PRIVATE key (mode 0600) to --out and prints the PUBLIC
verifying key (JSON) to stdout for Hub provisioning. The private key is never printed.

sign reads a pending request JSON and emits an Ed25519-signed CanonicalApproval (JSON)
to stdout. The private key never appears in the output.";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("friday-operator-approve: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("keygen") => cmd_keygen(&args[2..]),
        Some("sign") => cmd_sign(&args[2..]),
        Some("help") | Some("--help") | Some("-h") | None => {
            println!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(format!("unknown subcommand {other:?}\n\n{USAGE}")),
    }
}

fn cmd_keygen(args: &[String]) -> Result<(), String> {
    let out = arg_value(args, "--out")
        .ok_or_else(|| format!("keygen requires --out <private-key-path>\n\n{USAGE}"))?;
    let vk_hex = keygen_to_path(Path::new(&out)).map_err(|e| e.to_string())?;
    // PUBLIC key only -> stdout (machine-parseable; this is what the Hub provisions).
    let public = serde_json::json!({
        "scheme": "ed25519",
        "verifying_key": vk_hex,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&public).map_err(|e| e.to_string())?
    );
    // Operator note -> stderr (the PATH is not secret; the key bytes never appear).
    eprintln!("operator private key written to {out} (mode 0600); keep it off the Hub. Provision the verifying_key above into the Hub.");
    Ok(())
}

fn cmd_sign(args: &[String]) -> Result<(), String> {
    let key = arg_value(args, "--key")
        .ok_or_else(|| format!("sign requires --key <private-key-path>\n\n{USAGE}"))?;
    let request = arg_value(args, "--request")
        .ok_or_else(|| format!("sign requires --request <pending-request.json>\n\n{USAGE}"))?;
    let json = std::fs::read_to_string(&request)
        .map_err(|_| format!("could not read request file {request}"))?;
    let req: PendingRequest =
        serde_json::from_str(&json).map_err(|e| format!("invalid request JSON: {e}"))?;
    let signed = sign_request(Path::new(&key), &req).map_err(|e| e.to_string())?;
    // Signed approval -> stdout. The private key is never part of this output.
    println!(
        "{}",
        serde_json::to_string_pretty(&signed).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// `--name value` or `--name=value`. Mirrors the existing Hub bins' arg parsing.
fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}
