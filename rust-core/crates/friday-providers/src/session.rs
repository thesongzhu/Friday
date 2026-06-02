//! Codex/Claude provider adapters — Unit 6/7 **session control: send** slice
//! (`04` §2/§3/§4.5). Builds on the auth-readiness detection in the crate root.
//!
//! This slice can CONSUME the account (a send is a real model call). It is gated
//! two ways: (1) a send is refused unless the target provider is authenticated
//! (composes [`crate::detect`]), and (2) routing is to a SPECIFIC provider with
//! **no fallback** — there is no code path that substitutes another provider, so
//! a failure surfaces as that provider's error, never another provider's output.
//!
//! Secret hygiene: the real [`CliSession`] runs each CLI non-interactively with
//! `stdin`/`stderr` detached (`stderr` → null), so account identifiers the CLI
//! might print to stderr are never captured; errors carry only the provider
//! label + exit code, never CLI output. [`SessionOutcome`] holds only the model's
//! reply text.

use crate::{detect, Provider, ProviderError, ProviderProbe};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A provider's reply. Secret-safe: only the model's response text — never
/// account email/org/tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionOutcome {
    pub text: String,
}

/// Sends a prompt to a provider non-interactively. Real impl is [`CliSession`];
/// tests inject [`MockSession`] so routing / no-fallback / auth-gating are
/// provable without spending the account.
pub trait SessionRunner {
    fn send(&self, provider: Provider, prompt: &str) -> Result<SessionOutcome, ProviderError>;
}

/// Send a prompt to a SPECIFIC provider after verifying it is authenticated.
///
/// No fallback: this only ever calls `runner.send(provider)` for the requested
/// provider — there is no path to a different one. An unauthenticated/absent
/// provider is refused BEFORE any send (so the account is never even touched),
/// and a send failure returns that provider's error unchanged.
pub fn send_to_provider<P: ProviderProbe, R: SessionRunner>(
    probe: &P,
    runner: &R,
    provider: Provider,
    prompt: &str,
) -> Result<SessionOutcome, ProviderError> {
    let status = detect(probe, provider);
    if !status.authenticated {
        return Err(ProviderError::NotAuthenticated(provider.as_str()));
    }
    runner.send(provider, prompt)
}

/// Real session runner: invokes each CLI's non-interactive mode by ABSOLUTE path
/// with a wall-clock timeout. `codex exec` (read-only sandbox, prompt as the
/// positional arg, final message captured via `--output-last-message`); `claude
/// -p` (print mode). A send IS a model call and consumes the account.
pub struct CliSession {
    pub codex_bin: String,
    pub claude_bin: String,
    pub timeout: Duration,
}

impl Default for CliSession {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        CliSession {
            codex_bin: format!("{home}/.local/bin/codex"),
            claude_bin: format!("{home}/.local/bin/claude"),
            timeout: Duration::from_secs(120),
        }
    }
}

impl SessionRunner for CliSession {
    fn send(&self, provider: Provider, prompt: &str) -> Result<SessionOutcome, ProviderError> {
        match provider {
            Provider::Codex => {
                // Capture the model's FINAL message ONLY (via --output-last-message),
                // never the raw `codex exec` event stream (which echoes the prompt and
                // carries a session id / metadata). The temp file is uniquely named
                // per call and removed on every return path by the guard.
                let last = unique_temp_path("friday-codex-last");
                let _guard = TempFileGuard(last.clone());
                let last_str = last.to_string_lossy().to_string();
                // The event-stream stdout is intentionally DISCARDED, never surfaced.
                let _ = run_with_timeout(
                    &self.codex_bin,
                    &[
                        "exec",
                        "--skip-git-repo-check",
                        "--sandbox",
                        "read-only",
                        "--color",
                        "never",
                        "--output-last-message",
                        &last_str,
                    ],
                    prompt,
                    self.timeout,
                    Provider::Codex,
                )?;
                // The reply is strictly the captured final message; if it is
                // empty/unreadable we FAIL rather than substitute the raw stream.
                let text = std::fs::read_to_string(&last)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .ok_or(ProviderError::SendFailed {
                        provider: Provider::Codex.as_str(),
                        code: None,
                    })?;
                Ok(SessionOutcome { text })
            }
            Provider::Claude => {
                // `claude -p` prints only the reply to stdout.
                let stdout = run_with_timeout(
                    &self.claude_bin,
                    &["-p"],
                    prompt,
                    self.timeout,
                    Provider::Claude,
                )?;
                Ok(SessionOutcome {
                    text: stdout.trim().to_string(),
                })
            }
        }
    }
}

/// Spawn `bin args... prompt`, capture stdout (stdin/stderr detached), and
/// enforce a wall-clock timeout — killing the child if it overruns. Returns
/// stdout on a zero exit; otherwise a secret-safe `SendFailed`/`Timeout` error.
///
/// The stdout drain runs on a detached thread and every read is bounded by
/// `recv_timeout`, so the caller can NEVER hang — not even if the CLI orphans a
/// grandchild that inherits the stdout pipe (in that rare case the reader thread
/// is left to exit on its own; the caller still returns within the timeout).
/// Errors carry only the provider label + exit code, never the CLI's output or
/// the binary path (which would leak the OS username).
fn run_with_timeout(
    bin: &str,
    args: &[&str],
    prompt: &str,
    timeout: Duration,
    provider: Provider,
) -> Result<String, ProviderError> {
    let mut child = Command::new(bin)
        .args(args)
        .arg(prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null()) // never capture CLI stderr (may hold account info)
        .spawn()
        .map_err(|_| ProviderError::NotInstalled(provider.as_str().to_string()))?;

    // Drain stdout on a DETACHED thread (no join) so a full pipe buffer cannot
    // deadlock the child, and send the result over a channel we read with a bound.
    let mut out = child.stdout.take().expect("stdout piped");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = out.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    // Grace for draining buffered stdout after the child has exited/been killed.
    // Bounded, so an orphaned grandchild holding the pipe cannot hang the caller.
    let drain_grace = Duration::from_secs(2);

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = rx.recv_timeout(drain_grace).unwrap_or_default();
                return if status.success() {
                    Ok(stdout)
                } else {
                    Err(ProviderError::SendFailed {
                        provider: provider.as_str(),
                        code: status.code(),
                    })
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = rx.recv_timeout(drain_grace);
                    return Err(ProviderError::Timeout {
                        provider: provider.as_str(),
                        secs: timeout.as_secs(),
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // A post-spawn wait error: reap best-effort and report a send failure
            // (the process WAS found/spawned, so this is not "not installed").
            Err(_e) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = rx.recv_timeout(drain_grace);
                return Err(ProviderError::SendFailed {
                    provider: provider.as_str(),
                    code: None,
                });
            }
        }
    }
}

/// A uniquely-named temp path (`prefix-<pid>-<nanos>-<counter>`), distinct per
/// call so concurrent sends never share a file.
fn unique_temp_path(prefix: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = CTR.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}-{}.txt",
        std::process::id(),
        nanos,
        n
    ))
}

/// Removes its temp file on drop — so a captured-output file is cleaned up on
/// EVERY return path (success, error, or timeout), not only the happy path.
struct TempFileGuard(std::path::PathBuf);
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Programmable mock runner that RECORDS which providers it was asked to send to
/// (so routing fidelity + "called exactly once" are testable). Not for prod use.
pub struct MockSession {
    codex: Result<String, ProviderError>,
    claude: Result<String, ProviderError>,
    calls: std::cell::RefCell<Vec<Provider>>,
}

impl MockSession {
    pub fn new(
        codex: Result<String, ProviderError>,
        claude: Result<String, ProviderError>,
    ) -> Self {
        MockSession {
            codex,
            claude,
            calls: std::cell::RefCell::new(Vec::new()),
        }
    }

    /// The exact sequence of providers `send` was invoked for.
    pub fn calls(&self) -> Vec<Provider> {
        self.calls.borrow().clone()
    }
}

impl SessionRunner for MockSession {
    fn send(&self, provider: Provider, _prompt: &str) -> Result<SessionOutcome, ProviderError> {
        self.calls.borrow_mut().push(provider);
        let r = match provider {
            Provider::Codex => &self.codex,
            Provider::Claude => &self.claude,
        };
        match r {
            Ok(text) => Ok(SessionOutcome { text: text.clone() }),
            Err(ProviderError::SendFailed { provider, code }) => Err(ProviderError::SendFailed {
                provider,
                code: *code,
            }),
            Err(ProviderError::Timeout { provider, secs }) => Err(ProviderError::Timeout {
                provider,
                secs: *secs,
            }),
            Err(ProviderError::NotAuthenticated(p)) => Err(ProviderError::NotAuthenticated(p)),
            Err(ProviderError::NotInstalled(s)) => Err(ProviderError::NotInstalled(s.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProbeOutput;
    use std::collections::HashMap;

    /// Probe stub that reports a fixed auth status per provider.
    struct AuthStub {
        authed: HashMap<&'static str, bool>,
    }
    impl AuthStub {
        fn new() -> Self {
            Self {
                authed: HashMap::new(),
            }
        }
        fn with(mut self, p: Provider, authed: bool) -> Self {
            self.authed.insert(p.as_str(), authed);
            self
        }
    }
    impl ProviderProbe for AuthStub {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            // Encode the desired auth result in output that parse_status will read.
            let authed = *self.authed.get(provider.as_str()).unwrap_or(&false);
            let body = match (provider, authed) {
                (Provider::Codex, true) => "Logged in using ChatGPT".to_string(),
                (Provider::Codex, false) => "Not logged in".to_string(),
                (Provider::Claude, true) => "{\"loggedIn\": true}".to_string(),
                (Provider::Claude, false) => "{\"loggedIn\": false}".to_string(),
            };
            Ok(ProbeOutput {
                stdout: body,
                stderr: String::new(),
            })
        }
    }

    fn ok(s: &str) -> Result<String, ProviderError> {
        Ok(s.to_string())
    }
    fn fail(p: Provider) -> Result<String, ProviderError> {
        Err(ProviderError::SendFailed {
            provider: p.as_str(),
            code: Some(1),
        })
    }

    #[test]
    fn send_routes_to_requested_provider_and_returns_its_text() {
        let probe = AuthStub::new()
            .with(Provider::Codex, true)
            .with(Provider::Claude, true);
        let runner = MockSession::new(ok("from-codex"), ok("from-claude"));
        let out = send_to_provider(&probe, &runner, Provider::Claude, "hi").unwrap();
        assert_eq!(out.text, "from-claude");
        // Routed to exactly the requested provider, once.
        assert_eq!(runner.calls(), vec![Provider::Claude]);
    }

    #[test]
    fn unauthenticated_provider_is_refused_and_runner_is_never_called() {
        let probe = AuthStub::new().with(Provider::Claude, false);
        let runner = MockSession::new(ok("x"), ok("y"));
        let r = send_to_provider(&probe, &runner, Provider::Claude, "hi");
        assert!(matches!(r, Err(ProviderError::NotAuthenticated("claude"))));
        // The account is never even touched: no send was attempted.
        assert!(runner.calls().is_empty());
    }

    #[test]
    fn send_failure_returns_that_providers_error_unchanged_called_exactly_once() {
        let probe = AuthStub::new().with(Provider::Codex, true);
        let runner = MockSession::new(fail(Provider::Codex), ok("from-claude"));
        let r = send_to_provider(&probe, &runner, Provider::Codex, "hi");
        // The Codex failure surfaces as a CODEX error — not a success, not
        // Claude's text. And exactly one call was made, to the requested provider.
        match r {
            Err(ProviderError::SendFailed { provider, code }) => {
                assert_eq!(provider, "codex");
                assert_eq!(code, Some(1));
            }
            other => panic!("expected Codex SendFailed, got {other:?}"),
        }
        assert_eq!(runner.calls(), vec![Provider::Codex]);
    }

    #[test]
    fn auth_gate_keys_on_the_requested_provider() {
        // Codex authed, Claude NOT: requesting Codex succeeds; requesting Claude is
        // refused — proving the gate keys on the REQUESTED provider, not the other.
        let probe = AuthStub::new()
            .with(Provider::Codex, true)
            .with(Provider::Claude, false);
        let runner = MockSession::new(ok("from-codex"), ok("from-claude"));
        assert_eq!(
            send_to_provider(&probe, &runner, Provider::Codex, "hi")
                .unwrap()
                .text,
            "from-codex"
        );
        assert!(matches!(
            send_to_provider(&probe, &runner, Provider::Claude, "hi"),
            Err(ProviderError::NotAuthenticated("claude"))
        ));
        // Only the authed (Codex) send happened; the refused one never reached the runner.
        assert_eq!(runner.calls(), vec![Provider::Codex]);
    }

    #[test]
    fn outcome_and_errors_are_secret_safe_labels_only() {
        // SessionOutcome carries only reply text; errors carry only the provider
        // label + exit code — no CLI stdout/stderr (account info) and no binary
        // path (which would leak the OS username).
        let s = format!(
            "{}",
            ProviderError::SendFailed {
                provider: "codex",
                code: Some(2),
            }
        );
        assert!(s.contains("codex"));
        assert!(!s.to_lowercase().contains("token"));
        assert!(!s.to_lowercase().contains("email"));
        assert!(format!(
            "{}",
            ProviderError::Timeout {
                provider: "claude",
                secs: 120,
            }
        )
        .contains("claude"));
        // The send-path NotInstalled carries the provider label only — never the
        // absolute binary path (no "/Users/<user>/..." username leak).
        let ni = format!("{}", ProviderError::NotInstalled("codex".to_string()));
        assert!(ni.contains("codex"));
        assert!(!ni.contains('/'), "must not embed a filesystem path: {ni}");
    }
}
