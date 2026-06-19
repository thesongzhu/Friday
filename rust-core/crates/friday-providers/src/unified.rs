//! Unified provider session surface — C-PR1.
//!
//! These are Hub-side, metadata-first types for rendering Codex and Claude in
//! one Provider Workspace without pretending their native controls are the same.
//! Raw transcript text, command bodies, files, account ids, tokens, and URLs
//! stay behind `BodyRef`/`*_ref` handles owned by the Hub event store.

use friday_core::SyncMode;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlatformProvider {
    Codex,
    Claude,
}

impl PlatformProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            PlatformProvider::Codex => "codex",
            PlatformProvider::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderSyncMode {
    ProviderNativeSynced,
    ProviderAppServerLocal,
    FridayLocalMirror,
    ProviderNativeLinkOnly,
    UnsupportedTruthLabeled,
}

impl ProviderSyncMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProviderSyncMode::ProviderNativeSynced => "provider_native_synced",
            ProviderSyncMode::ProviderAppServerLocal => "provider_app_server_local",
            ProviderSyncMode::FridayLocalMirror => "friday_local_mirror",
            ProviderSyncMode::ProviderNativeLinkOnly => "provider_native_link_only",
            ProviderSyncMode::UnsupportedTruthLabeled => "unsupported_truth_labeled",
        }
    }
}

impl From<SyncMode> for ProviderSyncMode {
    fn from(value: SyncMode) -> Self {
        match value {
            SyncMode::ProviderNativeSynced => ProviderSyncMode::ProviderNativeSynced,
            SyncMode::ProviderAppServerLocal => ProviderSyncMode::ProviderAppServerLocal,
            SyncMode::FridayLocalMirror => ProviderSyncMode::FridayLocalMirror,
            SyncMode::ProviderNativeLinkOnly => ProviderSyncMode::ProviderNativeLinkOnly,
            SyncMode::UnsupportedTruthLabeled => ProviderSyncMode::UnsupportedTruthLabeled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    AwaitingApproval,
    AwaitingUserInput,
    Interrupted,
    Completed,
    Errored,
    Disconnected,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackStatus {
    NoFallback,
    UnavailableNoFallback,
    FallbackDisabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionLevel {
    MetadataOnly,
    RedactedPreview,
    EncryptedBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BodyRef {
    pub uri: String,
    pub redaction_level: RedactionLevel,
}

impl BodyRef {
    pub fn metadata(uri: impl Into<String>) -> Self {
        Self {
            uri: uri.into(),
            redaction_level: RedactionLevel::MetadataOnly,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderSession {
    pub friday_session_id: String,
    pub provider: PlatformProvider,
    pub workspace_id: String,
    pub sync_mode: ProviderSyncMode,
    pub status: SessionStatus,
    pub capability_snapshot: Vec<ProviderCapability>,
    pub external_thread_id: Option<String>,
    pub active_turn_id: Option<String>,
    pub last_event_seq: u64,
    pub truth_label: String,
    pub fallback_status: FallbackStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionEvent {
    pub event_id: String,
    pub provider: PlatformProvider,
    pub friday_session_id: String,
    pub provider_event_id: Option<String>,
    pub seq: u64,
    pub kind: SessionEventKind,
    pub status: SessionStatus,
    pub transcript_item: Option<TranscriptItem>,
    pub tool_call: Option<ToolCall>,
    pub approval_request: Option<ApprovalRequest>,
    pub user_question: Option<UserQuestion>,
    pub file_change: Option<FileChange>,
    pub command_output: Option<CommandOutput>,
    pub diff_summary: Option<DiffSummary>,
    pub attachment: Option<Attachment>,
    pub token_ledger_ref: Option<String>,
    pub audit_receipt_ref: Option<String>,
}

impl SessionEvent {
    pub fn needs_me(&self, priority: NeedsMePriority) -> Option<NeedsMeItem> {
        let (kind, ref_id) = match (&self.approval_request, &self.user_question) {
            (Some(approval), _) => (NeedsMeKind::Approval, approval.approval_ref.clone()),
            (None, Some(question)) => (NeedsMeKind::UserQuestion, question.question_ref.clone()),
            (None, None) => return None,
        };

        Some(NeedsMeItem {
            item_id: format!("needs-me:{}:{}", self.friday_session_id, ref_id),
            provider: self.provider,
            friday_session_id: self.friday_session_id.clone(),
            kind,
            priority,
            ref_id,
            status: self.status,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventKind {
    SessionStatus,
    UserMessage,
    AssistantMessage,
    ToolCall,
    ToolResult,
    ApprovalRequested,
    ApprovalResolved,
    UserQuestion,
    FileChange,
    CommandOutput,
    DiffUpdated,
    Attachment,
    TokenUsage,
    ProviderError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRole {
    User,
    Assistant,
    System,
    Tool,
    Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptItem {
    pub item_id: String,
    pub role: TranscriptRole,
    pub body_ref: BodyRef,
    pub provider_item_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool_call_id: String,
    pub tool_name: String,
    pub input_ref: BodyRef,
    pub risk_label: RiskLabel,
    pub approval_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLabel {
    SafeRead,
    NeedsApproval,
    HighRisk,
    Blocked,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub approval_ref: String,
    pub kind: ApprovalKind,
    pub tool_call_id: Option<String>,
    pub summary_ref: BodyRef,
    pub risk_label: RiskLabel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    CommandExecution,
    FileChange,
    Permissions,
    Plan,
    McpTool,
    ProviderNative,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserQuestion {
    pub question_ref: String,
    pub prompt_ref: BodyRef,
    pub option_count: u16,
    pub secret_answer_allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChange {
    pub file_change_ref: String,
    pub path_ref: BodyRef,
    pub summary_ref: BodyRef,
    pub diff_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandOutput {
    pub command_ref: String,
    pub stdout_ref: Option<BodyRef>,
    pub stderr_ref: Option<BodyRef>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffSummary {
    pub diff_ref: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub attachment_ref: String,
    pub mime_type: String,
    pub redaction_level: RedactionLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NeedsMeItem {
    pub item_id: String,
    pub provider: PlatformProvider,
    pub friday_session_id: String,
    pub kind: NeedsMeKind,
    pub priority: NeedsMePriority,
    pub ref_id: String,
    pub status: SessionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsMeKind {
    Approval,
    UserQuestion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsMePriority {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapability {
    pub capability_id: String,
    pub provider: PlatformProvider,
    pub status: CapabilityStatus,
    pub sync_mode: ProviderSyncMode,
    pub truth_label: String,
    pub blocker: Option<String>,
    pub proof_ref: Option<String>,
    pub native_action: Option<ProviderNativeAction>,
}

impl ProviderCapability {
    pub fn validate(&self) -> Result<(), UnifiedSurfaceError> {
        if self.status == CapabilityStatus::Verified && self.proof_ref.is_none() {
            return Err(UnifiedSurfaceError::VerifiedCapabilityMissingProof);
        }
        if self.status == CapabilityStatus::Blocked && self.blocker.is_none() {
            return Err(UnifiedSurfaceError::BlockedCapabilityMissingBlocker);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Verified,
    ImplementedUnproven,
    OperatorGated,
    ExternalBlocked,
    Blocked,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "provider_action", rename_all = "snake_case")]
pub enum ProviderNativeAction {
    CodexAppServer {
        method: CodexAppServerMethod,
        schema_ref: String,
    },
    ClaudeRemoteControl {
        action: ClaudeRemoteControlAction,
        proof_required: bool,
    },
    ClaudeStreamJson {
        event_type: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexAppServerMethod {
    ThreadList,
    ThreadRead,
    ThreadStart,
    ThreadResume,
    ThreadFork,
    TurnStart,
    TurnSteer,
    TurnInterrupt,
    ApprovalResponse,
    UserInputResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeRemoteControlAction {
    Launch,
    OpenSessionUrl,
    ShowQr,
    Disconnect,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum UnifiedSurfaceError {
    #[error("verified provider capability missing proof_ref")]
    VerifiedCapabilityMissingProof,

    #[error("blocked provider capability missing blocker")]
    BlockedCapabilityMissingBlocker,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval_event() -> SessionEvent {
        SessionEvent {
            event_id: "evt-1".into(),
            provider: PlatformProvider::Codex,
            friday_session_id: "friday-session-1".into(),
            provider_event_id: Some("codex-event-1".into()),
            seq: 7,
            kind: SessionEventKind::ApprovalRequested,
            status: SessionStatus::AwaitingApproval,
            transcript_item: Some(TranscriptItem {
                item_id: "item-1".into(),
                role: TranscriptRole::Tool,
                body_ref: BodyRef::metadata("friday://body/tool-summary/1"),
                provider_item_id: Some("provider-item-1".into()),
            }),
            tool_call: Some(ToolCall {
                tool_call_id: "tool-1".into(),
                tool_name: "shell".into(),
                input_ref: BodyRef::metadata("friday://body/tool-input/1"),
                risk_label: RiskLabel::HighRisk,
                approval_ref: Some("approval-1".into()),
            }),
            approval_request: Some(ApprovalRequest {
                approval_ref: "approval-1".into(),
                kind: ApprovalKind::CommandExecution,
                tool_call_id: Some("tool-1".into()),
                summary_ref: BodyRef::metadata("friday://body/approval-summary/1"),
                risk_label: RiskLabel::HighRisk,
            }),
            user_question: None,
            file_change: Some(FileChange {
                file_change_ref: "file-change-1".into(),
                path_ref: BodyRef::metadata("friday://body/path/1"),
                summary_ref: BodyRef::metadata("friday://body/file-summary/1"),
                diff_ref: Some("diff-1".into()),
            }),
            command_output: Some(CommandOutput {
                command_ref: "cmd-1".into(),
                stdout_ref: Some(BodyRef::metadata("friday://body/stdout/1")),
                stderr_ref: None,
                exit_code: None,
            }),
            diff_summary: Some(DiffSummary {
                diff_ref: "diff-1".into(),
                files_changed: 1,
                insertions: 4,
                deletions: 2,
            }),
            attachment: None,
            token_ledger_ref: None,
            audit_receipt_ref: Some("audit-1".into()),
        }
    }

    #[test]
    fn session_event_round_trips_without_flattening_shape() {
        let event = approval_event();
        let encoded = serde_json::to_string(&event).expect("serialize");
        let decoded: SessionEvent = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(decoded, event);
        assert_eq!(
            decoded.approval_request.as_ref().map(|a| a.kind),
            Some(ApprovalKind::CommandExecution)
        );
        assert_eq!(
            decoded.tool_call.as_ref().map(|t| t.risk_label),
            Some(RiskLabel::HighRisk)
        );
    }

    #[test]
    fn metadata_event_does_not_expose_raw_secret_or_transcript_strings() {
        let event = approval_event();
        let encoded = serde_json::to_string(&event).expect("serialize");
        let debug = format!("{event:?}");
        for forbidden in [
            "sk-live-secret",
            "jarvis@example.com",
            "org-secret",
            "rm -rf /private/project",
            "raw assistant transcript with private data",
        ] {
            assert!(!encoded.contains(forbidden), "json leaked {forbidden}");
            assert!(!debug.contains(forbidden), "debug leaked {forbidden}");
        }
        assert!(encoded.contains("friday://body/tool-input/1"));
    }

    #[test]
    fn provider_specific_native_actions_are_preserved() {
        let codex = ProviderCapability {
            capability_id: "provider.codex.turn.start".into(),
            provider: PlatformProvider::Codex,
            status: CapabilityStatus::ImplementedUnproven,
            sync_mode: ProviderSyncMode::ProviderAppServerLocal,
            truth_label: "codex_app_server_local_control".into(),
            blocker: None,
            proof_ref: None,
            native_action: Some(ProviderNativeAction::CodexAppServer {
                method: CodexAppServerMethod::TurnStart,
                schema_ref: "codex-schema:0.136.0".into(),
            }),
        };
        let claude = ProviderCapability {
            capability_id: "provider.claude.remote_control.open".into(),
            provider: PlatformProvider::Claude,
            status: CapabilityStatus::OperatorGated,
            sync_mode: ProviderSyncMode::ProviderNativeLinkOnly,
            truth_label: "claude_remote_control_link_only_until_live_proof".into(),
            blocker: Some("operator must connect same account Claude mobile/web".into()),
            proof_ref: None,
            native_action: Some(ProviderNativeAction::ClaudeRemoteControl {
                action: ClaudeRemoteControlAction::OpenSessionUrl,
                proof_required: true,
            }),
        };

        let codex_json = serde_json::to_value(&codex).expect("codex json");
        let claude_json = serde_json::to_value(&claude).expect("claude json");
        assert_eq!(
            codex_json["native_action"]["provider_action"],
            "codex_app_server"
        );
        assert_eq!(
            claude_json["native_action"]["provider_action"],
            "claude_remote_control"
        );
        assert_ne!(codex_json["native_action"], claude_json["native_action"]);
    }

    #[test]
    fn verified_capabilities_require_proof_and_blocked_require_blocker() {
        let mut capability = ProviderCapability {
            capability_id: "provider.codex.thread.list".into(),
            provider: PlatformProvider::Codex,
            status: CapabilityStatus::Verified,
            sync_mode: ProviderSyncMode::ProviderAppServerLocal,
            truth_label: "thread_list_verified".into(),
            blocker: None,
            proof_ref: None,
            native_action: Some(ProviderNativeAction::CodexAppServer {
                method: CodexAppServerMethod::ThreadList,
                schema_ref: "codex-schema:0.136.0".into(),
            }),
        };
        assert_eq!(
            capability.validate(),
            Err(UnifiedSurfaceError::VerifiedCapabilityMissingProof)
        );

        capability.proof_ref = Some("71-PNS004".into());
        assert_eq!(capability.validate(), Ok(()));

        capability.status = CapabilityStatus::Blocked;
        capability.proof_ref = None;
        assert_eq!(
            capability.validate(),
            Err(UnifiedSurfaceError::BlockedCapabilityMissingBlocker)
        );
        capability.blocker = Some("operator_gated".into());
        assert_eq!(capability.validate(), Ok(()));
    }

    #[test]
    fn needs_me_projects_approval_or_question_only() {
        let event = approval_event();
        let needs = event
            .needs_me(NeedsMePriority::High)
            .expect("approval needs me");
        assert_eq!(needs.kind, NeedsMeKind::Approval);
        assert_eq!(needs.ref_id, "approval-1");

        let mut neutral = event;
        neutral.approval_request = None;
        neutral.kind = SessionEventKind::AssistantMessage;
        assert!(neutral.needs_me(NeedsMePriority::Normal).is_none());
    }

    #[test]
    fn sync_mode_strings_match_core_file_60_contract() {
        for mode in [
            SyncMode::ProviderNativeSynced,
            SyncMode::ProviderAppServerLocal,
            SyncMode::FridayLocalMirror,
            SyncMode::ProviderNativeLinkOnly,
            SyncMode::UnsupportedTruthLabeled,
        ] {
            let unified: ProviderSyncMode = mode.into();
            assert_eq!(unified.as_str(), mode.as_str());
        }
        let encoded =
            serde_json::to_string(&ProviderSyncMode::UnsupportedTruthLabeled).expect("serialize");
        assert_eq!(encoded, "\"unsupported_truth_labeled\"");
    }

    #[test]
    fn fallback_status_is_explicit_no_provider_substitution() {
        let session = ProviderSession {
            friday_session_id: "friday-session-1".into(),
            provider: PlatformProvider::Claude,
            workspace_id: "workspace-1".into(),
            sync_mode: ProviderSyncMode::FridayLocalMirror,
            status: SessionStatus::Disconnected,
            capability_snapshot: Vec::new(),
            external_thread_id: None,
            active_turn_id: None,
            last_event_seq: 0,
            truth_label: "claude_unavailable_no_fallback".into(),
            fallback_status: FallbackStatus::UnavailableNoFallback,
        };

        let encoded = serde_json::to_string(&session).expect("serialize");
        assert!(encoded.contains("unavailable_no_fallback"));
        assert!(!encoded.contains("deepseek"));
        assert!(!encoded.contains("fallback_provider"));
    }
}
