//! Friday Rust Core — the phone<->Hub wire contract (gate `21` §4).
//!
//! Both endpoints are Rust, so the wire types are serde structs carrying a
//! per-message `schema_version` (gate §0/§4.1). This crate is **pure**: envelope
//! types, (de)serialization, version negotiation, idempotency, and replay/
//! catch-up logic — no networking and no encryption (the transport layer seals
//! the serialized payload; see Unit-4 transport slice).
//!
//! Scope (gate §4.2): exactly the first-slice message kinds. Session-detail,
//! attachments, workflow, and provider-adapter messages are deferred to their
//! owning units. The actual networked WebSocket + relay + live key exchange are
//! the Unit-4 transport sub-slice (this crate is the contract they carry).

use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;

/// Highest wire schema version this build speaks.
pub const CURRENT_SCHEMA_VERSION: u16 = 1;
/// The inclusive range of versions this build supports.
pub const SUPPORTED: VersionRange = VersionRange { min: 1, max: 1 };

/// Redacted provider-session projection safe to carry to phone/channel clients.
/// Hub-only fields such as account hashes, cwd, external URLs, provider tokens,
/// and raw provider ids are intentionally absent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderSessionProjectionWire {
    pub friday_session_id: String,
    pub provider: String,
    pub workspace_id: String,
    pub sync_mode: String,
    pub capability_snapshot: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_provider_seen_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_friday_event_id: Option<String>,
    pub truth_label: String,
}

impl From<friday_core::ProviderSessionProjection> for ProviderSessionProjectionWire {
    fn from(value: friday_core::ProviderSessionProjection) -> Self {
        Self {
            friday_session_id: value.friday_session_id,
            provider: value.provider,
            workspace_id: value.workspace_id,
            sync_mode: value.sync_mode.as_str().to_string(),
            capability_snapshot: value.capability_snapshot,
            last_provider_seen_at: value.last_provider_seen_at,
            last_friday_event_id: value.last_friday_event_id,
            truth_label: value.truth_label,
        }
    }
}

/// Structured QR payload for Hub/device pairing. This is the JSON that can be
/// encoded into a QR code. It contains a short-lived Friday pairing secret, but
/// never provider OAuth/API/session material.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct FridayPairPayloadWire {
    pub v: u16,
    pub hub_id: String,
    pub pairing_id: String,
    pub pairing_secret: String,
    pub display_name: String,
    pub transport_hints: Vec<PairTransportHintWire>,
    pub expires_at: i64,
    pub capabilities_hint: Vec<String>,
}

impl fmt::Debug for FridayPairPayloadWire {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FridayPairPayloadWire")
            .field("v", &self.v)
            .field("hub_id", &self.hub_id)
            .field("pairing_id", &self.pairing_id)
            .field("pairing_secret", &"<redacted>")
            .field("display_name", &self.display_name)
            .field("transport_hints", &self.transport_hints)
            .field("expires_at", &self.expires_at)
            .field("capabilities_hint", &self.capabilities_hint)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairTransportHintWire {
    pub kind: String,
    pub endpoint: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FridayPairProjectionWire {
    pub v: u16,
    pub hub_id: String,
    pub pairing_id: String,
    pub display_name: String,
    pub transport_labels: Vec<String>,
    pub expires_at: i64,
    pub capabilities_hint: Vec<String>,
}

impl FridayPairPayloadWire {
    pub fn encode_qr_json(&self) -> Result<String, ProtocolError> {
        serde_json::to_string(self).map_err(|e| ProtocolError::Encode(e.to_string()))
    }

    pub fn decode_qr_json(value: &str) -> Result<Self, ProtocolError> {
        serde_json::from_str(value).map_err(|e| ProtocolError::Decode(e.to_string()))
    }

    pub fn into_core(self) -> Result<friday_core::FridayPairPayload, ProtocolError> {
        let mut hints = Vec::with_capacity(self.transport_hints.len());
        for hint in self.transport_hints {
            let kind = friday_core::PairTransportKind::parse(&hint.kind).ok_or_else(|| {
                ProtocolError::Decode(format!("unknown pair transport kind '{}'", hint.kind))
            })?;
            hints.push(
                friday_core::PairTransportHint::new(kind, hint.endpoint, hint.label)
                    .map_err(|e| ProtocolError::Decode(e.to_string()))?,
            );
        }
        let mut authorities = Vec::with_capacity(self.capabilities_hint.len());
        for authority in self.capabilities_hint {
            authorities.push(
                friday_core::PairAuthority::parse(&authority).ok_or_else(|| {
                    ProtocolError::Decode(format!("unknown pair authority '{authority}'"))
                })?,
            );
        }
        friday_core::FridayPairPayload::new(
            self.v,
            self.hub_id,
            self.pairing_id,
            self.pairing_secret,
            self.display_name,
            hints,
            self.expires_at,
            authorities,
        )
        .map_err(|e| ProtocolError::Decode(e.to_string()))
    }
}

impl From<&friday_core::FridayPairPayload> for FridayPairPayloadWire {
    fn from(value: &friday_core::FridayPairPayload) -> Self {
        Self {
            v: value.v,
            hub_id: value.hub_id.clone(),
            pairing_id: value.pairing_id.clone(),
            pairing_secret: value.pairing_secret.expose_for_qr().to_string(),
            display_name: value.display_name.clone(),
            transport_hints: value
                .transport_hints
                .iter()
                .map(|hint| PairTransportHintWire {
                    kind: hint.kind.as_str().to_string(),
                    endpoint: hint.endpoint.clone(),
                    label: hint.label.clone(),
                })
                .collect(),
            expires_at: value.expires_at,
            capabilities_hint: value
                .capabilities_hint
                .iter()
                .map(|authority| authority.as_str().to_string())
                .collect(),
        }
    }
}

impl From<friday_core::FridayPairProjection> for FridayPairProjectionWire {
    fn from(value: friday_core::FridayPairProjection) -> Self {
        Self {
            v: value.v,
            hub_id: value.hub_id,
            pairing_id: value.pairing_id,
            display_name: value.display_name,
            transport_labels: value.transport_labels,
            expires_at: value.expires_at,
            capabilities_hint: value
                .capabilities_hint
                .iter()
                .map(|authority| authority.as_str().to_string())
                .collect(),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("decode error: {0}")]
    Decode(String),
    #[error("encode error: {0}")]
    Encode(String),
    #[error("schema versions incompatible: local {l_min}..={l_max}, remote {r_min}..={r_max}")]
    VersionUnsupported {
        l_min: u16,
        l_max: u16,
        r_min: u16,
        r_max: u16,
    },
}

/// Explicit, UI-visible error codes (gate §4.5). None degrade silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    PairingDenied,
    DeviceRevoked,
    SchemaVersionUnsupported,
    HubOffline,
    /// DeepSeek route down / credential bad — surfaced, never a silent fallback.
    ProviderUnavailable,
    RateLimited,
    /// Informational: a duplicate command was deduped (executed exactly once).
    IdempotencyReplay,
    Internal,
}

/// First-slice message kinds (gate §4.2). Tagged by `kind`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Message {
    /// phone->hub: complete QR pairing handshake (pubkey + proof; never the raw secret).
    Pair {
        device_pubkey: Vec<u8>,
        pairing_proof: Vec<u8>,
    },
    /// hub->phone: accept/deny pairing.
    PairAck {
        accepted: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<ErrorCode>,
    },
    /// hub->phone: health + capability set + supported version range. No model call.
    HubStatus {
        online: bool,
        capabilities: Vec<String>,
        min_version: u16,
        max_version: u16,
    },
    /// phone->hub: the only slice message that may cause a model call.
    AskFridayRequest { prompt: String },
    /// hub->phone: streamed token chunk; ordered/replayable by `seq`.
    AskFridayStream { seq: u64, chunk: String },
    /// hub->phone: terminal frame of a stream; carries the ledger id.
    AskFridayResult {
        ledger_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_link: Option<String>,
    },
    /// hub->phone: token/model ledger row projection (fallback must be false).
    LedgerEntry {
        ledger_id: String,
        provider_kind: String,
        model: String,
        base_url_host: String,
        total_tokens: i64,
        fallback: bool,
    },
    /// hub->phone: status/receipt for the ask.
    ActivityItem {
        activity_id: String,
        item_type: String,
        state: String,
    },
    /// hub->phone: ack of a queued offline action on reconnect. NOT completion.
    OfflineQueueAck { acked_msg_id: String },
    /// either: explicit error code + message.
    Error { code: ErrorCode, message: String },
}

/// The versioned envelope (gate §4.1). The relay sees only ciphertext of the
/// serialized envelope after session establishment (transport layer).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub schema_version: u16,
    pub msg_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub sent_at: i64,
    pub message: Message,
}

impl Envelope {
    /// Build an envelope stamped with the current schema version.
    pub fn new(msg_id: impl Into<String>, sent_at: i64, message: Message) -> Envelope {
        Envelope {
            schema_version: CURRENT_SCHEMA_VERSION,
            msg_id: msg_id.into(),
            correlation_id: None,
            sent_at,
            message,
        }
    }

    pub fn with_correlation(mut self, correlation_id: impl Into<String>) -> Envelope {
        self.correlation_id = Some(correlation_id.into());
        self
    }

    /// Serialize to JSON (gate §4.6: JSON chosen for debuggability).
    pub fn encode(&self) -> Result<String, ProtocolError> {
        serde_json::to_string(self).map_err(|e| ProtocolError::Encode(e.to_string()))
    }

    /// Parse from JSON. Unknown *fields* are tolerated (forward-compatible);
    /// unknown message *kinds* are a hard decode error (truth-labeled, not
    /// silently dropped).
    pub fn decode(s: &str) -> Result<Envelope, ProtocolError> {
        serde_json::from_str(s).map_err(|e| ProtocolError::Decode(e.to_string()))
    }
}

/// Inclusive supported schema-version range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VersionRange {
    pub min: u16,
    pub max: u16,
}

/// Agree on the highest schema version both sides support (gate §4.4). Errors
/// (never silently downgrades) when the ranges are disjoint.
pub fn negotiate_version(local: VersionRange, remote: VersionRange) -> Result<u16, ProtocolError> {
    let lo = local.min.max(remote.min);
    let hi = local.max.min(remote.max);
    if lo <= hi {
        Ok(hi)
    } else {
        Err(ProtocolError::VersionUnsupported {
            l_min: local.min,
            l_max: local.max,
            r_min: remote.min,
            r_max: remote.max,
        })
    }
}

/// Result of observing a client command's `msg_id`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Seen {
    /// First time seen — execute it.
    First,
    /// Already processed — dedupe so it executes exactly once.
    Replay,
}

/// Dedupes client commands by `msg_id` so a reconnect-and-resend executes once
/// (critical for the offline queue — gate §4.4).
#[derive(Default)]
pub struct IdempotencyTracker {
    seen: std::collections::HashSet<String>,
}

impl IdempotencyTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(&mut self, msg_id: &str) -> Seen {
        if self.seen.insert(msg_id.to_string()) {
            Seen::First
        } else {
            Seen::Replay
        }
    }

    pub fn has_seen(&self, msg_id: &str) -> bool {
        self.seen.contains(msg_id)
    }
}

/// A durable, resumable stream of `AskFridayStream` frames (gate §4.3). On
/// reconnect, the peer reports its last acked `seq` and we replay only the
/// frames it missed, in order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamFrame {
    pub seq: u64,
    pub chunk: String,
}

#[derive(Default)]
pub struct ResumableStream {
    frames: Vec<StreamFrame>,
}

impl ResumableStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append the next frame. Returns its assigned seq (monotonic from 1).
    pub fn push(&mut self, chunk: impl Into<String>) -> u64 {
        let seq = self.frames.len() as u64 + 1;
        self.frames.push(StreamFrame {
            seq,
            chunk: chunk.into(),
        });
        seq
    }

    /// Frames the peer missed (seq strictly greater than its last acked seq).
    pub fn missed_since(&self, last_acked_seq: u64) -> Vec<StreamFrame> {
        self.frames
            .iter()
            .filter(|f| f.seq > last_acked_seq)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_for_each_kind() {
        let cases = vec![
            Message::Pair {
                device_pubkey: vec![1, 2, 3],
                pairing_proof: vec![4, 5],
            },
            Message::AskFridayRequest {
                prompt: "hello".into(),
            },
            Message::AskFridayResult {
                ledger_id: "l1".into(),
                result_link: Some("friday://result/1".into()),
            },
            Message::LedgerEntry {
                ledger_id: "l1".into(),
                provider_kind: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                base_url_host: "api.deepseek.com".into(),
                total_tokens: 31,
                fallback: false,
            },
            Message::Error {
                code: ErrorCode::ProviderUnavailable,
                message: "down".into(),
            },
        ];
        for msg in cases {
            let env = Envelope::new("m1", 1000, msg).with_correlation("c1");
            let json = env.encode().unwrap();
            assert!(json.contains("\"schema_version\":1"));
            let back = Envelope::decode(&json).unwrap();
            assert_eq!(back, env);
        }
    }

    #[test]
    fn decode_tolerates_unknown_future_fields() {
        // A newer peer adds a field we don't know; we must still parse.
        let json = r#"{"schema_version":1,"msg_id":"m1","sent_at":5,
            "future_top_level":"ignored",
            "message":{"kind":"AskFridayRequest","prompt":"hi","future_field":42}}"#;
        let env = Envelope::decode(json).unwrap();
        assert_eq!(
            env.message,
            Message::AskFridayRequest {
                prompt: "hi".into()
            }
        );
    }

    #[test]
    fn decode_rejects_unknown_kind_explicitly() {
        let json = r#"{"schema_version":1,"msg_id":"m1","sent_at":5,
            "message":{"kind":"TeleportUser","whom":"all"}}"#;
        assert!(matches!(
            Envelope::decode(json),
            Err(ProtocolError::Decode(_))
        ));
    }

    #[test]
    fn version_negotiation_picks_highest_common() {
        assert_eq!(
            negotiate_version(
                VersionRange { min: 1, max: 3 },
                VersionRange { min: 2, max: 5 }
            )
            .unwrap(),
            3
        );
        assert_eq!(
            negotiate_version(
                VersionRange { min: 1, max: 1 },
                VersionRange { min: 1, max: 1 }
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn version_negotiation_errors_when_disjoint() {
        let err = negotiate_version(
            VersionRange { min: 1, max: 1 },
            VersionRange { min: 2, max: 4 },
        )
        .unwrap_err();
        assert!(matches!(err, ProtocolError::VersionUnsupported { .. }));
    }

    #[test]
    fn idempotency_executes_command_once() {
        let mut t = IdempotencyTracker::new();
        assert_eq!(t.observe("cmd-1"), Seen::First); // execute
        assert_eq!(t.observe("cmd-1"), Seen::Replay); // reconnect resend -> skip
        assert_eq!(t.observe("cmd-2"), Seen::First);
        assert!(t.has_seen("cmd-1"));
    }

    #[test]
    fn resumable_stream_replays_only_missed_frames() {
        let mut s = ResumableStream::new();
        assert_eq!(s.push("a"), 1);
        assert_eq!(s.push("b"), 2);
        assert_eq!(s.push("c"), 3);
        // Peer acked up to seq 1 -> it missed 2 and 3.
        let missed = s.missed_since(1);
        assert_eq!(
            missed,
            vec![
                StreamFrame {
                    seq: 2,
                    chunk: "b".into()
                },
                StreamFrame {
                    seq: 3,
                    chunk: "c".into()
                },
            ]
        );
        // Fully caught up -> nothing to replay.
        assert!(s.missed_since(3).is_empty());
    }

    #[test]
    fn provider_session_projection_wire_is_redacted() {
        let wire: ProviderSessionProjectionWire = friday_core::ProviderSessionLink {
            friday_session_id: "friday-s1".into(),
            provider: "codex".into(),
            account_key_hash: "account-hash".into(),
            workspace_id: "workspace".into(),
            cwd: Some("/Users/jarvis/private".into()),
            external_session_id: Some("external-session".into()),
            external_thread_id: Some("external-thread".into()),
            external_url: Some("https://provider.example/private".into()),
            sync_mode: friday_core::SyncMode::ProviderAppServerLocal,
            capability_snapshot: "thread/read".into(),
            last_provider_seen_at: Some(1),
            last_friday_event_id: Some("event-1".into()),
            truth_label: "provider local session".into(),
        }
        .redacted_projection()
        .into();
        let json = serde_json::to_string(&wire).unwrap();
        assert!(json.contains("provider_app_server_local"));
        for forbidden in [
            "account-hash",
            "/Users/jarvis/private",
            "external-session",
            "external-thread",
            "https://provider.example/private",
        ] {
            assert!(
                !json.contains(forbidden),
                "provider session wire projection leaked {forbidden}: {json}"
            );
        }
    }

    #[test]
    fn friday_pair_payload_wire_round_trips_and_projection_redacts_secret() {
        let payload = friday_core::FridayPairPayload::new(
            friday_core::CURRENT_PAIR_PAYLOAD_VERSION,
            "hub-mac-mini",
            "pair-1",
            "friday-pairing-secret-32-bytes",
            "Jarvis Mac mini",
            vec![friday_core::PairTransportHint::new(
                friday_core::PairTransportKind::LanWebSocket,
                "ws://192.168.1.8:4477",
                "LAN WebSocket",
            )
            .unwrap()],
            2000,
            vec![
                friday_core::PairAuthority::StatusOnly,
                friday_core::PairAuthority::Approvals,
            ],
        )
        .unwrap();
        let wire = FridayPairPayloadWire::from(&payload);
        let debug = format!("{wire:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(payload.pairing_secret.expose_for_qr()));

        let json = wire.encode_qr_json().unwrap();
        assert!(
            json.contains(payload.pairing_secret.expose_for_qr()),
            "QR JSON must carry the Friday-scoped pairing secret"
        );
        let decoded = FridayPairPayloadWire::decode_qr_json(&json)
            .unwrap()
            .into_core()
            .unwrap();
        decoded.validate_at(1000).unwrap();

        let projection: FridayPairProjectionWire = decoded.redacted_projection().into();
        let projection_json = serde_json::to_string(&projection).unwrap();
        assert!(!projection_json.contains(payload.pairing_secret.expose_for_qr()));
        assert!(projection_json.contains("LAN WebSocket"));
    }

    #[test]
    fn friday_pair_payload_wire_rejects_unknown_authority_and_provider_secret_hints() {
        let raw = r#"{
            "v":1,
            "hub_id":"hub",
            "pairing_id":"pair",
            "pairing_secret":"friday-pairing-secret-32-bytes",
            "display_name":"Hub",
            "transport_hints":[{"kind":"lan_websocket","endpoint":"ws://127.0.0.1:4477?api_key=abc","label":"LAN"}],
            "expires_at":2000,
            "capabilities_hint":["status_only"]
        }"#;
        assert!(FridayPairPayloadWire::decode_qr_json(raw)
            .unwrap()
            .into_core()
            .is_err());

        let raw = r#"{
            "v":1,
            "hub_id":"hub",
            "pairing_id":"pair",
            "pairing_secret":"friday-pairing-secret-32-bytes",
            "display_name":"Hub",
            "transport_hints":[{"kind":"lan_websocket","endpoint":"ws://127.0.0.1:4477","label":"LAN"}],
            "expires_at":2000,
            "capabilities_hint":["provider_oauth_admin"]
        }"#;
        assert!(FridayPairPayloadWire::decode_qr_json(raw)
            .unwrap()
            .into_core()
            .is_err());
    }
}
