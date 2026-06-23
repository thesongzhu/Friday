//! Refs-only capability-doctor projection for the sealed read seam.
//!
//! This is the callable sibling of `hub_capability_doctor`: owner-auth happens in
//! the read server before this function is called; this module only shapes the
//! already-safe doctor signals into guarded JSON.

use crate::capability_doctor::{CapabilityDoctor, KeyValidationSignal};
use crate::provider_doctor::ProviderDoctor;
use crate::provider_route_readiness::{
    backend_kind_label, model_size_label, provider_api_label, FailoverReadiness,
    ProviderReadinessFlags, ProviderReadinessReport, ProviderRouteReadiness,
};
use crate::routing::{ProviderRoute, RouteRegistry};
use crate::runtime::{
    ENV_CLAUDE_ROUTE_ENABLED, ENV_CODEX_ROUTE_ENABLED, ENV_DEEPSEEK_PRO_ROUTE_ENABLED,
    ENV_PROVIDER_FAILOVER, ENV_PROVIDER_FAILOVER_CLAUDE_TO_DEEPSEEK,
};
use friday_providers::{
    KeyValidationOutcome, KeyValidationProbe, Provider, ProviderAuthStatus, ProviderProbe,
};
use serde_json::{json, Value};

pub fn project_capability_doctor<P: ProviderProbe + ?Sized, K: KeyValidationProbe + ?Sized>(
    cli_probe: &P,
    key_probe: &K,
    validate_keys: bool,
) -> Result<Value, String> {
    if validate_keys {
        let doctor = CapabilityDoctor::run(cli_probe, key_probe);
        render_with_keys(&doctor)
    } else {
        let cli_doctor = ProviderDoctor::run_for(cli_probe, Provider::all());
        render_cli_only(&cli_doctor.statuses)
    }
}

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

fn key_entry(signal: &KeyValidationSignal) -> Value {
    use KeyValidationOutcome::*;
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

fn render_cli_only(statuses: &[ProviderAuthStatus]) -> Result<Value, String> {
    let (detected, logged_in) = cli_section(statuses);
    finish(json!({
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
    }))
}

fn render_with_keys(doctor: &CapabilityDoctor) -> Result<Value, String> {
    let (detected, logged_in) = cli_section(&doctor.cli_statuses);
    let key_validation: Vec<Value> = doctor.key_signals.iter().map(key_entry).collect();
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

    finish(json!({
        "truth_label": "rust_capability_doctor",
        "proof_only": true,
        "ok": true,
        "cli_detected": detected,
        "cli_logged_in": logged_in,
        "key_validation_probed": true,
        "key_validation": key_validation,
        "confirmed_valid_keys": confirmed,
        "route_readiness": route_readiness_entries(&readiness),
        "suggested_text_route": readiness.suggested_text_route,
        "suggested_strong_route": readiness.suggested_strong_route,
        "failover_readiness": failover_readiness_entries(&readiness),
    }))
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

fn finish(payload: Value) -> Result<Value, String> {
    let rendered = serde_json::to_string(&payload).map_err(|_| "serialize_failed".to_string())?;
    reject_forbidden_output(&rendered)?;
    Ok(payload)
}

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
    use friday_providers::{
        KeyProvider, KeyValidationOutcome, MockKeyValidationProbe, ProbeOutput, ProviderError,
    };
    use std::collections::HashMap;

    struct MockCliProbe {
        out: HashMap<&'static str, Result<ProbeOutput, ()>>,
    }

    impl MockCliProbe {
        fn new() -> Self {
            Self {
                out: HashMap::new(),
            }
        }

        fn set(mut self, provider: Provider, stdout: &str) -> Self {
            self.out.insert(
                provider.as_str(),
                Ok(ProbeOutput {
                    stdout: stdout.to_string(),
                    stderr: String::new(),
                }),
            );
            self
        }
    }

    impl ProviderProbe for MockCliProbe {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            match self.out.get(provider.as_str()) {
                Some(Ok(output)) => Ok(output.clone()),
                _ => Err(ProviderError::NotInstalled("mock".into())),
            }
        }
    }

    #[test]
    fn default_off_is_cli_only_and_route_null() {
        let cli = MockCliProbe::new().set(Provider::Codex, "Logged in using ChatGPT");
        let keys = MockKeyValidationProbe::new();
        let payload =
            project_capability_doctor(&cli, &keys, false).expect("renders default-off payload");
        assert_eq!(payload["truth_label"], "rust_capability_doctor");
        assert_eq!(payload["key_validation_probed"], false);
        assert!(payload["route_readiness"].is_null());
        assert!(payload["failover_readiness"].is_null());
        assert_eq!(payload["cli_logged_in"][0], "codex");
    }

    #[test]
    fn validate_keys_renders_route_readiness_refs_only() {
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "Logged in");
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(
                KeyProvider::Anthropic,
                KeyValidationOutcome::CredentialMissing,
            );
        let payload =
            project_capability_doctor(&cli, &keys, true).expect("renders route readiness payload");
        assert_eq!(payload["key_validation_probed"], true);
        assert!(payload["route_readiness"].is_array());
        assert!(payload["failover_readiness"].is_array());
        let rendered = serde_json::to_string(&payload).expect("json");
        assert!(!rendered.contains("loggedIn"));
        assert!(!rendered.contains("authMethod"));
        assert!(!rendered.contains("subscriptionType"));
    }
}
