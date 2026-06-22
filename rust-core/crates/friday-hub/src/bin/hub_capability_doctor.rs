//! Read-only capability-doctor surface — `hub_capability_doctor`. PROOF-ONLY / DARK.
//!
//! A thin one-shot bin over the hub-library composite
//! [`friday_hub::capability_doctor::CapabilityDoctor`], surfacing the (now 503)
//! `capabilities.doctor` / `providers.doctor` / `providers.validate` retired TS
//! surfaces at the Rust layer. It composes TWO orthogonal, truth-labeled signals as
//! TWO separate sections — never collapsed:
//!
//! 1. **CLI-detect** (`codex`, `claude`) — the LOCAL onboarding question: does each
//!    provider CLI report itself logged-in? Run via [`friday_providers::CliProbe`]'s
//!    read-only `status` command — **no model call, no quota, no network beyond the
//!    CLI's own local auth check, no secret read**. This is the SAME signal A3's
//!    `hub_providers_detect` emits (this bin subsumes that detect — see the
//!    "subsumes detect" note below).
//! 2. **Live key-validation** (`deepseek`, `anthropic`) — the orthogonal LIVE
//!    question: does each API credential actually round-trip? DeepSeek =
//!    authenticated `GET /models` (NO completion quota); Anthropic = minimal
//!    `POST /v1/messages` `max_tokens=1` (~1-2 tokens of LIVE quota).
//!
//! ## Default-OFF / quota safety (the key safety posture)
//! Because the Anthropic validate arm SPENDS LIVE QUOTA on bare invocation, the live
//! key-validation section is GATED behind an explicit `--validate-keys` flag and is
//! **default OFF**. With NO flag the bin runs ONLY the zero-quota CLI-detect section
//! (safe to run anywhere, including the key-bearing prod hub) and reports
//! `key_validation_probed=false` + a `null` key section — an HONEST "we did not
//! check," NOT a fabricated "all keys missing" (a no-fallback/truth-label violation
//! would be to inject a mock and synthesize `CredentialMissing` for unprobed keys).
//! Only with `--validate-keys` does it inject the real
//! [`friday_hub::provider_key_validation::LiveKeyValidationProbe`] and run the live
//! round-trips. So *deploying the binary is safe* — it spends nothing until an
//! operator explicitly asks for the live arm.
//!
//! ## DARK — built ready, NOT routed
//! Registers NO production route, is NOT in `friday_hub::capability`'s route table,
//! and does NOT flip the live TS `capabilities.doctor`/`providers.validate`/
//! `providers.doctor` paths. TS wiring is operator-/design-handoff-gated and OUT OF
//! SCOPE. Confers no v1 GO.
//!
//! ## "Subsumes detect" — coordinated, but does NOT touch A3's bin
//! `CapabilityDoctor`'s CLI section IS provider-detect, so this bin can serve both
//! `detect` and `validate`/`doctor`. To avoid a competing change it does NOT modify
//! or delete A3's already-merged `hub_providers_detect` bin; consolidating the two is
//! a deliberate FUTURE cleanup (recorded as a concern), not part of this slice.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no account info)
//! Emits a single JSON object to stdout with ONLY secret-safe fields:
//! - `truth_label="rust_capability_doctor"`, `proof_only=true`, `ok=true`
//! - `cli_detected`: one entry per CLI provider with ONLY the four safe
//!   [`friday_providers::ProviderAuthStatus`] fields (`provider`, `installed`,
//!   `authenticated`, static `detail`).
//! - `cli_logged_in`: the safe labels of the CLI providers reporting logged-in
//!   (derived per-provider, never a fallback).
//! - `key_validation_probed`: `true` iff `--validate-keys` was passed.
//! - `key_validation`: when probed, one entry per credential with ONLY the coarse
//!   safe fields — the credential label, the static outcome `label`, and (where
//!   present) the coarse HTTP `status` (Invalid) or static `detail` (Unavailable).
//!   When NOT probed this is `null`.
//! - `confirmed_valid_keys`: when probed, the credentials a live round-trip CONFIRMED
//!   valid (ONLY `Valid` — an `Unavailable` "could-not-confirm" is NOT counted);
//!   `null` when not probed.
//!
//! It NEVER emits a raw [`friday_providers::ProbeOutput`] (CLI stdout/stderr) — the
//! parsed status carries none of those account fields — nor any request/response body
//! or key (the [`friday_providers::KeyValidationOutcome`] is already coarse). A
//! defensive output guard (the SAME shared `refs_guard` the `hub_providers_detect`
//! bin uses, with the same raw-CLI markers) rejects any forbidden marker before
//! printing.

use std::env;
use std::ffi::OsString;

use friday_hub::capability_doctor::{CapabilityDoctor, KeyValidationSignal};
use friday_hub::provider_doctor::ProviderDoctor;
use friday_hub::provider_key_validation::LiveKeyValidationProbe;
use friday_hub::provider_route_readiness::{
    backend_kind_label, model_size_label, provider_api_label, FailoverReadiness,
    ProviderReadinessFlags, ProviderReadinessReport, ProviderRouteReadiness,
};
use friday_hub::routing::{ProviderRoute, RouteRegistry};
use friday_hub::runtime::{
    ENV_CLAUDE_ROUTE_ENABLED, ENV_CODEX_ROUTE_ENABLED, ENV_DEEPSEEK_PRO_ROUTE_ENABLED,
    ENV_PROVIDER_FAILOVER, ENV_PROVIDER_FAILOVER_CLAUDE_TO_DEEPSEEK,
};
use friday_providers::{CliProbe, Provider, ProviderAuthStatus};
use serde_json::{json, Value};

/// A fail-closed error: `kind` is a coarse, safe category (the only thing surfaced);
/// the raw detail is deliberately NOT carried so nothing path-/account-shaped can leak
/// through an error path. `Debug` is safe to derive because the only field is a
/// closed-vocabulary `&'static str`.
#[derive(Debug)]
struct BridgeError {
    kind: &'static str,
}

impl BridgeError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    // Read argv as OsString and convert fail-closed: a non-UTF-8 arg (in ANY position)
    // maps to a coarse `bad_args` error rather than PANICKING the way `env::args()`
    // does inside `.collect()`. Mirrors `hub_providers_detect`'s contract.
    let parsed = parse_args(env::args_os()).and_then(|args| run(&args));
    match parsed {
        Ok(rendered) => {
            println!("{rendered}");
        }
        Err(err) => {
            let payload = json!({
                "truth_label": "rust_capability_doctor",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            // Defense-in-depth: route the error payload through the SAME guard as the
            // success path. `error_kind` is a static closed-vocab token, so this never
            // suppresses output.
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_capability_doctor_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

/// Convert raw OS argv into UTF-8 `String`s fail-closed (see `hub_providers_detect`).
fn parse_args(args: impl Iterator<Item = OsString>) -> Result<Vec<String>, BridgeError> {
    args.map(|a| a.into_string().map_err(|_| BridgeError::new("bad_args")))
        .collect()
}

/// Whether the live key-validation section was requested. Default OFF — without this
/// flag the bin spends ZERO quota (CLI-detect only), so deploying/invoking it is safe
/// even on the key-bearing prod hub.
fn validate_keys_requested(args: &[String]) -> bool {
    args.iter().any(|a| a == "--validate-keys")
}

fn run(args: &[String]) -> Result<String, BridgeError> {
    // Reject any unknown flag fail-closed so a typo (e.g. `--validate-key`) can never
    // silently degrade to the wrong (or unintended) posture. Only `--validate-keys`
    // is recognized; argv[0] (the program name) and that one flag are allowed.
    for arg in args.iter().skip(1) {
        if arg != "--validate-keys" {
            return Err(BridgeError::new("bad_args"));
        }
    }

    let probe_keys = validate_keys_requested(args);
    // Production CLI probe: reads HOME, builds the absolute ~/.local/bin CLI paths.
    let cli_probe = CliProbe::default();

    if probe_keys {
        // LIVE arm: inject the real secret-bearing key-validation probe. DeepSeek =
        // authenticated GET /models (no completion quota); Anthropic = minimal POST
        // /v1/messages max_tokens=1 (~1-2 tokens). Operator-gated by the flag.
        let key_probe = LiveKeyValidationProbe::new();
        let doctor = CapabilityDoctor::run(&cli_probe, &key_probe);
        render_with_keys(&doctor)
    } else {
        // DEFAULT (safe): CLI-detect only, ZERO quota. Run the SAME R6 engine the
        // detect bin uses (no key probe constructed, no network beyond the CLI). The
        // key section is honestly `null` / not-probed — NOT a fabricated all-missing.
        let cli_doctor = ProviderDoctor::run_for(&cli_probe, Provider::all());
        render_cli_only(&cli_doctor.statuses)
    }
}

/// Render the CLI-detect section JSON entries (the four safe fields each) + the
/// derived `cli_logged_in` labels. Shared by both render paths so the CLI shape is
/// byte-identical whether or not keys were probed.
fn cli_section(statuses: &[ProviderAuthStatus]) -> (Vec<Value>, Vec<&'static str>) {
    let detected: Vec<Value> = statuses
        .iter()
        .map(|status| {
            json!({
                "provider": status.provider.as_str(),
                "installed": status.installed,
                "authenticated": status.authenticated,
                "detail": status.detail,
            })
        })
        .collect();
    let logged_in: Vec<&'static str> = statuses
        .iter()
        .filter(|s| s.authenticated)
        .map(|s| s.provider.as_str())
        .collect();
    (detected, logged_in)
}

/// Render the per-credential key-validation entry — ONLY the coarse safe fields. The
/// `status` (Invalid) / `detail` (Unavailable) are surfaced via the typed accessors,
/// never via `Debug` (which could, in principle, format more than intended).
fn key_entry(signal: &KeyValidationSignal) -> Value {
    use friday_providers::KeyValidationOutcome::*;
    let (status, detail) = match signal.outcome {
        Invalid { status } => (Some(status), None),
        Unavailable { detail } => (None, Some(detail)),
        Valid | CredentialMissing => (None, None),
    };
    json!({
        "provider": signal.provider.as_str(),
        "label": signal.outcome.label(),
        "status": status,
        "detail": detail,
    })
}

/// Default-OFF render: CLI-detect only. The key section is honestly absent —
/// `key_validation_probed=false`, `key_validation=null`, `confirmed_valid_keys=null`.
/// "We did not check" is NOT "all keys missing": we deliberately do NOT fabricate a
/// per-key outcome for credentials we never probed.
fn render_cli_only(statuses: &[ProviderAuthStatus]) -> Result<String, BridgeError> {
    let (detected, logged_in) = cli_section(statuses);
    let payload = json!({
        "truth_label": "rust_capability_doctor",
        "proof_only": true,
        "ok": true,
        "cli_detected": detected,
        "cli_logged_in": logged_in,
        "key_validation_probed": false,
        "key_validation": Value::Null,
        "confirmed_valid_keys": Value::Null,
        "route_readiness": Value::Null,
        "suggested_text_route": Value::Null,
        "suggested_strong_route": Value::Null,
        "failover_readiness": Value::Null,
    });
    finish(payload)
}

/// Full composite render: CLI-detect section PLUS the live key-validation section,
/// kept as TWO distinct sections (never collapsed). Driven by the hub-library
/// [`CapabilityDoctor`] so the no-collapse + truth-label invariants are the same the
/// library enforces.
fn render_with_keys(doctor: &CapabilityDoctor) -> Result<String, BridgeError> {
    let (detected, logged_in) = cli_section(&doctor.cli_statuses);

    let key_validation: Vec<Value> = doctor.key_signals.iter().map(key_entry).collect();
    // Derived per-credential (no-fallback): ONLY `Valid` counts — an `Unavailable`
    // could-not-confirm is excluded. Labels only; no account info.
    let confirmed: Vec<&'static str> = doctor
        .confirmed_valid_keys()
        .iter()
        .map(|kp| kp.as_str())
        .collect();
    let readiness = doctor.provider_readiness_report(
        &runtime_readiness_registry(),
        ProviderReadinessFlags {
            deepseek_to_claude_failover: env_exact_one(ENV_PROVIDER_FAILOVER),
            claude_to_deepseek_failover: env_exact_one(ENV_PROVIDER_FAILOVER_CLAUDE_TO_DEEPSEEK),
        },
    );
    let route_readiness = route_readiness_entries(&readiness);
    let failover_readiness = failover_readiness_entries(&readiness);

    let payload = json!({
        "truth_label": "rust_capability_doctor",
        "proof_only": true,
        "ok": true,
        "cli_detected": detected,
        "cli_logged_in": logged_in,
        "key_validation_probed": true,
        "key_validation": key_validation,
        "confirmed_valid_keys": confirmed,
        "route_readiness": route_readiness,
        "suggested_text_route": readiness.suggested_text_route,
        "suggested_strong_route": readiness.suggested_strong_route,
        "failover_readiness": failover_readiness,
    });
    finish(payload)
}

fn runtime_readiness_registry() -> RouteRegistry {
    let mut registry = RouteRegistry::autonomous_baseline();
    if !env_exact_one(ENV_DEEPSEEK_PRO_ROUTE_ENABLED) {
        set_route_state(&mut registry, "deepseek-pro", false, false);
    }
    if env_exact_one(ENV_CLAUDE_ROUTE_ENABLED) {
        set_route_state(&mut registry, "claude", true, true);
    }
    if env_exact_one(ENV_CODEX_ROUTE_ENABLED) {
        set_route_state(&mut registry, "codex", true, true);
    }
    registry
}

fn set_route_state(
    registry: &mut RouteRegistry,
    provider_id: &str,
    available: bool,
    validation_ok: bool,
) {
    if let Some(route) = registry.get(provider_id).cloned() {
        registry.register(ProviderRoute {
            available,
            validation_ok,
            ..route
        });
    }
}

fn env_exact_one(key: &str) -> bool {
    matches!(std::env::var(key), Ok(value) if value.trim() == "1")
}

fn route_readiness_entries(report: &ProviderReadinessReport) -> Vec<Value> {
    report.routes.iter().map(route_readiness_entry).collect()
}

fn route_readiness_entry(route: &ProviderRouteReadiness) -> Value {
    let blockers: Vec<Value> = route
        .blockers
        .iter()
        .map(|blocker| {
            json!({
                "kind": blocker.kind.as_str(),
                "code": blocker.code,
            })
        })
        .collect();
    json!({
        "provider_id": route.provider_id,
        "api": provider_api_label(route.api),
        "backend_kind": backend_kind_label(route.backend_kind),
        "model": route.model,
        "model_size": model_size_label(route.model_size),
        "strength": route.strength.as_str(),
        "dispatchable": route.dispatchable,
        "blockers": blockers,
    })
}

fn failover_readiness_entries(report: &ProviderReadinessReport) -> Vec<Value> {
    report
        .failovers
        .iter()
        .map(failover_readiness_entry)
        .collect()
}

fn failover_readiness_entry(failover: &FailoverReadiness) -> Value {
    let blockers: Vec<Value> = failover
        .blockers
        .iter()
        .map(|blocker| {
            json!({
                "kind": blocker.kind.as_str(),
                "code": blocker.code,
            })
        })
        .collect();
    json!({
        "direction": failover.direction,
        "flag_enabled": failover.flag_enabled,
        "can_enable": failover.can_enable,
        "blockers": blockers,
    })
}

/// Serialize + run through the output guard (fail-closed on any forbidden marker).
fn finish(payload: Value) -> Result<String, BridgeError> {
    let rendered =
        serde_json::to_string(&payload).map_err(|_| BridgeError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the refs-only
/// payload. Reuses the SAME shared `refs_guard` the `hub_providers_detect` bin uses,
/// with the same raw-CLI account-field markers (`authMethod`/`subscriptionType`/
/// `loggedIn`) — the parsed CLI status carries none of these; the guard is a
/// structural backstop. The key section is already coarse (status/static label only),
/// so the same guard covers it without extra markers.
fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &["authMethod", "subscriptionType", "loggedIn"],
    )
    .map_err(|_| BridgeError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::{
        KeyProvider, KeyValidationOutcome, KeyValidationProbe, MockKeyValidationProbe, ProbeOutput,
        ProviderError, ProviderProbe,
    };
    use serde_json::{from_str, Value};
    use std::collections::HashMap;

    /// A mock CLI probe returning canned raw CLI output (or a missing-CLI error). It
    /// can return raw stdout containing account fields to prove the parsed surface
    /// strips them.
    struct MockCliProbe {
        out: HashMap<&'static str, Result<ProbeOutput, ()>>,
    }
    impl MockCliProbe {
        fn new() -> Self {
            Self {
                out: HashMap::new(),
            }
        }
        fn set(mut self, p: Provider, stdout: &str) -> Self {
            self.out.insert(
                p.as_str(),
                Ok(ProbeOutput {
                    stdout: stdout.to_string(),
                    stderr: String::new(),
                }),
            );
            self
        }
        fn set_missing(mut self, p: Provider) -> Self {
            self.out.insert(p.as_str(), Err(()));
            self
        }
    }
    impl ProviderProbe for MockCliProbe {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            match self.out.get(provider.as_str()) {
                Some(Ok(o)) => Ok(o.clone()),
                _ => Err(ProviderError::NotInstalled("mock".into())),
            }
        }
    }

    fn parse(rendered: &str) -> Value {
        from_str(rendered).expect("rendered payload is valid JSON")
    }

    /// Build the full-composite render through the SAME path `main` uses for the
    /// `--validate-keys` branch, but with mock probes (no network, no quota). This is
    /// the genuine end-to-end shape assertion, not a helper-only one.
    fn render_composite<P: ProviderProbe, K: KeyValidationProbe>(
        cli: &P,
        keys: &K,
    ) -> Result<String, BridgeError> {
        let doctor = CapabilityDoctor::run(cli, keys);
        render_with_keys(&doctor)
    }

    // ---------- arg parsing ----------

    #[test]
    fn validate_keys_flag_defaults_off_and_parses() {
        assert!(!validate_keys_requested(&["bin".to_string()]));
        assert!(validate_keys_requested(&[
            "bin".to_string(),
            "--validate-keys".to_string()
        ]));
    }

    #[test]
    fn unknown_flag_is_fail_closed_bad_args() {
        // A typo must NOT silently degrade to the default posture.
        let err = run(&["bin".to_string(), "--validate-key".to_string()])
            .expect_err("unknown flag must be rejected");
        assert_eq!(err.kind, "bad_args");
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_argv_is_fail_closed_not_a_panic() {
        use std::os::unix::ffi::OsStrExt;
        let argv = [
            OsString::from("hub_capability_doctor"),
            std::ffi::OsStr::from_bytes(&[0xff]).to_os_string(),
        ];
        let err = parse_args(argv.into_iter())
            .expect_err("non-UTF-8 argv must be rejected, not converted/panicked");
        assert_eq!(err.kind, "bad_args");
    }

    // ---------- default-OFF (no quota) render ----------

    #[test]
    fn default_off_renders_cli_only_and_honestly_omits_keys() {
        // No --validate-keys: only the CLI-detect section. The key section must be
        // honestly NULL/not-probed — NOT a fabricated all-missing.
        let statuses = vec![
            friday_providers::detect(
                &MockCliProbe::new().set(Provider::Codex, "Logged in using ChatGPT"),
                Provider::Codex,
            ),
            friday_providers::detect(
                &MockCliProbe::new().set(Provider::Claude, "{\n  \"loggedIn\": false\n}"),
                Provider::Claude,
            ),
        ];
        let rendered = render_cli_only(&statuses).expect("renders");
        let v = parse(&rendered);

        assert_eq!(v["truth_label"], "rust_capability_doctor");
        assert_eq!(v["ok"], true);
        assert_eq!(v["key_validation_probed"], false);
        // HONEST absence: null, not an array of fabricated CredentialMissing.
        assert!(
            v["key_validation"].is_null(),
            "key section must be null when not probed"
        );
        assert!(
            v["confirmed_valid_keys"].is_null(),
            "confirmed list must be null when not probed (not an empty array implying we checked)"
        );
        assert!(v["route_readiness"].is_null());
        assert!(v["failover_readiness"].is_null());

        // CLI section present + correct.
        let cli = v["cli_detected"].as_array().expect("cli_detected array");
        assert_eq!(cli.len(), 2);
        assert_eq!(cli[0]["provider"], "codex");
        assert_eq!(cli[0]["authenticated"], true);
        assert_eq!(cli[1]["provider"], "claude");
        assert_eq!(cli[1]["authenticated"], false);
        assert_eq!(
            v["cli_logged_in"].as_array().unwrap(),
            &vec![serde_json::json!("codex")]
        );
    }

    #[test]
    fn run_default_branch_spends_no_keys_and_omits_section() {
        // Drive the ACTUAL `run` default branch (no flag). It must not panic and must
        // emit a not-probed key section. (It uses the production CliProbe, which on a
        // CI box with no CLIs reports not_installed — that's fine; we assert the key
        // section is honestly absent, the part this test owns.)
        let rendered = run(&["bin".to_string()]).expect("default run renders");
        let v = parse(&rendered);
        assert_eq!(v["key_validation_probed"], false);
        assert!(v["key_validation"].is_null());
    }

    // ---------- full composite (mock-injected) render ----------

    #[test]
    fn composite_emits_two_distinct_sections_with_exact_safe_shapes() {
        // CLI: codex logged-in, claude logged-out. Keys: deepseek valid, anthropic
        // invalid(401). Both sections must appear side-by-side, never merged.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(
                KeyProvider::Anthropic,
                KeyValidationOutcome::Invalid { status: 401 },
            );
        let rendered = render_composite(&cli, &keys).expect("renders");
        let v = parse(&rendered);

        assert_eq!(v["key_validation_probed"], true);

        // CLI section: exactly the four safe keys per entry.
        let cli_arr = v["cli_detected"].as_array().expect("cli array");
        assert_eq!(cli_arr.len(), 2);
        for entry in cli_arr {
            let obj = entry.as_object().unwrap();
            assert_eq!(obj.len(), 4, "cli entry must carry exactly 4 safe keys");
            for k in ["provider", "installed", "authenticated", "detail"] {
                assert!(obj.contains_key(k));
            }
        }
        assert_eq!(cli_arr[0]["provider"], "codex");
        assert_eq!(cli_arr[0]["authenticated"], true);
        assert_eq!(cli_arr[1]["provider"], "claude");
        assert_eq!(cli_arr[1]["authenticated"], false);
        assert_eq!(
            v["cli_logged_in"].as_array().unwrap(),
            &vec![serde_json::json!("codex")]
        );

        // Key section: exactly the four safe keys per entry, in KeyProvider::all() order.
        let keys_arr = v["key_validation"].as_array().expect("key array");
        assert_eq!(keys_arr.len(), 2);
        for entry in keys_arr {
            let obj = entry.as_object().unwrap();
            assert_eq!(obj.len(), 4, "key entry must carry exactly 4 safe keys");
            for k in ["provider", "label", "status", "detail"] {
                assert!(obj.contains_key(k));
            }
        }
        // deepseek valid: label valid, no status/detail.
        assert_eq!(keys_arr[0]["provider"], "deepseek");
        assert_eq!(keys_arr[0]["label"], "valid");
        assert!(keys_arr[0]["status"].is_null());
        assert!(keys_arr[0]["detail"].is_null());
        // anthropic invalid: label invalid + coarse status 401, no detail.
        assert_eq!(keys_arr[1]["provider"], "anthropic");
        assert_eq!(keys_arr[1]["label"], "invalid");
        assert_eq!(keys_arr[1]["status"], 401);
        assert!(keys_arr[1]["detail"].is_null());

        // Confirmed-valid: only deepseek (anthropic invalid).
        assert_eq!(
            v["confirmed_valid_keys"].as_array().unwrap(),
            &vec![serde_json::json!("deepseek")]
        );
        let route_readiness = v["route_readiness"]
            .as_array()
            .expect("route_readiness array");
        let deepseek = route_readiness
            .iter()
            .find(|entry| entry["provider_id"] == "deepseek")
            .expect("deepseek route readiness is surfaced");
        assert_eq!(deepseek["dispatchable"], true);
        assert_eq!(deepseek["strength"], "cheap");
        assert!(
            v["failover_readiness"].is_array(),
            "failover readiness is surfaced with route readiness"
        );
    }

    #[test]
    fn claude_cli_and_anthropic_key_are_never_folded_into_one_verdict() {
        // The false-collapse guard at the render level: claude CLI logged-IN but the
        // anthropic API key INVALID(403). The render must keep them distinct — claude
        // shows authenticated in the CLI section, anthropic shows invalid in the key
        // section — with NO single merged "Claude ready" field.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Not logged in")
            .set(Provider::Claude, "{\n  \"loggedIn\": true\n}");
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(
                KeyProvider::Anthropic,
                KeyValidationOutcome::Invalid { status: 403 },
            );
        let rendered = render_composite(&cli, &keys).expect("renders");
        let v = parse(&rendered);

        // claude CLI authenticated.
        let claude = v["cli_detected"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["provider"] == "claude")
            .unwrap();
        assert_eq!(claude["authenticated"], true);

        // anthropic key invalid(403) — independently surfaced, not hidden by the login.
        let anthropic = v["key_validation"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["provider"] == "anthropic")
            .unwrap();
        assert_eq!(anthropic["label"], "invalid");
        assert_eq!(anthropic["status"], 403);

        // No collapse: no top-level field named after a single fused "claude ready".
        let obj = v.as_object().unwrap();
        assert!(!obj.contains_key("claude_ready"));
        assert!(!obj.contains_key("ready"));
    }

    #[test]
    fn unavailable_key_is_not_counted_confirmed_but_its_outcome_is_surfaced() {
        // Honesty core at the render level: a transient Unavailable must NOT be in
        // confirmed_valid_keys, but its exact coarse outcome (label + detail) is still
        // surfaced in the key section.
        let cli = MockCliProbe::new()
            .set_missing(Provider::Codex)
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let keys = MockKeyValidationProbe::new()
            .with(
                KeyProvider::DeepSeek,
                KeyValidationOutcome::Unavailable {
                    detail: "provider_unavailable",
                },
            )
            .with(KeyProvider::Anthropic, KeyValidationOutcome::Valid);
        let rendered = render_composite(&cli, &keys).expect("renders");
        let v = parse(&rendered);

        // confirmed: only anthropic.
        assert_eq!(
            v["confirmed_valid_keys"].as_array().unwrap(),
            &vec![serde_json::json!("anthropic")]
        );
        // deepseek outcome still surfaced as unavailable + its coarse detail.
        let ds = v["key_validation"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["provider"] == "deepseek")
            .unwrap();
        assert_eq!(ds["label"], "unavailable");
        assert_eq!(ds["detail"], "provider_unavailable");
        assert!(ds["status"].is_null());
    }

    #[test]
    fn credential_missing_key_is_labeled_missing_not_invalid() {
        // An UNSET key must read credential_missing (a setup blocker), DISTINCT from
        // invalid (a rejected key). No status, no detail.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let keys = MockKeyValidationProbe::new(); // both unset → CredentialMissing
        let rendered = render_composite(&cli, &keys).expect("renders");
        let v = parse(&rendered);

        for kp in ["deepseek", "anthropic"] {
            let e = v["key_validation"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["provider"] == kp)
                .unwrap();
            assert_eq!(
                e["label"], "credential_missing",
                "{kp} must be credential_missing"
            );
            assert!(e["status"].is_null());
            assert!(e["detail"].is_null());
        }
        assert!(v["confirmed_valid_keys"].as_array().unwrap().is_empty());
    }

    // ---------- secret hygiene ----------

    #[test]
    fn render_strips_raw_cli_account_fields() {
        // Even when the CLI mock returns account-laden raw stdout, the parsed surface
        // discards it; the rendered JSON carries none of those fields and the guard
        // passes.
        let cli = MockCliProbe::new().set(
            Provider::Claude,
            "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\",\n  \"subscriptionType\": \"max\",\n  \"email\": \"someone@example.com\"\n}",
        );
        let keys =
            MockKeyValidationProbe::new().with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid);
        let rendered = render_composite(&cli, &keys).expect("renders (guard passes)");

        for forbidden in ["authMethod", "subscriptionType", "loggedIn", "example.com"] {
            assert!(
                !rendered.contains(forbidden),
                "raw account field {forbidden} must be stripped"
            );
        }
    }

    #[test]
    fn output_guard_blocks_secret_and_raw_cli_markers() {
        // CANARY: the shared guard trips on the marker set (secret + raw-CLI).
        assert!(reject_forbidden_output(r#"{"x":"authMethod"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"subscriptionType"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"loggedIn"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"sk-secret"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"p":"/Users/someone"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"p":"/private/tmp"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"h":"Authorization: x"}"#).is_err());
    }

    #[test]
    fn actual_safe_output_clears_the_guard_no_marker_collision() {
        // Verify (not just reason) the bin's REAL output for both postures clears the
        // guard — the snake_case/static labels do not collide with any marker. Use
        // logged-in + valid so the most marker-adjacent labels appear.
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": true\n}");
        // Composite (keys probed).
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(KeyProvider::Anthropic, KeyValidationOutcome::Valid);
        let composite = render_composite(&cli, &keys).expect("renders");
        assert!(
            reject_forbidden_output(&composite).is_ok(),
            "composite safe output must clear the guard: {composite}"
        );

        // Default-off (CLI only).
        let statuses: Vec<_> = Provider::all()
            .iter()
            .map(|&p| friday_providers::detect(&cli, p))
            .collect();
        let cli_only = render_cli_only(&statuses).expect("renders");
        assert!(
            reject_forbidden_output(&cli_only).is_ok(),
            "cli-only safe output must clear the guard: {cli_only}"
        );
    }

    #[test]
    fn never_serializes_raw_stream_field_names() {
        // The raw ProbeOutput stream fields must never reach output (structurally,
        // ProbeOutput is not Serialize; also assert at runtime).
        let cli = MockCliProbe::new().set(Provider::Codex, "Logged in using ChatGPT");
        let keys = MockKeyValidationProbe::new();
        let rendered = render_composite(&cli, &keys).expect("renders");
        assert!(!rendered.contains("stdout"));
        assert!(!rendered.contains("stderr"));
    }
}
