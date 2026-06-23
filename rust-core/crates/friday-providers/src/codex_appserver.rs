//! Codex App Server protocol harness — PNS-002.
//!
//! Scope: schema/method drift checks and JSON-RPC transport plumbing only. This
//! module does not start a model turn, does not call `codex exec`, and does not
//! claim official ChatGPT/Codex same-account history sync. It is the safe
//! foundation for later PNS-003 thread/turn control.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;

use friday_core::ProviderSessionEvent;

pub const CODEX_APP_SERVER_SYNC_MODE: &str = "provider_app_server_local";
pub const CODEX_APP_SERVER_CLI_VERSION: &str = "codex-cli 0.140.0";

/// Approval policy pinned for a [`CodexAppServerClient::run_turn`] model turn. `"never"`
/// (a value of `v2/AskForApproval`) keeps a non-interactive completion from triggering an
/// approval ask in this dark, no-operator-in-the-loop slice. Interactive approval routing
/// is explicitly out of scope for the flag-OFF default path (a mid-turn approval REQUEST
/// fails closed). When the [`FRIDAY_CODEX_MUTATING_GATE`] flag is ON, the gated turn pins
/// [`MODEL_TURN_GATE_APPROVAL_POLICY`] instead so approvals are FORCED and routed.
pub const MODEL_TURN_APPROVAL_POLICY: &str = "never";

/// Approval policy a GATED ([`FRIDAY_CODEX_MUTATING_GATE`]-ON) model turn pins on
/// `turn/start.approvalPolicy` (a string value of `v2/AskForApproval`; see the captured
/// `tests/fixtures/codex-schema/AskForApproval.json`).
///
/// `"untrusted"` is the value that forces an approval REQUEST for the broadest set of
/// actions — every command Codex does not classify as a built-in trusted read AND every
/// file-change / apply-patch. It is the correct choice for a *mutating* gate, and is chosen
/// over the three alternatives deliberately:
///   - `"never"` suppresses approvals entirely (the dark default; the gate would be a no-op
///     because Codex would never ask).
///   - `"on-request"` lets the MODEL decide when to ask. Forbidden by this gate's charter
///     ("never trust the model's classification") — a mutating action the model silently
///     self-approves would bypass the gate.
///   - `"on-failure"` only escalates AFTER a sandboxed command fails; a mutating action that
///     "succeeds" in-sandbox is never surfaced.
///
/// Honest scope note: under `"untrusted"`, trusted read-only commands still auto-run without
/// an approval request — which is exactly what a MUTATING gate wants (reads are not gated).
/// This constant only pins what we ASK Codex to do; whether Codex actually prompts for every
/// action is runtime behavior proven by PR2's live wiring, not by this PR's recorded-stream
/// KATs (which prove the marshaling + the response shape only).
pub const MODEL_TURN_GATE_APPROVAL_POLICY: &str = "untrusted";

/// Env flag that arms Codex pre-execution approval ROUTING in [`CodexAppServerClient`]'s
/// model turn. DEFAULT-OFF: unset / empty / `"0"` / any value other than the literal `"1"`
/// (after trimming) ⇒ OFF, byte-identical to the pre-flag behavior (a mid-turn approval
/// REQUEST fails closed with `interactive-approval-unsupported`, `approvalPolicy` stays
/// [`MODEL_TURN_APPROVAL_POLICY`]). Kept narrow + explicit so the gate can never be enabled
/// by accident (mirrors the `FRIDAY_TRUST_GRANT_ENFORCE` idiom in `friday-hub`).
///
/// When ON, the turn pins [`MODEL_TURN_GATE_APPROVAL_POLICY`] and routes each interleaved
/// `item/*/requestApproval` server-request through a Friday-supplied handler. The handler is
/// a pluggable callback; the DEFAULT handler (none supplied) is DENY-ALL. The actual
/// authorize decision is PR2's job — this surface only marshals the request + the response.
pub const FRIDAY_CODEX_MUTATING_GATE: &str = "FRIDAY_CODEX_MUTATING_GATE";

/// Pure flag-matcher for [`FRIDAY_CODEX_MUTATING_GATE`] (env read split out so the gate is
/// unit-testable without `set_var` — the env-race-free idiom this codebase uses everywhere;
/// see `friday-hub`'s `trust_grant_enforce_from`). ONLY the literal `"1"` (trimmed) enables;
/// everything else (including `"true"`) is OFF.
fn codex_mutating_gate_from(raw: Option<String>) -> bool {
    matches!(raw, Some(v) if v.trim() == "1")
}

/// Hard upper bound on JSON-RPC messages [`CodexAppServerClient::run_turn`] will read
/// before giving up with a typed `turn-no-completion` error. Guarantees a malformed or
/// never-completing notification stream terminates the loop instead of spinning forever.
pub const MODEL_TURN_MAX_MESSAGES: usize = 100_000;

/// Env override for the local `codex app-server --stdio` watchdog. The watchdog is a
/// process-level no-wedge guard: if the app-server stops emitting stdout, killing the child
/// breaks any blocking `read_line` in the stdio transport. DEFAULT is deliberately generous
/// for live provider calls and matches the mission-bound Codex dispatch budget; tests can
/// exercise the parser without mutating process env.
pub const FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS: &str = "FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS";
pub const DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS: u64 = 300_000;
pub const CODEX_APP_SERVER_WATCHDOG_WALL_MULTIPLIER: u32 = 4;

pub const REQUIRED_CLIENT_METHODS: &[&str] = &[
    "initialize",
    "thread/list",
    "thread/read",
    "thread/start",
    "thread/resume",
    "thread/fork",
    "thread/archive",
    "thread/unarchive",
    "thread/name/set",
    "thread/metadata/update",
    "thread/compact/start",
    "thread/rollback",
    "thread/inject_items",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
];

pub const REQUIRED_SERVER_REQUEST_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
];

pub const REQUIRED_SERVER_NOTIFICATION_METHODS: &[&str] = &[
    "thread/started",
    "thread/status/changed",
    "thread/tokenUsage/updated",
    "turn/started",
    "turn/completed",
    "turn/diff/updated",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
];

#[derive(Debug, Error)]
pub enum CodexAppServerError {
    #[error("codex app-server transport failed: {code}")]
    Transport { code: &'static str },

    #[error("codex app-server protocol error: {code}")]
    Protocol { code: &'static str },

    #[error("codex app-server schema drift: missing required methods")]
    SchemaDrift,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitializeSummary {
    pub platform_family: String,
    pub platform_os: String,
    pub user_agent: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadListProbe {
    pub item_count: usize,
    pub has_next_cursor: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadListSummary {
    pub threads: Vec<ThreadSummary>,
    pub has_next_cursor: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthSummary {
    pub initialized: InitializeSummary,
    pub thread_list: ThreadListProbe,
    pub sync_mode: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadSummary {
    pub thread_id: String,
    pub session_id: Option<String>,
    pub status: Option<String>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadReadSummary {
    pub thread: ThreadSummary,
    pub turn_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSummary {
    pub thread_id: String,
    pub turn_id: String,
    pub status: Option<String>,
    pub item_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterruptSummary {
    pub thread_id: String,
    pub turn_id: String,
}

/// Token usage for one model turn, projected from a `thread/tokenUsage/updated`
/// notification's `tokenUsage.last` breakdown (per `v2/ThreadTokenUsageUpdatedNotification.json`).
/// Optional on [`ModelTurnOutcome`] because the protocol does not guarantee the
/// notification arrives every turn — its absence is NOT a turn failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexTokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

/// The result of one Codex app-server MODEL TURN (`turn/start` → drive the notification
/// stream to `turn/completed`). Mirrors `friday_anthropic::ModelCallOutcome`: it carries
/// the assistant text + a terminal status + (when the protocol emitted it) token usage.
///
/// `content` is assembled from the AUTHORITATIVE `item/completed` agent-message items
/// (`AgentMessageThreadItem.text`, per `v2/ItemCompletedNotification.json` →
/// `ThreadItem`), NOT the `item/agentMessage/delta` concatenation — the schema warns the
/// completed item is authoritative and may not match the delta concat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelTurnOutcome {
    pub thread_id: String,
    pub turn_id: String,
    /// Terminal turn status (`completed` / `interrupted` / `failed`), from
    /// `turn/completed`'s `turn.status` (`v2/TurnStatus`).
    pub status: String,
    /// Concatenated authoritative agent-message text for this turn.
    pub content: String,
    /// Token usage if a `thread/tokenUsage/updated` arrived for this turn; else `None`.
    pub usage: Option<CodexTokenUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcServerMessage {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderMirrorContext {
    pub friday_session_id: String,
    pub provider: String,
}

impl ProviderMirrorContext {
    pub fn codex(friday_session_id: impl Into<String>) -> Self {
        Self {
            friday_session_id: friday_session_id.into(),
            provider: "codex".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerSchemaMethods {
    pub client_requests: BTreeSet<String>,
    pub server_requests: BTreeSet<String>,
    pub server_notifications: BTreeSet<String>,
}

impl CodexAppServerSchemaMethods {
    pub fn from_generated_bundle_dir(path: impl AsRef<Path>) -> Result<Self, CodexAppServerError> {
        let path = path.as_ref();
        Ok(Self {
            client_requests: extract_methods_from_schema_file(path.join("ClientRequest.json"))?,
            server_requests: extract_methods_from_schema_file(path.join("ServerRequest.json"))?,
            server_notifications: extract_methods_from_schema_file(
                path.join("ServerNotification.json"),
            )?,
        })
    }

    pub fn assert_required_surface(&self) -> Result<(), CodexAppServerError> {
        if has_all(&self.client_requests, REQUIRED_CLIENT_METHODS)
            && has_all(&self.server_requests, REQUIRED_SERVER_REQUEST_METHODS)
            && has_all(
                &self.server_notifications,
                REQUIRED_SERVER_NOTIFICATION_METHODS,
            )
        {
            Ok(())
        } else {
            Err(CodexAppServerError::SchemaDrift)
        }
    }
}

fn has_all(actual: &BTreeSet<String>, required: &[&str]) -> bool {
    required.iter().all(|m| actual.contains(*m))
}

fn extract_methods_from_schema_file(
    path: impl AsRef<Path>,
) -> Result<BTreeSet<String>, CodexAppServerError> {
    let bytes = std::fs::read(path).map_err(|_| CodexAppServerError::Transport {
        code: "schema-file-read",
    })?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| CodexAppServerError::Protocol {
            code: "schema-json",
        })?;
    let mut methods = BTreeSet::new();
    collect_method_enums(&value, &mut methods);
    Ok(methods)
}

fn collect_method_enums(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(method) = map.get("method").and_then(Value::as_object) {
                if let Some(values) = method.get("enum").and_then(Value::as_array) {
                    for item in values {
                        if let Some(s) = item.as_str() {
                            out.insert(s.to_string());
                        }
                    }
                }
            }
            for v in map.values() {
                collect_method_enums(v, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_method_enums(item, out);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcResponse {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<JsonRpcErrorEnvelope>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JsonRpcErrorEnvelope {
    pub code: i64,
    #[serde(default)]
    pub message: Option<String>,
}

/// One JSON-RPC message read off the app-server's stdout, classified by its shape so
/// the model-turn loop ([`CodexAppServerClient::run_turn`]) can route it. The Codex
/// app-server multiplexes three message kinds on the SAME stdout channel during a turn:
/// the synchronous `result`/`error` of a client request, server→client *notifications*
/// (no `id`, e.g. `turn/completed`), and server→client *requests* (an `id` + a `method`,
/// e.g. `item/commandExecution/requestApproval`) that expect a response.
#[derive(Debug, Clone, PartialEq)]
pub enum CodexInboundMessage {
    /// A reply to a client request (`id` matches, carries `result` or `error`).
    Response(JsonRpcResponse),
    /// A server-initiated notification (no `id`): carries a `method` + `params`.
    Notification { method: String, params: Value },
    /// A server-initiated REQUEST (has both an `id` and a `method`): expects a
    /// client response. During a non-interactive dark turn these are approval/elicitation
    /// asks; the turn loop surfaces them as a typed blocker (it does not route interactive
    /// approvals in this slice) rather than dropping them (which would hang the server).
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
}

/// Classify a raw JSON-RPC message value into a [`CodexInboundMessage`]. Shared by the
/// real [`JsonLineTransport`] and any in-memory transport so the SAME classification is
/// exercised in KATs and live. A value with both `id` and `method` is a server request;
/// `method` without `id` is a notification; everything else is a response.
pub fn classify_inbound(value: Value) -> Result<CodexInboundMessage, CodexAppServerError> {
    let has_method = value.get("method").and_then(Value::as_str).is_some();
    let id = value.get("id").cloned().filter(|v| !v.is_null());
    match (has_method, id) {
        (true, Some(id)) => Ok(CodexInboundMessage::ServerRequest {
            id,
            method: value
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            params: value.get("params").cloned().unwrap_or(Value::Null),
        }),
        (true, None) => Ok(CodexInboundMessage::Notification {
            method: value
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            params: value.get("params").cloned().unwrap_or(Value::Null),
        }),
        (false, _) => serde_json::from_value(value)
            .map(CodexInboundMessage::Response)
            .map_err(|_| CodexAppServerError::Protocol {
                code: "response-json",
            }),
    }
}

/// A Codex app-server pre-execution APPROVAL request, parsed from an interleaved
/// `CodexInboundMessage::ServerRequest` into a typed shape a Friday approval handler can
/// inspect. Every variant carries ONLY the fields present in the captured app-server schema
/// for that method (see `tests/fixtures/codex-schema/`) — nothing is invented.
///
/// The four variants correspond to the four approval `method`s the app-server can issue:
///   - [`CodexServerRequest::CommandExecution`] ⇐ `item/commandExecution/requestApproval`
///     (`CommandExecutionRequestApprovalParams.json`)
///   - [`CodexServerRequest::FileChange`]       ⇐ `item/fileChange/requestApproval`
///     (`FileChangeRequestApprovalParams.json`)
///   - [`CodexServerRequest::ExecCommand`]      ⇐ `execCommandApproval`
///     (`ExecCommandApprovalParams.json`, legacy v1 surface)
///   - [`CodexServerRequest::ApplyPatch`]       ⇐ `applyPatchApproval`
///     (`ApplyPatchApprovalParams.json`, legacy v1 surface)
///
/// IMPORTANT: the two `item/*/requestApproval` methods take an `accept`/`decline`/`cancel`
/// decision family (`CommandExecutionApprovalDecision` / `FileChangeApprovalDecision`),
/// while the legacy `execCommandApproval` / `applyPatchApproval` take a `ReviewDecision`
/// (`approved`/`denied`/`abort`). The per-variant `decision_*` helpers below encode that
/// split, so the response written to the transport always matches the method's schema. The
/// raw command/path text is carried for the handler but NEVER inlined into a
/// [`CodexAppServerError`] (which stays code-only) or surfaced in Debug-sensitive paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexServerRequest {
    /// `item/commandExecution/requestApproval` — a v2 command-execution approval ask.
    CommandExecution {
        thread_id: String,
        turn_id: String,
        item_id: String,
        /// Distinct opaque callback id (UUID) for zsh-exec-bridge subcommand approvals;
        /// `null` for regular shell/unified_exec approvals (per the schema).
        approval_id: Option<String>,
        /// The command to be executed (optional per the schema).
        command: Option<String>,
        /// The command's working directory (`AbsolutePathBuf`, optional).
        cwd: Option<String>,
    },
    /// `item/fileChange/requestApproval` — a v2 file-change approval ask. NOTE: this params
    /// shape carries NO path/diff (only ids + optional `grantRoot`/`reason`); the
    /// path-bearing change set lives on [`CodexServerRequest::ApplyPatch`].
    FileChange {
        thread_id: String,
        turn_id: String,
        item_id: String,
        /// `[UNSTABLE]` root the agent asks to grant writes under for the session.
        grant_root: Option<String>,
    },
    /// `execCommandApproval` — legacy v1 exec-command approval ask (uses `ReviewDecision`).
    ExecCommand {
        conversation_id: String,
        call_id: String,
        approval_id: Option<String>,
        cwd: String,
        /// The argv vector of the command to be executed.
        command: Vec<String>,
    },
    /// `applyPatchApproval` — legacy v1 apply-patch approval ask (uses `ReviewDecision`).
    ApplyPatch {
        conversation_id: String,
        call_id: String,
        grant_root: Option<String>,
        /// The set of changed file paths (keys of the `fileChanges` map). The diff/content
        /// bodies are intentionally NOT carried here (this surface marshals the request;
        /// the authorize decision + any body inspection is PR2's job).
        changed_paths: Vec<String>,
    },
}

impl CodexServerRequest {
    /// The JSON-RPC `method` this request was parsed from (for response routing + audit).
    pub fn method(&self) -> &'static str {
        match self {
            CodexServerRequest::CommandExecution { .. } => "item/commandExecution/requestApproval",
            CodexServerRequest::FileChange { .. } => "item/fileChange/requestApproval",
            CodexServerRequest::ExecCommand { .. } => "execCommandApproval",
            CodexServerRequest::ApplyPatch { .. } => "applyPatchApproval",
        }
    }

    /// Build the JSON-RPC `result` body to write back for `decision`, in the EXACT response
    /// shape the originating method's schema requires. The two `item/*` methods take the
    /// `accept`/`decline`/`cancel` family; the legacy methods take `ReviewDecision`
    /// (`approved`/`denied`/`abort`). Single-shot decisions ONLY — never the session-caching
    /// or policy-amendment variants (those would defeat the gate on subsequent actions).
    fn response_result(&self, decision: CodexApprovalDecision) -> Value {
        match self {
            // v2 `accept`/`decline`/`cancel` family (CommandExecution/FileChange decision).
            CodexServerRequest::CommandExecution { .. } | CodexServerRequest::FileChange { .. } => {
                let d = match decision {
                    CodexApprovalDecision::Allow => "accept",
                    // `cancel` (not `decline`) so a denied mutating action ALSO interrupts the
                    // turn — fail-closed parity with the legacy `abort` below.
                    CodexApprovalDecision::Deny => "cancel",
                };
                json!({ "decision": d })
            }
            // legacy v1 `ReviewDecision` family (ExecCommand/ApplyPatch).
            CodexServerRequest::ExecCommand { .. } | CodexServerRequest::ApplyPatch { .. } => {
                let d = match decision {
                    CodexApprovalDecision::Allow => "approved",
                    CodexApprovalDecision::Deny => "abort",
                };
                json!({ "decision": d })
            }
        }
    }
}

/// A Friday approval decision for a [`CodexServerRequest`]. Deliberately MINIMAL — only a
/// single-shot Allow or Deny. The session-caching (`acceptForSession` / `approved_for_session`)
/// and policy-amendment (`acceptWithExecpolicyAmendment` / network-amendment) variants the
/// Codex schema also defines are intentionally NOT representable here: they would cache an
/// approval and silently auto-approve later actions, defeating a per-action mutating gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexApprovalDecision {
    /// Approve this single action; the turn continues.
    Allow,
    /// Deny this single action AND interrupt the turn (fail-closed).
    Deny,
}

/// Parse a server-initiated approval REQUEST (`method` + `params`) into a typed
/// [`CodexServerRequest`]. Field extraction is manual (mirroring this module's
/// `required_string` / `extract_optional_string` idiom) so a malformed/partial params object
/// yields a typed [`CodexAppServerError::Protocol`] — never a panic/unwrap. An unrecognized
/// `method` (e.g. `item/permissions/requestApproval`, `item/tool/requestUserInput`,
/// `mcpServer/elicitation/request`) is NOT an approval this surface routes: it returns a
/// typed `unroutable-server-request` error so the gated loop fails CLOSED rather than
/// guessing a response shape.
pub fn parse_server_request(
    method: &str,
    params: &Value,
) -> Result<CodexServerRequest, CodexAppServerError> {
    match method {
        "item/commandExecution/requestApproval" => Ok(CodexServerRequest::CommandExecution {
            thread_id: required_string(params, "threadId")?,
            turn_id: required_string(params, "turnId")?,
            item_id: required_string(params, "itemId")?,
            approval_id: optional_string(params, "approvalId"),
            command: optional_string(params, "command"),
            cwd: optional_string(params, "cwd"),
        }),
        "item/fileChange/requestApproval" => Ok(CodexServerRequest::FileChange {
            thread_id: required_string(params, "threadId")?,
            turn_id: required_string(params, "turnId")?,
            item_id: required_string(params, "itemId")?,
            grant_root: optional_string(params, "grantRoot"),
        }),
        "execCommandApproval" => Ok(CodexServerRequest::ExecCommand {
            conversation_id: required_string(params, "conversationId")?,
            call_id: required_string(params, "callId")?,
            approval_id: optional_string(params, "approvalId"),
            cwd: required_string(params, "cwd")?,
            command: required_string_array(params, "command")?,
        }),
        "applyPatchApproval" => Ok(CodexServerRequest::ApplyPatch {
            conversation_id: required_string(params, "conversationId")?,
            call_id: required_string(params, "callId")?,
            grant_root: optional_string(params, "grantRoot"),
            changed_paths: object_keys(params, "fileChanges")?,
        }),
        _ => Err(CodexAppServerError::Protocol {
            code: "unroutable-server-request",
        }),
    }
}

pub trait CodexAppServerTransport {
    fn request(&mut self, request: JsonRpcRequest) -> Result<JsonRpcResponse, CodexAppServerError>;

    /// Send a fire-and-forget JSON-RPC notification (no id, no response wait). Default
    /// no-op so in-memory / mocked transports need not implement it; the real
    /// [`JsonLineTransport`] overrides it. Used for the post-`initialize` `initialized`
    /// handshake the app-server expects before thread/turn calls.
    fn notify(&mut self, _method: &str, _params: Option<Value>) -> Result<(), CodexAppServerError> {
        Ok(())
    }

    /// Read the NEXT JSON-RPC message off the channel and classify it. Drives the
    /// model-turn loop, which (unlike a single request/response) must consume the
    /// interleaved notification + server-request stream until `turn/completed`. The
    /// default errors so a transport that cannot stream (e.g. the request/response-only
    /// [`MockCodexAppServerTransport`]) fails closed rather than silently hanging a turn.
    fn read_message(&mut self) -> Result<CodexInboundMessage, CodexAppServerError> {
        Err(CodexAppServerError::Transport {
            code: "read-message-unsupported",
        })
    }

    /// Send a JSON-RPC RESPONSE to a server-initiated request (used to unblock an
    /// interleaved approval/elicitation ask so the turn does not hang). Default no-op
    /// for transports that do not stream; the real [`JsonLineTransport`] overrides it.
    fn respond(&mut self, _id: &Value, _result: Value) -> Result<(), CodexAppServerError> {
        Ok(())
    }
}

pub struct JsonLineTransport<R, W> {
    reader: BufReader<R>,
    writer: W,
    watchdog_progress: Option<Sender<AppServerWatchdogSignal>>,
}

impl<R: Read, W: Write> JsonLineTransport<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self::with_watchdog_progress(reader, writer, None)
    }

    fn with_watchdog_progress(
        reader: R,
        writer: W,
        watchdog_progress: Option<Sender<AppServerWatchdogSignal>>,
    ) -> Self {
        Self {
            reader: BufReader::new(reader),
            writer,
            watchdog_progress,
        }
    }

    pub fn into_parts(self) -> (BufReader<R>, W) {
        (self.reader, self.writer)
    }

    fn note_stdout_progress(&self) {
        if let Some(progress) = &self.watchdog_progress {
            let _ = progress.send(AppServerWatchdogSignal::Progress);
        }
    }
}

impl<R: Read, W: Write> CodexAppServerTransport for JsonLineTransport<R, W> {
    fn notify(&mut self, method: &str, params: Option<Value>) -> Result<(), CodexAppServerError> {
        let mut msg = serde_json::Map::new();
        msg.insert("jsonrpc".to_string(), json!("2.0"));
        msg.insert("method".to_string(), json!(method));
        if let Some(p) = params {
            msg.insert("params".to_string(), p);
        }
        let encoded =
            serde_json::to_vec(&Value::Object(msg)).map_err(|_| CodexAppServerError::Protocol {
                code: "notify-encode",
            })?;
        self.writer
            .write_all(&encoded)
            .and_then(|_| self.writer.write_all(b"\n"))
            .and_then(|_| self.writer.flush())
            .map_err(|_| CodexAppServerError::Transport {
                code: "notify-write",
            })
    }

    fn read_message(&mut self) -> Result<CodexInboundMessage, CodexAppServerError> {
        let mut line = String::new();
        let read =
            self.reader
                .read_line(&mut line)
                .map_err(|_| CodexAppServerError::Transport {
                    code: "stream-read",
                })?;
        if read == 0 {
            return Err(CodexAppServerError::Transport { code: "stream-eof" });
        }
        self.note_stdout_progress();
        let value: Value =
            serde_json::from_str(&line).map_err(|_| CodexAppServerError::Protocol {
                code: "stream-json",
            })?;
        classify_inbound(value)
    }

    fn respond(&mut self, id: &Value, result: Value) -> Result<(), CodexAppServerError> {
        let encoded = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }))
        .map_err(|_| CodexAppServerError::Protocol {
            code: "respond-encode",
        })?;
        self.writer
            .write_all(&encoded)
            .and_then(|_| self.writer.write_all(b"\n"))
            .and_then(|_| self.writer.flush())
            .map_err(|_| CodexAppServerError::Transport {
                code: "respond-write",
            })
    }

    fn request(&mut self, request: JsonRpcRequest) -> Result<JsonRpcResponse, CodexAppServerError> {
        let request_id = request.id;
        let encoded = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": request.method,
            "params": request.params,
        }))
        .map_err(|_| CodexAppServerError::Protocol {
            code: "request-encode",
        })?;
        self.writer
            .write_all(&encoded)
            .and_then(|_| self.writer.write_all(b"\n"))
            .and_then(|_| self.writer.flush())
            .map_err(|_| CodexAppServerError::Transport {
                code: "request-write",
            })?;

        loop {
            let mut line = String::new();
            let read =
                self.reader
                    .read_line(&mut line)
                    .map_err(|_| CodexAppServerError::Transport {
                        code: "response-read",
                    })?;
            if read == 0 {
                return Err(CodexAppServerError::Transport {
                    code: "response-eof",
                });
            }
            self.note_stdout_progress();
            let value: Value =
                serde_json::from_str(&line).map_err(|_| CodexAppServerError::Protocol {
                    code: "response-json",
                })?;
            match value.get("id") {
                Some(id) if id == &json!(request_id) => {
                    return serde_json::from_value(value).map_err(|_| {
                        CodexAppServerError::Protocol {
                            code: "response-json",
                        }
                    });
                }
                Some(_) => {
                    return Err(CodexAppServerError::Protocol {
                        code: "interleaved-server-request",
                    });
                }
                None => {
                    continue;
                }
            }
        }
    }
}

pub struct CodexAppServerClient<T> {
    transport: T,
    next_id: u64,
}

impl<T: CodexAppServerTransport> CodexAppServerClient<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            next_id: 1,
        }
    }

    pub fn into_transport(self) -> T {
        self.transport
    }

    pub fn initialize(
        &mut self,
        client_name: &str,
        client_version: &str,
    ) -> Result<InitializeSummary, CodexAppServerError> {
        let result = self.call(
            "initialize",
            json!({
                "clientInfo": {
                    "name": client_name,
                    "title": "Friday Hub",
                    "version": client_version,
                },
                "capabilities": {
                    "experimentalApi": false,
                    "requestAttestation": false,
                    "optOutNotificationMethods": null,
                }
            }),
        )?;
        Ok(InitializeSummary {
            platform_family: required_string(&result, "platformFamily")?,
            platform_os: required_string(&result, "platformOs")?,
            user_agent: required_string(&result, "userAgent")?,
        })
    }

    /// Send the post-`initialize` `initialized` notification (JSON-RPC fire-and-forget).
    /// The app-server expects it before thread/turn calls. A no-op for transports that do
    /// not override `notify` (the in-memory test transports).
    pub fn initialized(&mut self) -> Result<(), CodexAppServerError> {
        self.transport.notify("initialized", None)
    }

    /// Non-model health probe. `thread/list` is a metadata read; it must not be
    /// used as proof of a model send or official provider-history sync.
    pub fn thread_list_probe(&mut self) -> Result<ThreadListProbe, CodexAppServerError> {
        let list = self.list_threads(1, true)?;
        Ok(ThreadListProbe {
            item_count: list.threads.len(),
            has_next_cursor: list.has_next_cursor,
        })
    }

    pub fn list_threads(
        &mut self,
        limit: u64,
        use_state_db_only: bool,
    ) -> Result<ThreadListSummary, CodexAppServerError> {
        let result = self.call(
            "thread/list",
            json!({
                "limit": limit,
                "archived": false,
                "useStateDbOnly": use_state_db_only,
            }),
        )?;
        let data =
            result
                .get("data")
                .and_then(Value::as_array)
                .ok_or(CodexAppServerError::Protocol {
                    code: "thread-list-data",
                })?;
        let threads = data
            .iter()
            .map(thread_summary_from_thread_value)
            .collect::<Result<Vec<_>, _>>()?;
        let has_next_cursor = result.get("nextCursor").is_some_and(|v| !v.is_null());
        Ok(ThreadListSummary {
            threads,
            has_next_cursor,
        })
    }

    pub fn health_check(
        &mut self,
        client_name: &str,
        client_version: &str,
    ) -> Result<HealthSummary, CodexAppServerError> {
        let initialized = self.initialize(client_name, client_version)?;
        let thread_list = self.thread_list_probe()?;
        Ok(HealthSummary {
            initialized,
            thread_list,
            sync_mode: CODEX_APP_SERVER_SYNC_MODE,
        })
    }

    pub fn start_thread(
        &mut self,
        cwd: Option<&str>,
        model: Option<&str>,
    ) -> Result<ThreadSummary, CodexAppServerError> {
        let result = self.call(
            "thread/start",
            json!({
                "cwd": cwd,
                "model": model,
                "modelProvider": null,
                "approvalPolicy": null,
                "approvalsReviewer": null,
                "sandbox": null,
                "ephemeral": false,
                "threadSource": null,
                "sessionStartSource": null,
            }),
        )?;
        thread_summary_from_response(&result)
    }

    pub fn resume_thread(&mut self, thread_id: &str) -> Result<ThreadSummary, CodexAppServerError> {
        let result = self.call(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "approvalPolicy": null,
                "approvalsReviewer": null,
            }),
        )?;
        thread_summary_from_response(&result)
    }

    pub fn read_thread(
        &mut self,
        thread_id: &str,
        include_turns: bool,
    ) -> Result<ThreadReadSummary, CodexAppServerError> {
        let result = self.call(
            "thread/read",
            json!({
                "threadId": thread_id,
                "includeTurns": include_turns,
            }),
        )?;
        let thread_value = result.get("thread").ok_or(CodexAppServerError::Protocol {
            code: "thread-missing",
        })?;
        let turn_count = thread_value
            .get("turns")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        Ok(ThreadReadSummary {
            thread: thread_summary_from_thread_value(thread_value)?,
            turn_count,
        })
    }

    pub fn send_turn_text(
        &mut self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
    ) -> Result<TurnSummary, CodexAppServerError> {
        let result = self.call(
            "turn/start",
            json!({
                "threadId": thread_id,
                "clientUserMessageId": client_user_message_id,
                "input": [
                    {
                        "type": "text",
                        "text": text,
                    }
                ],
            }),
        )?;
        turn_summary_from_response(thread_id, &result)
    }

    pub fn steer_turn_text(
        &mut self,
        thread_id: &str,
        expected_turn_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
    ) -> Result<InterruptSummary, CodexAppServerError> {
        let result = self.call(
            "turn/steer",
            json!({
                "threadId": thread_id,
                "expectedTurnId": expected_turn_id,
                "clientUserMessageId": client_user_message_id,
                "input": [
                    {
                        "type": "text",
                        "text": text,
                    }
                ],
            }),
        )?;
        let turn_id = required_string(&result, "turnId")?;
        Ok(InterruptSummary {
            thread_id: thread_id.to_string(),
            turn_id,
        })
    }

    pub fn interrupt_turn(
        &mut self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<InterruptSummary, CodexAppServerError> {
        self.call(
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )?;
        Ok(InterruptSummary {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
        })
    }

    /// Run a COMPLETE Codex model turn: send a `turn/start` text input on `thread_id`,
    /// then drive the server's notification stream until the matching `turn/completed`,
    /// returning the authoritative assistant text + terminal status + (if emitted) token
    /// usage. This is the C1 model-turn capability — the actual "run a Codex completion",
    /// distinct from the metadata-only `thread/list`/`thread/read` reads.
    ///
    /// The turn is started with `approvalPolicy: "never"` (`v2/AskForApproval`) so a plain
    /// text completion does NOT trigger an interactive approval ask. Defensively, if the
    /// server DOES interleave an `item/*/requestApproval` / elicitation REQUEST mid-turn,
    /// the loop fails closed with a typed `interactive-approval-unsupported` blocker rather
    /// than hanging — this dark slice does not route interactive approvals. (After
    /// surfacing the blocker the caller should `interrupt_turn` to release the server.)
    ///
    /// `turn/completed` (terminal `status`) is the ONLY normal loop exit; a `failed` turn
    /// still returns `Ok` carrying `status = "failed"` (the controlled `turn.error.message`
    /// is intentionally NOT inlined here — error text stays out of the typed outcome,
    /// consistent with this module's `metadata_only` hygiene). A bounded iteration cap
    /// guarantees a malformed/never-completing stream yields a typed transport error, not
    /// a spin. Requires the transport to support `read_message` (the request/response-only
    /// mock does not, and fails closed).
    pub fn run_turn(
        &mut self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
    ) -> Result<ModelTurnOutcome, CodexAppServerError> {
        // Delegate through `run_turn_with_handler` with a DENY-ALL handler — NOT a hardcoded
        // `gate_on=false`. This makes the gate flag the SINGLE source of truth for both
        // entrypoints, closing a fail-OPEN footgun: a hardcoded-off `run_turn` would, with
        // the flag flipped ON in prod, still pin `approvalPolicy="never"` and let Codex
        // auto-approve+execute mutating actions (gate bypassed via the wrong entrypoint —
        // the route-only-guard defect this codebase has been bitten by).
        //
        // With this delegation: flag OFF (the default) → byte-identical to the historical
        // `run_turn` (the deny-all handler is never consulted, `approvalPolicy="never"`,
        // mid-turn server request fails closed with `interactive-approval-unsupported`).
        // Flag ON → `approvalPolicy="untrusted"` + deny-all → any mutating action fails
        // CLOSED (a text-only turn, which triggers no approval, still completes). PR2 wires
        // the hub to `run_turn_with_handler` with a real authorizer; an un-migrated caller on
        // `run_turn` degrades safely (deny) rather than bypassing the gate.
        self.run_turn_with_handler(thread_id, client_user_message_id, text, |_req| {
            Ok(CodexApprovalDecision::Deny)
        })
    }

    /// Run a complete Codex model turn, ROUTING any interleaved pre-execution approval
    /// request through `handler`. This is the C1-PR1 seam: a hub-side authorizer (PR2)
    /// supplies the `handler`; this surface only marshals the typed [`CodexServerRequest`]
    /// to it and writes the schema-correct response back.
    ///
    /// Behavior is gated by [`FRIDAY_CODEX_MUTATING_GATE`] (read ONCE here, then threaded as
    /// an explicit bool into the shared core — no env read inside the loop, so parallel
    /// tests never race the process-global env):
    ///   - flag OFF (default): IGNORES `handler`, pins `approvalPolicy =`
    ///     [`MODEL_TURN_APPROVAL_POLICY`] (`"never"`), and fails closed on any mid-turn
    ///     server request — byte-identical to [`CodexAppServerClient::run_turn`].
    ///   - flag ON: pins `approvalPolicy =` [`MODEL_TURN_GATE_APPROVAL_POLICY`]
    ///     (`"untrusted"`, forcing approval for all mutating actions) and, on each
    ///     `item/*/requestApproval` / legacy approval request, parses it, calls `handler`,
    ///     and `respond`s with the schema-correct decision; a `Deny` aborts the turn (typed
    ///     `approval-denied`), an `Allow` continues. A handler error, a parse failure, or an
    ///     unroutable method all fail CLOSED (typed error) — never hang, never auto-approve.
    ///
    /// The DEFAULT [`CodexAppServerClient::run_turn`] supplies a deny-all handler, so even if
    /// a future caller flipped the flag without supplying a handler the fail-closed posture
    /// holds. The actual authorize decision is PR2's responsibility; the model's own
    /// classification is never trusted here.
    pub fn run_turn_with_handler<F>(
        &mut self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
        handler: F,
    ) -> Result<ModelTurnOutcome, CodexAppServerError>
    where
        F: Fn(&CodexServerRequest) -> Result<CodexApprovalDecision, CodexAppServerError>,
    {
        let gate_on = codex_mutating_gate_from(std::env::var(FRIDAY_CODEX_MUTATING_GATE).ok());
        self.run_turn_core(thread_id, client_user_message_id, text, gate_on, &handler)
    }

    /// Run a complete Codex model turn like [`Self::run_turn_with_handler`], while mirroring
    /// provider-originated JSON-RPC notifications/requests to `observer`.
    ///
    /// The observer is best-effort and metadata-oriented: it is called after the app-server
    /// message is read but before Friday maps it into any durable row. This crate still does
    /// NOT persist anything, bill anything, or interpret the observer's result; callers that
    /// store observations must keep failures isolated so an observe tap can never change the
    /// observed Codex turn. The existing public entrypoints delegate through a no-op observer
    /// and keep their signatures/behavior unchanged.
    pub fn run_turn_with_handler_observed<F, O>(
        &mut self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
        handler: F,
        mut observer: O,
    ) -> Result<ModelTurnOutcome, CodexAppServerError>
    where
        F: Fn(&CodexServerRequest) -> Result<CodexApprovalDecision, CodexAppServerError>,
        O: FnMut(&JsonRpcServerMessage),
    {
        let gate_on = codex_mutating_gate_from(std::env::var(FRIDAY_CODEX_MUTATING_GATE).ok());
        self.run_turn_core_observed(
            thread_id,
            client_user_message_id,
            text,
            gate_on,
            &handler,
            &mut observer,
        )
    }

    /// The flag-parameterized turn core. `gate_on` is supplied by the public entrypoints
    /// (from the env flag) and injected directly by the gate KATs (so they never mutate
    /// `std::env`, avoiding the in-process test race). When `gate_on` is FALSE the turn is
    /// byte-identical to the historical `run_turn`: `approvalPolicy` serializes as
    /// [`MODEL_TURN_APPROVAL_POLICY`] and a mid-turn server request fails closed WITHOUT
    /// consulting `handler` or writing to the transport.
    fn run_turn_core(
        &mut self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
        gate_on: bool,
        handler: &dyn Fn(&CodexServerRequest) -> Result<CodexApprovalDecision, CodexAppServerError>,
    ) -> Result<ModelTurnOutcome, CodexAppServerError> {
        let mut observer = |_message: &JsonRpcServerMessage| {};
        self.run_turn_core_observed(
            thread_id,
            client_user_message_id,
            text,
            gate_on,
            handler,
            &mut observer,
        )
    }

    fn run_turn_core_observed(
        &mut self,
        thread_id: &str,
        client_user_message_id: Option<&str>,
        text: &str,
        gate_on: bool,
        handler: &dyn Fn(&CodexServerRequest) -> Result<CodexApprovalDecision, CodexAppServerError>,
        observer: &mut dyn FnMut(&JsonRpcServerMessage),
    ) -> Result<ModelTurnOutcome, CodexAppServerError> {
        let approval_policy = if gate_on {
            MODEL_TURN_GATE_APPROVAL_POLICY
        } else {
            MODEL_TURN_APPROVAL_POLICY
        };
        let start = self.call(
            "turn/start",
            json!({
                "threadId": thread_id,
                "clientUserMessageId": client_user_message_id,
                "approvalPolicy": approval_policy,
                "input": [
                    {
                        "type": "text",
                        "text": text,
                    }
                ],
            }),
        )?;
        let turn = start.get("turn").ok_or(CodexAppServerError::Protocol {
            code: "turn-missing",
        })?;
        let turn_id = required_string(turn, "id")?;

        let mut content = String::new();
        let mut usage: Option<CodexTokenUsage> = None;

        for _ in 0..MODEL_TURN_MAX_MESSAGES {
            match self.transport.read_message()? {
                CodexInboundMessage::Notification { method, params } => {
                    // Ignore traffic for a different concurrent turn.
                    if extract_optional_string(&params, "turnId").as_deref()
                        == Some(turn_id.as_str())
                        || params
                            .get("turn")
                            .and_then(|t| extract_optional_string(t, "id"))
                            .as_deref()
                            == Some(turn_id.as_str())
                    {
                        observer(&JsonRpcServerMessage {
                            id: None,
                            method: method.clone(),
                            params: params.clone(),
                        });
                        match method.as_str() {
                            "item/completed" => {
                                if let Some(text) = agent_message_item_text(&params) {
                                    content.push_str(&text);
                                }
                            }
                            "thread/tokenUsage/updated" => {
                                if let Some(u) = token_usage_from_notification(&params) {
                                    usage = Some(u);
                                }
                            }
                            "turn/completed" => {
                                let status = params
                                    .get("turn")
                                    .and_then(status_string)
                                    .unwrap_or_else(|| "completed".to_string());
                                return Ok(ModelTurnOutcome {
                                    thread_id: thread_id.to_string(),
                                    turn_id,
                                    status,
                                    content,
                                    usage,
                                });
                            }
                            // agentMessage/delta (streaming only — not the authoritative
                            // text), turn/started, item/started, diffs, plan, etc.: skip.
                            _ => {}
                        }
                    }
                }
                // A server→client REQUEST mid-turn (approval/elicitation).
                CodexInboundMessage::ServerRequest { id, method, params } => {
                    observer(&JsonRpcServerMessage {
                        id: Some(id.clone()),
                        method: method.clone(),
                        params: params.clone(),
                    });
                    if !gate_on {
                        // Flag OFF (default): not routed — fail closed with the historical
                        // typed blocker so the turn can never hang waiting for a response we
                        // will not send. Byte-identical to the pre-flag behavior (no
                        // transport write, same error code).
                        return Err(CodexAppServerError::Protocol {
                            code: "interactive-approval-unsupported",
                        });
                    }
                    // Flag ON: parse → ask the handler → respond with the schema-correct
                    // decision. A parse failure / unroutable method / handler error all
                    // propagate as a typed error (fail closed); a Deny aborts the turn.
                    let request = parse_server_request(&method, &params)?;
                    let decision = handler(&request)?;
                    self.transport
                        .respond(&id, request.response_result(decision))?;
                    if matches!(decision, CodexApprovalDecision::Deny) {
                        // The denied action's response already told Codex to cancel/abort the
                        // turn; surface a typed, text-free blocker to the caller too.
                        return Err(CodexAppServerError::Protocol {
                            code: "approval-denied",
                        });
                    }
                    // Allow: keep draining the stream until turn/completed.
                }
                // A stray response (no in-flight client request during the loop) is a
                // protocol violation — fail closed rather than loop on it.
                CodexInboundMessage::Response(_) => {
                    return Err(CodexAppServerError::Protocol {
                        code: "unexpected-response-in-turn",
                    });
                }
            }
        }
        Err(CodexAppServerError::Transport {
            code: "turn-no-completion",
        })
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, CodexAppServerError> {
        let id = self.next_id;
        self.next_id += 1;
        let response = self.transport.request(JsonRpcRequest {
            id,
            method: method.to_string(),
            params,
        })?;
        if response.error.is_some() {
            return Err(CodexAppServerError::Protocol {
                code: "server-error",
            });
        }
        response.result.ok_or(CodexAppServerError::Protocol {
            code: "missing-result",
        })
    }
}

/// A locally-spawned `codex app-server` process speaking JSON-RPC over stdio, wrapped in a
/// [`CodexAppServerClient`] (CODEX-LIVE-001). Hub-side only. The lane label is ALWAYS
/// [`CODEX_APP_SERVER_SYNC_MODE`] = `provider_app_server_local` — this is Friday's LOCAL
/// Codex control (initialize / thread list-read / turn-control), NOT official
/// ChatGPT/Codex same-account history sync, which it must never claim. The child process
/// is killed on drop. Spawning requires the Codex CLI installed + logged in; a failure is
/// surfaced as an exact [`CodexAppServerError`], never faked.
pub struct LocalCodexAppServer {
    child: Child,
    client: CodexAppServerClient<JsonLineTransport<ChildStdout, ChildStdin>>,
    watchdog_control: Option<Sender<AppServerWatchdogSignal>>,
}

impl LocalCodexAppServer {
    /// Spawn `<program> app-server --stdio` (default `program` = `"codex"`) and wrap its
    /// newline-delimited JSON-RPC stdio stream in the (UNCHANGED) [`JsonLineTransport`].
    ///
    /// `--stdio` (equivalent to `--listen stdio://`, the default transport — see
    /// `codex app-server --help`) is the DIRECT stdio path on codex-cli 0.140.0: the
    /// app-server speaks JSON-RPC straight over its own piped stdin/stdout, so the
    /// `initialize` handshake round-trips against the logged-in account with no broker in
    /// between. (The `app-server daemon start` + `app-server proxy --sock` bridge fails the
    /// handshake on 0.140.0 — the daemon closes the proxy's control connection, so the
    /// client's `initialize` reads `response-eof`; remote-control enabled does not help. That
    /// proxy EOF was not evidence that stock bare `codex app-server` stopped speaking
    /// newline-delimited JSON over stdio: the stock bare process and this explicit `--stdio`
    /// path both answer JSON-RPC when driven on their stdio transport. The failure mode was
    /// sending newline JSON to the WS-only control/proxy path.) This is the same
    /// single-process model the pre-0.140 bare `codex app-server` used, now made explicit with
    /// the `--stdio` flag. The handshake, methods, approval routing, and gating downstream are
    /// all unchanged.
    ///
    /// The owned `child` IS the app-server process; `child_id`/`kill`/`Drop` manage it
    /// directly (killed on drop). Spawning requires the Codex CLI installed + logged in; a
    /// `.spawn()` failure means the CLI is absent and surfaces as the code-only / secret-free
    /// `app-server-spawn` transport error (the error type is code-only by contract — see
    /// `friday-hub`'s `codex_error_code`). stderr is discarded so a noisy app-server can never
    /// leak diagnostics into an error path or block on a full pipe.
    pub fn spawn(program: &str) -> Result<Self, CodexAppServerError> {
        let mut child = Command::new(program)
            .arg("app-server")
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| CodexAppServerError::Transport {
                code: "app-server-spawn",
            })?;
        let stdin = child.stdin.take().ok_or(CodexAppServerError::Transport {
            code: "app-server-stdin",
        })?;
        let stdout = child.stdout.take().ok_or(CodexAppServerError::Transport {
            code: "app-server-stdout",
        })?;
        let timeout = codex_app_server_watchdog_timeout_from(
            std::env::var(FRIDAY_CODEX_APP_SERVER_TIMEOUT_MS)
                .ok()
                .as_deref(),
        );
        let watchdog_control = Some(spawn_app_server_watchdog(child.id(), timeout));
        let client = CodexAppServerClient::new(JsonLineTransport::with_watchdog_progress(
            stdout,
            stdin,
            watchdog_control.clone(),
        ));
        Ok(Self {
            child,
            client,
            watchdog_control,
        })
    }

    /// The OS pid of the spawned `codex app-server --stdio` process (for an external watchdog
    /// kill). Killing it tears down the app-server and its stdio stream, so a blocking read
    /// returns EOF and the in-flight call errors instead of hanging.
    pub fn child_id(&self) -> u32 {
        self.child.id()
    }

    pub fn client(
        &mut self,
    ) -> &mut CodexAppServerClient<JsonLineTransport<ChildStdout, ChildStdin>> {
        &mut self.client
    }

    /// Terminate the spawned `codex app-server --stdio` process (idempotent).
    pub fn kill(&mut self) {
        if let Some(control) = self.watchdog_control.take() {
            let _ = control.send(AppServerWatchdogSignal::Release);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for LocalCodexAppServer {
    fn drop(&mut self) {
        self.kill();
    }
}

fn codex_app_server_watchdog_timeout_from(raw: Option<&str>) -> Duration {
    let millis = raw
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS);
    Duration::from_millis(millis)
}

fn codex_app_server_watchdog_wall_timeout_from(idle_timeout: Duration) -> Duration {
    idle_timeout
        .checked_mul(CODEX_APP_SERVER_WATCHDOG_WALL_MULTIPLIER)
        .unwrap_or(Duration::from_millis(u64::MAX))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppServerWatchdogSignal {
    Progress,
    Release,
}

fn spawn_app_server_watchdog(pid: u32, idle_timeout: Duration) -> Sender<AppServerWatchdogSignal> {
    let (control, events) = mpsc::channel();
    let _ = thread::spawn(move || {
        let wall_timeout = codex_app_server_watchdog_wall_timeout_from(idle_timeout);
        let started = Instant::now();
        loop {
            let elapsed = started.elapsed();
            if elapsed >= wall_timeout {
                break;
            }
            let remaining_wall = wall_timeout.saturating_sub(elapsed);
            let wait_for = idle_timeout.min(remaining_wall);
            match events.recv_timeout(wait_for) {
                Ok(AppServerWatchdogSignal::Release)
                | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return;
                }
                Ok(AppServerWatchdogSignal::Progress) => continue,
                Err(mpsc::RecvTimeoutError::Timeout) => break,
            }
        }
        let pid = pid.to_string();
        let _ = Command::new("/bin/kill").args(["-TERM", &pid]).status();
        thread::sleep(Duration::from_millis(500));
        let _ = Command::new("/bin/kill").args(["-KILL", &pid]).status();
    });
    control
}

/// (C1-2) The seam a hub-side `AgentLlmClient` adapter drives to run ONE Codex model turn
/// and get back the authoritative [`ModelTurnOutcome`]. Deliberately `&self` (not
/// `&mut self`): the `AgentLlmClient` trait its caller implements is `&self`, and a
/// STATELESS source (one that spawns + tears down a fresh app-server per turn) needs no
/// interior mutation — which keeps an implementor naturally `Sync`, so a future boxed
/// `dyn AgentLlmClient` adapter holding one does not trip a `Sync` bound. The turn input is
/// a single text prompt (the FULL conversation history already rides inside it via the
/// hub's `build_loop_prompt`), so the source need not hold a long-lived thread/process.
pub trait CodexTurnSource {
    /// Run one complete text turn for `prompt` and return its authoritative outcome.
    fn run_text_turn(&self, prompt: &str) -> Result<ModelTurnOutcome, CodexAppServerError>;
}

/// A STATELESS [`CodexTurnSource`]: every call spawns a FRESH `codex app-server`,
/// `initialize`s + `initialized`-handshakes, `thread/start`s, drives ONE `run_turn`, and
/// tears the process down on scope exit (`LocalCodexAppServer`'s kill-on-drop). This is the
/// faithful mirror of the resend model — the hub's `build_loop_prompt` already carries the
/// entire prior history into each `prompt`, so there is NO need to keep a thread alive
/// across turns. Holding the process across turns would force an interior `!Sync`
/// `RefCell<LocalCodexAppServer>` (the `Child`/`ChildStdin` stream is single-owner) and
/// collide with a boxed-`dyn`-adapter `Sync` expectation; spawning per turn sidesteps that
/// entirely. The fields are immutable config only, so the impl is `Sync`.
///
/// DARK: spawning requires the Codex CLI installed + logged in; with no creds present the
/// spawn/handshake surfaces a typed [`CodexAppServerError`] (never faked). The adapter's
/// genuine `run_turn` parse + outcome mapping is proven creds-free by a KAT driving a
/// scripted byte-stream through the real `run_turn` (see the `friday-hub` adapter tests).
pub struct LocalCodexAppServerTurnSource {
    program: String,
    client_name: String,
    client_version: String,
    cwd: Option<String>,
    model: Option<String>,
}

impl LocalCodexAppServerTurnSource {
    /// Build a source that spawns `<program> app-server` per turn (default `program` =
    /// `"codex"`), identifying as `client_name`/`client_version` on `initialize`, starting
    /// each thread in `cwd` with `model` (both optional — `None` lets the app-server
    /// default).
    pub fn new(
        program: impl Into<String>,
        client_name: impl Into<String>,
        client_version: impl Into<String>,
        cwd: Option<String>,
        model: Option<String>,
    ) -> Self {
        Self {
            program: program.into(),
            client_name: client_name.into(),
            client_version: client_version.into(),
            cwd,
            model,
        }
    }
}

impl CodexTurnSource for LocalCodexAppServerTurnSource {
    fn run_text_turn(&self, prompt: &str) -> Result<ModelTurnOutcome, CodexAppServerError> {
        // Fresh process per turn — `server` is killed on drop at the end of this scope, so
        // nothing non-`Sync` is held across calls.
        let mut server = LocalCodexAppServer::spawn(&self.program)?;
        let client = server.client();
        client.initialize(&self.client_name, &self.client_version)?;
        client.initialized()?;
        let thread = client.start_thread(self.cwd.as_deref(), self.model.as_deref())?;
        client.run_turn(&thread.thread_id, None, prompt)
    }
}

fn required_string(value: &Value, field: &'static str) -> Result<String, CodexAppServerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or(CodexAppServerError::Protocol { code: field })
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Extract a required array-of-string field (e.g. `execCommandApproval.command` argv). A
/// missing field, a non-array, or any non-string element yields a typed `Protocol` error —
/// never a panic.
fn required_string_array(
    value: &Value,
    field: &'static str,
) -> Result<Vec<String>, CodexAppServerError> {
    let arr = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or(CodexAppServerError::Protocol { code: field })?;
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(ToString::to_string)
                .ok_or(CodexAppServerError::Protocol { code: field })
        })
        .collect()
}

/// Extract the KEYS of a required object field (e.g. `applyPatchApproval.fileChanges`, a map
/// of path → FileChange). The values (diff/content bodies) are intentionally NOT read here.
/// A missing field or a non-object yields a typed `Protocol` error.
fn object_keys(value: &Value, field: &'static str) -> Result<Vec<String>, CodexAppServerError> {
    let obj = value
        .get(field)
        .and_then(Value::as_object)
        .ok_or(CodexAppServerError::Protocol { code: field })?;
    Ok(obj.keys().cloned().collect())
}

fn status_string(value: &Value) -> Option<String> {
    match value.get("status") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(map)) => map
            .get("type")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        _ => None,
    }
}

fn thread_summary_from_response(value: &Value) -> Result<ThreadSummary, CodexAppServerError> {
    let thread = value.get("thread").ok_or(CodexAppServerError::Protocol {
        code: "thread-missing",
    })?;
    thread_summary_from_thread_value(thread)
}

fn thread_summary_from_thread_value(value: &Value) -> Result<ThreadSummary, CodexAppServerError> {
    Ok(ThreadSummary {
        thread_id: required_string(value, "id")?,
        session_id: optional_string(value, "sessionId"),
        status: status_string(value),
        preview: optional_string(value, "preview"),
    })
}

fn turn_summary_from_response(
    thread_id: &str,
    value: &Value,
) -> Result<TurnSummary, CodexAppServerError> {
    let turn = value.get("turn").ok_or(CodexAppServerError::Protocol {
        code: "turn-missing",
    })?;
    Ok(TurnSummary {
        thread_id: thread_id.to_string(),
        turn_id: required_string(turn, "id")?,
        status: status_string(turn),
        item_count: turn
            .get("items")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    })
}

pub fn map_server_message_to_provider_event(
    context: &ProviderMirrorContext,
    message: &JsonRpcServerMessage,
    observed_at: i64,
    mirror_seq: u64,
) -> Result<Option<ProviderSessionEvent>, CodexAppServerError> {
    let method = message.method.as_str();
    let (event_kind, transcript_item_kind) = match method {
        "thread/started" => ("thread_started", "thread"),
        "thread/status/changed" => ("thread_status_changed", "thread"),
        "thread/tokenUsage/updated" => ("token_usage_updated", "token_usage"),
        "turn/started" => ("turn_started", "turn"),
        "turn/completed" => ("turn_completed", "turn"),
        "turn/diff/updated" => ("turn_diff_updated", "diff"),
        "item/started" => ("item_started", "item"),
        "item/completed" => ("item_completed", "item"),
        "item/agentMessage/delta" => ("agent_message_delta", "agent_message"),
        "item/plan/delta" => ("plan_delta", "plan"),
        "command/exec/outputDelta" | "item/commandExecution/outputDelta" => {
            ("command_output_delta", "command_execution")
        }
        "terminalInteraction" => ("terminal_interaction", "terminal_interaction"),
        "item/fileChange/outputDelta" => ("file_change_output_delta", "file_change"),
        "item/commandExecution/requestApproval" => ("approval_requested", "approval"),
        "item/fileChange/requestApproval" => ("approval_requested", "approval"),
        "item/permissions/requestApproval" => ("approval_requested", "approval"),
        "item/tool/requestUserInput" => ("user_input_requested", "user_input"),
        "mcpServer/elicitation/request" => ("user_input_requested", "user_input"),
        _ => ("provider_event_unmapped", "provider_event"),
    };
    if method == "error" {
        return Ok(None);
    }

    let thread_id = extract_thread_id(&message.params)?;
    let turn_id = extract_optional_string(&message.params, "turnId")
        .or_else(|| {
            message
                .params
                .get("turn")
                .and_then(|turn| extract_optional_string(turn, "id"))
        })
        .unwrap_or_else(|| "no-turn".to_string());
    let item_id = extract_optional_string(&message.params, "itemId")
        .or_else(|| {
            message
                .params
                .get("item")
                .and_then(|item| extract_optional_string(item, "id"))
        })
        .unwrap_or_else(|| "no-item".to_string());
    let approval_ref = if event_kind == "approval_requested" || event_kind == "user_input_requested"
    {
        Some(format!(
            "codex:{}:{}:{}:{}:{}",
            method,
            thread_id,
            turn_id,
            item_id,
            extract_optional_string(&message.params, "approvalId")
                .unwrap_or_else(|| "default".to_string())
        ))
    } else {
        None
    };

    Ok(Some(ProviderSessionEvent {
        friday_session_id: context.friday_session_id.clone(),
        provider_event_id: format!(
            "codex:{}:{}:{}:{}:{}",
            method, thread_id, turn_id, item_id, mirror_seq
        ),
        provider: context.provider.clone(),
        event_kind: event_kind.to_string(),
        transcript_item_kind: transcript_item_kind.to_string(),
        body_ref: format!(
            "codex://provider-event/{}/{}/{}",
            context.friday_session_id,
            mirror_seq,
            method.replace('/', ".")
        ),
        redaction_level: "metadata_only".to_string(),
        token_ledger_ref: None,
        approval_ref,
        audit_receipt_ref: None,
        observed_at,
    }))
}

fn extract_thread_id(params: &Value) -> Result<String, CodexAppServerError> {
    extract_optional_string(params, "threadId")
        .or_else(|| {
            params
                .get("thread")
                .and_then(|thread| extract_optional_string(thread, "id"))
        })
        .ok_or(CodexAppServerError::Protocol { code: "thread-id" })
}

fn extract_optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Extract the authoritative agent-message text from an `item/completed` notification's
/// `item` (a `ThreadItem`). Per `v2/ItemCompletedNotification.json` → `ThreadItem`, an
/// `AgentMessageThreadItem` is `{ type: "agentMessage", text: string, .. }`. Returns
/// `None` for any non-agent-message item (tool calls, reasoning, command exec, …) so
/// only assistant prose contributes to the turn content.
fn agent_message_item_text(params: &Value) -> Option<String> {
    let item = params.get("item")?;
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return None;
    }
    item.get("text")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

/// Project a `thread/tokenUsage/updated` notification into [`CodexTokenUsage`]. Per
/// `v2/ThreadTokenUsageUpdatedNotification.json`, `params.tokenUsage.last` is a
/// `TokenUsageBreakdown { inputTokens, outputTokens, totalTokens, .. }` (int64). Returns
/// `None` if the shape is absent/partial (a missing usage update is never a turn failure).
fn token_usage_from_notification(params: &Value) -> Option<CodexTokenUsage> {
    let breakdown = params.get("tokenUsage").and_then(|tu| tu.get("last"))?;
    let input_tokens = breakdown.get("inputTokens").and_then(Value::as_i64)?;
    let output_tokens = breakdown.get("outputTokens").and_then(Value::as_i64)?;
    let total_tokens = breakdown
        .get("totalTokens")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| input_tokens.saturating_add(output_tokens));
    Some(CodexTokenUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

#[derive(Debug, Default)]
pub struct MockCodexAppServerTransport {
    responses: VecDeque<Result<JsonRpcResponse, CodexAppServerError>>,
    calls: Vec<JsonRpcRequest>,
}

impl MockCodexAppServerTransport {
    pub fn new(responses: Vec<Result<JsonRpcResponse, CodexAppServerError>>) -> Self {
        Self {
            responses: responses.into(),
            calls: Vec::new(),
        }
    }

    pub fn calls(&self) -> &[JsonRpcRequest] {
        &self.calls
    }
}

impl CodexAppServerTransport for MockCodexAppServerTransport {
    fn request(&mut self, request: JsonRpcRequest) -> Result<JsonRpcResponse, CodexAppServerError> {
        self.calls.push(request);
        self.responses
            .pop_front()
            .unwrap_or(Err(CodexAppServerError::Transport { code: "mock-empty" }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn ok(result: Value) -> Result<JsonRpcResponse, CodexAppServerError> {
        Ok(JsonRpcResponse {
            id: Some(json!(1)),
            result: Some(result),
            error: None,
        })
    }

    fn temp_schema_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "friday-codex-schema-fixture-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn schema_with_methods(methods: &[&str]) -> String {
        let one_of = methods
            .iter()
            .map(|m| {
                json!({
                    "type": "object",
                    "required": ["id", "method", "params"],
                    "properties": {
                        "id": { "type": "integer" },
                        "method": { "type": "string", "enum": [m] },
                        "params": true
                    }
                })
            })
            .collect::<Vec<_>>();
        json!({ "oneOf": one_of }).to_string()
    }

    #[test]
    fn required_method_surface_is_present_in_pinned_schema_fixture() {
        let dir = temp_schema_dir();
        std::fs::write(
            dir.join("ClientRequest.json"),
            schema_with_methods(REQUIRED_CLIENT_METHODS),
        )
        .unwrap();
        std::fs::write(
            dir.join("ServerRequest.json"),
            schema_with_methods(REQUIRED_SERVER_REQUEST_METHODS),
        )
        .unwrap();
        std::fs::write(
            dir.join("ServerNotification.json"),
            schema_with_methods(REQUIRED_SERVER_NOTIFICATION_METHODS),
        )
        .unwrap();

        let methods = CodexAppServerSchemaMethods::from_generated_bundle_dir(&dir).unwrap();
        methods.assert_required_surface().unwrap();
    }

    #[test]
    fn schema_drift_missing_thread_turn_methods_fails_closed() {
        let dir = temp_schema_dir();
        std::fs::write(
            dir.join("ClientRequest.json"),
            schema_with_methods(&["initialize"]),
        )
        .unwrap();
        std::fs::write(
            dir.join("ServerRequest.json"),
            schema_with_methods(REQUIRED_SERVER_REQUEST_METHODS),
        )
        .unwrap();
        std::fs::write(
            dir.join("ServerNotification.json"),
            schema_with_methods(REQUIRED_SERVER_NOTIFICATION_METHODS),
        )
        .unwrap();

        let methods = CodexAppServerSchemaMethods::from_generated_bundle_dir(&dir).unwrap();
        assert!(matches!(
            methods.assert_required_surface(),
            Err(CodexAppServerError::SchemaDrift)
        ));
    }

    #[test]
    fn json_line_transport_writes_request_and_reads_response() {
        let response = br#"{"id":1,"result":{"platformFamily":"unix","platformOs":"macos","userAgent":"codex-test"}}
"#;
        let writer = Vec::<u8>::new();
        let mut transport = JsonLineTransport::new(&response[..], writer);
        let out = transport
            .request(JsonRpcRequest {
                id: 1,
                method: "initialize".to_string(),
                params: json!({"clientInfo":{"name":"friday","version":"0"}}),
            })
            .unwrap();
        assert!(out.error.is_none());
        assert_eq!(
            out.result.unwrap().get("userAgent").and_then(Value::as_str),
            Some("codex-test")
        );
        let (_reader, writer) = transport.into_parts();
        let written = String::from_utf8(writer).unwrap();
        assert!(written.contains("\"jsonrpc\":\"2.0\""));
        assert!(written.contains("\"method\":\"initialize\""));
        assert!(written.ends_with('\n'));
    }

    #[test]
    fn json_line_transport_skips_notifications_until_matching_response() {
        let response = br#"{"method":"remoteControl/status/changed","params":{"status":"disabled"}}
{"id":1,"result":{"platformFamily":"unix","platformOs":"macos","userAgent":"codex-test"}}
"#;
        let mut transport = JsonLineTransport::new(&response[..], Vec::<u8>::new());
        let out = transport
            .request(JsonRpcRequest {
                id: 1,
                method: "initialize".to_string(),
                params: json!({}),
            })
            .unwrap();
        assert_eq!(
            out.result.unwrap().get("userAgent").and_then(Value::as_str),
            Some("codex-test")
        );
    }

    #[test]
    fn health_check_uses_initialize_then_thread_list_without_turn_start() {
        let transport = MockCodexAppServerTransport::new(vec![
            ok(json!({
                "codexHome": "/tmp/codex",
                "platformFamily": "unix",
                "platformOs": "macos",
                "userAgent": "codex-cli 0.136.0",
            })),
            ok(json!({
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null,
            })),
        ]);
        let mut client = CodexAppServerClient::new(transport);
        let summary = client.health_check("friday", "0.0.1").unwrap();
        assert_eq!(summary.sync_mode, CODEX_APP_SERVER_SYNC_MODE);
        assert_eq!(summary.initialized.platform_os, "macos");
        assert_eq!(summary.thread_list.item_count, 0);

        let transport = client.into_transport();
        let calls = transport.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].method, "initialize");
        assert_eq!(calls[1].method, "thread/list");
        assert!(
            calls.iter().all(|c| c.method != "turn/start"),
            "PNS-002 health must not start a model turn"
        );
    }

    #[test]
    fn list_threads_projects_thread_summaries_without_turns() {
        let transport = MockCodexAppServerTransport::new(vec![ok(json!({
            "data": [
                thread("thread-1", json!({"type":"notLoaded"}), json!([])),
            ],
            "nextCursor": "cursor-2",
        }))]);
        let mut client = CodexAppServerClient::new(transport);
        let list = client.list_threads(1, true).unwrap();
        assert_eq!(list.threads[0].thread_id, "thread-1");
        assert_eq!(list.threads[0].status.as_deref(), Some("notLoaded"));
        assert!(list.has_next_cursor);
        let transport = client.into_transport();
        assert_eq!(transport.calls()[0].method, "thread/list");
        assert_eq!(
            transport.calls()[0].params.get("useStateDbOnly"),
            Some(&json!(true))
        );
    }

    fn thread(id: &str, status: Value, turns: Value) -> Value {
        json!({
            "id": id,
            "sessionId": "session-1",
            "status": status,
            "preview": "Friday test",
            "turns": turns,
        })
    }

    fn turn(id: &str, status: &str, items: Value) -> Value {
        json!({
            "id": id,
            "status": status,
            "items": items,
        })
    }

    #[test]
    fn thread_and_turn_control_methods_use_app_server_not_cli_send() {
        let transport = MockCodexAppServerTransport::new(vec![
            ok(json!({"thread": thread("thread-1", json!({"type":"idle"}), json!([]))})),
            ok(
                json!({"thread": thread("thread-1", json!({"type":"active","activeFlags":[]}), json!([]))}),
            ),
            ok(json!({"turn": turn("turn-1", "inProgress", json!([]))})),
            ok(json!({"turnId": "turn-1"})),
            ok(json!({})),
            ok(
                json!({"thread": thread("thread-1", json!({"type":"idle"}), json!([turn("turn-1", "completed", json!([]))]))}),
            ),
        ]);
        let mut client = CodexAppServerClient::new(transport);
        assert_eq!(
            client
                .start_thread(Some("/tmp/friday"), Some("gpt-5"))
                .unwrap()
                .thread_id,
            "thread-1"
        );
        assert_eq!(
            client.resume_thread("thread-1").unwrap().status.as_deref(),
            Some("active")
        );
        let turn = client
            .send_turn_text("thread-1", Some("client-msg-1"), "ping")
            .unwrap();
        assert_eq!(turn.turn_id, "turn-1");
        assert_eq!(
            client
                .steer_turn_text("thread-1", "turn-1", Some("client-msg-2"), "more")
                .unwrap()
                .turn_id,
            "turn-1"
        );
        client.interrupt_turn("thread-1", "turn-1").unwrap();
        assert_eq!(client.read_thread("thread-1", true).unwrap().turn_count, 1);

        let transport = client.into_transport();
        let methods: Vec<&str> = transport
            .calls()
            .iter()
            .map(|c| c.method.as_str())
            .collect();
        assert_eq!(
            methods,
            vec![
                "thread/start",
                "thread/resume",
                "turn/start",
                "turn/steer",
                "turn/interrupt",
                "thread/read",
            ]
        );
        let calls = transport.calls();
        assert_eq!(calls[0].params.get("threadSource"), Some(&Value::Null));
        assert_eq!(
            calls[2].params.get("input"),
            Some(&json!([
                {
                    "type": "text",
                    "text": "ping",
                }
            ]))
        );
    }

    #[test]
    fn server_notifications_map_to_friday_provider_events_without_raw_body() {
        let context = ProviderMirrorContext::codex("friday-session-1");
        let msg = JsonRpcServerMessage {
            id: None,
            method: "item/agentMessage/delta".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": "secret transcript text must live behind a future blob ref",
            }),
        };
        let event = map_server_message_to_provider_event(&context, &msg, 123, 7)
            .unwrap()
            .unwrap();
        assert_eq!(event.event_kind, "agent_message_delta");
        assert_eq!(event.transcript_item_kind, "agent_message");
        assert_eq!(event.redaction_level, "metadata_only");
        assert_eq!(event.approval_ref, None);
        let debug = format!("{event:?}");
        assert!(
            !debug.contains("secret transcript text"),
            "PNS-003 mirror event must not inline raw provider text: {debug}"
        );
    }

    #[test]
    fn terminal_interaction_maps_to_first_class_provider_event() {
        let context = ProviderMirrorContext::codex("friday-session-1");
        let msg = JsonRpcServerMessage {
            id: None,
            method: "terminalInteraction".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "terminal-1",
                "output": "raw terminal text must stay out of the mirror row",
            }),
        };
        let event = map_server_message_to_provider_event(&context, &msg, 123, 10)
            .unwrap()
            .unwrap();
        assert_eq!(event.event_kind, "terminal_interaction");
        assert_eq!(event.transcript_item_kind, "terminal_interaction");
        assert_eq!(event.redaction_level, "metadata_only");
        let debug = format!("{event:?}");
        assert!(
            !debug.contains("raw terminal text"),
            "terminal event must not inline raw provider text: {debug}"
        );
    }

    #[test]
    fn unmapped_provider_events_remain_observable() {
        let context = ProviderMirrorContext::codex("friday-session-1");
        let msg = JsonRpcServerMessage {
            id: None,
            method: "future/newEvent".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "future-1",
            }),
        };
        let event = map_server_message_to_provider_event(&context, &msg, 123, 11)
            .unwrap()
            .unwrap();
        assert_eq!(event.event_kind, "provider_event_unmapped");
        assert_eq!(event.transcript_item_kind, "provider_event");
        assert!(
            event.body_ref.ends_with("/future.newEvent"),
            "unmapped method should remain visible through body_ref: {}",
            event.body_ref
        );
    }

    #[test]
    fn approval_requests_map_to_needs_me_ready_event_refs() {
        let context = ProviderMirrorContext::codex("friday-session-1");
        let msg = JsonRpcServerMessage {
            id: Some(json!(99)),
            method: "item/commandExecution/requestApproval".to_string(),
            params: json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-approval",
                "approvalId": "approval-1",
                "command": "rm -rf /private/project",
                "startedAtMs": 123000,
            }),
        };
        let event = map_server_message_to_provider_event(&context, &msg, 123, 8)
            .unwrap()
            .unwrap();
        assert_eq!(event.event_kind, "approval_requested");
        assert_eq!(event.transcript_item_kind, "approval");
        assert_eq!(
            event.approval_ref.as_deref(),
            Some("codex:item/commandExecution/requestApproval:thread-1:turn-1:item-approval:approval-1")
        );
        let debug = format!("{event:?}");
        assert!(
            !debug.contains("rm -rf"),
            "approval event must not inline raw command text before a future redacted body store"
        );
    }

    #[test]
    fn recognized_events_missing_thread_id_fail_closed() {
        let context = ProviderMirrorContext::codex("friday-session-1");
        let msg = JsonRpcServerMessage {
            id: None,
            method: "turn/started".to_string(),
            params: json!({"turn": turn("turn-1", "inProgress", json!([]))}),
        };
        assert!(matches!(
            map_server_message_to_provider_event(&context, &msg, 123, 9),
            Err(CodexAppServerError::Protocol { code: "thread-id" })
        ));
    }

    #[test]
    fn protocol_error_is_label_only_and_fails_health() {
        let transport = MockCodexAppServerTransport::new(vec![Ok(JsonRpcResponse {
            id: Some(json!(1)),
            result: None,
            error: Some(JsonRpcErrorEnvelope {
                code: -32000,
                message: Some("raw provider text must not be surfaced".to_string()),
            }),
        })]);
        let mut client = CodexAppServerClient::new(transport);
        let err = client.health_check("friday", "0.0.1").unwrap_err();
        assert_eq!(
            err.to_string(),
            "codex app-server protocol error: server-error"
        );
    }

    // ---- C1 model-turn (run_turn) KATs ----
    //
    // These drive the REAL `JsonLineTransport` over a `&[u8]` byte stream so the actual
    // line-read + `classify_inbound` + `run_turn` notification loop is exercised — NOT a
    // pre-parsed mock that would bypass the parsing under test. Every fixture line is
    // shaped per the codex CLI's `app-server generate-json-schema` v2 bundle (the same
    // creds-free schema source `codex_appserver_live_schema.rs` validates); the source
    // schema file is named in each comment so "not guessed" is auditable.

    fn run_turn_client(
        stream: &'static str,
    ) -> CodexAppServerClient<JsonLineTransport<&'static [u8], Vec<u8>>> {
        CodexAppServerClient::new(JsonLineTransport::new(stream.as_bytes(), Vec::<u8>::new()))
    }

    #[test]
    fn run_turn_collects_authoritative_text_and_usage_then_completes() {
        // turn/start response (v2/TurnStartResponse: {turn: Turn{id,status,items}}),
        // then the notification stream the server interleaves on the same channel:
        // a streaming delta (v2/AgentMessageDeltaNotification) that must be IGNORED for
        // content, the authoritative item/completed (v2/ItemCompletedNotification ->
        // ThreadItem AgentMessageThreadItem{type:"agentMessage",text}), a
        // thread/tokenUsage/updated (v2/ThreadTokenUsageUpdatedNotification ->
        // tokenUsage.last TokenUsageBreakdown), and finally turn/completed
        // (v2/TurnCompletedNotification: {threadId, turn{status}}).
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"PO"}}"#,
            "\n",
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"NG-stream-not-authoritative"}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"item-1","type":"agentMessage","text":"PONG"}}}"#,
            "\n",
            r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"cachedInputTokens":0,"inputTokens":11,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":19},"total":{"cachedInputTokens":0,"inputTokens":11,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":19}}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let mut client = run_turn_client(stream);
        let out = client
            .run_turn("thread-1", Some("client-msg-1"), "ping")
            .unwrap();
        assert_eq!(out.thread_id, "thread-1");
        assert_eq!(out.turn_id, "turn-1");
        assert_eq!(out.status, "completed");
        // Authoritative item text, NOT the delta concat ("PONG-stream-not-authoritative").
        assert_eq!(out.content, "PONG");
        assert_eq!(
            out.usage,
            Some(CodexTokenUsage {
                input_tokens: 11,
                output_tokens: 8,
                total_tokens: 19,
            })
        );

        // The request actually written to the wire is a well-formed turn/start with the
        // pinned non-interactive approval policy + the text input.
        let (_r, written) = client.into_transport().into_parts();
        let sent = String::from_utf8(written).unwrap();
        let req: Value = serde_json::from_str(sent.lines().next().unwrap()).unwrap();
        assert_eq!(req["jsonrpc"], "2.0");
        assert_eq!(req["method"], "turn/start");
        assert_eq!(req["params"]["threadId"], "thread-1");
        assert_eq!(req["params"]["clientUserMessageId"], "client-msg-1");
        assert_eq!(req["params"]["approvalPolicy"], MODEL_TURN_APPROVAL_POLICY);
        assert_eq!(
            req["params"]["input"],
            json!([{ "type": "text", "text": "ping" }])
        );
    }

    #[test]
    fn run_turn_with_handler_observed_mirrors_provider_messages_without_changing_outcome() {
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"item-1","type":"agentMessage","text":"PONG"}}}"#,
            "\n",
            r#"{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"last":{"cachedInputTokens":0,"inputTokens":11,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":19},"total":{"cachedInputTokens":0,"inputTokens":11,"outputTokens":8,"reasoningOutputTokens":0,"totalTokens":19}}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let mut client = run_turn_client(stream);
        let mut observed = Vec::new();
        let out = client
            .run_turn_with_handler_observed(
                "thread-1",
                Some("client-msg-1"),
                "ping",
                |_req| Ok(CodexApprovalDecision::Deny),
                |message| observed.push(message.method.clone()),
            )
            .unwrap();

        assert_eq!(out.content, "PONG");
        assert_eq!(
            observed,
            vec![
                "turn/started",
                "item/completed",
                "thread/tokenUsage/updated",
                "turn/completed"
            ]
        );
    }

    #[test]
    fn run_turn_multiple_agent_items_concatenate_and_skip_non_agent_items() {
        // Two authoritative agentMessage items concatenate; a reasoning / command item
        // (any non-"agentMessage" ThreadItem type) is skipped. No tokenUsage notification
        // arrives — usage MUST be None (absence is not a turn failure).
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"r-1","type":"reasoning","text":"internal not surfaced"}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{"id":"a-1","type":"agentMessage","text":"Hello "}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":3,"item":{"id":"a-2","type":"agentMessage","text":"world"}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let out = run_turn_client(stream)
            .run_turn("thread-1", None, "hi")
            .unwrap();
        assert_eq!(out.content, "Hello world");
        assert!(!out.content.contains("internal not surfaced"));
        assert_eq!(out.usage, None);
        assert_eq!(out.status, "completed");
    }

    #[test]
    fn run_turn_ignores_other_turn_notifications() {
        // A notification for a DIFFERENT turn id must not contribute to this turn's
        // content (concurrent-turn isolation).
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-OTHER","completedAtMs":1,"item":{"id":"x","type":"agentMessage","text":"WRONG-TURN"}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{"id":"a","type":"agentMessage","text":"RIGHT"}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let out = run_turn_client(stream)
            .run_turn("thread-1", None, "hi")
            .unwrap();
        assert_eq!(out.content, "RIGHT");
    }

    #[test]
    fn run_turn_failed_status_returns_ok_with_failed_no_inlined_error() {
        // A failed turn (v2/TurnStatus "failed", v2/TurnError populated) returns Ok with
        // status="failed"; the controlled turn.error.message is NOT inlined into the
        // typed outcome (metadata-only hygiene).
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"failed","items":[],"error":{"message":"SECRET-PROVIDER-ERROR-DETAIL"}}}}"#,
            "\n",
        );
        let out = run_turn_client(stream)
            .run_turn("thread-1", None, "hi")
            .unwrap();
        assert_eq!(out.status, "failed");
        assert_eq!(out.content, "");
        let rendered = format!("{out:?}");
        assert!(
            !rendered.contains("SECRET-PROVIDER-ERROR-DETAIL"),
            "turn outcome must not inline raw provider error text: {rendered}"
        );
    }

    #[test]
    fn run_turn_mid_turn_approval_request_fails_closed_does_not_hang() {
        // The server interleaves an item/commandExecution/requestApproval REQUEST (an
        // id-bearing server->client request per v2/ServerRequest) mid-turn. This dark
        // slice does not route interactive approvals, so run_turn fails CLOSED with the
        // typed blocker rather than dropping it (which would hang the server) — and never
        // surfaces the raw command text.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":42,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"i","approvalId":"ap-1","command":"rm -rf /private/project"}}"#,
            "\n",
        );
        let err = run_turn_client(stream)
            .run_turn("thread-1", None, "hi")
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Protocol {
                code: "interactive-approval-unsupported"
            }
        ));
        let rendered = format!("{err:?} {err}");
        assert!(
            !rendered.contains("rm -rf"),
            "approval blocker must not surface raw command text: {rendered}"
        );
    }

    #[test]
    fn run_turn_eof_before_completion_is_typed_transport_error_not_hang() {
        // Stream ends (EOF) before turn/completed — must yield a typed transport error,
        // never a spin/hang.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"a","type":"agentMessage","text":"partial"}}}"#,
            "\n",
        );
        let err = run_turn_client(stream)
            .run_turn("thread-1", None, "hi")
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Transport { code: "stream-eof" }
        ));
    }

    #[test]
    fn run_turn_requires_streaming_transport_mock_fails_closed() {
        // The request/response-only mock does not implement read_message — a turn that
        // needs to drain the notification stream fails closed (never silently "succeeds"
        // off the turn/start envelope alone).
        let transport = MockCodexAppServerTransport::new(vec![ok(json!({
            "turn": {"id": "turn-1", "status": "inProgress", "items": []}
        }))]);
        let mut client = CodexAppServerClient::new(transport);
        let err = client.run_turn("thread-1", None, "hi").unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Transport {
                code: "read-message-unsupported"
            }
        ));
    }

    #[test]
    fn classify_inbound_distinguishes_response_notification_and_server_request() {
        // The shared classifier the turn loop depends on: id+method => ServerRequest,
        // method only => Notification, neither method => Response.
        assert!(matches!(
            classify_inbound(json!({"id":7,"method":"item/tool/requestUserInput","params":{}})).unwrap(),
            CodexInboundMessage::ServerRequest { method, .. } if method == "item/tool/requestUserInput"
        ));
        assert!(matches!(
            classify_inbound(json!({"method":"turn/completed","params":{}})).unwrap(),
            CodexInboundMessage::Notification { method, .. } if method == "turn/completed"
        ));
        assert!(matches!(
            classify_inbound(json!({"id":1,"result":{"ok":true}})).unwrap(),
            CodexInboundMessage::Response(_)
        ));
        // A null id alongside a method is still a notification (not a server request).
        assert!(matches!(
            classify_inbound(json!({"id":null,"method":"turn/started","params":{}})).unwrap(),
            CodexInboundMessage::Notification { .. }
        ));
    }

    // ---- C1-PR1 approval-routing (FRIDAY_CODEX_MUTATING_GATE) KATs ----
    //
    // These drive the REAL `JsonLineTransport` over a recorded `&[u8]` byte stream through
    // `run_turn_core` with an EXPLICIT `gate_on` bool (NOT the process-global env var) so the
    // tests are deterministic + parallel-safe (no `set_var` race). Every fixture line is
    // shaped per the captured app-server schema (the same files copied into
    // `tests/fixtures/codex-schema/`); the source schema file is named in each comment so
    // "not guessed" is auditable. They prove the MARSHALING + response shape only — not that
    // Codex actually prompts at runtime (that is PR2's live wiring).

    /// Parse the JSON-RPC RESPONSE the client wrote back to the transport (the line carrying
    /// an `id` + a `result`, distinct from the `turn/start` request which carries a `method`).
    fn written_response(written: &str) -> Value {
        for line in written.lines() {
            let v: Value = serde_json::from_str(line).unwrap();
            if v.get("id").is_some() && v.get("result").is_some() {
                return v;
            }
        }
        panic!("no JSON-RPC response written to transport; wrote: {written}");
    }

    #[test]
    fn gate_on_commandexecution_approval_allowed_continues_and_completes() {
        // (KAT a) item/commandExecution/requestApproval (CommandExecutionRequestApprovalParams
        // .json) interleaved mid-turn; the handler returns Allow, so the turn continues to the
        // authoritative agentMessage item and turn/completed. The response written back is a
        // well-formed JSON-RPC response carrying the inbound request id (77) and the
        // CommandExecutionApprovalDecision "accept" (NOT a ReviewDecision "approved").
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":77,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"i-1","approvalId":"ap-1","command":"cargo build","cwd":"/work","startedAtMs":123}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{"id":"a-1","type":"agentMessage","text":"built"}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let mut client = run_turn_client(stream);
        let seen = std::cell::RefCell::new(Vec::<String>::new());
        let out = client
            .run_turn_core("thread-1", None, "build it", true, &|req| {
                seen.borrow_mut().push(req.method().to_string());
                // The parsed request carries the real command for the handler to inspect.
                assert!(matches!(
                    req,
                    CodexServerRequest::CommandExecution { command: Some(c), cwd: Some(w), .. }
                        if c == "cargo build" && w == "/work"
                ));
                Ok(CodexApprovalDecision::Allow)
            })
            .unwrap();
        assert_eq!(out.status, "completed");
        assert_eq!(out.content, "built");
        assert_eq!(
            seen.borrow().as_slice(),
            ["item/commandExecution/requestApproval"]
        );

        // (KAT e) The response on the wire is valid JSON-RPC with the correct decision enum
        // + the inbound request id, AND pins the force-approval policy on turn/start.
        let (_r, written) = client.into_transport().into_parts();
        let written = String::from_utf8(written).unwrap();
        let resp = written_response(&written);
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], json!(77));
        assert_eq!(resp["result"], json!({ "decision": "accept" }));
        let req: Value = serde_json::from_str(written.lines().next().unwrap()).unwrap();
        assert_eq!(req["method"], "turn/start");
        assert_eq!(
            req["params"]["approvalPolicy"],
            MODEL_TURN_GATE_APPROVAL_POLICY
        );
        assert_eq!(req["params"]["approvalPolicy"], "untrusted");
    }

    #[test]
    fn gate_on_filechange_approval_denied_aborts_turn() {
        // (KAT b) item/fileChange/requestApproval (FileChangeRequestApprovalParams.json — note
        // it carries NO path/diff, only ids + grantRoot); the handler returns Deny, so the
        // turn aborts with the typed `approval-denied` blocker AND the response written back is
        // FileChangeApprovalDecision "cancel" (the turn-interrupting deny), carrying id 88.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":88,"method":"item/fileChange/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"i-2","grantRoot":"/work","reason":"edit","startedAtMs":456}}"#,
            "\n",
        );
        let mut client = run_turn_client(stream);
        let err = client
            .run_turn_core("thread-1", None, "edit it", true, &|req| {
                assert!(matches!(
                    req,
                    CodexServerRequest::FileChange { grant_root: Some(g), .. } if g == "/work"
                ));
                Ok(CodexApprovalDecision::Deny)
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Protocol {
                code: "approval-denied"
            }
        ));
        let (_r, written) = client.into_transport().into_parts();
        let written = String::from_utf8(written).unwrap();
        let resp = written_response(&written);
        assert_eq!(resp["id"], json!(88));
        assert_eq!(resp["result"], json!({ "decision": "cancel" }));
    }

    #[test]
    fn gate_on_legacy_execcommand_and_applypatch_use_review_decision() {
        // The legacy v1 execCommandApproval (ExecCommandApprovalParams.json) + applyPatchApproval
        // (ApplyPatchApprovalParams.json) take a ReviewDecision ("approved"/"abort"), NOT the
        // accept/decline family. Allowed execCommand → "approved"; the parsed argv + applyPatch
        // changed paths are surfaced to the handler.
        let exec_stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"t","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":5,"method":"execCommandApproval","params":{"conversationId":"conv-1","callId":"call-1","cwd":"/work","command":["ls","-la"]}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"t","status":"completed","items":[]}}}"#,
            "\n",
        );
        let mut client = run_turn_client(exec_stream);
        client
            .run_turn_core("thread-1", None, "x", true, &|req| {
                assert!(matches!(
                    req,
                    CodexServerRequest::ExecCommand { command, .. } if command == &["ls".to_string(), "-la".to_string()]
                ));
                Ok(CodexApprovalDecision::Allow)
            })
            .unwrap();
        let (_r, written) = client.into_transport().into_parts();
        let resp = written_response(&String::from_utf8(written).unwrap());
        assert_eq!(resp["id"], json!(5));
        assert_eq!(resp["result"], json!({ "decision": "approved" }));

        // applyPatchApproval denied → ReviewDecision "abort"; fileChanges KEYS are the paths.
        let patch_stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"t","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":9,"method":"applyPatchApproval","params":{"conversationId":"conv-1","callId":"call-2","fileChanges":{"/work/a.rs":{"type":"add","content":"x"}}}}"#,
            "\n",
        );
        let mut client = run_turn_client(patch_stream);
        let err = client
            .run_turn_core("thread-1", None, "x", true, &|req| {
                assert!(matches!(
                    req,
                    CodexServerRequest::ApplyPatch { changed_paths, .. } if changed_paths == &["/work/a.rs".to_string()]
                ));
                Ok(CodexApprovalDecision::Deny)
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Protocol {
                code: "approval-denied"
            }
        ));
        let (_r, written) = client.into_transport().into_parts();
        let resp = written_response(&String::from_utf8(written).unwrap());
        assert_eq!(resp["id"], json!(9));
        assert_eq!(resp["result"], json!({ "decision": "abort" }));
    }

    #[test]
    fn gate_on_malformed_server_request_is_typed_error_not_panic() {
        // (KAT c) A commandExecution requestApproval MISSING the required `turnId` must yield a
        // typed Protocol error from parse_server_request — never a panic/unwrap.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":11,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","itemId":"i","command":"x"}}"#,
            "\n",
        );
        let err = run_turn_client(stream)
            .run_turn_core("thread-1", None, "x", true, &|_req| {
                panic!("handler must NOT be called for a malformed request");
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Protocol { code: "turnId" }
        ));

        // An approval method this surface does not route (e.g. permissions) fails CLOSED with
        // a typed `unroutable-server-request`, not a guessed response.
        assert!(matches!(
            parse_server_request("item/permissions/requestApproval", &json!({})),
            Err(CodexAppServerError::Protocol {
                code: "unroutable-server-request"
            })
        ));
    }

    #[test]
    fn gate_off_is_byte_identical_to_legacy_run_turn() {
        // (KAT d) With gate OFF the handler is NEVER consulted, a mid-turn server request
        // fails closed with the historical `interactive-approval-unsupported` (NOT
        // `approval-denied`), and NOTHING is written to the transport beyond the original
        // turn/start (which still pins approvalPolicy "never"). This is the byte-identity
        // guarantee for flag-OFF callers.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":42,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"i","approvalId":"ap-1","command":"rm -rf /private/project","startedAtMs":1}}"#,
            "\n",
        );
        let mut client = run_turn_client(stream);
        let err = client
            .run_turn_core("thread-1", None, "hi", false, &|_req| {
                panic!("handler must NOT be consulted when the gate is OFF");
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Protocol {
                code: "interactive-approval-unsupported"
            }
        ));
        // No approval response was written (fail closed without responding), and the raw
        // command text never leaked into the error.
        let (_r, written) = client.into_transport().into_parts();
        let written = String::from_utf8(written).unwrap();
        assert!(
            !written.lines().any(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                v.get("result").and_then(|r| r.get("decision")).is_some()
            }),
            "flag-OFF must not write any approval response: {written}"
        );
        let turn_start: Value = serde_json::from_str(written.lines().next().unwrap()).unwrap();
        assert_eq!(
            turn_start["params"]["approvalPolicy"],
            MODEL_TURN_APPROVAL_POLICY
        );
        assert_eq!(turn_start["params"]["approvalPolicy"], "never");
        let rendered = format!("{err:?} {err}");
        assert!(
            !rendered.contains("rm -rf"),
            "blocker must not surface raw command: {rendered}"
        );
    }

    #[test]
    fn gate_on_handler_error_fails_closed_without_continuing() {
        // A handler that returns an error (e.g. PR2 authorize lookup failed) must propagate as
        // a typed error and abort the turn — never silently continue or auto-approve.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":13,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"i","command":"x","startedAtMs":1}}"#,
            "\n",
        );
        let err = run_turn_client(stream)
            .run_turn_core("thread-1", None, "x", true, &|_req| {
                Err(CodexAppServerError::Protocol {
                    code: "authorize-unavailable",
                })
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Protocol {
                code: "authorize-unavailable"
            }
        ));
    }

    #[test]
    fn codex_mutating_gate_flag_matcher_only_literal_one_enables() {
        // The flag is ON only for the trimmed literal "1"; everything else is OFF (narrow +
        // explicit, mirroring FRIDAY_TRUST_GRANT_ENFORCE) so the gate can never be enabled by
        // accident.
        assert!(codex_mutating_gate_from(Some("1".to_string())));
        assert!(codex_mutating_gate_from(Some(" 1 ".to_string())));
        assert!(!codex_mutating_gate_from(Some("0".to_string())));
        assert!(!codex_mutating_gate_from(Some("true".to_string())));
        assert!(!codex_mutating_gate_from(Some(String::new())));
        assert!(!codex_mutating_gate_from(None));
    }

    #[test]
    fn codex_app_server_watchdog_timeout_defaults_and_requires_positive_millis() {
        assert_eq!(DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS, 300_000);
        assert_eq!(CODEX_APP_SERVER_WATCHDOG_WALL_MULTIPLIER, 4);
        assert_eq!(
            codex_app_server_watchdog_timeout_from(None),
            Duration::from_millis(DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS)
        );
        assert_eq!(
            codex_app_server_watchdog_timeout_from(Some("")),
            Duration::from_millis(DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS)
        );
        assert_eq!(
            codex_app_server_watchdog_timeout_from(Some("not-a-number")),
            Duration::from_millis(DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS)
        );
        assert_eq!(
            codex_app_server_watchdog_timeout_from(Some("0")),
            Duration::from_millis(DEFAULT_CODEX_APP_SERVER_TIMEOUT_MS)
        );
        assert_eq!(
            codex_app_server_watchdog_timeout_from(Some(" 250 ")),
            Duration::from_millis(250)
        );
        assert_eq!(
            codex_app_server_watchdog_wall_timeout_from(Duration::from_millis(250)),
            Duration::from_millis(1_000)
        );
    }

    #[test]
    fn json_line_transport_reports_stdout_progress_to_watchdog() {
        let (progress, observed) = mpsc::channel();
        let stream = r#"{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}"#;
        let mut transport = JsonLineTransport::with_watchdog_progress(
            stream.as_bytes(),
            Vec::<u8>::new(),
            Some(progress),
        );
        let message = transport.read_message().unwrap();
        assert!(matches!(
            message,
            CodexInboundMessage::Notification { method, .. } if method == "turn/started"
        ));
        assert_eq!(
            observed.recv_timeout(Duration::from_millis(100)).unwrap(),
            AppServerWatchdogSignal::Progress
        );
    }

    #[test]
    fn codex_app_server_watchdog_progress_resets_idle_timeout() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 5"])
            .spawn()
            .unwrap();
        let control = spawn_app_server_watchdog(child.id(), Duration::from_millis(120));
        thread::sleep(Duration::from_millis(70));
        control.send(AppServerWatchdogSignal::Progress).unwrap();
        thread::sleep(Duration::from_millis(70));
        assert!(
            child.try_wait().unwrap().is_none(),
            "scratch child should still be alive because stdout progress reset idle watchdog"
        );
        let _ = control.send(AppServerWatchdogSignal::Release);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn codex_app_server_watchdog_kills_alive_but_silent_child() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 5"])
            .spawn()
            .unwrap();
        let _control = spawn_app_server_watchdog(child.id(), Duration::from_millis(80));
        for _ in 0..20 {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(
                    !status.success(),
                    "watchdog-killed scratch child must not report successful sleep completion"
                );
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("watchdog did not kill alive-but-silent scratch child");
    }

    #[test]
    fn cli_version_constant_pins_codex_0_140() {
        // Doc-only constant (no live code reads it); pins the codex-cli version the
        // `app-server --stdio` direct transport was re-ported against, so the target version
        // is greppable. Format mirrors `codex --version`.
        assert_eq!(CODEX_APP_SERVER_CLI_VERSION, "codex-cli 0.140.0");
    }

    #[test]
    fn run_turn_delegates_through_handler_path_and_stays_gate_off_in_test_env() {
        // The public `run_turn` now delegates through `run_turn_with_handler` with a deny-all
        // default handler (NOT a hardcoded gate-off), so the flag is the single source of
        // truth for both entrypoints. The test env never sets FRIDAY_CODEX_MUTATING_GATE, so
        // this resolves gate-OFF: a plain text turn completes exactly as before, proving the
        // delegation preserves the historical behavior.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":1,"item":{"id":"a","type":"agentMessage","text":"ok"}}}"#,
            "\n",
            r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#,
            "\n",
        );
        let out = run_turn_client(stream)
            .run_turn("thread-1", None, "hi")
            .unwrap();
        assert_eq!(out.content, "ok");
        assert_eq!(out.status, "completed");
    }

    #[test]
    fn default_deny_all_handler_fails_a_mutating_turn_closed_when_gate_on() {
        // The fail-OPEN footgun guard: the deny-all default handler `run_turn` supplies, when
        // the gate is ON, ABORTS a mutating turn (responds "cancel" → typed `approval-denied`)
        // rather than bypassing the gate. Driven via `run_turn_core(gate_on=true)` with the
        // exact deny-all closure `run_turn` uses, so the wrong-entrypoint degradation is
        // proven deterministically without touching the env.
        let stream = concat!(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
            "\n",
            r#"{"id":21,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"i","command":"rm -rf /private/project","startedAtMs":1}}"#,
            "\n",
        );
        let mut client = run_turn_client(stream);
        let err = client
            .run_turn_core("thread-1", None, "x", true, &|_req| {
                Ok(CodexApprovalDecision::Deny)
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CodexAppServerError::Protocol {
                code: "approval-denied"
            }
        ));
        let (_r, written) = client.into_transport().into_parts();
        let written = String::from_utf8(written).unwrap();
        let resp = written_response(&written);
        assert_eq!(resp["result"], json!({ "decision": "cancel" }));
        assert!(
            !written.contains("rm -rf"),
            "deny path must not surface raw command text: {written}"
        );
    }
}
