//! C1 PR-A — the **authorize-only** core of a gated Codex turn (DARK, flag-gated).
//!
//! Codex is a coordinated AGENT: it runs in ITS OWN runtime (the `codex app-server`
//! child process), proposing pre-execution side effects (command execution / file
//! changes / apply-patch) as it works. Friday does NOT execute those side effects and
//! does NOT add a new gate for them — instead it **routes each Codex pre-execution
//! approval request through Friday's EXISTING closed loops**:
//!
//! ```text
//!  Codex app-server  ── item/*/requestApproval ──▶  this module's handler
//!        │                                              │ (1) TRANSLATE the request to a
//!        │                                              │     Friday MutatingActionRequest,
//!        │                                              │     deriving mutating/risk from the
//!        │                                              │     TRUSTED registry — never the model
//!        │                                              │ (2) GATE via the EXISTING stack:
//!        │                                              │     friday_storage::authorize_agent_action
//!        │                                              │     (trust-grant allowed_tools / risk
//!        │                                              │      ceiling AND the mutating-action gate)
//!        │  ◀── accept / cancel(deny) ──────────────────│ (3) MAP GateDecision → Codex decision
//!        ▼                                                    Allow→accept, Deny/RequiresApproval→cancel
//!  continues / aborts the turn                               and, on RequiresApproval, persist a
//!                                                             pending_approval_request (the SAME
//!                                                             NS-7 path the run-loop uses) so the
//!                                                             outer turn yields a `Paused` outcome.
//! ```
//!
//! ## What this PR is — and is NOT
//! - It is a single free function, [`run_codex_gated_turn`], plus the result/error types
//!   it returns. It is a FREE function (not an [`crate::AgentLlmClient`] method) so it can
//!   take `conn: &Connection` as a parameter — the gate + the pending-approval persistence
//!   both need the connection, and threading it through the trait would force a borrow that
//!   does not compose.
//! - It REUSES, never reimplements: the trusted classifier ([`crate::trusted_classify`] via
//!   [`crate::build_request_with_policy`]), the gate compose
//!   ([`friday_storage::authorize_agent_action`]), the pending-approval persistence
//!   ([`friday_storage::PendingApprovalRequest`] / [`friday_storage::persist_pending_request`]),
//!   the CSPRNG nonce ([`friday_crypto::generate_approval_nonce`]), and the billing map
//!   ([`crate::BilledUsage::from_codex`]). It adds NO parallel gate, ledger, or pause
//!   mechanism. The surrounding loops (session / memory / activity / audit) are UNTOUCHED.
//! - It is DARK. The actual Codex transport gate is governed by
//!   [`friday_providers::codex_appserver::FRIDAY_CODEX_MUTATING_GATE`] inside
//!   [`friday_providers::codex_appserver::CodexAppServerClient::run_turn_with_handler`]: with
//!   the flag OFF, that surface fails closed on any mid-turn approval request WITHOUT
//!   consulting our handler (byte-identical to the historical `interactive-approval-unsupported`),
//!   so this path is effectively unused until the operator flips the flag. PR-B rewires
//!   `runtime.rs` to CALL this and removes the in-process "brain"; this PR only builds the core.
//!
//! ## No-bypass / no-degrade invariants (the point of this PR)
//! - **Mutating-ness is registry-derived, never the model's word.** Every Codex approval
//!   request is translated into a Friday action whose `mutating`/`risk` come from the
//!   trusted [`crate::ToolRegistry`] (via [`crate::build_request_with_policy`]); a command
//!   the model presents as benign is classified by [`friday_core::gate::classify`] (which
//!   escalates a destructive `run_command` via `shell_risk`), so it is STILL gated. The
//!   typed [`crate::RawToolCall`] has no `mutating` field — the model cannot even express
//!   the "this destructive action is non-mutating" lie.
//! - **Chat-only trust grant ⇒ Codex can only answer.** A grant with empty `allowed_tools`
//!   makes [`friday_core::check_grant`] Deny every tool dimension, so every Codex tool
//!   proposal is Denied here — Codex's turn can still produce a text answer (a text-only
//!   turn triggers no approval request), but it can execute nothing.
//! - **Fail-closed translation.** An approval request this module cannot map to a trusted
//!   registry action (e.g. a `commandExecution` with no command string) is DENIED — never
//!   guessed, never allowed.
//! - **A `RequiresApproval` never auto-allows.** It maps to a Codex `cancel` (the
//!   turn-interrupting deny) AND persists a `pending_approval_request`, so the outer turn
//!   `Paused`s for the offline operator to sign — exactly as the run-loop's Pause arm.

use std::cell::RefCell;

use friday_core::gate::{CanonicalApproval, GateDecision, MutatingActionRequest};
use friday_providers::codex_appserver::{
    CodexAppServerClient, CodexAppServerTransport, CodexApprovalDecision, CodexServerRequest,
    ModelTurnOutcome,
};
use friday_storage::AgentActionContext;
use rusqlite::Connection;

use crate::{build_request_with_policy, BilledUsage, RawToolCall, RunPolicy, ToolError};

/// TTL (ms) of a `pending_approval_request` a gated Codex turn persists on
/// `RequiresApproval` — the offline-signing window the operator has. Mirrors the run-loop's
/// `PENDING_APPROVAL_TTL_MS` (24h) so a Codex-originated pause and a loop-originated pause
/// expire identically; kept as a local const (not a cross-module re-export) since the
/// run-loop's copy is private and this surface must not reach into the loop.
const PENDING_APPROVAL_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// The outcome of one gated Codex model turn. Mirrors the run-loop's terminal taxonomy
/// (`Finished` / `Paused` / `Errored`) projected onto a single Codex turn — there is no
/// `Blocked` variant because a hard Deny inside a turn surfaces as `Errored` (the turn
/// could not complete its work), distinct from `Paused` (the work is recoverable once the
/// operator signs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexTurnOutcome {
    /// The turn completed. `answer` is the authoritative agent-message text; `usage` is the
    /// provider-neutral billed usage ([`BilledUsage::from_codex`]) the caller ledgers.
    Finished { answer: String, usage: BilledUsage },
    /// A Codex pre-execution action required operator approval. The action was DENIED to
    /// Codex (its turn aborted) AND a `pending_approval_request` was persisted under
    /// `approval_nonce` (the CSPRNG nonce the offline operator signs over). The work is
    /// resumable once the operator approves. `action` is the translated Friday verb.
    Paused {
        action: String,
        approval_nonce: String,
    },
    /// The turn could not complete: a hard gate Deny (trust-revoked, chat-only grant,
    /// reserved-action), an unmappable/unrecognized approval request, or a transport/protocol
    /// failure. `reason` is a code-only, secret-free label (never the raw command/path).
    Errored { reason: String },
}

/// Why composing a gated Codex turn failed at the Friday side (distinct from a turn that ran
/// and resolved to [`CodexTurnOutcome::Errored`]). These are Friday-side faults the caller
/// fail-closes on — never a silent default, never an auto-approve.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexGatedTurnError {
    /// Persisting the `pending_approval_request` for a `RequiresApproval` failed. The turn
    /// was already DENIED to Codex (it cannot proceed); this surfaces that the pause is not
    /// durably recoverable. Fail-closed: we do NOT fabricate a `Paused` outcome without a
    /// persisted pending row.
    PersistPending,
}

impl std::fmt::Display for CodexGatedTurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexGatedTurnError::PersistPending => {
                write!(
                    f,
                    "codex_gated_turn: pending_approval_request persist failed"
                )
            }
        }
    }
}

impl std::error::Error for CodexGatedTurnError {}

/// What the gate handler captured for the outer function to finalize AFTER the turn returns.
/// The Codex handler can only return Allow/Deny, so a `RequiresApproval` is captured here and
/// resolved into a `Paused` outcome by [`run_codex_gated_turn`] (the SINGLE place that owns
/// `conn` for the pending-approval persist). A hard Deny is captured as `Denied` so the
/// caller can report the gate reason rather than a bare transport error.
enum CapturedGate {
    /// The gate Denied (trust objection / chat-only grant / reserved action / base-gate
    /// Deny). Carries the code-only reason for the outcome (the action verb is not surfaced
    /// on a Denied outcome — only the reason is reported).
    Denied { reason: String },
    /// The gate RequiresApproval. Carries the EXACT translated request so the outer fn can
    /// persist a `pending_approval_request` bound to it (digest, principal, params). Boxed:
    /// `MutatingActionRequest` is the by-far-largest variant, so boxing keeps the enum small.
    RequiresApproval {
        request: Box<MutatingActionRequest>,
        action: String,
    },
    /// The request could not be translated to a trusted registry action — fail closed.
    Unmappable { reason: String },
}

/// Run ONE gated Codex model turn through the EXISTING Friday trust/approval stack and map
/// the result onto a [`CodexTurnOutcome`].
///
/// `codex_client` must already be on a started thread (the caller — PR-B — does
/// `initialize`/`thread/start`); this function drives exactly one turn via
/// [`CodexAppServerClient::run_turn_with_handler`]. The Codex-transport gate flag
/// ([`friday_providers::codex_appserver::FRIDAY_CODEX_MUTATING_GATE`]) governs whether the
/// handler is consulted at all: flag OFF ⇒ a mid-turn approval request fails closed inside
/// `run_turn_with_handler` (`interactive-approval-unsupported`) WITHOUT reaching our handler,
/// so a text-only turn still `Finished`s and any side-effecting turn `Errored`s — byte-identical
/// to today.
///
/// Per approval request the handler:
/// 1. **Translates** the [`CodexServerRequest`] into a [`RawToolCall`] whose action is chosen
///    from the request KIND (commandExecution/exec → `run_command`; fileChange/applyPatch →
///    `write_file`), then builds a [`MutatingActionRequest`] via
///    [`crate::build_request_with_policy`] — so `mutating`/`risk`/`resource` are derived by
///    the trusted [`crate::trusted_classify`], NEVER from the model. An untranslatable
///    request (e.g. a command-execution with no command) fails closed.
/// 2. **Gates** it via [`friday_storage::authorize_agent_action`] (the trust-grant
///    `allowed_tools`/risk-ceiling AND-gate composed with the mutating-action gate) — reused
///    verbatim. `approve_fn` supplies the (optional) [`CanonicalApproval`].
/// 3. **Maps** the [`GateDecision`]: `Allow` → [`CodexApprovalDecision::Allow`]; `Deny` →
///    [`CodexApprovalDecision::Deny`] (captured as a hard deny); `RequiresApproval` →
///    [`CodexApprovalDecision::Deny`] (captured so the outer fn persists a pending request).
///
/// `now_ms` timestamps the pending-approval row + its expiry. The `policy`'s
/// `action_context` (the agent identity/workspace the trust grant is scoped to) is read back
/// for the gate; if it carries none, the gate fails closed (`trust_no_active_grant`).
#[allow(clippy::too_many_arguments)]
pub fn run_codex_gated_turn<T, F>(
    conn: &Connection,
    codex_client: &mut CodexAppServerClient<T>,
    policy: &RunPolicy,
    secret: &[u8],
    approve_fn: &F,
    thread_id: &str,
    user_message_id: Option<&str>,
    text: &str,
    route_model: &str,
    run_id: &str,
    now_ms: i64,
) -> Result<CodexTurnOutcome, CodexGatedTurnError>
where
    T: CodexAppServerTransport,
    F: Fn(&MutatingActionRequest) -> Option<CanonicalApproval>,
{
    // Build the trust-check context ONCE from the run policy. `None` ⇒ no agent identity ⇒
    // no grant can apply ⇒ the gate fails closed (`trust_no_active_grant`); we still run the
    // turn (a text-only turn `Finished`s), but any tool proposal is Denied. The action
    // `.tool` dimension is enriched per-request inside the handler (the dispatched action is
    // not known until the request arrives), mirroring the run-loop's TP-PR1 enrich.
    let base_ctx: AgentActionContext = policy.action_context().cloned().unwrap_or_default();

    // The handler can only return Allow/Deny; a RequiresApproval (and a hard Deny / an
    // unmappable request) is CAPTURED here so the outer fn — which owns `conn` for the
    // pending-approval persist — can finalize the outcome AFTER the turn returns. At most one
    // capture happens per turn: the first Deny aborts the turn inside `run_turn_with_handler`.
    let captured: RefCell<Option<CapturedGate>> = RefCell::new(None);

    let handler = |req: &CodexServerRequest| -> Result<
        CodexApprovalDecision,
        friday_providers::codex_appserver::CodexAppServerError,
    > {
        // (1) TRANSLATE to a trusted registry action — never the model's word. Fail closed on
        // an unrecognized/under-specified request.
        let raw = match translate_to_raw_tool_call(req) {
            Some(raw) => raw,
            None => {
                *captured.borrow_mut() = Some(CapturedGate::Unmappable {
                    reason: format!("codex_request_unmappable:{}", req.method()),
                });
                return Ok(CodexApprovalDecision::Deny);
            }
        };
        let request = match build_request_with_policy(&raw, policy) {
            Ok(r) => r,
            Err(ToolError::UnknownTool(action)) => {
                *captured.borrow_mut() = Some(CapturedGate::Unmappable {
                    reason: format!("codex_action_unregistered:{action}"),
                });
                return Ok(CodexApprovalDecision::Deny);
            }
        };

        // (2) GATE via the EXISTING stack. Enrich the context's `.tool` dimension with the
        // dispatched (registry) action so the trust grant's `allowed_tools` allowlist is
        // actually checked (the same enrich the run-loop's TP-PR1 path does; without it the
        // tool dimension is silently skipped = fail-open). This is restriction-only.
        let mut ctx = base_ctx.clone();
        ctx.tool = Some(raw.action.clone());
        let record = match friday_storage::authorize_agent_action(
            conn,
            &request,
            &ctx,
            approve_fn(&request).as_ref(),
            secret,
            now_ms,
        ) {
            Ok(r) => r,
            // A storage error during authorize fails CLOSED: deny + capture so the turn
            // aborts and the caller sees a typed reason (never auto-approve on a DB hiccup).
            Err(_) => {
                *captured.borrow_mut() = Some(CapturedGate::Denied {
                    reason: "codex_authorize_unavailable".to_string(),
                });
                return Ok(CodexApprovalDecision::Deny);
            }
        };

        // (3) MAP the decision.
        match record.decision {
            GateDecision::Allow => Ok(CodexApprovalDecision::Allow),
            GateDecision::Deny => {
                *captured.borrow_mut() = Some(CapturedGate::Denied {
                    reason: record.reason,
                });
                Ok(CodexApprovalDecision::Deny)
            }
            GateDecision::RequiresApproval => {
                // Capture the EXACT request so the outer fn can persist a pending row bound to
                // its digest. The decision to Codex is the turn-interrupting Deny (cancel).
                *captured.borrow_mut() = Some(CapturedGate::RequiresApproval {
                    request: Box::new(request),
                    action: raw.action.clone(),
                });
                Ok(CodexApprovalDecision::Deny)
            }
        }
    };

    // Drive the turn. `run_turn_with_handler` reads the gate flag itself: flag OFF ⇒ a
    // mid-turn approval request fails closed (the handler is never consulted); flag ON ⇒ each
    // approval request routes through `handler` and a Deny aborts with `approval-denied`.
    let turn_result = codex_client.run_turn_with_handler(thread_id, user_message_id, text, handler);

    // Finalize. A captured gate result takes precedence over the raw transport error (a Deny
    // surfaces as `approval-denied`; we want the richer gate reason / a real Paused).
    let captured = captured.into_inner();
    match (turn_result, captured) {
        // RequiresApproval: persist the pending request (the EXISTING NS-7 path) → Paused.
        (Err(_), Some(CapturedGate::RequiresApproval { request, action })) => {
            let nonce = friday_crypto::generate_approval_nonce();
            let expires_at = now_ms.saturating_add(PENDING_APPROVAL_TTL_MS);
            // Carry the raw params (JSON) the action paused on, exactly as the run-loop's
            // Pause arm, so a resume can re-check the EXACT mutation against the signed approval.
            let tool_params = request.parameters.clone().or(Some("[]".to_string()));
            let pending = friday_storage::PendingApprovalRequest::for_request(
                &request, &nonce, run_id, expires_at, now_ms,
            )
            .with_tool_params(tool_params);
            match friday_storage::persist_pending_request(conn, &pending) {
                Ok(()) => Ok(CodexTurnOutcome::Paused {
                    action,
                    approval_nonce: nonce,
                }),
                // Fail-closed: the action was already denied to Codex, but the pause is not
                // durably recoverable. Surface the typed error rather than a phantom Paused.
                Err(_) => Err(CodexGatedTurnError::PersistPending),
            }
        }
        // A hard gate Deny — report the gate's own reason (richer than `approval-denied`).
        (Err(_), Some(CapturedGate::Denied { reason, .. })) => {
            Ok(CodexTurnOutcome::Errored { reason })
        }
        // An untranslatable request — fail closed with the typed reason.
        (Err(_), Some(CapturedGate::Unmappable { reason })) => {
            Ok(CodexTurnOutcome::Errored { reason })
        }
        // The turn errored for a transport/protocol reason with NO gate capture (e.g. flag-OFF
        // `interactive-approval-unsupported`, or a malformed server request). Code-only reason.
        (Err(e), None) => Ok(CodexTurnOutcome::Errored {
            reason: codex_error_code(&e),
        }),
        // The turn COMPLETED. Map to Finished + the neutral billed usage. (A capture with an
        // Ok turn is impossible — a Deny aborts the turn — but if it ever happened, the turn
        // genuinely completed, so Finished is honest.)
        (Ok(outcome), _) => Ok(finish(&outcome, route_model)),
    }
}

/// Map a completed [`ModelTurnOutcome`] to a [`CodexTurnOutcome::Finished`] with the
/// provider-neutral billed usage ([`BilledUsage::from_codex`], reusing the ONE biller's map).
fn finish(outcome: &ModelTurnOutcome, route_model: &str) -> CodexTurnOutcome {
    CodexTurnOutcome::Finished {
        answer: outcome.content.clone(),
        usage: BilledUsage::from_codex(outcome, route_model),
    }
}

/// Translate a [`CodexServerRequest`] into a [`RawToolCall`] for the TRUSTED classifier.
///
/// The action verb is chosen from the request KIND (never a model-asserted label), and the
/// command/path strings ride as params so [`friday_core::gate::classify`] can inspect them
/// (e.g. escalate a destructive `run_command` via `shell_risk`):
/// - `CommandExecution` / `ExecCommand` → `run_command` (mutating, registry `Risk::High`).
///   A command-execution with NO command string is unmappable (fail closed) — there is
///   nothing to classify and nothing the resume could replay.
/// - `FileChange` / `ApplyPatch` → `write_file` (mutating, registry `Risk::Medium`), the
///   conservative file-mutation verb. Codex carries no diff body on these surfaces; the
///   targeted root/first-changed path rides as the `path` param so the gate's `resource` is
///   scoped to it. Both are mutating, so the gate engages regardless.
///
/// Returns `None` for anything that cannot be mapped to a trusted action (fail closed). The
/// raw command/path text is carried for classification ONLY — it is never surfaced in an
/// outcome reason.
fn translate_to_raw_tool_call(req: &CodexServerRequest) -> Option<RawToolCall> {
    match req {
        CodexServerRequest::CommandExecution { command, .. } => {
            let command = command.as_ref()?;
            Some(RawToolCall {
                action: "run_command".to_string(),
                params: vec![("command".to_string(), command.clone())],
            })
        }
        CodexServerRequest::ExecCommand { command, cwd, .. } => {
            if command.is_empty() {
                return None;
            }
            // The legacy surface carries argv; join it into the single `command` string the
            // `run_command` classifier (`shell_risk`) + executor expect. `cwd` rides too so a
            // resume has the working directory the action was proposed under.
            Some(RawToolCall {
                action: "run_command".to_string(),
                params: vec![
                    ("command".to_string(), command.join(" ")),
                    ("cwd".to_string(), cwd.clone()),
                ],
            })
        }
        CodexServerRequest::FileChange { grant_root, .. } => Some(RawToolCall {
            action: "write_file".to_string(),
            // The v2 fileChange params carry no path/diff, only an optional grant root; bind
            // it as the resource `path` when present so the approval is scoped to that root.
            params: match grant_root {
                Some(root) => vec![("path".to_string(), root.clone())],
                None => vec![],
            },
        }),
        CodexServerRequest::ApplyPatch { changed_paths, .. } => {
            // Bind the FIRST changed path as the resource (deterministic; a patch with no
            // paths is still a mutating write the gate engages on).
            let params = match changed_paths.first() {
                Some(path) => vec![("path".to_string(), path.clone())],
                None => vec![],
            };
            Some(RawToolCall {
                action: "write_file".to_string(),
                params,
            })
        }
    }
}

/// Code-only, secret-free label for a Codex transport/protocol error. NEVER carries the raw
/// command/path (the error type itself is code-only, but we keep the projection explicit).
fn codex_error_code(e: &friday_providers::codex_appserver::CodexAppServerError) -> String {
    use friday_providers::codex_appserver::CodexAppServerError;
    match e {
        CodexAppServerError::Transport { code } => format!("codex_transport:{code}"),
        CodexAppServerError::Protocol { code } => format!("codex_protocol:{code}"),
        CodexAppServerError::SchemaDrift => "codex_schema_drift".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::gate::ActorKind;
    use friday_core::Risk;
    use friday_providers::codex_appserver::{
        CodexAppServerClient, JsonLineTransport, FRIDAY_CODEX_MUTATING_GATE,
    };
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, MutexGuard};

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Serializes the few KATs that must drive the handler (which requires the process-global
    /// [`FRIDAY_CODEX_MUTATING_GATE`] ON) so they never race the flag-OFF KATs in-process. The
    /// codex_appserver crate avoids env entirely (its `run_turn_core` takes an explicit
    /// `gate_on` bool), but that core is private; our function only has the env-reading
    /// `run_turn_with_handler`, so the gate-ON behavioral KATs set the env under THIS lock for
    /// the whole test body and clear it on the way out. Held for the test body's lifetime.
    static GATE_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// RAII gate-ON guard: sets `FRIDAY_CODEX_MUTATING_GATE=1` while held, clears it on drop.
    /// Holding the [`GATE_ENV_LOCK`] makes the set+clear atomic against other env-sensitive KATs.
    struct GateOn(#[allow(dead_code)] MutexGuard<'static, ()>);

    impl GateOn {
        fn on() -> Self {
            let guard = GATE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            std::env::set_var(FRIDAY_CODEX_MUTATING_GATE, "1");
            GateOn(guard)
        }
    }

    impl Drop for GateOn {
        fn drop(&mut self) {
            std::env::remove_var(FRIDAY_CODEX_MUTATING_GATE);
        }
    }

    /// A fresh file path for a temp hub DB (unique across runs AND processes — a fixed name
    /// would let a prior run's leftover DB collide on reopen).
    fn temp_path(tag: &str) -> String {
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.join(format!("friday-codex-gated-{pid}-{tag}-{n}-{nanos}.sqlite"))
            .to_string_lossy()
            .into_owned()
    }

    // ---- shared test harness (recorded byte-streams + temp DB + a test trust-grant) ----

    /// A `CodexAppServerClient` over a recorded `&[u8]` byte stream (the REAL
    /// `JsonLineTransport`), mirroring the codex_appserver crate's gate KATs — NO live codex.
    fn client_over(
        stream: &'static str,
    ) -> CodexAppServerClient<JsonLineTransport<&'static [u8], Vec<u8>>> {
        CodexAppServerClient::new(JsonLineTransport::new(stream.as_bytes(), Vec::<u8>::new()))
    }

    /// A turn whose ONLY mid-turn event is the given commandExecution approval request, then
    /// (if `complete`) an agent message + turn/completed. Shaped per
    /// `CommandExecutionRequestApprovalParams.json`.
    fn command_turn(command: &str, complete: bool) -> String {
        let mut s = String::new();
        s.push_str(
            r#"{"id":1,"result":{"turn":{"id":"turn-1","status":"inProgress","items":[]}}}"#,
        );
        s.push('\n');
        s.push_str(&format!(
            r#"{{"id":77,"method":"item/commandExecution/requestApproval","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"i-1","approvalId":"ap-1","command":"{command}","cwd":"/work","startedAtMs":1}}}}"#
        ));
        s.push('\n');
        if complete {
            s.push_str(r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{"id":"a-1","type":"agentMessage","text":"done"}}}"#);
            s.push('\n');
            s.push_str(r#"{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed","items":[]}}}"#);
            s.push('\n');
        }
        s
    }

    /// A text-only turn (no approval request) → completes.
    fn text_turn(text: &str) -> String {
        format!(
            concat!(
                r#"{{"id":1,"result":{{"turn":{{"id":"turn-1","status":"inProgress","items":[]}}}}}}"#,
                "\n",
                r#"{{"method":"item/completed","params":{{"threadId":"thread-1","turnId":"turn-1","completedAtMs":2,"item":{{"id":"a-1","type":"agentMessage","text":"{text}"}}}}}}"#,
                "\n",
                r#"{{"method":"turn/completed","params":{{"threadId":"thread-1","turn":{{"id":"turn-1","status":"completed","items":[]}}}}}}"#,
                "\n",
            ),
            text = text
        )
    }

    /// Insert an ACTIVE trust grant for `agent_id` with the given `allowed_tools` /
    /// `risk_ceiling` so `authorize_agent_action` can find it (the EXISTING `grant_trust` path
    /// — not a parallel insert). Panics on a setup failure (a test-only fixture).
    fn insert_grant(db: &Db, agent_id: &str, allowed_tools: &[&str], risk_ceiling: Risk) {
        let grant = friday_core::TrustGrant {
            grant_id: format!("g-{agent_id}"),
            agent_id: agent_id.to_string(),
            granted_at: 1,
            expires_at: None,
            revoked: false,
            revoked_at: None,
            boundaries: friday_core::TrustBoundaries {
                workspace: None,
                risk_ceiling,
                token_ceiling: None,
                max_runs: None,
                allowed_channels: vec![],
                allowed_providers: vec![],
                allowed_tools: allowed_tools.iter().map(|s| s.to_string()).collect(),
                allowed_workflow_families: vec![],
                allowed_skill_families: vec![],
            },
        };
        friday_storage::grant_trust(db.conn(), &grant, 1).expect("insert grant");
    }

    /// A policy bound to `agent_id` with an action-context (so the trust check can find the
    /// grant). The principal binds into the digest; the context carries the agent identity.
    fn policy_for(agent_id: &str) -> RunPolicy {
        RunPolicy::new(Some(agent_id.to_string()), Vec::<String>::new(), false).with_action_context(
            AgentActionContext {
                agent_id: agent_id.to_string(),
                ..Default::default()
            },
        )
    }

    /// `approve_fn` that NEVER supplies an approval (the offline-operator default): the gate
    /// can only Allow (trust), RequiresApproval (mutating, no approval), or Deny.
    fn no_approval(_req: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }

    fn run<T: CodexAppServerTransport>(
        db: &Db,
        client: &mut CodexAppServerClient<T>,
        policy: &RunPolicy,
        text: &str,
    ) -> Result<CodexTurnOutcome, CodexGatedTurnError> {
        run_codex_gated_turn(
            db.conn(),
            client,
            policy,
            b"test-secret",
            &no_approval,
            "thread-1",
            None,
            text,
            "gpt-5-codex",
            "run-1",
            1_000,
        )
    }

    // ---- KAT (a): grant allows the tool → Allow → turn continues + Finishes ----
    //
    // A grant whose `allowed_tools` includes `run_command` AND whose risk ceiling admits a
    // High command: the gate composes trust-OK with the mutating gate. With no approval the
    // mutating gate still RequiresApproval (a mutating action never auto-allows), so KAT (a)
    // uses a READ-equivalent? No — every Codex approval request is a mutating action. The
    // "turn continues + Finishes" Allow path is exercised by a grant that admits the tool AND
    // an approval supplied by `approve_fn`. We prove the Allow→continue wire with an approval.
    #[test]
    fn kat_a_allowed_tool_with_approval_continues_and_finishes() {
        let _gate = GateOn::on();
        let db = Db::open_hub(&temp_path("kat-a")).unwrap();
        let policy = policy_for("agent-1");
        insert_grant(&db, "agent-1", &["run_command"], Risk::High);

        // approve_fn mints a valid approval bound to the EXACT request → the mutating gate
        // upgrades RequiresApproval to Allow → Codex `accept` → turn continues to completion.
        let approve = |req: &MutatingActionRequest| -> Option<CanonicalApproval> {
            Some(crate::mint_approval(
                req,
                "ap-allowed",
                b"test-secret",
                10_000,
            ))
        };
        let mut client = client_over(Box::leak(
            command_turn("cargo build", true).into_boxed_str(),
        ));
        let out = run_codex_gated_turn(
            db.conn(),
            &mut client,
            &policy,
            b"test-secret",
            &approve,
            "thread-1",
            None,
            "build it",
            "gpt-5-codex",
            "run-1",
            1_000,
        )
        .unwrap();
        match out {
            CodexTurnOutcome::Finished { answer, usage } => {
                assert_eq!(answer, "done");
                assert_eq!(usage.provider_kind, friday_core::ProviderKind::Codex);
                assert_eq!(usage.model, "gpt-5-codex");
            }
            other => panic!("expected Finished, got {other:?}"),
        }
        // The wire carries the `accept` decision (Allow), and the force-approval policy.
        let written = String::from_utf8(client.into_transport().into_parts().1).unwrap();
        assert!(
            written.lines().any(|l| {
                let v: serde_json::Value = serde_json::from_str(l).unwrap();
                v.get("result").and_then(|r| r.get("decision"))
                    == Some(&serde_json::json!("accept"))
            }),
            "expected an accept decision on the wire: {written}"
        );
    }

    // ---- KAT (b): chat-only grant (empty allowed_tools) → Deny → turn aborts ----
    #[test]
    fn kat_b_chat_only_grant_denies_every_tool() {
        let _gate = GateOn::on();
        let db = Db::open_hub(&temp_path("kat-b")).unwrap();
        let policy = policy_for("agent-1");
        // Chat-only: empty allowed_tools → check_grant denies the tool dimension.
        insert_grant(&db, "agent-1", &[], Risk::High);

        let mut client = client_over(Box::leak(
            command_turn("cargo build", false).into_boxed_str(),
        ));
        let out = run(&db, &mut client, &policy, "build it").unwrap();
        match out {
            CodexTurnOutcome::Errored { reason } => {
                assert!(
                    reason.contains("tool_not_allowed") || reason.contains("trust_grant"),
                    "expected a trust-tool deny reason, got {reason}"
                );
            }
            other => panic!("expected Errored(deny), got {other:?}"),
        }
        // The wire carries the turn-interrupting `cancel` (deny), NOT accept.
        let written = String::from_utf8(client.into_transport().into_parts().1).unwrap();
        assert!(
            written.lines().any(|l| {
                let v: serde_json::Value = serde_json::from_str(l).unwrap();
                v.get("result").and_then(|r| r.get("decision"))
                    == Some(&serde_json::json!("cancel"))
            }),
            "expected a cancel (deny) decision on the wire: {written}"
        );
        // The raw command never leaks into the reason.
        if let CodexTurnOutcome::Errored { reason } = run(
            &db,
            &mut client_over(Box::leak(command_turn("rm -rf /", false).into_boxed_str())),
            &policy,
            "x",
        )
        .unwrap()
        {
            assert!(
                !reason.contains("rm -rf"),
                "reason must not leak command: {reason}"
            );
        }
    }

    // ---- KAT (c): gate RequiresApproval → Deny + pending_approval_request persisted + Paused ----
    #[test]
    fn kat_c_requires_approval_persists_pending_and_pauses() {
        let _gate = GateOn::on();
        let db = Db::open_hub(&temp_path("kat-c")).unwrap();
        let policy = policy_for("agent-1");
        // Grant admits the tool + risk, but NO approval is supplied → mutating gate
        // RequiresApproval (a mutating action never auto-allows without a bound approval).
        insert_grant(&db, "agent-1", &["run_command"], Risk::High);

        let mut client = client_over(Box::leak(
            command_turn("cargo build", false).into_boxed_str(),
        ));
        let out = run(&db, &mut client, &policy, "build it").unwrap();
        let nonce = match out {
            CodexTurnOutcome::Paused {
                action,
                approval_nonce,
            } => {
                assert_eq!(action, "run_command");
                approval_nonce
            }
            other => panic!("expected Paused, got {other:?}"),
        };
        // The pending_approval_request row was persisted under THIS run + nonce (the EXISTING
        // path — NOT a parallel mechanism).
        let count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM pending_approval_request WHERE run_id='run-1' AND approval_id=?1 AND action='run_command' AND status='pending'",
                [&nonce],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "exactly one pending row under the run+nonce");
        // The wire carries the turn-interrupting `cancel`.
        let written = String::from_utf8(client.into_transport().into_parts().1).unwrap();
        assert!(
            written.contains(r#""decision":"cancel""#),
            "expected cancel on the wire: {written}"
        );
    }

    // ---- KAT (d): destructive tool the "model" presents as benign → still Denied/gated ----
    //
    // The model labels nothing here (the typed request has no mutating flag). We prove the
    // registry-derived classification gates a destructive command even under a grant that
    // would admit a benign one: a grant with `risk_ceiling = Medium` admits `run_command`'s
    // tool name but the destructive `rm -rf` escalates to High via `shell_risk`, exceeding the
    // ceiling → the trust check Denies on risk. A model "this is harmless" label cannot lower it.
    #[test]
    fn kat_d_destructive_command_gated_by_registry_not_model_label() {
        let _gate = GateOn::on();
        let db = Db::open_hub(&temp_path("kat-d")).unwrap();
        let policy = policy_for("agent-1");
        // Tool allowed, but ceiling is Medium — a benign Medium command would pass the trust
        // check; the destructive one escalates to High and is Denied by the risk ceiling.
        insert_grant(&db, "agent-1", &["run_command"], Risk::Medium);

        let mut client = client_over(Box::leak(
            command_turn("rm -rf /work/data", false).into_boxed_str(),
        ));
        let out = run(&db, &mut client, &policy, "clean up").unwrap();
        match out {
            CodexTurnOutcome::Errored { reason } => {
                assert!(
                    reason.contains("risk") || reason.contains("trust_grant"),
                    "expected a risk-ceiling deny, got {reason}"
                );
                assert!(
                    !reason.contains("rm -rf"),
                    "reason must not leak command: {reason}"
                );
            }
            other => panic!("expected Errored(risk deny), got {other:?}"),
        }
    }

    // ---- KAT (e): flag-OFF → unchanged (handler never consulted; mutating turn Errors closed) ----
    #[test]
    fn kat_e_flag_off_is_unchanged_failclosed() {
        // The Codex-transport gate flag is OFF here (we hold the env lock + ensure it is
        // unset so a parallel GateOn KAT cannot race it), so a mid-turn approval request fails
        // closed INSIDE run_turn_with_handler with the historical
        // `interactive-approval-unsupported` — our handler is never consulted, no gate runs,
        // no pending row is written.
        let _lock = GATE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(FRIDAY_CODEX_MUTATING_GATE);
        let db = Db::open_hub(&temp_path("kat-e")).unwrap();
        let policy = policy_for("agent-1");
        insert_grant(&db, "agent-1", &["run_command"], Risk::High);

        let mut client = client_over(Box::leak(
            command_turn("cargo build", false).into_boxed_str(),
        ));
        let out = run(&db, &mut client, &policy, "build it").unwrap();
        match out {
            CodexTurnOutcome::Errored { reason } => {
                assert_eq!(reason, "codex_protocol:interactive-approval-unsupported");
            }
            other => panic!("flag-OFF mutating turn must Error closed, got {other:?}"),
        }
        // No pending row written under flag-OFF (the gate never ran).
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM pending_approval_request", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "flag-OFF must not persist a pending row");
    }

    // ---- flag-OFF text-only turn still Finishes (byte-identical to today's run_turn) ----
    #[test]
    fn flag_off_text_only_turn_finishes() {
        let _lock = GATE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var(FRIDAY_CODEX_MUTATING_GATE);
        let db = Db::open_hub(&temp_path("flag-off-text")).unwrap();
        let policy = policy_for("agent-1");
        let mut client = client_over(Box::leak(text_turn("hello").into_boxed_str()));
        let out = run(&db, &mut client, &policy, "say hi").unwrap();
        match out {
            CodexTurnOutcome::Finished { answer, .. } => assert_eq!(answer, "hello"),
            other => panic!("text-only turn must Finish, got {other:?}"),
        }
    }

    // ---- unmappable request (no command string) fails closed ----
    #[test]
    fn unmappable_command_execution_fails_closed() {
        // A commandExecution with NO command → unmappable. We must drive this gate-ON path
        // WITHOUT std::env (parallel-safe) — translate is a pure fn, so assert it directly.
        let req = CodexServerRequest::CommandExecution {
            thread_id: "t".to_string(),
            turn_id: "tn".to_string(),
            item_id: "i".to_string(),
            approval_id: None,
            command: None,
            cwd: Some("/work".to_string()),
        };
        assert!(translate_to_raw_tool_call(&req).is_none());

        // A populated command maps to the trusted `run_command` (never a model label).
        let req = CodexServerRequest::CommandExecution {
            thread_id: "t".to_string(),
            turn_id: "tn".to_string(),
            item_id: "i".to_string(),
            approval_id: None,
            command: Some("ls".to_string()),
            cwd: None,
        };
        let raw = translate_to_raw_tool_call(&req).unwrap();
        assert_eq!(raw.action, "run_command");
        assert_eq!(raw.params, vec![("command".to_string(), "ls".to_string())]);
    }

    // ---- fileChange / applyPatch translate to the mutating write_file verb ----
    #[test]
    fn file_change_and_apply_patch_translate_to_write_file() {
        let fc = CodexServerRequest::FileChange {
            thread_id: "t".to_string(),
            turn_id: "tn".to_string(),
            item_id: "i".to_string(),
            grant_root: Some("/work".to_string()),
        };
        let raw = translate_to_raw_tool_call(&fc).unwrap();
        assert_eq!(raw.action, "write_file");
        assert_eq!(raw.params, vec![("path".to_string(), "/work".to_string())]);

        let ap = CodexServerRequest::ApplyPatch {
            conversation_id: "c".to_string(),
            call_id: "call".to_string(),
            grant_root: None,
            changed_paths: vec!["/work/a.rs".to_string(), "/work/b.rs".to_string()],
        };
        let raw = translate_to_raw_tool_call(&ap).unwrap();
        assert_eq!(raw.action, "write_file");
        assert_eq!(
            raw.params,
            vec![("path".to_string(), "/work/a.rs".to_string())]
        );
    }

    // ---- no action-context on the policy → fail closed (trust_no_active_grant) ----
    #[test]
    fn no_action_context_fails_closed() {
        let _gate = GateOn::on();
        let db = Db::open_hub(&temp_path("no-ctx")).unwrap();
        // A policy with a principal but NO action context: the gate has no agent identity.
        let policy = RunPolicy::new(Some("agent-1".to_string()), Vec::<String>::new(), false);
        insert_grant(&db, "agent-1", &["run_command"], Risk::High);

        let mut client = client_over(Box::leak(
            command_turn("cargo build", false).into_boxed_str(),
        ));
        let out = run(&db, &mut client, &policy, "build it").unwrap();
        match out {
            CodexTurnOutcome::Errored { reason } => {
                assert!(reason.contains("trust_no_active_grant"), "got {reason}");
            }
            other => panic!("expected fail-closed Errored, got {other:?}"),
        }
    }

    // ---- the actor kind stays Agent (cannot self-approve) ----
    #[test]
    fn translated_request_actor_is_agent() {
        let req = CodexServerRequest::CommandExecution {
            thread_id: "t".to_string(),
            turn_id: "tn".to_string(),
            item_id: "i".to_string(),
            approval_id: None,
            command: Some("ls".to_string()),
            cwd: None,
        };
        let raw = translate_to_raw_tool_call(&req).unwrap();
        let request = build_request_with_policy(&raw, &policy_for("agent-1")).unwrap();
        assert_eq!(request.actor.kind, ActorKind::Agent);
        assert!(request.mutating(), "run_command is registry-mutating");
    }
}
