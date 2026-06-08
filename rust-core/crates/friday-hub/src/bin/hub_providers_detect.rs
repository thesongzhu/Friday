//! Read-only providers-detect surface — `hub_providers_detect`.
//!
//! PROOF-ONLY. A thin one-shot bin that surfaces the existing
//! [`friday_providers::detect`] engine as a reachable, refs-only entrypoint,
//! cloning the read-only output-guard shape of the `hub_run_task` write-bridge.
//!
//! It runs ONLY each provider CLI's official, read-only **status** command
//! (`codex login status`, `claude auth status`) via [`friday_providers::CliProbe`]
//! — never a prompt/send — so **no model call** occurs, no quota is spent, no
//! network is touched beyond the CLI's own local auth check, and no secret is read.
//!
//! This resolves the (now 503) `providers/detect` onboarding surface at the Rust
//! layer. It does NOT register a production route and confers no v1 GO. TS wiring
//! is deferred (design-handoff gated) and OUT OF SCOPE here.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no account info)
//! Emits a single JSON object to stdout carrying ONLY the secret-safe
//! [`friday_providers::ProviderAuthStatus`] fields — the provider label, the
//! `installed`/`authenticated` booleans, and a coarse static `detail`
//! (`"logged_in" | "not_logged_in" | "not_installed"`). It NEVER emits the raw
//! [`friday_providers::ProbeOutput`] (CLI stdout/stderr), which can carry
//! `authMethod`/`subscriptionType`/account identifiers. A defensive output guard
//! rejects any forbidden marker before printing.

use std::env;
use std::ffi::OsString;

use friday_providers::{detect, CliProbe, Provider, ProviderProbe};
use serde_json::json;

/// A fail-closed error: `kind` is a coarse, safe category (the only thing
/// surfaced); the raw detail is deliberately NOT carried so nothing path- or
/// account-shaped can leak through an error path. `Debug` is safe to derive
/// because the only field is a closed-vocabulary `&'static str` (used by the
/// tests' `.expect`/`.unwrap_err`); it can never carry a path/secret/account.
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
    // Read argv as OsString and convert fail-closed: a non-UTF-8 arg (in ANY
    // position) maps to a coarse `bad_args` error rather than PANICKING the way
    // `env::args()` does inside `.collect()`. This keeps the bin's "never a
    // panic / fail-closed, coarse error kind + exit 2" contract intact for
    // inputs like `hub_providers_detect $'\xff'` (a bare non-UTF-8 positional).
    let parsed = parse_args(env::args_os()).and_then(|args| run(&args));
    match parsed {
        Ok(rendered) => {
            println!("{rendered}");
        }
        Err(err) => {
            // Refs-only error to stdout (no detail), coarse category to stderr, non-zero exit.
            let payload = json!({
                "truth_label": "rust_providers_detect",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            println!("{payload}");
            eprintln!("hub_providers_detect_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

/// Convert raw OS argv into UTF-8 `String`s fail-closed. `std::env::args()`
/// PANICS (abort, exit 101) the moment any argv entry is not valid UTF-8 — it
/// fires inside `.collect()` BEFORE the fail-closed arg-parse path can run. By
/// reading `args_os()` and mapping each `OsString -> String` failure to a coarse
/// `bad_args` error, any non-UTF-8 arg in any position (e.g. a bare `$'\xff'`
/// positional, not just a `--probe` value) routes to the refs-only error + exit
/// 2 instead of a panic.
fn parse_args(args: impl Iterator<Item = OsString>) -> Result<Vec<String>, BridgeError> {
    args.map(|a| a.into_string().map_err(|_| BridgeError::new("bad_args")))
        .collect()
}

/// Parse `--probe codex|claude|both` (default `both`) into the providers to detect.
fn parse_providers(args: &[String]) -> Result<Vec<Provider>, BridgeError> {
    let which = arg_value(args, "--probe").unwrap_or_else(|| "both".to_string());
    match which.as_str() {
        "codex" => Ok(vec![Provider::Codex]),
        "claude" => Ok(vec![Provider::Claude]),
        "both" => Ok(vec![Provider::Codex, Provider::Claude]),
        _ => Err(BridgeError::new("bad_args")),
    }
}

fn run(args: &[String]) -> Result<String, BridgeError> {
    let providers = parse_providers(args)?;
    // Production probe: reads HOME, builds the absolute ~/.local/bin CLI paths.
    let probe = CliProbe::default();
    render_detect(&probe, &providers)
}

/// Core: detect each requested provider, build the refs-only JSON, and run it
/// through the output guard. Generic over the probe so `main` ships `CliProbe`
/// and tests inject a `MockProbe` through the IDENTICAL code path (so the
/// "exact safe shape" and "never serializes raw ProbeOutput" assertions are
/// genuine end-to-end checks, not helper-only ones).
fn render_detect<P: ProviderProbe>(
    probe: &P,
    providers: &[Provider],
) -> Result<String, BridgeError> {
    // For each provider we surface ONLY the parsed `ProviderAuthStatus` fields.
    // The raw `ProbeOutput` (CLI stdout/stderr) is consumed inside `detect` ->
    // `parse_status`, which discards it and returns only booleans + a static
    // label — it is structurally impossible to place raw CLI text here.
    let detected: Vec<_> = providers
        .iter()
        .map(|&provider| {
            let status = detect(probe, provider);
            json!({
                "provider": status.provider.as_str(),
                "installed": status.installed,
                "authenticated": status.authenticated,
                "detail": status.detail,
            })
        })
        .collect();

    let payload = json!({
        "truth_label": "rust_providers_detect",
        "proof_only": true,
        "ok": true,
        "detected": detected,
    });

    let rendered =
        serde_json::to_string(&payload).map_err(|_| BridgeError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
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

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the
/// refs-only payload. Mirrors `hub_run_task`'s `reject_forbidden_output`, with
/// the raw-CLI-field markers (`authMethod`/`subscriptionType`/`loggedIn`) added
/// — the primary defense is that `parse_status` discards the raw `ProbeOutput`,
/// so these markers should never appear; the guard is a structural backstop.
fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    for marker in [
        // Secret / path markers (mirrors hub_run_task).
        "Authorization",
        "Bearer",
        "sk-",
        "/Users/",
        "/private/",
        // Raw-CLI account-field markers — must NEVER reach output (the parsed
        // status carries none of these; this catches a regression if it did).
        "authMethod",
        "subscriptionType",
        "loggedIn",
    ] {
        if rendered.contains(marker) {
            return Err(BridgeError::new("output_guard"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::{ProbeOutput, ProviderError};
    use serde_json::{from_str, Value};
    use std::collections::HashMap;

    /// A mock probe returning canned raw CLI output (or a missing-CLI error) so
    /// the bin's detect -> render -> guard path is provable without the CLIs and
    /// without spending quota. Crucially, it can return raw stdout containing
    /// account fields (`authMethod`/`subscriptionType`) to prove the parsed
    /// surface strips them.
    struct MockProbe {
        out: HashMap<&'static str, Result<ProbeOutput, ()>>,
    }
    impl MockProbe {
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
    impl ProviderProbe for MockProbe {
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

    #[test]
    fn parse_providers_defaults_to_both_and_maps_each_flag() {
        let both = vec!["bin".to_string()];
        assert_eq!(
            parse_providers(&both).unwrap(),
            vec![Provider::Codex, Provider::Claude]
        );
        let codex = vec![
            "bin".to_string(),
            "--probe".to_string(),
            "codex".to_string(),
        ];
        assert_eq!(parse_providers(&codex).unwrap(), vec![Provider::Codex]);
        let claude = vec!["bin".to_string(), "--probe=claude".to_string()];
        assert_eq!(parse_providers(&claude).unwrap(), vec![Provider::Claude]);
        let bad = vec!["bin".to_string(), "--probe".to_string(), "nope".to_string()];
        assert!(parse_providers(&bad).is_err());
    }

    #[test]
    fn emitted_json_has_exact_safe_shape() {
        // Codex logged in (parser literal), Claude logged-out (JSON literal).
        let probe = MockProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let rendered =
            render_detect(&probe, &[Provider::Codex, Provider::Claude]).expect("renders");
        let v = parse(&rendered);

        assert_eq!(v["truth_label"], "rust_providers_detect");
        assert_eq!(v["proof_only"], true);
        assert_eq!(v["ok"], true);

        let detected = v["detected"].as_array().expect("detected is an array");
        assert_eq!(detected.len(), 2);

        // codex: installed + authenticated + logged_in.
        assert_eq!(detected[0]["provider"], "codex");
        assert_eq!(detected[0]["installed"], true);
        assert_eq!(detected[0]["authenticated"], true);
        assert_eq!(detected[0]["detail"], "logged_in");

        // claude: installed but not authenticated.
        assert_eq!(detected[1]["provider"], "claude");
        assert_eq!(detected[1]["installed"], true);
        assert_eq!(detected[1]["authenticated"], false);
        assert_eq!(detected[1]["detail"], "not_logged_in");

        // EXACT shape: each entry has ONLY the four safe keys (no raw fields).
        for entry in detected {
            let obj = entry.as_object().expect("entry is an object");
            assert_eq!(obj.len(), 4, "entry must carry exactly 4 safe keys");
            assert!(obj.contains_key("provider"));
            assert!(obj.contains_key("installed"));
            assert!(obj.contains_key("authenticated"));
            assert!(obj.contains_key("detail"));
        }
    }

    #[test]
    fn missing_cli_surfaces_not_installed_never_a_fallback() {
        let probe = MockProbe::new().set_missing(Provider::Codex);
        let rendered = render_detect(&probe, &[Provider::Codex]).expect("renders");
        let v = parse(&rendered);
        let entry = &v["detected"][0];
        assert_eq!(entry["installed"], false);
        assert_eq!(entry["authenticated"], false);
        assert_eq!(entry["detail"], "not_installed");
    }

    #[test]
    fn parsed_surface_strips_raw_account_fields_from_output() {
        // PRIMARY defense: even when the mock returns raw stdout laden with
        // account identifiers, `detect`/`parse_status` discard the raw
        // ProbeOutput and surface only booleans + a static label — so the
        // rendered JSON contains none of those fields, and the guard PASSES.
        let probe = MockProbe::new().set(
            Provider::Claude,
            "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\",\n  \"subscriptionType\": \"max\",\n  \"email\": \"someone@example.com\"\n}",
        );
        let rendered = render_detect(&probe, &[Provider::Claude]).expect("renders (guard passes)");

        assert!(
            !rendered.contains("authMethod"),
            "raw authMethod must be stripped"
        );
        assert!(
            !rendered.contains("subscriptionType"),
            "raw subscriptionType must be stripped"
        );
        assert!(
            !rendered.contains("loggedIn"),
            "raw loggedIn must be stripped"
        );
        assert!(
            !rendered.contains("example.com"),
            "account email must be stripped"
        );

        // The safe surface still reports authenticated=true via the parsed label.
        let v = parse(&rendered);
        assert_eq!(v["detected"][0]["authenticated"], true);
        assert_eq!(v["detected"][0]["detail"], "logged_in");
    }

    #[test]
    fn forbidden_output_guard_blocks_raw_cli_and_secret_markers() {
        // CANARY: prove the guard itself trips — if some future regression DID
        // let a raw CLI field reach the payload, the backstop blocks printing.
        assert!(reject_forbidden_output(r#"{"x":"authMethod"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"subscriptionType"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"loggedIn"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"sk-secret"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"path":"/Users/someone"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"path":"/private/tmp"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"h":"Authorization: x"}"#).is_err());
    }

    #[test]
    fn guard_passes_on_actual_rendered_safe_output_no_marker_collision() {
        // Verify (not just reason) that the bin's REAL output for every probe
        // selection clears the guard — i.e. the snake_case/static labels and
        // safe field names do not collide with any camelCase/secret marker.
        for providers in [
            vec![Provider::Codex],
            vec![Provider::Claude],
            vec![Provider::Codex, Provider::Claude],
        ] {
            // Use logged-in for both so the most marker-adjacent labels appear.
            let probe = MockProbe::new()
                .set(Provider::Codex, "Logged in using ChatGPT")
                .set(
                    Provider::Claude,
                    "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\"\n}",
                );
            let rendered = render_detect(&probe, &providers).expect("renders");
            assert!(
                reject_forbidden_output(&rendered).is_ok(),
                "actual safe output must clear the guard: {rendered}"
            );
        }
    }

    #[test]
    fn never_serializes_raw_probe_output() {
        // Structural guarantee: `ProbeOutput` is NOT `Serialize`, so it cannot
        // be placed into the json! payload at all — accidental serialization is
        // a COMPILE error, not a runtime leak. Here we additionally assert at
        // runtime that the rendered output never carries the raw stream field
        // names, belt-and-suspenders with the compile-time guarantee.
        let probe = MockProbe::new().set(Provider::Codex, "Logged in using ChatGPT");
        let rendered = render_detect(&probe, &[Provider::Codex]).expect("renders");
        assert!(!rendered.contains("stdout"));
        assert!(!rendered.contains("stderr"));
        let v = parse(&rendered);
        assert!(v["detected"][0].get("stdout").is_none());
        assert!(v["detected"][0].get("stderr").is_none());
    }

    /// Fail-closed argv: a NON-UTF-8 arg must route to the coarse `bad_args`
    /// error (then exit 2 in `main`), NEVER panic. Pre-fix, `main` collected
    /// `env::args()`, whose `.collect()` PANICS (process abort, exit 101) on the
    /// first non-UTF-8 entry — BEFORE any fail-closed path runs. We reproduce
    /// the bin's documented contract violation `hub_providers_detect $'\xff'`:
    /// the bad bytes are a BARE POSITIONAL (not a `--probe` value), so a lossy
    /// conversion would have silently defaulted to `both` + exit 0; the explicit
    /// `OsString -> String` failure mapping correctly yields `bad_args`. The
    /// test drives `parse_args` directly (no process spawn) for determinism.
    #[cfg(unix)]
    #[test]
    fn non_utf8_argv_is_fail_closed_not_a_panic() {
        use std::os::unix::ffi::OsStrExt;

        // [prog, <invalid-UTF-8 bare positional>] — the literal defect input.
        let argv = [
            OsString::from("hub_providers_detect"),
            std::ffi::OsStr::from_bytes(&[0xff]).to_os_string(),
        ];
        let err = parse_args(argv.into_iter())
            .expect_err("non-UTF-8 argv must be rejected, not converted/panicked");
        assert_eq!(err.kind, "bad_args");
    }
}
