//! Provider Workspace runtime projection.
//!
//! This is the Hub-side bridge between the provider-session contract and UI
//! surfaces. It is deliberately pure: no provider process is started, no model
//! call is made, and no provider credential is read. The goal is to make every
//! Provider Workspace action capability-driven before UI wiring exists.

use std::collections::BTreeMap;

use friday_protocol::{
    ProviderWorkspaceActionWire, ProviderWorkspaceNativeActionWire, ProviderWorkspaceNeedsMeWire,
    ProviderWorkspaceProjectionWire, ProviderWorkspaceSessionWire,
};
use friday_providers::unified::{
    CapabilityStatus, ClaudeRemoteControlAction, CodexAppServerMethod, FallbackStatus, NeedsMeItem,
    NeedsMeKind, NeedsMePriority, PlatformProvider, ProviderCapability, ProviderNativeAction,
    ProviderSession, ProviderSyncMode, SessionEvent, SessionStatus,
};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProviderWorkspaceError {
    #[error("provider capability failed validation: {capability_id}")]
    InvalidCapability { capability_id: String },

    #[error("non-routable provider capability missing blocker: {capability_id}")]
    NonRoutableCapabilityMissingBlocker { capability_id: String },

    #[error("provider capability/action mismatch: {capability_id} expected {expected_id}")]
    CapabilityActionMismatch {
        capability_id: String,
        expected_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProviderWorkspaceAction {
    ListSessions,
    ReadSession,
    StartSession,
    ResumeSession,
    ForkSession,
    SendTurn,
    SteerTurn,
    InterruptTurn,
    ApproveOrReject,
    AnswerQuestion,
    OpenProviderNative,
}

impl ProviderWorkspaceAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            ProviderWorkspaceAction::ListSessions => "list_sessions",
            ProviderWorkspaceAction::ReadSession => "read_session",
            ProviderWorkspaceAction::StartSession => "start_session",
            ProviderWorkspaceAction::ResumeSession => "resume_session",
            ProviderWorkspaceAction::ForkSession => "fork_session",
            ProviderWorkspaceAction::SendTurn => "send_turn",
            ProviderWorkspaceAction::SteerTurn => "steer_turn",
            ProviderWorkspaceAction::InterruptTurn => "interrupt_turn",
            ProviderWorkspaceAction::ApproveOrReject => "approve_or_reject",
            ProviderWorkspaceAction::AnswerQuestion => "answer_question",
            ProviderWorkspaceAction::OpenProviderNative => "open_provider_native",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderWorkspaceActionProjection {
    pub provider: PlatformProvider,
    pub action: ProviderWorkspaceAction,
    pub capability_id: String,
    pub sync_mode: ProviderSyncMode,
    pub status: CapabilityStatus,
    pub truth_label: String,
    pub routed: bool,
    pub blocker: Option<String>,
    pub proof_ref: Option<String>,
    pub native_action: Option<ProviderNativeAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderWorkspaceProjection {
    pub session: ProviderSession,
    pub actions: Vec<ProviderWorkspaceActionProjection>,
    pub needs_me: Vec<NeedsMeItem>,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderWorkspaceCatalog {
    capabilities: BTreeMap<(PlatformProvider, ProviderWorkspaceAction), ProviderCapability>,
}

impl ProviderWorkspaceCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        action: ProviderWorkspaceAction,
        capability: ProviderCapability,
    ) -> Result<(), ProviderWorkspaceError> {
        capability
            .validate()
            .map_err(|_| ProviderWorkspaceError::InvalidCapability {
                capability_id: capability.capability_id.clone(),
            })?;
        if capability.status != CapabilityStatus::Verified && capability.blocker.is_none() {
            return Err(
                ProviderWorkspaceError::NonRoutableCapabilityMissingBlocker {
                    capability_id: capability.capability_id,
                },
            );
        }
        let expected_id = capability_id(capability.provider, action);
        if capability.capability_id != expected_id {
            return Err(ProviderWorkspaceError::CapabilityActionMismatch {
                capability_id: capability.capability_id,
                expected_id,
            });
        }
        self.capabilities
            .insert((capability.provider, action), capability);
        Ok(())
    }

    pub fn resolve(
        &self,
        provider: PlatformProvider,
        action: ProviderWorkspaceAction,
    ) -> Option<Result<ProviderWorkspaceActionProjection, ProviderWorkspaceError>> {
        self.capabilities
            .get(&(provider, action))
            .map(|capability| project_action(action, capability))
    }

    pub fn project_session(
        &self,
        session: ProviderSession,
        events: &[SessionEvent],
    ) -> Result<ProviderWorkspaceProjection, ProviderWorkspaceError> {
        let mut actions = Vec::new();
        for action in PROVIDER_WORKSPACE_ACTIONS {
            let Some(projected) = self.resolve(session.provider, *action) else {
                continue;
            };
            actions.push(projected?);
        }
        let needs_me = events
            .iter()
            .filter(|event| event.provider == session.provider)
            .filter_map(|event| event.needs_me(NeedsMePriority::High))
            .collect();
        Ok(ProviderWorkspaceProjection {
            session,
            actions,
            needs_me,
        })
    }

    pub fn project_session_wire(
        &self,
        session: ProviderSession,
        events: &[SessionEvent],
    ) -> Result<ProviderWorkspaceProjectionWire, ProviderWorkspaceError> {
        self.project_session(session, events)
            .map(projection_to_wire)
    }

    /// Current Friday truth-labeled provider workspace catalog. It is not a
    /// provider parity claim: unproven actions are disabled with exact blockers.
    pub fn friday_current() -> Self {
        let mut catalog = Self::new();
        for (action, capability) in codex_current_capabilities() {
            catalog
                .register(action, capability)
                .expect("valid codex row");
        }
        for (action, capability) in claude_current_capabilities() {
            catalog
                .register(action, capability)
                .expect("valid claude row");
        }
        catalog
    }
}

pub fn projection_to_wire(
    projection: ProviderWorkspaceProjection,
) -> ProviderWorkspaceProjectionWire {
    ProviderWorkspaceProjectionWire {
        session: ProviderWorkspaceSessionWire {
            friday_session_id: projection.session.friday_session_id,
            provider: projection.session.provider.as_str().to_string(),
            workspace_id: projection.session.workspace_id,
            sync_mode: projection.session.sync_mode.as_str().to_string(),
            status: session_status_str(projection.session.status).to_string(),
            active_turn_id: projection.session.active_turn_id,
            last_event_seq: projection.session.last_event_seq,
            truth_label: projection.session.truth_label,
            fallback_status: fallback_status_str(projection.session.fallback_status).to_string(),
        },
        actions: projection.actions.into_iter().map(action_to_wire).collect(),
        needs_me: projection
            .needs_me
            .into_iter()
            .map(needs_me_to_wire)
            .collect(),
    }
}

fn action_to_wire(action: ProviderWorkspaceActionProjection) -> ProviderWorkspaceActionWire {
    ProviderWorkspaceActionWire {
        provider: action.provider.as_str().to_string(),
        action: action.action.as_str().to_string(),
        capability_id: action.capability_id,
        sync_mode: action.sync_mode.as_str().to_string(),
        status: capability_status_str(action.status).to_string(),
        truth_label: action.truth_label,
        routed: action.routed,
        blocker: action.blocker,
        proof_ref: action.proof_ref,
        native_action: action.native_action.map(native_action_to_wire),
    }
}

fn native_action_to_wire(action: ProviderNativeAction) -> ProviderWorkspaceNativeActionWire {
    match action {
        ProviderNativeAction::CodexAppServer { method, schema_ref } => {
            ProviderWorkspaceNativeActionWire::CodexAppServer {
                method: codex_method_str(method).to_string(),
                schema_ref,
            }
        }
        ProviderNativeAction::ClaudeRemoteControl {
            action,
            proof_required,
        } => ProviderWorkspaceNativeActionWire::ClaudeRemoteControl {
            action: claude_remote_action_str(action).to_string(),
            proof_required,
        },
        ProviderNativeAction::ClaudeStreamJson { event_type } => {
            ProviderWorkspaceNativeActionWire::ClaudeStreamJson { event_type }
        }
    }
}

fn needs_me_to_wire(item: NeedsMeItem) -> ProviderWorkspaceNeedsMeWire {
    ProviderWorkspaceNeedsMeWire {
        item_id: item.item_id,
        provider: item.provider.as_str().to_string(),
        friday_session_id: item.friday_session_id,
        kind: needs_me_kind_str(item.kind).to_string(),
        priority: needs_me_priority_str(item.priority).to_string(),
        ref_id: item.ref_id,
        status: session_status_str(item.status).to_string(),
    }
}

pub const PROVIDER_WORKSPACE_ACTIONS: &[ProviderWorkspaceAction] = &[
    ProviderWorkspaceAction::ListSessions,
    ProviderWorkspaceAction::ReadSession,
    ProviderWorkspaceAction::StartSession,
    ProviderWorkspaceAction::ResumeSession,
    ProviderWorkspaceAction::ForkSession,
    ProviderWorkspaceAction::SendTurn,
    ProviderWorkspaceAction::SteerTurn,
    ProviderWorkspaceAction::InterruptTurn,
    ProviderWorkspaceAction::ApproveOrReject,
    ProviderWorkspaceAction::AnswerQuestion,
    ProviderWorkspaceAction::OpenProviderNative,
];

fn capability_id(provider: PlatformProvider, action: ProviderWorkspaceAction) -> String {
    format!("provider.{}.{}", provider.as_str(), action.as_str())
}

fn session_status_str(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Idle => "idle",
        SessionStatus::Running => "running",
        SessionStatus::AwaitingApproval => "awaiting_approval",
        SessionStatus::AwaitingUserInput => "awaiting_user_input",
        SessionStatus::Interrupted => "interrupted",
        SessionStatus::Completed => "completed",
        SessionStatus::Errored => "errored",
        SessionStatus::Disconnected => "disconnected",
        SessionStatus::Unknown => "unknown",
    }
}

fn fallback_status_str(status: FallbackStatus) -> &'static str {
    match status {
        FallbackStatus::NoFallback => "no_fallback",
        FallbackStatus::UnavailableNoFallback => "unavailable_no_fallback",
        FallbackStatus::FallbackDisabled => "fallback_disabled",
    }
}

fn capability_status_str(status: CapabilityStatus) -> &'static str {
    match status {
        CapabilityStatus::Verified => "verified",
        CapabilityStatus::ImplementedUnproven => "implemented_unproven",
        CapabilityStatus::OperatorGated => "operator_gated",
        CapabilityStatus::ExternalBlocked => "external_blocked",
        CapabilityStatus::Blocked => "blocked",
        CapabilityStatus::Unsupported => "unsupported",
    }
}

fn codex_method_str(method: CodexAppServerMethod) -> &'static str {
    match method {
        CodexAppServerMethod::ThreadList => "thread_list",
        CodexAppServerMethod::ThreadRead => "thread_read",
        CodexAppServerMethod::ThreadStart => "thread_start",
        CodexAppServerMethod::ThreadResume => "thread_resume",
        CodexAppServerMethod::ThreadFork => "thread_fork",
        CodexAppServerMethod::TurnStart => "turn_start",
        CodexAppServerMethod::TurnSteer => "turn_steer",
        CodexAppServerMethod::TurnInterrupt => "turn_interrupt",
        CodexAppServerMethod::ApprovalResponse => "approval_response",
        CodexAppServerMethod::UserInputResponse => "user_input_response",
    }
}

fn claude_remote_action_str(action: ClaudeRemoteControlAction) -> &'static str {
    match action {
        ClaudeRemoteControlAction::Launch => "launch",
        ClaudeRemoteControlAction::OpenSessionUrl => "open_session_url",
        ClaudeRemoteControlAction::ShowQr => "show_qr",
        ClaudeRemoteControlAction::Disconnect => "disconnect",
    }
}

fn needs_me_kind_str(kind: NeedsMeKind) -> &'static str {
    match kind {
        NeedsMeKind::Approval => "approval",
        NeedsMeKind::UserQuestion => "user_question",
    }
}

fn needs_me_priority_str(priority: NeedsMePriority) -> &'static str {
    match priority {
        NeedsMePriority::Low => "low",
        NeedsMePriority::Normal => "normal",
        NeedsMePriority::High => "high",
        NeedsMePriority::Critical => "critical",
    }
}

fn project_action(
    action: ProviderWorkspaceAction,
    capability: &ProviderCapability,
) -> Result<ProviderWorkspaceActionProjection, ProviderWorkspaceError> {
    capability
        .validate()
        .map_err(|_| ProviderWorkspaceError::InvalidCapability {
            capability_id: capability.capability_id.clone(),
        })?;
    let routed = capability.status == CapabilityStatus::Verified;
    if !routed && capability.blocker.is_none() {
        return Err(
            ProviderWorkspaceError::NonRoutableCapabilityMissingBlocker {
                capability_id: capability.capability_id.clone(),
            },
        );
    }
    Ok(ProviderWorkspaceActionProjection {
        provider: capability.provider,
        action,
        capability_id: capability.capability_id.clone(),
        sync_mode: capability.sync_mode,
        status: capability.status,
        truth_label: capability.truth_label.clone(),
        routed,
        blocker: capability.blocker.clone(),
        proof_ref: capability.proof_ref.clone(),
        native_action: capability.native_action.clone(),
    })
}

#[derive(Debug, Clone)]
struct CapabilitySeed {
    provider: PlatformProvider,
    action: ProviderWorkspaceAction,
    status: CapabilityStatus,
    sync_mode: ProviderSyncMode,
    truth_label: &'static str,
    blocker: Option<&'static str>,
    proof_ref: Option<&'static str>,
    native_action: Option<ProviderNativeAction>,
}

impl CapabilitySeed {
    fn new(
        provider: PlatformProvider,
        action: ProviderWorkspaceAction,
        status: CapabilityStatus,
        sync_mode: ProviderSyncMode,
        truth_label: &'static str,
    ) -> Self {
        Self {
            provider,
            action,
            status,
            sync_mode,
            truth_label,
            blocker: None,
            proof_ref: None,
            native_action: None,
        }
    }

    fn maybe_blocker(mut self, blocker: Option<&'static str>) -> Self {
        self.blocker = blocker;
        self
    }

    fn maybe_proof_ref(mut self, proof_ref: Option<&'static str>) -> Self {
        self.proof_ref = proof_ref;
        self
    }

    fn maybe_native_action(mut self, native_action: Option<ProviderNativeAction>) -> Self {
        self.native_action = native_action;
        self
    }

    fn into_pair(self) -> (ProviderWorkspaceAction, ProviderCapability) {
        (
            self.action,
            ProviderCapability {
                capability_id: capability_id(self.provider, self.action),
                provider: self.provider,
                status: self.status,
                sync_mode: self.sync_mode,
                truth_label: self.truth_label.to_string(),
                blocker: self.blocker.map(ToString::to_string),
                proof_ref: self.proof_ref.map(ToString::to_string),
                native_action: self.native_action,
            },
        )
    }
}

macro_rules! cap {
    (
        $provider:expr,
        $action:expr,
        $status:expr,
        $sync_mode:expr,
        $truth_label:expr,
        $blocker:expr,
        $proof_ref:expr,
        $native_action:expr $(,)?
    ) => {
        CapabilitySeed::new($provider, $action, $status, $sync_mode, $truth_label)
            .maybe_blocker($blocker)
            .maybe_proof_ref($proof_ref)
            .maybe_native_action($native_action)
            .into_pair()
    };
}

fn codex_current_capabilities() -> Vec<(ProviderWorkspaceAction, ProviderCapability)> {
    use friday_providers::unified::CodexAppServerMethod as M;
    let blocker = "Codex app-server schema/metadata/mapping exists, but live turn lifecycle, approvals, and official-history behavior are not fully proven";
    vec![
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::ListSessions,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_thread_list_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::ThreadList,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::ReadSession,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_thread_read_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::ThreadRead,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::StartSession,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_thread_start_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::ThreadStart,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::ResumeSession,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_thread_resume_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::ThreadResume,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::ForkSession,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_thread_fork_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::ThreadFork,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::SendTurn,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_turn_start_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::TurnStart,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::SteerTurn,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_turn_steer_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::TurnSteer,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::InterruptTurn,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_turn_interrupt_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::TurnInterrupt,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::ApproveOrReject,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_approval_response_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::ApprovalResponse,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::AnswerQuestion,
            CapabilityStatus::ImplementedUnproven,
            ProviderSyncMode::ProviderAppServerLocal,
            "codex_app_server_local_user_input_response_unproven_for_ui",
            Some(blocker),
            None,
            Some(ProviderNativeAction::CodexAppServer {
                method: M::UserInputResponse,
                schema_ref: "codex-app-server-generated-schema".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Codex,
            ProviderWorkspaceAction::OpenProviderNative,
            CapabilityStatus::Unsupported,
            ProviderSyncMode::UnsupportedTruthLabeled,
            "codex_official_same_account_native_open_unproven",
            Some("no live proof that Friday app-server turns appear in official Codex/ChatGPT same-account history"),
            None,
            None,
        ),
    ]
}

fn claude_current_capabilities() -> Vec<(ProviderWorkspaceAction, ProviderCapability)> {
    use friday_providers::unified::ClaudeRemoteControlAction as R;
    let local_blocker = "Claude local mirror contract exists, but SDK/CLI session lifecycle and stream proof are not implemented";
    vec![
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::ListSessions,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_list_sessions_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "session_list".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::ReadSession,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_read_session_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "session_read".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::StartSession,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_start_session_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "query_start".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::ResumeSession,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_resume_session_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "session_resume".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::ForkSession,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_fork_session_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "session_fork".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::SendTurn,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_send_turn_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "stream_json_input".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::SteerTurn,
            CapabilityStatus::Unsupported,
            ProviderSyncMode::UnsupportedTruthLabeled,
            "claude_local_mirror_steer_turn_unsupported_until_official_surface",
            Some("no Claude local mirror steer-turn runtime owner is implemented or proven"),
            None,
            None,
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::InterruptTurn,
            CapabilityStatus::Blocked,
            ProviderSyncMode::ProviderNativeLinkOnly,
            "claude_remote_control_interrupt_link_only_until_live_proof",
            Some("Claude Remote Control live same-account proof is operator-gated; Friday cannot claim gate/control until observed"),
            None,
            Some(ProviderNativeAction::ClaudeRemoteControl {
                action: R::Disconnect,
                proof_required: true,
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::ApproveOrReject,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_approval_response_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "permission_response".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::AnswerQuestion,
            CapabilityStatus::Blocked,
            ProviderSyncMode::FridayLocalMirror,
            "claude_local_mirror_user_question_response_not_built",
            Some(local_blocker),
            None,
            Some(ProviderNativeAction::ClaudeStreamJson {
                event_type: "user_input_response".to_string(),
            }),
        ),
        cap!(
            PlatformProvider::Claude,
            ProviderWorkspaceAction::OpenProviderNative,
            CapabilityStatus::OperatorGated,
            ProviderSyncMode::ProviderNativeLinkOnly,
            "claude_remote_control_link_only_until_live_same_account_proof",
            Some("operator must log in and prove Claude Remote Control URL/QR controls the same local session from Claude mobile/browser"),
            None,
            Some(ProviderNativeAction::ClaudeRemoteControl {
                action: R::OpenSessionUrl,
                proof_required: true,
            }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_protocol::{Envelope, Message};
    use friday_providers::unified::{
        ApprovalKind, ApprovalRequest, BodyRef, RedactionLevel, RiskLabel, SessionEvent,
        SessionEventKind, SessionStatus,
    };

    fn session(provider: PlatformProvider) -> ProviderSession {
        ProviderSession {
            friday_session_id: format!("friday-{}", provider.as_str()),
            provider,
            workspace_id: "workspace-1".to_string(),
            sync_mode: match provider {
                PlatformProvider::Codex => ProviderSyncMode::ProviderAppServerLocal,
                PlatformProvider::Claude => ProviderSyncMode::FridayLocalMirror,
            },
            status: SessionStatus::Idle,
            capability_snapshot: Vec::new(),
            active_turn_id: None,
            last_event_seq: 0,
            truth_label: "provider workspace test".to_string(),
            fallback_status: friday_providers::unified::FallbackStatus::NoFallback,
        }
    }

    fn approval_event(provider: PlatformProvider) -> SessionEvent {
        SessionEvent {
            event_id: "event-1".to_string(),
            provider,
            friday_session_id: format!("friday-{}", provider.as_str()),
            provider_event_id: Some("provider-event-1".to_string()),
            seq: 1,
            kind: SessionEventKind::ApprovalRequested,
            status: SessionStatus::AwaitingApproval,
            transcript_item: None,
            tool_call: None,
            approval_request: Some(ApprovalRequest {
                approval_ref: "approval-1".to_string(),
                kind: ApprovalKind::CommandExecution,
                tool_call_id: Some("tool-1".to_string()),
                summary_ref: BodyRef {
                    uri: "friday://body/approval/1".to_string(),
                    redaction_level: RedactionLevel::MetadataOnly,
                },
                risk_label: RiskLabel::HighRisk,
            }),
            user_question: None,
            file_change: None,
            command_output: None,
            diff_summary: None,
            attachment: None,
            token_ledger_ref: None,
            audit_receipt_ref: Some("audit-1".to_string()),
        }
    }

    #[test]
    fn current_catalog_has_no_orphan_provider_workspace_actions() {
        let catalog = ProviderWorkspaceCatalog::friday_current();
        for provider in [PlatformProvider::Codex, PlatformProvider::Claude] {
            for action in PROVIDER_WORKSPACE_ACTIONS {
                let projected = catalog
                    .resolve(provider, *action)
                    .unwrap_or_else(|| panic!("{provider:?} {action:?} is orphaned"))
                    .expect("projection is valid");
                assert_eq!(projected.provider, provider);
                assert_eq!(projected.action, *action);
                assert!(!projected.capability_id.is_empty());
                if !projected.routed {
                    assert!(
                        projected.blocker.as_deref().is_some_and(|b| !b.is_empty()),
                        "disabled action must carry exact blocker: {provider:?} {action:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn current_codex_actions_are_local_app_server_not_official_history() {
        let catalog = ProviderWorkspaceCatalog::friday_current();
        let send = catalog
            .resolve(PlatformProvider::Codex, ProviderWorkspaceAction::SendTurn)
            .unwrap()
            .unwrap();
        assert!(!send.routed);
        assert_eq!(send.status, CapabilityStatus::ImplementedUnproven);
        assert_eq!(send.sync_mode, ProviderSyncMode::ProviderAppServerLocal);
        assert!(send
            .blocker
            .as_deref()
            .unwrap()
            .contains("official-history"));

        let native = catalog
            .resolve(
                PlatformProvider::Codex,
                ProviderWorkspaceAction::OpenProviderNative,
            )
            .unwrap()
            .unwrap();
        assert_eq!(native.sync_mode, ProviderSyncMode::UnsupportedTruthLabeled);
        assert!(!native.routed);
    }

    #[test]
    fn claude_remote_control_is_link_only_until_live_same_account_proof() {
        let catalog = ProviderWorkspaceCatalog::friday_current();
        let open = catalog
            .resolve(
                PlatformProvider::Claude,
                ProviderWorkspaceAction::OpenProviderNative,
            )
            .unwrap()
            .unwrap();
        assert_eq!(open.status, CapabilityStatus::OperatorGated);
        assert_eq!(open.sync_mode, ProviderSyncMode::ProviderNativeLinkOnly);
        assert!(!open.routed);
        assert!(open
            .truth_label
            .contains("link_only_until_live_same_account_proof"));
        assert!(matches!(
            open.native_action,
            Some(ProviderNativeAction::ClaudeRemoteControl { .. })
        ));
    }

    #[test]
    fn verified_capability_routes_only_with_proof() {
        let mut catalog = ProviderWorkspaceCatalog::new();
        catalog
            .register(
                ProviderWorkspaceAction::ListSessions,
                ProviderCapability {
                    capability_id: "provider.codex.list_sessions".to_string(),
                    provider: PlatformProvider::Codex,
                    status: CapabilityStatus::Verified,
                    sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                    truth_label: "verified app-server list".to_string(),
                    blocker: None,
                    proof_ref: Some("proof-1".to_string()),
                    native_action: Some(ProviderNativeAction::CodexAppServer {
                        method: friday_providers::unified::CodexAppServerMethod::ThreadList,
                        schema_ref: "schema".to_string(),
                    }),
                },
            )
            .unwrap();
        let projected = catalog
            .resolve(
                PlatformProvider::Codex,
                ProviderWorkspaceAction::ListSessions,
            )
            .unwrap()
            .unwrap();
        assert!(projected.routed);
        assert_eq!(projected.proof_ref.as_deref(), Some("proof-1"));
        assert!(projected.blocker.is_none());
    }

    #[test]
    fn non_verified_capability_without_blocker_is_rejected() {
        let mut catalog = ProviderWorkspaceCatalog::new();
        let err = catalog
            .register(
                ProviderWorkspaceAction::SendTurn,
                ProviderCapability {
                    capability_id: "provider.codex.send_turn".to_string(),
                    provider: PlatformProvider::Codex,
                    status: CapabilityStatus::ImplementedUnproven,
                    sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                    truth_label: "bad missing blocker".to_string(),
                    blocker: None,
                    proof_ref: None,
                    native_action: None,
                },
            )
            .unwrap_err();
        assert_eq!(
            err,
            ProviderWorkspaceError::NonRoutableCapabilityMissingBlocker {
                capability_id: "provider.codex.send_turn".to_string(),
            }
        );
    }

    #[test]
    fn capability_id_must_match_registered_action() {
        let mut catalog = ProviderWorkspaceCatalog::new();
        let err = catalog
            .register(
                ProviderWorkspaceAction::SendTurn,
                ProviderCapability {
                    capability_id: "provider.codex.list_sessions".to_string(),
                    provider: PlatformProvider::Codex,
                    status: CapabilityStatus::ImplementedUnproven,
                    sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                    truth_label: "bad mismatched action".to_string(),
                    blocker: Some("blocked but still mismatched".to_string()),
                    proof_ref: None,
                    native_action: None,
                },
            )
            .unwrap_err();
        assert_eq!(
            err,
            ProviderWorkspaceError::CapabilityActionMismatch {
                capability_id: "provider.codex.list_sessions".to_string(),
                expected_id: "provider.codex.send_turn".to_string(),
            }
        );
    }

    #[test]
    fn project_session_collects_needs_me_without_raw_provider_body() {
        let catalog = ProviderWorkspaceCatalog::friday_current();
        let projection = catalog
            .project_session(
                session(PlatformProvider::Codex),
                &[approval_event(PlatformProvider::Codex)],
            )
            .unwrap();
        assert_eq!(projection.needs_me.len(), 1);
        assert_eq!(projection.needs_me[0].ref_id, "approval-1");
        let debug = format!("{projection:?}");
        assert!(!debug.contains("rm -rf"));
        assert!(!debug.contains("sk-"));
        assert!(!debug.contains("provider-token"));
    }

    #[test]
    fn project_session_wire_round_trips_as_protocol_snapshot() {
        let catalog = ProviderWorkspaceCatalog::friday_current();
        let projection = catalog
            .project_session_wire(
                session(PlatformProvider::Codex),
                &[approval_event(PlatformProvider::Codex)],
            )
            .unwrap();
        assert_eq!(projection.session.provider, "codex");
        assert_eq!(
            projection.session.sync_mode,
            ProviderSyncMode::ProviderAppServerLocal.as_str()
        );
        assert_eq!(projection.actions.len(), PROVIDER_WORKSPACE_ACTIONS.len());
        assert_eq!(projection.needs_me.len(), 1);
        let send = projection
            .actions
            .iter()
            .find(|action| action.action == "send_turn")
            .expect("send_turn action present");
        assert!(!send.routed);
        assert_eq!(send.status, "implemented_unproven");
        assert!(send
            .blocker
            .as_deref()
            .unwrap()
            .contains("official-history"));

        let env = Envelope::new(
            "provider-workspace-1",
            100,
            Message::ProviderWorkspaceSnapshot { projection },
        );
        let json = env.encode().unwrap();
        assert!(json.contains("\"kind\":\"ProviderWorkspaceSnapshot\""));
        assert!(json.contains("\"schema_version\":2"));
        assert!(json.contains("\"capability_id\":\"provider.codex.send_turn\""));
        assert!(json.contains("\"provider_action\":\"codex_app_server\""));
        for forbidden in [
            "sk-",
            "provider-token",
            "account-hash",
            "/Users/jarvis/private",
            "external-thread",
            "https://provider.example/private",
            "rm -rf",
        ] {
            assert!(
                !json.contains(forbidden),
                "provider workspace wire leaked {forbidden}: {json}"
            );
        }
        let decoded = Envelope::decode(&json).unwrap();
        assert_eq!(decoded, env);
    }
}
