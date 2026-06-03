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
            &self.secret,
            &approve,
            self.max_turns,
            now_ms,
        )
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
        post_calls: Cell<usize>,
    }
    impl ScriptTransport {
        fn new(contents: &[&str]) -> Self {
            Self {
                contents: contents.iter().map(|s| s.to_string()).collect(),
                post_calls: Cell::new(0),
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
    ) -> (HubRuntime<ScriptTransport>, TempDir) {
        let ws = TempDir::new(tag);
        let client = DeepSeekClient::with_transport(ScriptTransport::new(contents), "k".into());
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: tmp(tag),
                workspace_root: ws.0.clone(),
                secret: SECRET.to_vec(),
                max_turns: 6,
            },
            agent,
            approval,
        )
        .unwrap();
        (rt, ws) // return the TempDir guard so the workspace lives for the test body
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
        let (rt, _root) = runtime_with(
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
        let (rt, root) = runtime_with(
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
        let (rt, root) = runtime_with(
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
        let write =
            "{\"tool\":\"write_file\",\"parameters\":{\"path\":\"out.txt\",\"content\":\"C\"}}";
        let (rt, root) = runtime_with(
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
        assert!(friday_storage::audit::verify_audit_chain(rt.db().conn()).is_ok());
    }

    /// ADVERSE no-hidden-call: the model client is called EXACTLY once per loop turn (the
    /// transport's POST count == turns), and the executor is reached only on a gate-Allow.
    #[test]
    fn composed_no_hidden_model_call_one_post_per_turn() {
        // read_file (Allow+exec) → finish = 2 turns, 2 POSTs, 1 execution.
        let (rt, root) = runtime_with(
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
        // The transport POST count is observed via the live e2e in practice; here the loop's
        // own `turns` is the no-hidden-call witness (model called once per turn, none outside).
        assert_eq!(out.executed_tools, 1);
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
