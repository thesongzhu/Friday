//! Provider session contract: sync truth labels + Hub-owned event mirror types.
//!
//! These are pure domain records. Provider adapters, network transports, SQL,
//! and UI projection live in their owning crates.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncMode {
    ProviderNativeSynced,
    ProviderAppServerLocal,
    FridayLocalMirror,
    ProviderNativeLinkOnly,
    UnsupportedTruthLabeled,
}

impl SyncMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            SyncMode::ProviderNativeSynced => "provider_native_synced",
            SyncMode::ProviderAppServerLocal => "provider_app_server_local",
            SyncMode::FridayLocalMirror => "friday_local_mirror",
            SyncMode::ProviderNativeLinkOnly => "provider_native_link_only",
            SyncMode::UnsupportedTruthLabeled => "unsupported_truth_labeled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "provider_native_synced" => Some(SyncMode::ProviderNativeSynced),
            "provider_app_server_local" => Some(SyncMode::ProviderAppServerLocal),
            "friday_local_mirror" => Some(SyncMode::FridayLocalMirror),
            "provider_native_link_only" => Some(SyncMode::ProviderNativeLinkOnly),
            "unsupported_truth_labeled" => Some(SyncMode::UnsupportedTruthLabeled),
            _ => None,
        }
    }
}

pub const ALL_SYNC_MODES: &[SyncMode] = &[
    SyncMode::ProviderNativeSynced,
    SyncMode::ProviderAppServerLocal,
    SyncMode::FridayLocalMirror,
    SyncMode::ProviderNativeLinkOnly,
    SyncMode::UnsupportedTruthLabeled,
];

/// Hub-only provider session link. It may contain local/private identifiers and
/// must not be projected to phone/channel surfaces directly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSessionLink {
    pub friday_session_id: String,
    pub provider: String,
    pub account_key_hash: String,
    pub workspace_id: String,
    pub cwd: Option<String>,
    pub external_session_id: Option<String>,
    pub external_thread_id: Option<String>,
    pub external_url: Option<String>,
    pub sync_mode: SyncMode,
    pub capability_snapshot: String,
    pub last_provider_seen_at: Option<i64>,
    pub last_friday_event_id: Option<String>,
    pub truth_label: String,
}

impl ProviderSessionLink {
    /// Redacted view safe for phone/channel UI. Raw account hashes, cwd, external
    /// ids, and URLs stay Hub-only.
    pub fn redacted_projection(&self) -> ProviderSessionProjection {
        ProviderSessionProjection {
            friday_session_id: self.friday_session_id.clone(),
            provider: self.provider.clone(),
            workspace_id: self.workspace_id.clone(),
            sync_mode: self.sync_mode,
            capability_snapshot: self.capability_snapshot.clone(),
            last_provider_seen_at: self.last_provider_seen_at,
            last_friday_event_id: self.last_friday_event_id.clone(),
            truth_label: self.truth_label.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSessionProjection {
    pub friday_session_id: String,
    pub provider: String,
    pub workspace_id: String,
    pub sync_mode: SyncMode,
    pub capability_snapshot: String,
    pub last_provider_seen_at: Option<i64>,
    pub last_friday_event_id: Option<String>,
    pub truth_label: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSessionEvent {
    pub friday_session_id: String,
    pub provider_event_id: String,
    pub provider: String,
    pub event_kind: String,
    pub transcript_item_kind: String,
    pub body_ref: String,
    pub redaction_level: String,
    pub token_ledger_ref: Option<String>,
    pub approval_ref: Option<String>,
    pub audit_receipt_ref: Option<String>,
    pub observed_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_modes_are_exact_file_60_values() {
        let values: Vec<&str> = ALL_SYNC_MODES.iter().map(|mode| mode.as_str()).collect();
        assert_eq!(
            values,
            vec![
                "provider_native_synced",
                "provider_app_server_local",
                "friday_local_mirror",
                "provider_native_link_only",
                "unsupported_truth_labeled",
            ]
        );
        for mode in ALL_SYNC_MODES {
            assert_eq!(SyncMode::parse(mode.as_str()), Some(*mode));
        }
        assert_eq!(SyncMode::parse("native_synced"), None);
    }

    #[test]
    fn redacted_projection_omits_hub_only_identity_and_urls() {
        let link = ProviderSessionLink {
            friday_session_id: "friday-s1".into(),
            provider: "codex".into(),
            account_key_hash: "acct-hash-secret".into(),
            workspace_id: "workspace-a".into(),
            cwd: Some("/Users/jarvis/private/project".into()),
            external_session_id: Some("provider-session-secret".into()),
            external_thread_id: Some("provider-thread-secret".into()),
            external_url: Some("https://provider.example/private".into()),
            sync_mode: SyncMode::ProviderAppServerLocal,
            capability_snapshot: "thread/start,turn/start".into(),
            last_provider_seen_at: Some(10),
            last_friday_event_id: Some("ev-1".into()),
            truth_label: "provider local session".into(),
        };

        let projection = format!("{:?}", link.redacted_projection());
        for forbidden in [
            "acct-hash-secret",
            "/Users/jarvis/private/project",
            "provider-session-secret",
            "provider-thread-secret",
            "https://provider.example/private",
        ] {
            assert!(
                !projection.contains(forbidden),
                "projection leaked Hub-only field {forbidden}: {projection}"
            );
        }
        assert!(projection.contains("provider local session"));
    }
}
