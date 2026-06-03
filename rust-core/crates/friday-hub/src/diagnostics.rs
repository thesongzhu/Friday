//! Step-3 — observability / diagnostics (small/medium **truth-labeled** version).
//!
//! NOT a metrics-collection pipeline (that XL subsystem stays NO-GO). This composes the
//! ALREADY-WIRED substrate (the `token_ledger`, the hash-chained `audit_ledger`, `agent_run`,
//! `activity_item`) into a single **truth-labeled** [`DiagnosticsSnapshot`], honoring the
//! contract's anti-dishonest-PASS requirements for `observability_metrics_diagnostics`:
//!
//! - **No fake-zero / no fabricated rows** (reuse #483 reverse-integrity / #485 invariants): a
//!   real-zero (e.g. 0 model calls on an empty ledger) is reported as a *genuine* 0 — it is
//!   NOT an unbuilt-subsystem placeholder. The two are kept DISTINCT: real substrate counts
//!   vs the truth-labeled [`DiagnosticsSnapshot::unavailable`] list (unbuilt subsystems carry
//!   their exact blocker, never a fabricated `0` that would falsely read as "0 problems").
//! - **Same-version (build) evidence (anti-stale):** every snapshot is stamped with
//!   [`current_build_id`] (the crate version); a reader compares it to the running build, so a
//!   stale snapshot from a different build is detectable ([`DiagnosticsSnapshot::is_current`]).
//! - **Audit chain is the integrity substrate; an anomaly is never silently suppressed:** the
//!   snapshot SURFACES `verify_audit_chain`'s result as [`ChainStatus::Verified`] or
//!   [`ChainStatus::Broken`] — a broken chain is reported, not hidden.
//!
//! Read-only: this collects, it does not mutate. (A side-effecting diagnostic probe would go
//! through the mutating-action gate; none is included here.)

use friday_storage::{audit, Db, StorageError};

/// The hash-chained audit ledger's integrity, surfaced (never hidden).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChainStatus {
    /// `verify_audit_chain` succeeded; `entries` rows verified from genesis.
    Verified { entries: usize },
    /// `verify_audit_chain` failed — the anomaly is surfaced with its reason, NOT suppressed.
    Broken { reason: String },
}

impl ChainStatus {
    pub fn is_verified(&self) -> bool {
        matches!(self, ChainStatus::Verified { .. })
    }
}

/// A subsystem whose metric is genuinely UNAVAILABLE (unbuilt) — truth-labeled with its exact
/// blocker. Reported instead of a fabricated `0` (a `0` would falsely read as "healthy / no
/// activity"). This is the anti-dishonest-PASS distinction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnavailableMetric {
    pub metric: &'static str,
    pub blocker: &'static str,
}

/// A read-only, truth-labeled diagnostics snapshot composed from the wired substrate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiagnosticsSnapshot {
    /// Build/version marker (same-version (build) evidence — anti-stale; `CARGO_PKG_VERSION`,
    /// version-granular not commit-granular). [`current_build_id`] at collect time.
    pub build_id: String,
    /// REAL count of `token_ledger` rows (billable model calls). `0` = genuinely none — not a
    /// fabricated placeholder.
    pub model_calls: i64,
    /// REAL `SUM(total_tokens)` over `token_ledger` (`0` on an empty ledger — truthful).
    pub total_tokens: i64,
    /// REAL `agent_run` count.
    pub agent_runs: i64,
    /// REAL `activity_item` count.
    pub activity_items: i64,
    /// The audit chain's integrity, surfaced.
    pub audit_chain: ChainStatus,
    /// Truth-labeled UNBUILT subsystem metrics (never reported as a fabricated `0`).
    pub unavailable: Vec<UnavailableMetric>,
}

/// The current build/version marker (compile-time crate version). A snapshot's `build_id` is
/// compared to this so a stale snapshot (from a different build) is detectable.
pub fn current_build_id() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The unbuilt subsystems whose metrics are truth-labeled `Unavailable` (never fabricated `0`),
/// matching the contract's NO-GO families. A reader sees "no workflow engine" — not "0".
const UNAVAILABLE_METRICS: &[UnavailableMetric] = &[
    UnavailableMetric {
        metric: "workflow_runtime_metrics",
        blocker: "no workflow execution engine (only run/step persistence + completion gate)",
    },
    UnavailableMetric {
        metric: "channel_throughput_metrics",
        blocker: "no channels/connectors/trusted-inbound subsystem",
    },
    UnavailableMetric {
        metric: "skill_execution_metrics",
        blocker: "no skills/plugin promotion+execution subsystem",
    },
    UnavailableMetric {
        metric: "self_heal_metrics",
        blocker: "no self-heal/repair subsystem",
    },
    UnavailableMetric {
        metric: "memory_cognition_metrics",
        blocker: "no recall/ranking/PII-decay cognition pipeline",
    },
];

impl DiagnosticsSnapshot {
    /// Collect a truth-labeled snapshot from `db`. Reads REAL substrate counts (no fake-zero,
    /// no fabricated rows), surfaces the audit-chain integrity, stamps the build id, and lists
    /// the unbuilt subsystems truth-labeled (never as `0`). Read-only.
    pub fn collect(db: &Db) -> Result<Self, StorageError> {
        let model_calls = db.count("token_ledger")?;
        // COALESCE so an empty ledger is a genuine 0, not NULL — a real-zero, not fabricated.
        let total_tokens: i64 = db.conn().query_row(
            "SELECT COALESCE(SUM(total_tokens), 0) FROM token_ledger",
            [],
            |r| r.get(0),
        )?;
        let agent_runs = db.count("agent_run")?;
        let activity_items = db.count("activity_item")?;
        // Surface the chain integrity — a Broken chain is reported, never silently suppressed.
        let audit_chain = match audit::verify_audit_chain(db.conn()) {
            Ok(entries) => ChainStatus::Verified { entries },
            Err(e) => ChainStatus::Broken {
                reason: e.to_string(),
            },
        };
        Ok(Self {
            build_id: current_build_id().to_string(),
            model_calls,
            total_tokens,
            agent_runs,
            activity_items,
            audit_chain,
            unavailable: UNAVAILABLE_METRICS.to_vec(),
        })
    }

    /// Healthy iff the audit chain verified. A Broken chain → not healthy (anomaly surfaced).
    pub fn is_healthy(&self) -> bool {
        self.audit_chain.is_verified()
    }

    /// True iff this snapshot was collected under the currently-running build (anti-stale):
    /// a snapshot whose `build_id` differs from `current_build_id()` is from a stale build and
    /// its numbers must not be trusted as current.
    pub fn is_current(&self) -> bool {
        self.build_id == current_build_id()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record_friday_ask;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Canned DeepSeek transport: GET /models → one model; POST /chat → a completion with
    /// usage. Used to seed ONE real billable model call (token_ledger + activity + audit)
    /// through the real `record_friday_ask` path (vs hand-building the storage types).
    struct MockTransport;
    impl friday_deepseek::Transport for MockTransport {
        fn get_json(
            &self,
            _url: &str,
            _bearer: &str,
        ) -> Result<Value, friday_deepseek::DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, friday_deepseek::DeepSeekError> {
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-hub-diag-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn empty_db_is_real_zero_not_fabricated_and_chain_verifies() {
        let db = Db::open_hub(&tmp("empty")).unwrap();
        let snap = DiagnosticsSnapshot::collect(&db).unwrap();
        // REAL zero (no calls yet) — a genuine 0, not a placeholder.
        assert_eq!(snap.model_calls, 0);
        assert_eq!(snap.total_tokens, 0);
        // empty chain verifies (genesis) — anomaly surface reports Verified, not hidden.
        assert_eq!(snap.audit_chain, ChainStatus::Verified { entries: 0 });
        assert!(snap.is_healthy());
        // anti-stale: stamped with the current build.
        assert_eq!(snap.build_id, current_build_id());
        assert!(snap.is_current());
        // anti-dishonest-PASS: unbuilt subsystems are truth-labeled Unavailable with a blocker,
        // NOT reported as a fabricated 0 alongside the real 0s.
        assert!(!snap.unavailable.is_empty());
        assert!(snap
            .unavailable
            .iter()
            .all(|u| !u.blocker.trim().is_empty()));
        assert!(snap
            .unavailable
            .iter()
            .any(|u| u.metric == "workflow_runtime_metrics"));
    }

    #[test]
    fn real_model_call_reflects_in_metrics_no_fabrication() {
        let mut db = Db::open_hub(&tmp("real")).unwrap();
        // one REAL billable model call via the real record_friday_ask path (atomic
        // token_ledger + activity + hash-chained audit) — usage total = 15.
        let client = friday_deepseek::DeepSeekClient::with_transport(MockTransport, "k".into());
        let out = record_friday_ask(&mut db, &client, "l1", "s1", "a1", "hi", 128, 1000).unwrap();
        assert_eq!(out.total_tokens, 15);

        let snap = DiagnosticsSnapshot::collect(&db).unwrap();
        assert_eq!(snap.model_calls, 1, "real ledger row counted");
        assert_eq!(snap.total_tokens, 15, "real token total (not fabricated)");
        assert_eq!(snap.agent_runs, 0);
        assert_eq!(snap.activity_items, 1);
        // the chain now has the one model-call audit entry and still verifies.
        assert_eq!(snap.audit_chain, ChainStatus::Verified { entries: 1 });
        assert!(snap.is_healthy());
    }

    #[test]
    fn stale_build_snapshot_is_detectable() {
        let db = Db::open_hub(&tmp("stale")).unwrap();
        let mut snap = DiagnosticsSnapshot::collect(&db).unwrap();
        assert!(snap.is_current());
        // a snapshot from a different build is NOT current — its numbers must not be trusted.
        snap.build_id = "0.0.0-stale".to_string();
        assert!(!snap.is_current());
    }

    #[test]
    fn tampered_audit_chain_surfaces_broken_via_collect_not_healthy() {
        // Real-path adverse test: seed a model call (one audit row), TAMPER the row's hashed
        // `action` column, then collect() — verify_audit_chain detects the hash mismatch, the
        // collector maps Err→Broken, and is_healthy()=false. The anomaly is surfaced through
        // the real collect path, NOT silently suppressed.
        let mut db = Db::open_hub(&tmp("tamper")).unwrap();
        let client = friday_deepseek::DeepSeekClient::with_transport(MockTransport, "k".into());
        record_friday_ask(&mut db, &client, "l1", "s1", "a1", "hi", 128, 1000).unwrap();
        // sanity: the chain is intact before tamper.
        assert!(DiagnosticsSnapshot::collect(&db).unwrap().is_healthy());
        // Tamper a HASHED field (`action`) of the audit row → recomputed entry_hash mismatches.
        let n = db
            .conn()
            .execute("UPDATE audit_ledger SET action = 'TAMPERED'", [])
            .unwrap();
        assert_eq!(n, 1, "tampered the one audit row");

        let snap = DiagnosticsSnapshot::collect(&db).unwrap();
        assert!(
            matches!(snap.audit_chain, ChainStatus::Broken { .. }),
            "tampered chain must surface Broken, got {:?}",
            snap.audit_chain
        );
        assert!(!snap.is_healthy(), "a broken chain is not healthy");
        // real substrate counts are still read truthfully alongside the surfaced anomaly
        assert_eq!(snap.model_calls, 1);
    }
}
