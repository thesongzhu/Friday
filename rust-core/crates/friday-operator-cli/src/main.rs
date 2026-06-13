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
//!
//! NS-3 adds two MORE subcommands — `grant` and `revoke` — the operator POLICY action
//! that mints / revokes a TrustGrant in the Hub DB (via `friday_storage`). They are
//! what make NS-2's (separate, default-OFF) enforced trust check satisfiable. DARK:
//! invoked from the CLI, NOT wired into the live run loop, enforcement stays OFF.

use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_operator_cli::trust_grant;
use friday_operator_cli::{keygen_to_path, sign_request, PendingRequest};

const USAGE: &str = "\
friday-operator-approve — operator CLI (S6c signing + NS-3 trust-grant issuance)

USAGE:
    friday-operator-approve keygen --out <private-key-path>
    friday-operator-approve sign  --key <private-key-path> --request <pending-request.json>
    friday-operator-approve grant  --db <hub.sqlite> --grant-id <id> --agent <agent-id> \\
                                    --risk-ceiling <read_only|low|medium|high|critical> \\
                                    [--expires-at <epoch-ms>] [--workspace <path-prefix>] \\
                                    [--token-ceiling <n>] [--max-runs <n>] \\
                                    [--tools a,b] [--providers a,b] [--channels a,b] \\
                                    [--workflow-families a,b] [--skill-families a,b]
    friday-operator-approve revoke --db <hub.sqlite> --grant-id <id>

keygen writes the operator PRIVATE key (mode 0600) to --out and prints the PUBLIC
verifying key (JSON) to stdout for Hub provisioning. The private key is never printed.

sign reads a pending request JSON and emits an Ed25519-signed CanonicalApproval (JSON)
to stdout. The private key never appears in the output.

grant mints a TrustGrant for --agent with the given boundaries (operator POLICY action;
the allowlists are fail-closed — an omitted dimension is DENY-ALL) and prints the
persisted grant (JSON). revoke marks the grant --grant-id revoked. Both write a
hash-chained audit row. DARK: this does NOT enable enforcement (NS-2 owns that flag).";

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
        Some("grant") => cmd_grant(&args[2..]),
        Some("revoke") => cmd_revoke(&args[2..]),
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

/// NS-3 `grant`: mint a TrustGrant for --agent with the supplied boundaries against the
/// Hub DB. Operator POLICY action. Prints the persisted grant as JSON to stdout. DARK —
/// does NOT enable enforcement (NS-2 owns that flag).
fn cmd_grant(args: &[String]) -> Result<(), String> {
    let db_path = arg_value(args, "--db")
        .ok_or_else(|| format!("grant requires --db <hub.sqlite>\n\n{USAGE}"))?;
    let grant_id = arg_value(args, "--grant-id")
        .ok_or_else(|| format!("grant requires --grant-id <id>\n\n{USAGE}"))?;
    let agent_id = arg_value(args, "--agent")
        .ok_or_else(|| format!("grant requires --agent <agent-id>\n\n{USAGE}"))?;
    let risk_str = arg_value(args, "--risk-ceiling").ok_or_else(|| {
        format!("grant requires --risk-ceiling <read_only|low|medium|high|critical>\n\n{USAGE}")
    })?;
    let risk_ceiling = trust_grant::parse_risk(&risk_str).map_err(|e| e.to_string())?;

    let spec = trust_grant::build_spec(
        grant_id,
        agent_id,
        risk_ceiling,
        arg_i64(args, "--expires-at")?,
        arg_value(args, "--workspace"),
        arg_i64(args, "--token-ceiling")?,
        arg_i64(args, "--max-runs")?,
        trust_grant::parse_csv(arg_value(args, "--channels").as_deref()),
        trust_grant::parse_csv(arg_value(args, "--providers").as_deref()),
        trust_grant::parse_csv(arg_value(args, "--tools").as_deref()),
        trust_grant::parse_csv(arg_value(args, "--workflow-families").as_deref()),
        trust_grant::parse_csv(arg_value(args, "--skill-families").as_deref()),
    )
    .map_err(|e| e.to_string())?;

    let db = trust_grant::open_hub(&db_path).map_err(|e| e.to_string())?;
    let grant = trust_grant::issue(&db, &spec, now_ms()?).map_err(|e| e.to_string())?;

    // Echo the persisted grant (JSON) for operator review + machine parsing. The
    // boundaries are flattened from the stored TrustGrant so the round-trip is visible.
    let b = &grant.boundaries;
    let out = serde_json::json!({
        "result": "granted",
        "grant_id": grant.grant_id,
        "agent_id": grant.agent_id,
        "granted_at": grant.granted_at,
        "expires_at": grant.expires_at,
        "boundaries": {
            "workspace": b.workspace,
            "risk_ceiling": b.risk_ceiling.as_str(),
            "token_ceiling": b.token_ceiling,
            "max_runs": b.max_runs,
            "allowed_channels": b.allowed_channels,
            "allowed_providers": b.allowed_providers,
            "allowed_tools": b.allowed_tools,
            "allowed_workflow_families": b.allowed_workflow_families,
            "allowed_skill_families": b.allowed_skill_families,
        },
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// NS-3 `revoke`: mark --grant-id revoked in the Hub DB. Prints a small JSON receipt.
fn cmd_revoke(args: &[String]) -> Result<(), String> {
    let db_path = arg_value(args, "--db")
        .ok_or_else(|| format!("revoke requires --db <hub.sqlite>\n\n{USAGE}"))?;
    let grant_id = arg_value(args, "--grant-id")
        .ok_or_else(|| format!("revoke requires --grant-id <id>\n\n{USAGE}"))?;
    let now = now_ms()?;
    let db = trust_grant::open_hub(&db_path).map_err(|e| e.to_string())?;
    trust_grant::revoke(&db, &grant_id, now).map_err(|e| e.to_string())?;
    let out = serde_json::json!({
        "result": "revoked",
        "grant_id": grant_id,
        "revoked_at": now,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?
    );
    Ok(())
}

/// Current wall-clock as epoch-ms. The CLI supplies the clock; the library issuance fn
/// takes `now` as an argument so a test can pin it.
fn now_ms() -> Result<i64, String> {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the unix epoch".to_string())?
        .as_millis();
    i64::try_from(ms).map_err(|_| "system clock overflows i64 epoch-ms".to_string())
}

/// Parse an OPTIONAL `--name <i64>` flag. Absent => `None`; present-but-unparseable =>
/// a clean error (fail-closed — never silently treated as absent).
fn arg_i64(args: &[String], name: &str) -> Result<Option<i64>, String> {
    match arg_value(args, name) {
        None => Ok(None),
        Some(v) => v
            .parse::<i64>()
            .map(Some)
            .map_err(|_| format!("{name} must be an integer, got {v:?}")),
    }
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
