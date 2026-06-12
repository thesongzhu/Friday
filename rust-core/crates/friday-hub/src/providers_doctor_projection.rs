//! **S-R3** — the providers-doctor projection, extracted to a CALLABLE library fn.
//!
//! The refs-only JSON-shaping previously lived INLINE in `bin/hub_providers_detect.rs`'s private
//! `render_detect`. S-R3 lifts it to [`project_providers_doctor`] so that BOTH the existing one-shot
//! CLI bin AND the new DARK sealed-WS read-projection server (`bin/hub_read_projection_server.rs`)
//! share ONE implementation — no duplication, no drift. This mirrors what S-R1 did for the Mission
//! Workbench and S-R2 for run-readback.
//!
//! ## NOT a DB read — a provider-CLI status probe (no model call, no credential, no quota)
//! Unlike the workbench/run-readback projections, this one does NOT touch the hub DB. It runs the
//! hub-library aggregate [`crate::provider_doctor::ProviderDoctor::run_for`], which executes each
//! provider CLI's OFFICIAL read-only status command (`codex login status`, `claude auth status`)
//! through the injected [`ProviderProbe`] — never a prompt/send. So there is NO model call, NO quota
//! spend, NO provider credential read, and no network beyond the CLI's own local auth check. The
//! read server passes a real `CliProbe`; tests inject a `MockProbe` through the IDENTICAL path.
//!
//! ## Refs-only + CONSERVATIVE truth labels (provider lanes → `linked_only`, never upgraded)
//! [`project_providers_doctor`] runs [`reject_forbidden_output`] INSIDE itself and returns `Err` on
//! any forbidden marker, so every caller inherits the refs-only guarantee. It surfaces ONLY the safe
//! parsed [`friday_providers::ProviderAuthStatus`] fields (provider label, `installed`/
//! `authenticated` booleans, coarse static `detail`), the `ready_providers` labels, and the
//! any/all-authenticated aggregate booleans — NEVER the raw [`friday_providers::ProbeOutput`] (CLI
//! stdout/stderr, which can carry `authMethod`/`subscriptionType`/account ids). Each provider entry
//! ALSO carries a conservative `truth_label = "linked_only"`: a provider being installed +
//! authenticated is a LINK to an external account, never a Friday-owned completion — so the label is
//! never upgraded past `linked_only` (the same ceiling `workbench_projection` puts on provider
//! lanes).

use friday_providers::{Provider, ProviderProbe};
use serde_json::{json, Value};

use crate::provider_doctor::ProviderDoctor;

/// The conservative truth label every provider lane carries in this projection. A provider's
/// installed/authenticated state is a LINK to an external account — never a Friday-owned completion
/// — so it is labelled `linked_only` and NEVER upgraded. Mirrors `workbench_projection`'s
/// `truth_label_for_lane` ceiling for the Codex/Claude/DeepSeek/FutureApi lanes.
pub const PROVIDER_LANE_TRUTH_LABEL: &str = "linked_only";

/// Parse a `--probe codex|claude|both` selection (default `both` when `None`) into the providers to
/// detect. Returns `Err("bad_args")` on an unknown selection — the SAME coarse vocab the bin used.
pub fn parse_provider_selection(probe: Option<&str>) -> Result<Vec<Provider>, String> {
    match probe.unwrap_or("both") {
        "codex" => Ok(vec![Provider::Codex]),
        "claude" => Ok(vec![Provider::Claude]),
        "both" => Ok(vec![Provider::Codex, Provider::Claude]),
        _ => Err("bad_args".to_string()),
    }
}

/// Project the refs-only providers-doctor snapshot for `providers`, running the hub-library
/// [`ProviderDoctor`] over the injected `probe`. Returns the refs-only snapshot `serde_json::Value`
/// on success.
///
/// Generic over the probe so the read server / production bin ship a real
/// [`friday_providers::CliProbe`] and tests inject a `MockProbe` through the IDENTICAL code path.
/// Fail-closed: a forbidden-marker leak returns `Err(String)` (a coarse `output_guard`/
/// `serialize_failed` kind) — never a partial or raw CLI text. The guard runs INSIDE this fn so both
/// the bin and the read server inherit refs-only.
pub fn project_providers_doctor<P: ProviderProbe + ?Sized>(
    probe: &P,
    providers: &[Provider],
) -> Result<Value, String> {
    let doctor = ProviderDoctor::run_for(probe, providers);

    let detected: Vec<Value> = doctor
        .statuses
        .iter()
        .map(|status| {
            json!({
                "provider": status.provider.as_str(),
                "installed": status.installed,
                "authenticated": status.authenticated,
                "detail": status.detail,
                // CONSERVATIVE: a provider lane is a LINK to an external account, never a
                // Friday-owned completion — labelled `linked_only`, never upgraded.
                "truthLabel": PROVIDER_LANE_TRUTH_LABEL,
            })
        })
        .collect();

    let ready: Vec<&str> = doctor
        .ready_providers()
        .iter()
        .map(|p| p.as_str())
        .collect();

    let snapshot = json!({
        "truth_label": "rust_providers_detect",
        "proof_only": true,
        "ok": true,
        "detected": detected,
        "ready_providers": ready,
        "any_authenticated": doctor.any_authenticated(),
        "all_authenticated": doctor.all_authenticated(),
    });

    let rendered = serde_json::to_string(&snapshot).map_err(|_| "serialize_failed".to_string())?;
    reject_forbidden_output(&rendered)?;
    Ok(snapshot)
}

/// Refs-only output guard — the SAME shared guard the bin ran, with the raw-CLI account-field
/// markers (`authMethod`/`subscriptionType`/`loggedIn`) added. The primary defense is that
/// `detect`/`parse_status` discard the raw `ProbeOutput`, so these markers should never appear; the
/// guard is a structural backstop. Returns `Err(marker)` on any forbidden marker so the bin and the
/// read server fail closed identically.
pub fn reject_forbidden_output(rendered: &str) -> Result<(), String> {
    crate::refs_guard::reject_forbidden_output(
        rendered,
        &["authMethod", "subscriptionType", "loggedIn"],
    )
    .map_err(|marker| format!("forbidden marker in projection: {marker}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::{ProbeOutput, ProviderError};
    use serde_json::{from_str, Value};
    use std::collections::HashMap;

    /// A mock probe returning canned raw CLI output (or a missing-CLI error) so the projection's
    /// detect -> render -> guard path is provable without the CLIs and without spending quota.
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

    fn parse(snapshot: &Value) -> Value {
        from_str(&serde_json::to_string(snapshot).unwrap()).unwrap()
    }

    #[test]
    fn parse_provider_selection_defaults_to_both_and_maps_each_flag() {
        assert_eq!(
            parse_provider_selection(None).unwrap(),
            vec![Provider::Codex, Provider::Claude]
        );
        assert_eq!(
            parse_provider_selection(Some("both")).unwrap(),
            vec![Provider::Codex, Provider::Claude]
        );
        assert_eq!(
            parse_provider_selection(Some("codex")).unwrap(),
            vec![Provider::Codex]
        );
        assert_eq!(
            parse_provider_selection(Some("claude")).unwrap(),
            vec![Provider::Claude]
        );
        assert!(parse_provider_selection(Some("nope")).is_err());
    }

    #[test]
    fn projection_has_exact_safe_shape_with_conservative_truth_labels() {
        // Codex logged in (parser literal), Claude logged-out (JSON literal).
        let probe = MockProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let snapshot = project_providers_doctor(&probe, &[Provider::Codex, Provider::Claude])
            .expect("renders");
        let v = parse(&snapshot);

        assert_eq!(v["truth_label"], "rust_providers_detect");
        let detected = v["detected"].as_array().expect("detected is an array");
        assert_eq!(detected.len(), 2);

        // codex: installed + authenticated + logged_in + linked_only.
        assert_eq!(detected[0]["provider"], "codex");
        assert_eq!(detected[0]["installed"], true);
        assert_eq!(detected[0]["authenticated"], true);
        assert_eq!(detected[0]["detail"], "logged_in");
        assert_eq!(detected[0]["truthLabel"], "linked_only");
        // claude: installed but not authenticated, still linked_only.
        assert_eq!(detected[1]["authenticated"], false);
        assert_eq!(detected[1]["truthLabel"], "linked_only");

        // EXACT shape: each entry has ONLY the five safe keys (no raw fields), and the provider
        // truth label is NEVER upgraded past `linked_only`.
        for entry in detected {
            let obj = entry.as_object().expect("entry is an object");
            assert_eq!(obj.len(), 5, "entry must carry exactly 5 safe keys");
            assert_eq!(obj["truthLabel"], "linked_only");
        }

        // Aggregate readiness: codex ready, claude not — never hides which provider is down.
        assert_eq!(
            v["ready_providers"].as_array().unwrap(),
            &vec![serde_json::json!("codex")]
        );
        assert_eq!(v["any_authenticated"], true);
        assert_eq!(v["all_authenticated"], false);
    }

    #[test]
    fn fully_logged_out_is_an_honest_not_ready() {
        let probe = MockProbe::new()
            .set_missing(Provider::Codex)
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");
        let snapshot = project_providers_doctor(&probe, &[Provider::Codex, Provider::Claude])
            .expect("renders");
        let v = parse(&snapshot);
        assert!(v["ready_providers"].as_array().unwrap().is_empty());
        assert_eq!(v["any_authenticated"], false);
        assert_eq!(v["all_authenticated"], false);
    }

    #[test]
    fn raw_account_fields_are_stripped_and_guard_passes() {
        // Even when the mock returns raw stdout laden with account identifiers, `detect`/
        // `parse_status` discard the raw ProbeOutput; the rendered JSON carries none of them.
        let probe = MockProbe::new().set(
            Provider::Claude,
            "{\n  \"loggedIn\": true,\n  \"authMethod\": \"claude.ai\",\n  \"subscriptionType\": \"max\",\n  \"email\": \"someone@example.com\"\n}",
        );
        let snapshot = project_providers_doctor(&probe, &[Provider::Claude]).expect("renders");
        let rendered = serde_json::to_string(&snapshot).unwrap();
        assert!(!rendered.contains("authMethod"));
        assert!(!rendered.contains("subscriptionType"));
        assert!(!rendered.contains("loggedIn"));
        assert!(!rendered.contains("example.com"));
        // The safe surface still reports authenticated=true via the parsed label.
        let v = parse(&snapshot);
        assert_eq!(v["detected"][0]["authenticated"], true);
        assert_eq!(v["detected"][0]["detail"], "logged_in");
    }

    #[test]
    fn forbidden_output_guard_blocks_raw_cli_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"x":"authMethod"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"subscriptionType"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"loggedIn"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"sk-secret"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"path":"/Users/someone"}"#).is_err());
    }
}
