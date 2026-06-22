//! Provider route readiness projection for `hub_capability_doctor`. PROOF-ONLY / DARK.
//!
//! This module composes existing truth sources into an operator-readable route view:
//! `CapabilityDoctor` (CLI login + API-key validation), `RouteRegistry` (which routes
//! are available/validated in this runtime shape), and explicit failover flags. It
//! never selects a route, never flips failover, never validates keys itself, and never
//! substitutes one provider for another.

use crate::capability_doctor::CapabilityDoctor;
use crate::routing::{BackendKind, ModelSize, ProviderApi, ProviderRoute, RouteRegistry};
use friday_providers::{KeyProvider, KeyValidationOutcome, Provider};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteStrength {
    Cheap,
    Strong,
    OperatorGated,
}

impl RouteStrength {
    pub fn as_str(self) -> &'static str {
        match self {
            RouteStrength::Cheap => "cheap",
            RouteStrength::Strong => "strong",
            RouteStrength::OperatorGated => "operator_gated",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadinessBlockerKind {
    Credential,
    Human,
    OperatorFlag,
    RouteConfig,
}

impl ReadinessBlockerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ReadinessBlockerKind::Credential => "credential",
            ReadinessBlockerKind::Human => "human",
            ReadinessBlockerKind::OperatorFlag => "operator_flag",
            ReadinessBlockerKind::RouteConfig => "route_config",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadinessBlocker {
    pub kind: ReadinessBlockerKind,
    pub code: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderRouteReadiness {
    pub provider_id: String,
    pub api: ProviderApi,
    pub backend_kind: BackendKind,
    pub model: String,
    pub model_size: ModelSize,
    pub strength: RouteStrength,
    pub dispatchable: bool,
    pub blockers: Vec<ReadinessBlocker>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProviderReadinessFlags {
    pub deepseek_to_claude_failover: bool,
    pub claude_to_deepseek_failover: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailoverReadiness {
    pub direction: &'static str,
    pub flag_enabled: bool,
    pub can_enable: bool,
    pub blockers: Vec<ReadinessBlocker>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderReadinessReport {
    pub routes: Vec<ProviderRouteReadiness>,
    pub suggested_text_route: Option<String>,
    pub suggested_strong_route: Option<String>,
    pub failovers: Vec<FailoverReadiness>,
}

impl CapabilityDoctor {
    pub fn provider_readiness_report(
        &self,
        registry: &RouteRegistry,
        flags: ProviderReadinessFlags,
    ) -> ProviderReadinessReport {
        let routes: Vec<ProviderRouteReadiness> = registry
            .all()
            .map(|route| self.route_readiness(route))
            .collect();
        let suggested_text_route = routes
            .iter()
            .find(|r| r.dispatchable && r.model_size == ModelSize::Small)
            .map(|r| r.provider_id.clone())
            .or_else(|| {
                routes
                    .iter()
                    .find(|r| r.dispatchable)
                    .map(|r| r.provider_id.clone())
            });
        let suggested_strong_route = routes
            .iter()
            .find(|r| r.dispatchable && r.model_size == ModelSize::Large)
            .map(|r| r.provider_id.clone());

        let deepseek_ready = route_dispatchable(&routes, "deepseek");
        let claude_ready = route_dispatchable(&routes, "claude");
        let failovers = vec![
            failover_readiness(
                "deepseek_to_claude",
                flags.deepseek_to_claude_failover,
                deepseek_ready,
                claude_ready,
            ),
            failover_readiness(
                "claude_to_deepseek",
                flags.claude_to_deepseek_failover,
                claude_ready,
                deepseek_ready,
            ),
        ];

        ProviderReadinessReport {
            routes,
            suggested_text_route,
            suggested_strong_route,
            failovers,
        }
    }

    fn route_readiness(&self, route: &ProviderRoute) -> ProviderRouteReadiness {
        let mut blockers = Vec::new();
        if !route.available {
            blockers.push(ReadinessBlocker {
                kind: ReadinessBlockerKind::OperatorFlag,
                code: route_flag_blocker(route.provider_id.as_str()),
            });
        }
        if !route.validation_ok {
            blockers.push(ReadinessBlocker {
                kind: ReadinessBlockerKind::RouteConfig,
                code: "route_validation_not_ok",
            });
        }
        blockers.extend(self.provider_blockers(route.provider_id.as_str()));

        ProviderRouteReadiness {
            provider_id: route.provider_id.clone(),
            api: route.api,
            backend_kind: route.backend_kind,
            model: route.model.clone(),
            model_size: route.model_size,
            strength: route_strength(route),
            dispatchable: blockers.is_empty(),
            blockers,
        }
    }

    fn provider_blockers(&self, provider_id: &str) -> Vec<ReadinessBlocker> {
        match provider_id {
            "deepseek" | "deepseek-pro" => self.key_blockers(KeyProvider::DeepSeek),
            "claude" => self.key_blockers(KeyProvider::Anthropic),
            "codex" => self.cli_blockers(Provider::Codex),
            _ => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::RouteConfig,
                code: "unknown_provider_route",
            }],
        }
    }

    fn key_blockers(&self, provider: KeyProvider) -> Vec<ReadinessBlocker> {
        match self.key_signal_for(provider).map(|signal| signal.outcome) {
            Some(KeyValidationOutcome::Valid) => Vec::new(),
            Some(KeyValidationOutcome::Invalid { .. }) => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::Credential,
                code: "api_key_invalid",
            }],
            Some(KeyValidationOutcome::CredentialMissing) => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::Credential,
                code: "api_key_missing",
            }],
            Some(KeyValidationOutcome::Unavailable { .. }) => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::Credential,
                code: "api_key_validation_unavailable",
            }],
            None => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::Credential,
                code: "api_key_not_probed",
            }],
        }
    }

    fn cli_blockers(&self, provider: Provider) -> Vec<ReadinessBlocker> {
        match self.cli_status_for(provider) {
            Some(status) if status.authenticated => Vec::new(),
            Some(status) if status.installed => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::Human,
                code: "cli_not_logged_in",
            }],
            Some(_) => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::Human,
                code: "cli_not_installed",
            }],
            None => vec![ReadinessBlocker {
                kind: ReadinessBlockerKind::Human,
                code: "cli_not_probed",
            }],
        }
    }
}

pub fn provider_api_label(api: ProviderApi) -> &'static str {
    match api {
        ProviderApi::OpenAiCompletions => "openai_completions",
        ProviderApi::OpenAiResponses => "openai_responses",
        ProviderApi::OpenAiCodexResponses => "openai_codex_responses",
        ProviderApi::AnthropicMessages => "anthropic_messages",
    }
}

pub fn backend_kind_label(kind: BackendKind) -> &'static str {
    match kind {
        BackendKind::Http => "http",
        BackendKind::Cli => "cli",
        BackendKind::Sdk => "sdk",
    }
}

pub fn model_size_label(size: ModelSize) -> &'static str {
    match size {
        ModelSize::Small => "small",
        ModelSize::Large => "large",
    }
}

fn route_dispatchable(routes: &[ProviderRouteReadiness], provider_id: &str) -> bool {
    routes
        .iter()
        .any(|r| r.provider_id == provider_id && r.dispatchable)
}

fn route_strength(route: &ProviderRoute) -> RouteStrength {
    match route.provider_id.as_str() {
        "deepseek" => RouteStrength::Cheap,
        "deepseek-pro" | "codex" | "claude" => RouteStrength::Strong,
        _ => RouteStrength::OperatorGated,
    }
}

fn route_flag_blocker(provider_id: &str) -> &'static str {
    match provider_id {
        "deepseek-pro" => "friday_deepseek_pro_route_disabled",
        "claude" => "friday_claude_route_disabled",
        "codex" => "friday_codex_route_disabled",
        _ => "provider_route_disabled",
    }
}

fn failover_readiness(
    direction: &'static str,
    flag_enabled: bool,
    primary_ready: bool,
    fallback_ready: bool,
) -> FailoverReadiness {
    let mut blockers = Vec::new();
    if !flag_enabled {
        blockers.push(ReadinessBlocker {
            kind: ReadinessBlockerKind::OperatorFlag,
            code: "failover_flag_off",
        });
    }
    if !primary_ready {
        blockers.push(ReadinessBlocker {
            kind: ReadinessBlockerKind::RouteConfig,
            code: "primary_route_not_dispatchable",
        });
    }
    if !fallback_ready {
        blockers.push(ReadinessBlocker {
            kind: ReadinessBlockerKind::RouteConfig,
            code: "fallback_route_not_dispatchable",
        });
    }
    FailoverReadiness {
        direction,
        flag_enabled,
        can_enable: blockers.is_empty(),
        blockers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::{
        KeyValidationOutcome, MockKeyValidationProbe, ProbeOutput, ProviderError, ProviderProbe,
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
    }

    impl ProviderProbe for MockCliProbe {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            self.out
                .get(provider.as_str())
                .and_then(|r| r.clone().ok())
                .ok_or_else(|| ProviderError::NotInstalled("mock".into()))
        }
    }

    #[test]
    fn readiness_marks_only_valid_dispatchable_route_ready() {
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": true\n}");
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(
                KeyProvider::Anthropic,
                KeyValidationOutcome::CredentialMissing,
            );
        let doctor = CapabilityDoctor::run(&cli, &keys);

        let report = doctor.provider_readiness_report(
            &RouteRegistry::autonomous_baseline(),
            ProviderReadinessFlags {
                deepseek_to_claude_failover: false,
                claude_to_deepseek_failover: false,
            },
        );

        let deepseek = report
            .routes
            .iter()
            .find(|r| r.provider_id == "deepseek")
            .unwrap();
        assert!(deepseek.dispatchable);

        let claude = report
            .routes
            .iter()
            .find(|r| r.provider_id == "claude")
            .unwrap();
        assert!(!claude.dispatchable);
        assert!(claude.blockers.iter().any(|b| b.code == "api_key_missing"));
        assert!(claude
            .blockers
            .iter()
            .any(|b| b.code == "friday_claude_route_disabled"));

        assert_eq!(report.suggested_text_route.as_deref(), Some("deepseek"));
    }

    #[test]
    fn failover_requires_flag_primary_and_fallback_ready() {
        let cli = MockCliProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": true\n}");
        let keys = MockKeyValidationProbe::new()
            .with(KeyProvider::DeepSeek, KeyValidationOutcome::Valid)
            .with(KeyProvider::Anthropic, KeyValidationOutcome::Valid);
        let doctor = CapabilityDoctor::run(&cli, &keys);

        let report = doctor.provider_readiness_report(
            &RouteRegistry::autonomous_baseline(),
            ProviderReadinessFlags {
                deepseek_to_claude_failover: true,
                claude_to_deepseek_failover: false,
            },
        );
        let deepseek_to_claude = report
            .failovers
            .iter()
            .find(|f| f.direction == "deepseek_to_claude")
            .unwrap();
        assert!(!deepseek_to_claude.can_enable);
        assert!(deepseek_to_claude
            .blockers
            .iter()
            .any(|b| b.code == "fallback_route_not_dispatchable"));
    }
}
