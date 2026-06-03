//! Ignored local app-server stdio proof. This starts a local Codex App Server
//! child process and performs metadata-only calls: initialize, thread/list, and
//! thread/read when a local thread exists. It must not start a model turn.

use friday_providers::codex_appserver::{
    CodexAppServerClient, JsonLineTransport, CODEX_APP_SERVER_SYNC_MODE,
};
use std::process::{Child, Command, Stdio};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "local CLI check: starts codex app-server --stdio; metadata-only, no model turn"]
fn live_stdio_appserver_metadata_round_trip() {
    let mut child = Command::new("codex")
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("codex app-server --stdio should launch");
    let stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let mut guard = ChildGuard(child);

    let transport = JsonLineTransport::new(stdout, stdin);
    let mut client = CodexAppServerClient::new(transport);
    let health = client
        .health_check("friday-live-stdio", "0.0.1")
        .expect("metadata health should complete without a model turn");
    assert_eq!(health.sync_mode, CODEX_APP_SERVER_SYNC_MODE);
    assert!(health.initialized.user_agent.contains("friday-live-stdio"));

    let threads = client
        .list_threads(1, true)
        .expect("thread/list should complete without a model turn");
    if let Some(first) = threads.threads.first() {
        let read = client
            .read_thread(&first.thread_id, false)
            .expect("thread/read should complete without a model turn");
        assert_eq!(read.thread.thread_id, first.thread_id);
    }

    let _ = guard.0.kill();
}
