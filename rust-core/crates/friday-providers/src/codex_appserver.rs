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
use thiserror::Error;

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
pub struct HealthSummary {
    pub initialized: InitializeSummary,
    pub thread_list: ThreadListProbe,
    pub sync_mode: &'static str,
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
    fn request(&mut self, request: JsonRpcRequest) -> Result<JsonRpcResponse, CodexAppServerError> {
        let encoded = serde_json::to_vec(&request).map_err(|_| CodexAppServerError::Protocol {
            code: "request-encode",
        })?;
        self.writer
            .write_all(&encoded)
            .and_then(|_| self.writer.write_all(b"\n"))
            .and_then(|_| self.writer.flush())
            .map_err(|_| CodexAppServerError::Transport {
                code: "request-write",
            })?;

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
        serde_json::from_str(&line).map_err(|_| CodexAppServerError::Protocol {
            code: "response-json",
        })
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

    /// Non-model health probe. `thread/list` is a metadata read; it must not be
    /// used as proof of a model send or official provider-history sync.
    pub fn thread_list_probe(&mut self) -> Result<ThreadListProbe, CodexAppServerError> {
        let result = self.call(
            "thread/list",
            json!({
                "limit": 1,
                "archived": false,
                "useStateDbOnly": true,
            }),
        )?;
        let item_count = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or(CodexAppServerError::Protocol {
                code: "thread-list-data",
            })?
            .len();
        let has_next_cursor = result.get("nextCursor").is_some_and(|v| !v.is_null());
        Ok(ThreadListProbe {
            item_count,
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

fn required_string(value: &Value, field: &'static str) -> Result<String, CodexAppServerError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or(CodexAppServerError::Protocol { code: field })
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
        assert!(written.contains("\"method\":\"initialize\""));
        assert!(written.ends_with('\n'));
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
