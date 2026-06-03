//! UNW-004 — Hub composition root.
//!
//! Wires the BUILT service graph into ONE composed entry point so the agent loop is
//! callable from a single bootstrap:
//!
//! ```text
//! Db (friday-storage) + RouteRegistry (UNW-003) + live DeepSeek agent client
//!   + FsToolExecutor (friday-fs, gate-mandatory) + Hub secret + ApprovalPolicy
//!   => HubRuntime::run_task(run_id, task)
//!        -> select_route (UNW-003 no-fallback)
//!        -> run_routed_loop -> run_loop (gate-mandatory multi-turn dispatch, #481/#482)
//! ```
//!
//! ## Honest scope (v1 = NO-GO)
//! Only **deepseek-flash** has a live client in this build. The route registry marks
//! `deepseek-pro`/`codex`/`claude` **unavailable**, so a Large or other-provider request
//! honestly resolves to `NoEligibleRoute` — it NEVER silently runs flash-for-pro and never
//! reroutes (the UNW-003 no-fallback contract). Live multi-provider routing stays
//! operator-gated on Codex/Claude login.
//!
//! The owner-approval seam defaults to [`DenyAllApprovals`] (safe): a mutating action
//! **Pauses** (resumable) until the phone-relayed owner-approval leg exists. This withholds
//! the approval *grant* only — the mutating-action gate is ALWAYS evaluated (deny-all does
//! not, and cannot, disable the UNW-001 gate). The gate-approval signing `secret` is
//! Hub-held (production: `friday-crypto::SecureStore`); it is dormant under deny-all.

use std::path::PathBuf;

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_deepseek::{DeepSeekClient, DeepSeekError, Transport, UreqTransport};
use friday_storage::{agent_run, Db, StorageError};

use crate::routing::{
    run_routed_loop, ProviderClientResolver, ProviderRoute, RouteRegistry, RouteRequest,
    RoutedLoopError, RoutedSelection,
};
use crate::{AgentLlmClient, DeepSeekAgentLlmClient, FsToolExecutor, LoopOutcome};

/// The owner-approval seam: given a mutating request, return a signed [`CanonicalApproval`]
/// iff the owner approved THIS exact action. Production default is [`DenyAllApprovals`]
/// until the phone-relayed owner-approval leg is wired (operator-gated).
pub trait ApprovalPolicy {
    fn approve(&self, request: &MutatingActionRequest) -> Option<CanonicalApproval>;
}

/// Safe default: never grants an approval, so every mutating action `Pauses` (resumable).
/// This only WITHHOLDS the grant — the mutating-action gate is still evaluated on every
/// dispatch; deny-all does not disable it.
#[derive(Debug, Default)]
pub struct DenyAllApprovals;

impl ApprovalPolicy for DenyAllApprovals {
    fn approve(&self, _request: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }
}

/// Composition-root configuration.
pub struct HubConfig {
    pub db_path: String,
    pub workspace_root: PathBuf,
    /// Gate-approval signing secret (Hub-held). Dormant under [`DenyAllApprovals`] (no
    /// approval to verify); load-bearing once a granting policy is wired.
    pub secret: Vec<u8>,
    pub max_turns: u64,
    /// The Hub owner whose confirmed memory may be recalled into a task's prompt
    /// (PROOF-MEMORY-001). A Hub is single-owner in v1, so every run inherits this
    /// principal. `None` ⇒ memory recall is DISABLED (fail-closed: no owner, no recall).
    pub principal_id: Option<String>,
}

/// Why the live runtime failed to assemble.
#[derive(Debug)]
pub enum HubInitError {
    DeepSeek(DeepSeekError),
    Storage(StorageError),
}

impl std::fmt::Display for HubInitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // DeepSeekError's Debug carries no key (verified in friday-deepseek); never prints the secret.
            HubInitError::DeepSeek(e) => write!(f, "deepseek init failed: {e:?}"),
            HubInitError::Storage(e) => write!(f, "storage init failed: {e}"),
        }
    }
}
impl std::error::Error for HubInitError {}

/// The assembled Hub runtime: a single composed entry (`run_task`) over the built graph.
/// Generic over the DeepSeek transport so tests inject a scripted mock; the live build is
/// [`HubRuntime<UreqTransport>`] via [`HubRuntime::live`].
pub struct HubRuntime<T: Transport> {
    db: Db,
    routes: RouteRegistry,
    deepseek: DeepSeekAgentLlmClient<T>,
    executor: FsToolExecutor,
    secret: Vec<u8>,
    approval: Box<dyn ApprovalPolicy>,
    max_turns: u64,
    /// Hub owner for memory recall; `None` disables recall (see [`HubConfig::principal_id`]).
    principal_id: Option<String>,
}

impl<T: Transport> HubRuntime<T> {
    /// Assemble the runtime from a (possibly mock-transport) DeepSeek client + config +
    /// approval policy. Opens the Hub DB, builds the workspace-root-contained
    /// `FsToolExecutor`, and the dispatchable route registry.
    pub fn new(
        config: HubConfig,
        deepseek: DeepSeekAgentLlmClient<T>,
        approval: Box<dyn ApprovalPolicy>,
    ) -> Result<Self, StorageError> {
        let db = Db::open_hub(&config.db_path)?;
        let executor = FsToolExecutor::new(config.workspace_root);
        let routes = Self::dispatchable_routes();
        Ok(Self {
            db,
            routes,
            deepseek,
            executor,
            secret: config.secret,
            approval,
            max_turns: config.max_turns,
            principal_id: config.principal_id,
        })
    }

    /// The route registry reflecting THIS build's ACTUAL dispatch capability: only the live
    /// `deepseek` (flash) route is available; `deepseek-pro`/`codex`/`claude` are marked
    /// unavailable so a Large/other request honestly `NoEligibleRoute`s. The single live
    /// client always `select_model`→flash, so marking pro unavailable prevents silently
    /// running flash for a pro request (no hidden downgrade).
    fn dispatchable_routes() -> RouteRegistry {
        let mut r = RouteRegistry::autonomous_baseline();
        if let Some(pro) = r.get("deepseek-pro").cloned() {
            r.register(ProviderRoute {
                available: false,
                validation_ok: false,
                ..pro
            });
        }
        r
    }

    /// Drive ONE task end-to-end through the composed graph: create the run row, select the
    /// provider route (UNW-003), then run the gate-mandatory multi-turn loop (#481/#482).
    /// `run_id` must be unique per task. Returns the routing selection (evidence) + outcome.
    pub fn run_task(
        &self,
        run_id: &str,
        task: &str,
        now_ms: i64,
    ) -> Result<(RoutedSelection, LoopOutcome), RoutedLoopError> {
        agent_run::create_run(self.db.conn(), run_id, task, now_ms)?;
        // PROOF-MEMORY-001: recall this owner's confirmed memory, gate it through the
        // Context Passport, and inject it as a prompt PREAMBLE (the run's `task` stays
        // clean — the preamble is added only to what the model sees). `None` principal ⇒
        // no recall. Records a hash-chained `memory.recalled` audit receipt.
        let recall_preamble = self.recall_preamble(run_id, now_ms)?;
        // v1: a constraint-free request (selects the highest-priority dispatchable route =
        // deepseek-flash, the only live one). Deriving required capabilities / model-size
        // from the task is a later refinement; with one live provider it cannot mask a wrong
        // selection here.
        let request = RouteRequest::any();
        let approve = |req: &MutatingActionRequest| self.approval.approve(req);
        run_routed_loop(
            &self.routes,
            &request,
            self,
            &self.executor,
            self.db.conn(),
            run_id,
            task,
            &recall_preamble,
            &self.secret,
            &approve,
            self.max_turns,
            now_ms,
        )
    }

    /// Build the memory-recall prompt preamble for this run and record its receipt.
    ///
    /// Pipeline: [`recall_confirmed`] (same-principal + Confirmed + content-bearing, SQL
    /// layer) → [`cognition::rank_recall`] (recency-decay + top-k + PII redaction) →
    /// [`cognition::gate_and_render_recall`] (the per-item Context Passport gate — a
    /// `sensitive` memory drops itself under v1 deny-all). When anything was recalled, a
    /// hash-chained `memory.recalled` audit event records the `recalled/injected/gated`
    /// counts and the injected `memory_id`s (the recall→answer receipt; the
    /// answer-carries-marker proof is the separate live e2e). `None` principal ⇒ empty
    /// preamble, no recall.
    ///
    /// SCOPE: this records the audit RECEIPT; it does NOT ledger tokens — `run_loop` does
    /// not write `token_ledger` rows (loop-level token ledgering is a separate gap), so no
    /// token-accounting claim is made here.
    fn recall_preamble(&self, run_id: &str, now_ms: i64) -> Result<String, RoutedLoopError> {
        // Delegates to the SHARED recall composition so the loop and the `friday_ask`
        // surface apply the identical per-item Passport gate (no divergence). The recall
        // principal and the gate Actor's principal (still `None` in the loop) are the SAME
        // v1 owner conceptually — flagged so they don't silently diverge when per-run
        // principal binding lands.
        let preamble = crate::recall_preamble_for(
            &self.db,
            self.principal_id.as_deref(),
            &format!("{run_id}:memory-recall"),
            now_ms,
        )?;
        Ok(preamble)
    }

    /// Read access to the composed DB (for evidence/inspection: agent_run events, audit chain).
    pub fn db(&self) -> &Db {
        &self.db
    }
}

impl HubRuntime<UreqTransport> {
    /// Assemble the LIVE runtime: the real DeepSeek client from the env key
    /// (`DeepSeekClient::from_env`, never logs the key) + deny-all approval (safe default).
    /// This is the bootstrap the live e2e proof drives.
    pub fn live(config: HubConfig) -> Result<Self, HubInitError> {
        let client = DeepSeekClient::from_env().map_err(HubInitError::DeepSeek)?;
        let agent = DeepSeekAgentLlmClient::new(client);
        Self::new(config, agent, Box::new(DenyAllApprovals)).map_err(HubInitError::Storage)
    }
}

impl<T: Transport> ProviderClientResolver for HubRuntime<T> {
    /// Only the live `deepseek` provider has a wired client in this build. Any other route
    /// returns `None` → fail-closed `NoClientForProvider` (a defensive backstop; the route
    /// registry already prevents selecting unavailable providers, so this never fires on
    /// the happy path). Routing decides WHO answers; classification stays the trusted
    /// chokepoint regardless — this resolver confers no classification authority.
    fn resolve(&self, route: &ProviderRoute) -> Option<&dyn AgentLlmClient> {
        if route.provider_id == "deepseek" {
            Some(&self.deepseek)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routing::RouteError;
    use crate::{mint_approval, LoopStatus};
    use friday_deepseek::DeepSeekError;
    use serde_json::Value;
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-hub-runtime-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "friday-hub-rt-ws-{}-{}-{}",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Scripted DeepSeek transport: GET /models → one flash model; POST /chat → the next
    /// scripted assistant `content` (a tool-call JSON the strict parser reads). Counts POST
    /// calls so the no-hidden-call invariant is checkable.
    struct ScriptTransport {
        contents: Vec<String>,
        // Shared so a test can assert the real chat/POST count == loop turns (no hidden call).
        post_calls: Rc<Cell<usize>>,
    }
    impl ScriptTransport {
        fn new(contents: &[&str]) -> Self {
            Self {
                contents: contents.iter().map(|s| s.to_string()).collect(),
                post_calls: Rc::new(Cell::new(0)),
            }
        }
    }
    impl Transport for ScriptTransport {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            let n = self.post_calls.get();
            self.post_calls.set(n + 1);
            let content = self
                .contents
                .get(n)
                .cloned()
                .unwrap_or_else(|| "{\"tool\":\"none\"}".to_string());
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }

    /// Test policy that mints a valid approval for the request (stands in for the owner).
    struct MintPolicy {
        secret: Vec<u8>,
        id: String,
        expires_at: i64,
    }
    impl ApprovalPolicy for MintPolicy {
        fn approve(&self, request: &MutatingActionRequest) -> Option<CanonicalApproval> {
            Some(mint_approval(
                request,
                &self.id,
                &self.secret,
                self.expires_at,
            ))
        }
    }

    const SECRET: &[u8] = b"hub-runtime-gate-secret-0123456789";

    fn runtime_with(
        tag: &str,
        contents: &[&str],
        approval: Box<dyn ApprovalPolicy>,
    ) -> (HubRuntime<ScriptTransport>, TempDir, Rc<Cell<usize>>) {
        let ws = TempDir::new(tag);
        let transport = ScriptTransport::new(contents);
        let post_calls = transport.post_calls.clone(); // shared chat/POST counter for no-hidden-call proof
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
                principal_id: None, // recall disabled by default; the recall test sets it
            },
            agent,
            approval,
        )
        .unwrap();
        (rt, ws, post_calls) // TempDir guard keeps the workspace alive; counter for the no-hidden test
    }

    // ---- PROOF-MEMORY-001 recall→inject wiring -------------------------------

    /// A transport that CAPTURES every outgoing chat body (so a test can assert what
    /// the model actually receives), and finishes the loop in one turn.
    struct CaptureTransport {
        bodies: Rc<std::cell::RefCell<Vec<Value>>>,
    }
    impl Transport for CaptureTransport {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            body: &Value,
        ) -> Result<Value, DeepSeekError> {
            self.bodies.borrow_mut().push(body.clone());
            // Finish immediately so the loop runs exactly one turn.
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":"{\"tool\":\"none\"}"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }

    fn recall_runtime(
        tag: &str,
        principal: Option<&str>,
    ) -> (
        HubRuntime<CaptureTransport>,
        TempDir,
        Rc<std::cell::RefCell<Vec<Value>>>,
    ) {
        let ws = TempDir::new(tag);
        let bodies = Rc::new(std::cell::RefCell::new(Vec::new()));
        let transport = CaptureTransport {
            bodies: bodies.clone(),
        };
        let client = DeepSeekClient::with_transport(transport, "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 4,
                principal_id: principal.map(|p| p.to_string()),
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws, bodies)
    }

    fn seed_confirmed(
        rt: &HubRuntime<CaptureTransport>,
        id: &str,
        content: &str,
        principal: &str,
        sensitive: bool,
    ) {
        let conn = rt.db().conn();
        friday_storage::memory::record_candidate(
            conn,
            &friday_storage::memory::NewMemoryCandidate {
                memory_id: id,
                scope: friday_core::MemoryScope::Global,
                content_ref: None,
                content: Some(content),
                principal_id: Some(principal),
                sensitive,
                created_at: 1,
            },
        )
        .unwrap();
        friday_storage::memory::confirm(conn, id, 2).unwrap();
    }

    fn body_contains(bodies: &Rc<std::cell::RefCell<Vec<Value>>>, needle: &str) -> bool {
        bodies
            .borrow()
            .iter()
            .any(|b| b.to_string().contains(needle))
    }

    fn recall_audit_count(rt: &HubRuntime<CaptureTransport>) -> i64 {
        rt.db()
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'memory.recalled%'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn recall_injects_owner_confirmed_memory_into_the_prompt_and_records_receipt() {
        // POSITIVE recall — the test that makes the negatives below non-vacuous.
        let (rt, _ws, bodies) = recall_runtime("recall-pos", Some("alice"));
        seed_confirmed(&rt, "m1", "MEMMARKER-alice-prefers-rust", "alice", false);
        rt.run_task("r-pos", "help me", 100).unwrap();
        assert!(
            body_contains(&bodies, "MEMMARKER-alice-prefers-rust"),
            "alice's confirmed memory must be injected into the outgoing prompt"
        );
        // a hash-chained memory.recalled receipt was written.
        assert_eq!(recall_audit_count(&rt), 1);
        // SCOPE: this proves recall→PROMPT INJECTION, not that the model's ANSWER carries
        // the marker (that is the separate live e2e — PROOF-MEMORY-001 stays proof_pending).
    }

    #[test]
    fn recall_is_cross_principal_isolated_in_the_prompt() {
        // bob's runtime, alice's memory → bob's prompt must NEVER carry it.
        let (rt, _ws, bodies) = recall_runtime("recall-xp", Some("bob"));
        seed_confirmed(&rt, "m1", "MEMMARKER-alice-secret-plan", "alice", false);
        rt.run_task("r-xp", "help me", 100).unwrap();
        assert!(
            !body_contains(&bodies, "MEMMARKER-alice-secret-plan"),
            "cross-principal recall leak: alice's memory reached bob's prompt"
        );
        // nothing was recalled for bob → no receipt.
        assert_eq!(recall_audit_count(&rt), 0);
    }

    #[test]
    fn recall_no_principal_injects_nothing() {
        let (rt, _ws, bodies) = recall_runtime("recall-none", None);
        seed_confirmed(&rt, "m1", "MEMMARKER-unowned", "alice", false);
        rt.run_task("r-none", "help me", 100).unwrap();
        assert!(!body_contains(&bodies, "MEMMARKER-unowned"));
        assert_eq!(recall_audit_count(&rt), 0);
    }

    #[test]
    fn recall_sensitive_memory_is_gated_out_under_deny_all() {
        let (rt, _ws, bodies) = recall_runtime("recall-sens", Some("alice"));
        seed_confirmed(&rt, "ok", "MEMMARKER-ok-nonsensitive", "alice", false);
        seed_confirmed(&rt, "sens", "MEMMARKER-sensitive-pii", "alice", true);
        rt.run_task("r-sens", "help me", 100).unwrap();
        // the non-sensitive memory injects; the sensitive one is gated out (deny-all).
        assert!(body_contains(&bodies, "MEMMARKER-ok-nonsensitive"));
        assert!(
            !body_contains(&bodies, "MEMMARKER-sensitive-pii"),
            "a sensitive memory must NOT be injected under deny-all"
        );
        // receipt recorded recalled=2 injected=1 gated_sensitive=1.
        let action: String = rt
            .db()
            .conn()
            .query_row(
                "SELECT action FROM audit_ledger WHERE action LIKE 'memory.recalled%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(action.contains("recalled=2") && action.contains("injected=1"));
        assert!(action.contains("gated_sensitive=1"));
    }

    // ---- routing honesty (dispatchable_routes) ------------------------------

    #[test]
    fn dispatchable_routes_only_flash_live_pro_and_others_honestly_unavailable() {
        let r = HubRuntime::<ScriptTransport>::dispatchable_routes();
        // open request → deepseek flash (the only live route)
        assert_eq!(
            crate::routing::select_route(&r, &RouteRequest::any())
                .unwrap()
                .provider_id,
            "deepseek"
        );
        // a Large request → deepseek-pro is unavailable → NoEligibleRoute (never silent flash-for-pro)
        let large = RouteRequest {
            model_size: Some(crate::routing::ModelSize::Large),
            ..RouteRequest::any()
        };
        assert!(matches!(
            crate::routing::select_route(&r, &large).unwrap_err(),
            RouteError::NoEligibleRoute { .. }
        ));
        // pinning codex (auth-gated) → RequestedProviderUnavailable (no reroute)
        let codex = RouteRequest {
            preferred_provider: Some("codex".to_string()),
            ..RouteRequest::any()
        };
        assert!(matches!(
            crate::routing::select_route(&r, &codex).unwrap_err(),
            RouteError::RequestedProviderUnavailable(_)
        ));
    }

    #[test]
    fn resolver_resolves_only_deepseek() {
        let (rt, _root, _post) = runtime_with(
            "resolve",
            &["{\"tool\":\"none\"}"],
            Box::new(DenyAllApprovals),
        );
        let r = HubRuntime::<ScriptTransport>::dispatchable_routes();
        let ds = r.get("deepseek").unwrap();
        assert!(rt.resolve(ds).is_some());
        let codex = r.get("codex").unwrap();
        assert!(rt.resolve(codex).is_none());
    }

    // ---- composed end-to-end through run_task -------------------------------

    #[test]
    fn composed_read_only_task_executes_via_gate_and_audit() {
        // turn 0: read_file (read-only → Allow → real fs read) ; turn 1: finish
        let (rt, root, _post) = runtime_with(
            "ro",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"notes.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            Box::new(DenyAllApprovals),
        );
        std::fs::write(root.join("notes.md"), b"composed e2e note").unwrap();
        let (sel, out) = rt.run_task("run-ro", "read the notes", 1000).unwrap();
        assert_eq!(sel.provider_id, "deepseek");
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.executed_tools, 1);
        // hash-chained audit receipt exists + verifies through the composed entry
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// ADVERSE no-bypass: a mutating tool proposed through the composed entry is DENIED
    /// without an owner approval (deny-all) — it Pauses, executes nothing, writes no file.
    #[test]
    fn composed_mutating_task_denied_without_approval_no_bypass() {
        let (rt, root, _post) = runtime_with(
            "nobypass",
            &["{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"X\"}}"],
            Box::new(DenyAllApprovals),
        );
        let (_sel, out) = rt.run_task("run-mut", "write a file", 2000).unwrap();
        assert!(
            matches!(out.status, LoopStatus::Paused | LoopStatus::Blocked),
            "mutating w/o approval must Pause/Block, got {:?}",
            out.status
        );
        assert_eq!(out.executed_tools, 0, "no execution without approval");
        assert!(
            !root.join("out.txt").exists(),
            "the gate withheld the write — no file created (no bypass)"
        );
    }

    /// With a minting owner policy, the mutating write executes ONCE; a replay of the same
    /// single-use approval on the next turn is refused (Blocked) — one execution, one receipt.
    #[test]
    fn composed_mutating_with_approval_executes_then_replay_refused() {
        // Two IDENTICAL writes: identical action+params → identical digest → the SAME
        // single-use approval. Turn 0 consumes it (Allow→execute); turn 1's replay of the
        // same digest is refused. (Different content would be a DIFFERENT digest → a fresh
        // approval → not a replay at all, so the writes must be identical for this scenario.)
        let write =
            "{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"C\"}}";
        let (rt, root, _post) = runtime_with(
            "approve",
            &[write, write, "{\"tool\":\"none\"}"],
            Box::new(MintPolicy {
                secret: SECRET.to_vec(),
                id: "ap-rt".to_string(),
                expires_at: 1_000_000,
            }),
        );
        let (_sel, out) = rt.run_task("run-appr", "write twice", 1000).unwrap();
        assert_eq!(
            out.executed_tools, 1,
            "single-use approval executes once; replay refused"
        );
        assert!(matches!(out.status, LoopStatus::Blocked));
        assert_eq!(std::fs::read_to_string(root.join("out.txt")).unwrap(), "C");
        // Discriminating witness (Finding B): EXACTLY ONE execution receipt on the hash-chain
        // — the replayed second write produced none. This distinguishes single-vs-double
        // execution without changing the (necessarily-identical) replay writes.
        let receipts: i64 = rt
            .db()
            .conn()
            .query_row(
                "SELECT count(*) FROM audit_ledger WHERE action LIKE 'tool.executed%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            receipts, 1,
            "one execution receipt; the replay produced none"
        );
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// ADVERSE no-hidden-call: the model client is called EXACTLY once per loop turn (the
    /// transport's POST count == turns), and the executor is reached only on a gate-Allow.
    #[test]
    fn composed_no_hidden_model_call_one_post_per_turn() {
        // read_file (Allow+exec) → finish = 2 turns, 2 chat POSTs, 1 execution.
        let (rt, root, post) = runtime_with(
            "nohidden",
            &[
                "{\"tool\":\"read_file\",\"parameters\":{\"path\":\"n.md\"}}",
                "{\"tool\":\"none\"}",
            ],
            Box::new(DenyAllApprovals),
        );
        std::fs::write(root.join("n.md"), b"x").unwrap();
        let (_sel, out) = rt.run_task("run-nh", "read n.md", 1000).unwrap();
        assert_eq!(out.status, LoopStatus::Finished);
        assert_eq!(out.turns, 2, "exactly 2 model turns");
        assert_eq!(out.executed_tools, 1);
        // THE no-hidden-call proof (transport-level, not just the loop's self-count): the
        // shared chat/POST counter equals the loop's turn count — exactly one model call per
        // turn, none hidden inside next_step or outside the loop body.
        assert_eq!(
            post.get(),
            out.turns as usize,
            "exactly one model chat/POST per loop turn — no hidden model call"
        );
    }

    /// LIVE end-to-end (runtime-proven) through the FULL composition root. Ignored in CI (no
    /// key); run manually with the Hub key. Real DeepSeek → route select → gate → real fs
    /// read → hash-chained audit receipt, all from one `HubRuntime::live().run_task()`.
    #[test]
    #[ignore = "live: requires FRIDAY_DEEPSEEK_API_KEY; run manually (see ledger)"]
    fn live_composed_run_task_e2e() {
        let ws = TempDir::new("live");
        std::fs::write(ws.0.join("notes.md"), b"Friday composed live e2e.").unwrap();
        let rt = HubRuntime::live(HubConfig {
            db_path: tmp("live"),
            workspace_root: ws.0.clone(),
            secret: SECRET.to_vec(),
            max_turns: 5,
            principal_id: None, // the live save→recall→answer-carries-marker e2e is a separate proof (PR4)
        })
        .expect("live runtime assembles (FRIDAY_DEEPSEEK_API_KEY set)");
        let (sel, out) = rt
            .run_task("run-live", "read the file notes.md and summarize it", 5000)
            .expect("composed run_task");
        eprintln!(
            "LIVE composed: provider={} status={:?} turns={} executed={}",
            sel.provider_id, out.status, out.turns, out.executed_tools
        );
        if out.executed_tools > 0 {
            assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
        }
    }
}
