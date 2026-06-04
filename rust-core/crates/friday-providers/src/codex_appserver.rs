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
use thiserror::Error;

use friday_core::ProviderSessionEvent;

pub const CODEX_APP_SERVER_SYNC_MODE: &str = "provider_app_server_local";
pub const CODEX_APP_SERVER_CLI_VERSION: &str = "codex-cli 0.136.0";

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

pub trait CodexAppServerTransport {
    fn request(&mut self, request: JsonRpcRequest) -> Result<JsonRpcResponse, CodexAppServerError>;

    /// Send a fire-and-forget JSON-RPC notification (no id, no response wait). Default
    /// no-op so in-memory / mocked transports need not implement it; the real
    /// [`JsonLineTransport`] overrides it. Used for the post-`initialize` `initialized`
    /// handshake the app-server expects before thread/turn calls.
    fn notify(&mut self, _method: &str, _params: Option<Value>) -> Result<(), CodexAppServerError> {
        Ok(())
    }
}

pub struct JsonLineTransport<R, W> {
    reader: BufReader<R>,
    writer: W,
}

impl<R: Read, W: Write> JsonLineTransport<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader: BufReader::new(reader),
            writer,
        }
    }

    pub fn into_parts(self) -> (BufReader<R>, W) {
        (self.reader, self.writer)
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
}

impl LocalCodexAppServer {
    /// Spawn `<program> app-server` (default `program` = `"codex"`) over piped stdio.
    pub fn spawn(program: &str) -> Result<Self, CodexAppServerError> {
        let mut child = Command::new(program)
            .arg("app-server")
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
        let client = CodexAppServerClient::new(JsonLineTransport::new(stdout, stdin));
        Ok(Self { child, client })
    }

    /// The OS pid of the spawned app-server (for an external watchdog kill).
    pub fn child_id(&self) -> u32 {
        self.child.id()
    }

    pub fn client(
        &mut self,
    ) -> &mut CodexAppServerClient<JsonLineTransport<ChildStdout, ChildStdin>> {
        &mut self.client
    }

    /// Terminate the app-server process (idempotent).
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for LocalCodexAppServer {
    fn drop(&mut self) {
        self.kill();
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
}
