//! QR/local-host pairing contract.
//!
//! `PAIR-001`: the QR payload is a Friday Hub/device bootstrap. It may contain a
//! short-lived Friday pairing secret, but it must never contain provider OAuth
//! material, API keys, provider account ids, or provider session tokens.

use crate::error::CoreError;
use std::fmt;

pub const CURRENT_PAIR_PAYLOAD_VERSION: u16 = 1;
const MIN_PAIRING_SECRET_LEN: usize = 16;

#[derive(Clone, PartialEq, Eq)]
pub struct PairingSecret(String);

impl PairingSecret {
    pub fn new(value: impl Into<String>) -> Result<Self, CoreError> {
        let value = value.into();
        if value.len() < MIN_PAIRING_SECRET_LEN {
            return Err(CoreError::InvalidPairPayload(
                "pairing_secret must be at least 16 bytes".into(),
            ));
        }
        if contains_provider_secret_hint(&value) {
            return Err(CoreError::InvalidPairPayload(
                "pairing_secret looks like provider credential material".into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn expose_for_qr(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for PairingSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PairingSecret(<redacted>)")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PairTransportKind {
    LanWebSocket,
    Mdns,
    ManualUrl,
    Tailscale,
    SshTunnel,
    P2pRelay,
}

impl PairTransportKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            PairTransportKind::LanWebSocket => "lan_websocket",
            PairTransportKind::Mdns => "mdns",
            PairTransportKind::ManualUrl => "manual_url",
            PairTransportKind::Tailscale => "tailscale",
            PairTransportKind::SshTunnel => "ssh_tunnel",
            PairTransportKind::P2pRelay => "p2p_relay",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "lan_websocket" => Some(Self::LanWebSocket),
            "mdns" => Some(Self::Mdns),
            "manual_url" => Some(Self::ManualUrl),
            "tailscale" => Some(Self::Tailscale),
            "ssh_tunnel" => Some(Self::SshTunnel),
            "p2p_relay" => Some(Self::P2pRelay),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairTransportHint {
    pub kind: PairTransportKind,
    pub endpoint: String,
    pub label: String,
}

impl PairTransportHint {
    pub fn new(
        kind: PairTransportKind,
        endpoint: impl Into<String>,
        label: impl Into<String>,
    ) -> Result<Self, CoreError> {
        let hint = Self {
            kind,
            endpoint: endpoint.into(),
            label: label.into(),
        };
        hint.validate()?;
        Ok(hint)
    }

    fn validate(&self) -> Result<(), CoreError> {
        require_non_empty(&self.endpoint, "transport_hints.endpoint")?;
        require_non_empty(&self.label, "transport_hints.label")?;
        if contains_provider_secret_hint(&self.endpoint)
            || contains_provider_secret_hint(&self.label)
        {
            return Err(CoreError::InvalidPairPayload(
                "transport hint contains provider credential-looking material".into(),
            ));
        }
        match self.kind {
            PairTransportKind::LanWebSocket | PairTransportKind::ManualUrl => {
                if !self.endpoint.starts_with("ws://") && !self.endpoint.starts_with("wss://") {
                    return Err(CoreError::InvalidPairPayload(format!(
                        "{} endpoint must be ws:// or wss://",
                        self.kind.as_str()
                    )));
                }
            }
            PairTransportKind::Mdns => {
                if !self.endpoint.contains("_friday") || !self.endpoint.contains("_tcp") {
                    return Err(CoreError::InvalidPairPayload(
                        "mdns endpoint must identify a Friday TCP service".into(),
                    ));
                }
            }
            PairTransportKind::Tailscale => {
                if !self.endpoint.starts_with("tailscale://") && !self.endpoint.starts_with("ws://")
                {
                    return Err(CoreError::InvalidPairPayload(
                        "tailscale endpoint must be tailscale:// or ws://".into(),
                    ));
                }
            }
            PairTransportKind::SshTunnel => {
                if !self.endpoint.starts_with("ssh://") {
                    return Err(CoreError::InvalidPairPayload(
                        "ssh tunnel endpoint must be ssh://".into(),
                    ));
                }
            }
            PairTransportKind::P2pRelay => {
                if !self.endpoint.starts_with("iroh://")
                    && !self.endpoint.starts_with("friday-p2p://")
                {
                    return Err(CoreError::InvalidPairPayload(
                        "p2p relay endpoint must be iroh:// or friday-p2p://".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PairAuthority {
    StatusOnly,
    Approvals,
    SendSteer,
    FileDiffReview,
    AdminSetup,
}

impl PairAuthority {
    pub fn as_str(&self) -> &'static str {
        match self {
            PairAuthority::StatusOnly => "status_only",
            PairAuthority::Approvals => "approvals",
            PairAuthority::SendSteer => "send_steer",
            PairAuthority::FileDiffReview => "file_diff_review",
            PairAuthority::AdminSetup => "admin_setup",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "status_only" => Some(Self::StatusOnly),
            "approvals" => Some(Self::Approvals),
            "send_steer" => Some(Self::SendSteer),
            "file_diff_review" => Some(Self::FileDiffReview),
            "admin_setup" => Some(Self::AdminSetup),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FridayPairPayload {
    pub v: u16,
    pub hub_id: String,
    pub pairing_id: String,
    pub pairing_secret: PairingSecret,
    pub display_name: String,
    pub transport_hints: Vec<PairTransportHint>,
    pub expires_at: i64,
    pub capabilities_hint: Vec<PairAuthority>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FridayPairProjection {
    pub v: u16,
    pub hub_id: String,
    pub pairing_id: String,
    pub display_name: String,
    pub transport_labels: Vec<String>,
    pub expires_at: i64,
    pub capabilities_hint: Vec<PairAuthority>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedDeviceProjection {
    pub device_id: String,
    pub label: String,
    pub paired_at: i64,
    pub revoked_at: Option<i64>,
    pub key_rotated_at: Option<i64>,
    pub pubkey_fingerprint: String,
}

impl FridayPairPayload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        v: u16,
        hub_id: impl Into<String>,
        pairing_id: impl Into<String>,
        pairing_secret: impl Into<String>,
        display_name: impl Into<String>,
        transport_hints: Vec<PairTransportHint>,
        expires_at: i64,
        capabilities_hint: Vec<PairAuthority>,
    ) -> Result<Self, CoreError> {
        let payload = Self {
            v,
            hub_id: hub_id.into(),
            pairing_id: pairing_id.into(),
            pairing_secret: PairingSecret::new(pairing_secret)?,
            display_name: display_name.into(),
            transport_hints,
            expires_at,
            capabilities_hint,
        };
        payload.validate_at(payload.expires_at - 1)?;
        Ok(payload)
    }

    pub fn validate_at(&self, now: i64) -> Result<(), CoreError> {
        if self.v != CURRENT_PAIR_PAYLOAD_VERSION {
            return Err(CoreError::InvalidPairPayload(format!(
                "unsupported version {}",
                self.v
            )));
        }
        require_non_empty(&self.hub_id, "hub_id")?;
        require_non_empty(&self.pairing_id, "pairing_id")?;
        require_non_empty(&self.display_name, "display_name")?;
        if self.expires_at <= now {
            return Err(CoreError::InvalidPairPayload(
                "pairing payload has expired".into(),
            ));
        }
        if self.transport_hints.is_empty() {
            return Err(CoreError::InvalidPairPayload(
                "at least one transport hint is required".into(),
            ));
        }
        if self.capabilities_hint.is_empty() {
            return Err(CoreError::InvalidPairPayload(
                "at least one capability hint is required".into(),
            ));
        }
        if contains_provider_secret_hint(&self.hub_id)
            || contains_provider_secret_hint(&self.pairing_id)
            || contains_provider_secret_hint(&self.display_name)
        {
            return Err(CoreError::InvalidPairPayload(
                "pair payload contains provider credential-looking material".into(),
            ));
        }
        for hint in &self.transport_hints {
            hint.validate()?;
        }
        Ok(())
    }

    pub fn redacted_projection(&self) -> FridayPairProjection {
        FridayPairProjection {
            v: self.v,
            hub_id: self.hub_id.clone(),
            pairing_id: self.pairing_id.clone(),
            display_name: self.display_name.clone(),
            transport_labels: self
                .transport_hints
                .iter()
                .map(|h| h.label.clone())
                .collect(),
            expires_at: self.expires_at,
            capabilities_hint: self.capabilities_hint.clone(),
        }
    }
}

fn require_non_empty(value: &str, field: &'static str) -> Result<(), CoreError> {
    if value.trim().is_empty() {
        Err(CoreError::InvalidPairPayload(format!(
            "{field} must not be empty"
        )))
    } else {
        Ok(())
    }
}

fn contains_provider_secret_hint(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("openai_api_key")
        || lower.contains("anthropic_api_key")
        || lower.contains("api_key=")
        || lower.contains("authorization:")
        || lower.contains("bearer ")
        || lower.contains("oauth")
        || lower.contains("refresh_token")
        || lower.contains("provider_token")
        || lower.contains("provider_secret")
        || value.contains("sk-")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payload() -> FridayPairPayload {
        FridayPairPayload::new(
            CURRENT_PAIR_PAYLOAD_VERSION,
            "hub-mac-mini",
            "pair-1",
            "friday-pairing-secret-32-bytes",
            "Jarvis Mac mini",
            vec![PairTransportHint::new(
                PairTransportKind::LanWebSocket,
                "ws://192.168.1.8:4477",
                "LAN WebSocket",
            )
            .unwrap()],
            2000,
            vec![PairAuthority::StatusOnly, PairAuthority::Approvals],
        )
        .unwrap()
    }

    #[test]
    fn pair_payload_validates_and_projects_without_secret() {
        let payload = sample_payload();
        payload.validate_at(1000).unwrap();
        let projection = format!("{:?}", payload.redacted_projection());
        assert!(projection.contains("Jarvis Mac mini"));
        assert!(!projection.contains(payload.pairing_secret.expose_for_qr()));
        assert!(payload.pairing_secret.expose_for_qr().len() >= MIN_PAIRING_SECRET_LEN);
    }

    #[test]
    fn pair_payload_debug_redacts_secret() {
        let payload = sample_payload();
        let debug = format!("{payload:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(payload.pairing_secret.expose_for_qr()));
    }

    #[test]
    fn invalid_or_expired_payloads_are_rejected() {
        let mut payload = sample_payload();
        assert!(payload.validate_at(payload.expires_at).is_err());
        payload.v = 999;
        assert!(payload.validate_at(1000).is_err());

        assert!(FridayPairPayload::new(
            CURRENT_PAIR_PAYLOAD_VERSION,
            "hub",
            "pair",
            "short",
            "Hub",
            vec![PairTransportHint::new(
                PairTransportKind::LanWebSocket,
                "ws://127.0.0.1:4477",
                "LAN"
            )
            .unwrap()],
            2000,
            vec![PairAuthority::StatusOnly],
        )
        .is_err());
    }

    #[test]
    fn provider_credential_looking_material_is_rejected() {
        assert!(PairingSecret::new("sk-live-provider-secret-value").is_err());
        assert!(PairTransportHint::new(
            PairTransportKind::LanWebSocket,
            "ws://127.0.0.1:4477?api_key=abc",
            "LAN"
        )
        .is_err());
    }
}
