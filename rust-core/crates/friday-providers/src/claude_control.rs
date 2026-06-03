//! Claude Code control-surface contract — CLAUDE-001.
//!
//! This module classifies Claude control paths without starting a model turn.
//! It separates the official Remote Control path, which can provide provider-
//! native phone/browser continuity only after a live same-account connection is
//! proven, from local `--print --output-format=stream-json` mirroring, which is
//! Friday-owned history only.

use friday_core::{ProviderSessionEvent, SyncMode};
use serde_json::Value;
use thiserror::Error;

pub const CLAUDE_REMOTE_CONTROL_CANDIDATE_SYNC_MODE: &str =
    SyncMode::ProviderNativeLinkOnly.as_str();
pub const CLAUDE_STREAM_JSON_SYNC_MODE: &str = SyncMode::FridayLocalMirror.as_str();

#[derive(Debug, Error)]
pub enum ClaudeControlError {
    #[error("claude control surface parse failed: {code}")]
    Parse { code: &'static str },

    #[error("claude stream event missing required metadata: {code}")]
    MissingMetadata { code: &'static str },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeHelpCapabilities {
    pub remote_control_command: bool,
    pub remote_control_flag: bool,
    pub remote_control_qr: bool,
    pub remote_control_mobile_or_browser: bool,
    pub remote_control_spawn_worktree: bool,
    pub remote_control_capacity: bool,
    pub resume_flag: bool,
    pub continue_flag: bool,
    pub fork_session_flag: bool,
    pub session_id_flag: bool,
    pub stream_json_input: bool,
    pub stream_json_output: bool,
    pub partial_messages: bool,
    pub hook_events: bool,
    pub max_budget_usd: bool,
}

impl ClaudeHelpCapabilities {
    pub fn parse(main_help: &str, remote_control_help: &str) -> Self {
        let main = main_help.to_lowercase();
        let remote = remote_control_help.to_lowercase();
        Self {
            remote_control_command: remote.contains("remote control")
                && remote.contains("claude.ai/code"),
            remote_control_flag: main.contains("--remote-control"),
            remote_control_qr: remote.contains("qr code") || remote.contains("spacebar"),
            remote_control_mobile_or_browser: remote.contains("claude mobile app")
                && remote.contains("claude.ai/code"),
            remote_control_spawn_worktree: remote.contains("--spawn")
                && remote.contains("worktree"),
            remote_control_capacity: remote.contains("--capacity"),
            resume_flag: main.contains("--resume"),
            continue_flag: main.contains("--continue"),
            fork_session_flag: main.contains("--fork-session"),
            session_id_flag: main.contains("--session-id"),
            stream_json_input: main.contains("--input-format") && main.contains("stream-json"),
            stream_json_output: main.contains("--output-format") && main.contains("stream-json"),
            partial_messages: main.contains("--include-partial-messages"),
            hook_events: main.contains("--include-hook-events"),
            max_budget_usd: main.contains("--max-budget-usd"),
        }
    }

    pub fn has_remote_control_surface(&self) -> bool {
        self.remote_control_command
            && self.remote_control_flag
            && self.remote_control_mobile_or_browser
    }

    pub fn has_local_stream_surface(&self) -> bool {
        self.stream_json_input
            && self.stream_json_output
            && self.session_id_flag
            && self.resume_flag
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeControlMode {
    RemoteControl,
    StreamJsonLocalMirror,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClaudeRemoteControlProof {
    pub session_url_seen: bool,
    pub qr_seen: bool,
    pub same_account_verified: bool,
    pub remote_surface_connected: bool,
}

impl ClaudeRemoteControlProof {
    pub fn is_provider_native_sync_proof(self) -> bool {
        self.session_url_seen
            && self.qr_seen
            && self.same_account_verified
            && self.remote_surface_connected
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeControlSurface {
    pub mode: ClaudeControlMode,
    pub sync_mode: SyncMode,
    pub no_model_call: bool,
    pub truth_label: &'static str,
    pub requires_operator_login: bool,
    pub requires_live_connection_proof: bool,
}

pub fn classify_remote_control_surface(
    capabilities: &ClaudeHelpCapabilities,
    proof: ClaudeRemoteControlProof,
) -> ClaudeControlSurface {
    if !capabilities.has_remote_control_surface() {
        return ClaudeControlSurface {
            mode: ClaudeControlMode::Unsupported,
            sync_mode: SyncMode::UnsupportedTruthLabeled,
            no_model_call: true,
            truth_label: "claude_remote_control_not_available",
            requires_operator_login: true,
            requires_live_connection_proof: true,
        };
    }

    let proven = proof.is_provider_native_sync_proof();
    ClaudeControlSurface {
        mode: ClaudeControlMode::RemoteControl,
        sync_mode: if proven {
            SyncMode::ProviderNativeSynced
        } else {
            SyncMode::ProviderNativeLinkOnly
        },
        no_model_call: true,
        truth_label: if proven {
            "claude_remote_control_provider_native_synced_live_proven"
        } else {
            "claude_remote_control_available_but_sync_unproven"
        },
        requires_operator_login: true,
        requires_live_connection_proof: !proven,
    }
}

pub fn classify_stream_json_surface(capabilities: &ClaudeHelpCapabilities) -> ClaudeControlSurface {
    if !capabilities.has_local_stream_surface() {
        return ClaudeControlSurface {
            mode: ClaudeControlMode::Unsupported,
            sync_mode: SyncMode::UnsupportedTruthLabeled,
            no_model_call: true,
            truth_label: "claude_stream_json_not_available",
            requires_operator_login: true,
            requires_live_connection_proof: false,
        };
    }

    ClaudeControlSurface {
        mode: ClaudeControlMode::StreamJsonLocalMirror,
        sync_mode: SyncMode::FridayLocalMirror,
        no_model_call: true,
        truth_label: "claude_stream_json_friday_local_mirror",
        requires_operator_login: true,
        requires_live_connection_proof: false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeMirrorContext {
    pub friday_session_id: String,
    pub provider: String,
}

impl ClaudeMirrorContext {
    pub fn claude(friday_session_id: impl Into<String>) -> Self {
        Self {
            friday_session_id: friday_session_id.into(),
            provider: "claude".to_string(),
        }
    }
}

pub fn map_stream_json_to_provider_event(
    context: &ClaudeMirrorContext,
    value: &Value,
    observed_at: i64,
    mirror_seq: u64,
) -> Result<Option<ProviderSessionEvent>, ClaudeControlError> {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ClaudeControlError::MissingMetadata { code: "type" })?;
    if matches!(event_type, "ping" | "heartbeat") {
        return Ok(None);
    }

    let session_id = optional_string(value, "session_id")
        .or_else(|| optional_string(value, "sessionId"))
        .ok_or(ClaudeControlError::MissingMetadata { code: "session_id" })?;
    let message_id = optional_string(value, "message_id")
        .or_else(|| optional_string(value, "messageId"))
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| optional_string(message, "id"))
        })
        .unwrap_or_else(|| "no-message".to_string());

    let (event_kind, transcript_item_kind) = match event_type {
        "system" => ("session_status", "system"),
        "assistant" => ("assistant_message", "assistant_message"),
        "user" => ("user_message", "user_message"),
        "result" => ("turn_completed", "result"),
        "tool_use" => ("tool_use", "tool"),
        "tool_result" => ("tool_result", "tool"),
        "permission_request" | "tool_permission_request" => ("approval_requested", "approval"),
        _ => ("provider_event_unmapped", "provider_event"),
    };

    let approval_ref = if event_kind == "approval_requested" {
        Some(format!("claude:{event_type}:{session_id}:{message_id}"))
    } else {
        None
    };

    Ok(Some(ProviderSessionEvent {
        friday_session_id: context.friday_session_id.clone(),
        provider_event_id: format!("claude:{event_type}:{session_id}:{message_id}:{mirror_seq}"),
        provider: context.provider.clone(),
        event_kind: event_kind.to_string(),
        transcript_item_kind: transcript_item_kind.to_string(),
        body_ref: format!(
            "claude://stream-event/{}/{}/{}",
            context.friday_session_id, mirror_seq, event_type
        ),
        redaction_level: "metadata_only".to_string(),
        token_ledger_ref: None,
        approval_ref,
        audit_receipt_ref: None,
        observed_at,
    }))
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_capabilities() -> ClaudeHelpCapabilities {
        ClaudeHelpCapabilities::parse(
            r#"
Usage: claude [options]
  --remote-control [name]
  -r, --resume [value]
  -c, --continue
  --fork-session
  --session-id <uuid>
  --input-format <format> "text" or "stream-json"
  --output-format <format> "text", "json", or "stream-json"
  --include-partial-messages
  --include-hook-events
  --max-budget-usd <amount>
"#,
            r#"
Remote Control - Control local sessions from claude.ai/code or the Claude mobile app
USAGE claude remote-control [options]
  --spawn <mode> same-dir, worktree, session
  --capacity <N>
DESCRIPTION
  It displays a session URL. Press spacebar to show a QR code.
"#,
        )
    }

    #[test]
    fn help_parse_detects_remote_control_and_stream_json_surfaces() {
        let caps = fixture_capabilities();
        assert!(caps.has_remote_control_surface());
        assert!(caps.remote_control_spawn_worktree);
        assert!(caps.remote_control_capacity);
        assert!(caps.has_local_stream_surface());
        assert!(caps.partial_messages);
        assert!(caps.hook_events);
        assert!(caps.max_budget_usd);
    }

    #[test]
    fn remote_control_does_not_claim_native_sync_without_live_connection_proof() {
        let surface = classify_remote_control_surface(
            &fixture_capabilities(),
            ClaudeRemoteControlProof {
                session_url_seen: true,
                qr_seen: true,
                same_account_verified: false,
                remote_surface_connected: false,
            },
        );
        assert_eq!(surface.mode, ClaudeControlMode::RemoteControl);
        assert_eq!(surface.sync_mode, SyncMode::ProviderNativeLinkOnly);
        assert_eq!(
            surface.truth_label,
            "claude_remote_control_available_but_sync_unproven"
        );
        assert!(surface.requires_live_connection_proof);
    }

    #[test]
    fn remote_control_native_sync_requires_all_four_live_proof_bits() {
        let surface = classify_remote_control_surface(
            &fixture_capabilities(),
            ClaudeRemoteControlProof {
                session_url_seen: true,
                qr_seen: true,
                same_account_verified: true,
                remote_surface_connected: true,
            },
        );
        assert_eq!(surface.sync_mode, SyncMode::ProviderNativeSynced);
        assert_eq!(
            surface.truth_label,
            "claude_remote_control_provider_native_synced_live_proven"
        );
        assert!(!surface.requires_live_connection_proof);
    }

    #[test]
    fn stream_json_is_friday_local_mirror_not_provider_native_sync() {
        let surface = classify_stream_json_surface(&fixture_capabilities());
        assert_eq!(surface.mode, ClaudeControlMode::StreamJsonLocalMirror);
        assert_eq!(surface.sync_mode, SyncMode::FridayLocalMirror);
        assert_eq!(
            surface.truth_label,
            "claude_stream_json_friday_local_mirror"
        );
    }

    #[test]
    fn stream_json_events_map_to_metadata_only_provider_events() {
        let context = ClaudeMirrorContext::claude("friday-session-1");
        let value = json!({
            "type": "assistant",
            "session_id": "provider-session-1",
            "message": {
                "id": "msg-1",
                "content": "raw Claude transcript must not be inlined"
            }
        });
        let event = map_stream_json_to_provider_event(&context, &value, 42, 9)
            .unwrap()
            .unwrap();
        assert_eq!(event.provider, "claude");
        assert_eq!(event.event_kind, "assistant_message");
        assert_eq!(event.transcript_item_kind, "assistant_message");
        assert_eq!(event.redaction_level, "metadata_only");
        assert_eq!(event.approval_ref, None);
        let debug = format!("{event:?}");
        assert!(
            !debug.contains("raw Claude transcript"),
            "Claude mirror event must not inline raw provider text: {debug}"
        );
    }

    #[test]
    fn stream_json_permission_request_maps_to_approval_ref_without_raw_tool_body() {
        let context = ClaudeMirrorContext::claude("friday-session-1");
        let value = json!({
            "type": "permission_request",
            "sessionId": "provider-session-1",
            "messageId": "permission-1",
            "tool_input": { "command": "rm -rf /private/project" }
        });
        let event = map_stream_json_to_provider_event(&context, &value, 42, 10)
            .unwrap()
            .unwrap();
        assert_eq!(event.event_kind, "approval_requested");
        assert_eq!(
            event.approval_ref.as_deref(),
            Some("claude:permission_request:provider-session-1:permission-1")
        );
        let debug = format!("{event:?}");
        assert!(
            !debug.contains("rm -rf"),
            "approval mirror event must not inline raw tool body: {debug}"
        );
    }

    #[test]
    fn stream_json_events_missing_session_id_fail_closed() {
        let context = ClaudeMirrorContext::claude("friday-session-1");
        let value = json!({
            "type": "assistant",
            "message": { "id": "msg-1", "content": "text" }
        });
        assert!(matches!(
            map_stream_json_to_provider_event(&context, &value, 42, 11),
            Err(ClaudeControlError::MissingMetadata { code: "session_id" })
        ));
    }
}
