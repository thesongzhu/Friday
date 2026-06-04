//! friday-ffi — phone-side FFI surface for Swift (iOS) / Kotlin (Android), via UniFFI.
//!
//! Unit 5a: this crate now exposes a first-slice UniFFI interface (gate `21` §5)
//! and generates idiomatic Swift + Kotlin bindings from one Rust definition
//! (`cargo run -p friday-ffi --bin uniffi-bindgen -- generate --library <cdylib>
//! --language swift|kotlin`). The exposed ops are pure, FFI-safe projections of
//! the slice's connection-state + protocol version-negotiation logic; the
//! model-calling `ask_friday` streaming op and the native app shells land with
//! the Unit-5 native build (operator-gated tooling).
//!
//! Trust boundary: this is the phone-side library. It links `friday-core`,
//! `friday-storage`, `friday-crypto`, `friday-protocol` and deliberately does NOT
//! depend on `friday-deepseek` or a Hub crate, so "no provider secret on phone"
//! is a compile-time property (gate `21` §1/§3), asserted by `friday-arch-tests`.

use friday_core::{ConnState, MemoryState, NeedsMeItem};

uniffi::setup_scaffolding!();

/// Connection state of the phone<->Hub link, projected for the UI (gate `21` §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ConnStateFfi {
    Disconnected,
    Connecting,
    Direct,
    Relay,
    Stale,
}

impl From<ConnState> for ConnStateFfi {
    fn from(c: ConnState) -> Self {
        match c {
            ConnState::Disconnected => ConnStateFfi::Disconnected,
            ConnState::Connecting => ConnStateFfi::Connecting,
            ConnState::Direct => ConnStateFfi::Direct,
            ConnState::Relay => ConnStateFfi::Relay,
            ConnState::Stale => ConnStateFfi::Stale,
        }
    }
}

impl ConnStateFfi {
    fn to_core(self) -> ConnState {
        match self {
            ConnStateFfi::Disconnected => ConnState::Disconnected,
            ConnStateFfi::Connecting => ConnState::Connecting,
            ConnStateFfi::Direct => ConnState::Direct,
            ConnStateFfi::Relay => ConnState::Relay,
            ConnStateFfi::Stale => ConnState::Stale,
        }
    }
}

/// Connection state a freshly launched client starts in (exposed to native UI).
#[uniffi::export]
pub fn initial_connection_state() -> ConnStateFfi {
    ConnState::Disconnected.into()
}

/// Whether a connection state is a live, usable link (no model call).
#[uniffi::export]
pub fn connection_is_online(state: ConnStateFfi) -> bool {
    state.to_core().is_online()
}

/// Whether the UI must show a stale/offline truth label (`05` §10).
#[uniffi::export]
pub fn connection_is_stale_or_offline(state: ConnStateFfi) -> bool {
    state.to_core().is_stale_or_offline()
}

/// The wire schema version this build speaks (gate `21` §4.1).
#[uniffi::export]
pub fn protocol_schema_version() -> u16 {
    friday_protocol::CURRENT_SCHEMA_VERSION
}

/// Highest schema version both sides support, or `None` if incompatible
/// (capability negotiation, gate `21` §4.4). Never silently downgrades.
#[uniffi::export]
pub fn negotiate_schema_version(
    local_min: u16,
    local_max: u16,
    remote_min: u16,
    remote_max: u16,
) -> Option<u16> {
    friday_protocol::negotiate_version(
        friday_protocol::VersionRange {
            min: local_min,
            max: local_max,
        },
        friday_protocol::VersionRange {
            min: remote_min,
            max: remote_max,
        },
    )
    .ok()
}

/// A cross-source "Needs Me" action item for the Activity inbox (`08` §1/§2),
/// projected for native UI. Carries the provider detail (reason/destination) so
/// nothing is silently dropped.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NeedsMeItemFfi {
    pub source: String,
    pub id: String,
    pub reason: String,
    /// Higher = more urgent.
    pub priority: u8,
    pub destination: String,
}

impl From<NeedsMeItem> for NeedsMeItemFfi {
    fn from(i: NeedsMeItem) -> Self {
        NeedsMeItemFfi {
            source: i.source,
            id: i.id,
            reason: i.reason,
            priority: i.priority,
            destination: i.destination,
        }
    }
}

impl From<NeedsMeItemFfi> for NeedsMeItem {
    fn from(i: NeedsMeItemFfi) -> Self {
        NeedsMeItem {
            source: i.source,
            id: i.id,
            reason: i.reason,
            priority: i.priority,
            destination: i.destination,
        }
    }
}

/// Aggregate Needs-Me items urgency-first (highest priority first, stable within
/// equal priority), via the `friday-core` logic. Exposed to native UI (`08` §1).
#[uniffi::export]
pub fn aggregate_needs_me(items: Vec<NeedsMeItemFfi>) -> Vec<NeedsMeItemFfi> {
    friday_core::aggregate_needs_me(items.into_iter().map(Into::into).collect())
        .into_iter()
        .map(Into::into)
        .collect()
}

/// A representative Needs-Me inbox, built and aggregated in Rust — a UI fixture
/// so the native shells can render the prioritized Activity list before the
/// persisted Activity store (Unit 9) is wired to the phone. NOT live data.
#[uniffi::export]
pub fn sample_activity_inbox() -> Vec<NeedsMeItemFfi> {
    aggregate_needs_me(vec![
        NeedsMeItemFfi {
            source: "claude".into(),
            id: "c1".into(),
            reason: "Question: which API key to use?".into(),
            priority: 9,
            destination: "session/claude-1".into(),
        },
        NeedsMeItemFfi {
            source: "codex".into(),
            id: "x1".into(),
            reason: "Approve: run DB migration".into(),
            priority: 7,
            destination: "session/codex-1".into(),
        },
        NeedsMeItemFfi {
            source: "workflow".into(),
            id: "w1".into(),
            reason: "Checkpoint: confirm deploy".into(),
            priority: 7,
            destination: "wf/deploy".into(),
        },
        NeedsMeItemFfi {
            source: "memory".into(),
            id: "m1".into(),
            reason: "Review: 2 new memory candidates".into(),
            priority: 3,
            destination: "memory/review".into(),
        },
    ])
}

/// Lifecycle of a long-term memory item, projected for UI (`07` §6/§7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MemoryStateFfi {
    Candidate,
    Confirmed,
    Rejected,
}

impl From<MemoryState> for MemoryStateFfi {
    fn from(s: MemoryState) -> Self {
        match s {
            MemoryState::Candidate => MemoryStateFfi::Candidate,
            MemoryState::Confirmed => MemoryStateFfi::Confirmed,
            MemoryState::Rejected => MemoryStateFfi::Rejected,
        }
    }
}

impl MemoryStateFfi {
    fn to_core(self) -> MemoryState {
        match self {
            MemoryStateFfi::Candidate => MemoryState::Candidate,
            MemoryStateFfi::Confirmed => MemoryState::Confirmed,
            MemoryStateFfi::Rejected => MemoryState::Rejected,
        }
    }
}

/// A memory candidate awaiting the user's review (`07` §7), projected for UI.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MemoryCandidateFfi {
    pub memory_id: String,
    pub scope: String,
    /// A short human-readable preview of the candidate content.
    pub preview: String,
    pub confidence: String,
    pub state: MemoryStateFfi,
}

/// Apply the user's review decision to a memory candidate, via the `friday-core`
/// invariant: a candidate becomes `Confirmed` ONLY on an explicit yes; an explicit
/// no rejects it; **no decision leaves it a candidate (never silently written)**
/// (`07` §6/§7). Exposed so the native Memory Review UI surfaces the real logic.
#[uniffi::export]
pub fn decide_candidate(state: MemoryStateFfi, user_confirmed: Option<bool>) -> MemoryStateFfi {
    friday_core::decide_candidate(state.to_core(), user_confirmed).into()
}

/// A representative Memory Review queue — pending candidates awaiting an explicit
/// confirm/reject. A Rust-built UI fixture (the persisted phone memory store is
/// deferred); every item is a `Candidate` (nothing is auto-confirmed). NOT live data.
#[uniffi::export]
pub fn sample_memory_review() -> Vec<MemoryCandidateFfi> {
    let candidate = |id: &str, scope: &str, preview: &str, confidence: &str| MemoryCandidateFfi {
        memory_id: id.into(),
        scope: scope.into(),
        preview: preview.into(),
        confidence: confidence.into(),
        state: MemoryStateFfi::Candidate,
    };
    vec![
        candidate("mc1", "global", "Prefers Rust for new services", "inferred"),
        candidate(
            "mc2",
            "project",
            "Deploy target is the Pixel_8 emulator",
            "candidate",
        ),
        candidate(
            "mc3",
            "session",
            "Working on the Friday mobile rewrite",
            "high_confidence_context",
        ),
    ]
}

/// A Context Passport item PROJECTED to the phone (`07` §10, design `passportPattern: Checklist
/// Sheet`). The `label` is ALREADY redacted by `friday_core::redact_passport_for_projection` for
/// secret/token/sensitive kinds — the secret value never reaches this struct. `transferable` is
/// `false` for never-transferable (secret/token) kinds.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PassportItemFfi {
    pub kind: String,
    pub label: String,
    pub included: bool,
    pub transferable: bool,
    pub redacted: bool,
}

fn passport_kind_str(kind: friday_core::PassportItemKind) -> String {
    use friday_core::PassportItemKind as K;
    match kind {
        K::MemorySnippet => "memory_snippet",
        K::Summary => "summary",
        K::File => "file",
        K::Screenshot => "screenshot",
        K::Attachment => "attachment",
        K::ProviderSecret => "provider_secret", // pragma: allowlist secret (kind tag, not a secret)
        K::RawToken => "raw_token",
    }
    .to_string()
}

/// A representative Context Passport "Checklist Sheet" PROJECTED through
/// `friday_core::redact_passport_for_projection`, so a secret/token kind is redacted +
/// non-transferable — the secret value NEVER leaves the Hub. A Rust-built UI fixture (the live
/// passport store is deferred); NOT live data. Surfaces the real redaction boundary the UI shows.
#[uniffi::export]
pub fn sample_context_passport() -> Vec<PassportItemFfi> {
    use friday_core::{PassportItem, PassportItemKind};
    let mk = |kind, label: &str, included, sensitive| PassportItem {
        kind,
        label: label.to_string(),
        included,
        sensitive,
    };
    let items = vec![
        mk(
            PassportItemKind::MemorySnippet,
            "Prefers Rust for new services",
            true,
            false,
        ),
        mk(
            PassportItemKind::Summary,
            "This week: ship the Rust agent loop",
            true,
            false,
        ),
        mk(PassportItemKind::File, "design-notes.md", true, false),
        // a secret in context: projected redacted + non-transferable (value never leaves the Hub).
        // Fixture values are intentionally NOT secret-shaped (no `sk-`/`eyJ`/`API_KEY=`) so the
        // repo secrets-scanner stays clean; redaction is by KIND, so the value is irrelevant.
        mk(
            PassportItemKind::ProviderSecret,
            "deepseek provider material FIXTURE-PROVIDER-VALUE",
            true,
            true,
        ),
        mk(
            PassportItemKind::RawToken,
            "phone session blob FIXTURE-TOKEN-VALUE",
            false,
            true,
        ),
    ];
    friday_core::redact_passport_for_projection(&items)
        .iter()
        .map(|r| PassportItemFfi {
            kind: passport_kind_str(r.kind),
            label: r.label.clone(),
            included: r.included,
            transferable: r.transferable,
            redacted: r.redacted,
        })
        .collect()
}

/// An activity item read back from the phone's own SQLite store (`08`), for UI.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityItemFfi {
    pub activity_id: String,
    pub kind: String,
    pub state: String,
    pub summary: String,
    pub created_at: i64,
}

/// Result of reading the phone-side activity store. `ok=false` carries a
/// secret-safe `error` string (errors are surfaced to the UI, not swallowed).
#[derive(Debug, Clone, uniffi::Record)]
pub struct PhoneActivityFfi {
    pub ok: bool,
    pub error: String,
    pub items: Vec<ActivityItemFfi>,
}

/// Open the **phone-profile** SQLite DB at `db_path`, seed a few demo activity
/// rows on first run, then read them back — a REAL on-device persistence
/// round-trip through the bundled SQLite compiled into this library (NOT a
/// fixture). The phone profile omits all Hub-only secret/audit tables (gate
/// `21` §2), so nothing sensitive can exist in this store.
#[uniffi::export]
pub fn phone_activity_demo(db_path: String) -> PhoneActivityFfi {
    match load_phone_activity(&db_path) {
        Ok(items) => PhoneActivityFfi {
            ok: true,
            error: String::new(),
            items,
        },
        Err(e) => PhoneActivityFfi {
            ok: false,
            error: e.to_string(),
            items: Vec::new(),
        },
    }
}

fn load_phone_activity(db_path: &str) -> friday_storage::Result<Vec<ActivityItemFfi>> {
    use friday_core::{ActivityState, ActivityType};
    use friday_storage::{ActivityRow, Db};

    let db = Db::open_phone(db_path)?;
    if db.count("activity_item")? == 0 {
        let seed = |id: &str, kind, state, summary: &str, t: i64| ActivityRow {
            activity_id: id.to_string(),
            session_id: None,
            kind,
            state,
            summary: summary.to_string(),
            created_at: t,
            updated_at: t,
            deep_link: None,
        };
        db.insert_activity(&seed(
            "a1",
            ActivityType::AskReceipt,
            ActivityState::Done,
            "Asked Friday: today's build status",
            1,
        ))?;
        db.insert_activity(&seed(
            "a2",
            ActivityType::AskStatus,
            ActivityState::Running,
            "Friday is summarizing the repo",
            2,
        ))?;
        db.insert_activity(&seed(
            "a3",
            ActivityType::OfflineQueued,
            ActivityState::Pending,
            "Queued offline: send report",
            3,
        ))?;
    }
    activity_items(&db)
}

fn activity_items(db: &friday_storage::Db) -> friday_storage::Result<Vec<ActivityItemFfi>> {
    Ok(db
        .list_activity()?
        .into_iter()
        .map(|s| ActivityItemFfi {
            activity_id: s.activity_id,
            kind: s.kind,
            state: s.state,
            summary: s.summary,
            created_at: s.created_at,
        })
        .collect())
}

/// Interactive WRITE path: mark an activity item `Done` in the phone's own SQLite
/// store and return the updated list. A real persisted state change (the UI's
/// "mark done" action), not UI-only state. An UNKNOWN id is surfaced as `ok=false`
/// with an error — no longer a silent success (file-37 red-team NIT #4). The struct
/// shape is unchanged, so callers that already branch on `ok` need no change.
#[uniffi::export]
pub fn mark_activity_done(db_path: String, activity_id: String, now: i64) -> PhoneActivityFfi {
    match mark_and_list(&db_path, &activity_id, now) {
        Ok(items) => PhoneActivityFfi {
            ok: true,
            error: String::new(),
            items,
        },
        Err(e) => PhoneActivityFfi {
            ok: false,
            error: e.to_string(),
            items: Vec::new(),
        },
    }
}

fn mark_and_list(
    db_path: &str,
    activity_id: &str,
    now: i64,
) -> friday_storage::Result<Vec<ActivityItemFfi>> {
    let db = friday_storage::Db::open_phone(db_path)?;
    // Surface an unknown id instead of silently succeeding: `mark_activity_done`
    // returns false when no row matched (file-37 NIT #4).
    if !db.mark_activity_done(activity_id, now)? {
        return Err(friday_storage::StorageError::NotFound(format!(
            "activity_id {activity_id}"
        )));
    }
    activity_items(&db)
}

/// A token/cost usage row for the UI (`02` §13 cost transparency). `fallback` is
/// always shown — a fallback is never hidden.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TokenUsageFfi {
    pub provider: String,
    pub model: String,
    pub total_tokens: i64,
    pub cost_estimate: Option<f64>,
    pub fallback: bool,
}

/// Result of reading the phone-side token/cost ledger (`ok=false` -> secret-safe error).
#[derive(Debug, Clone, uniffi::Record)]
pub struct PhoneTokensFfi {
    pub ok: bool,
    pub error: String,
    pub items: Vec<TokenUsageFfi>,
}

/// Read the phone's own `token_ledger` (seeding a couple of DeepSeek Friday-route
/// rows on first run) for a cost/usage view. Real on-device SQLite; the
/// `fallback` flag is surfaced for every row (`02` §13 — never hide a fallback).
#[uniffi::export]
pub fn phone_token_usage(db_path: String) -> PhoneTokensFfi {
    match load_token_usage(&db_path) {
        Ok(items) => PhoneTokensFfi {
            ok: true,
            error: String::new(),
            items,
        },
        Err(e) => PhoneTokensFfi {
            ok: false,
            error: e.to_string(),
            items: Vec::new(),
        },
    }
}

fn load_token_usage(db_path: &str) -> friday_storage::Result<Vec<TokenUsageFfi>> {
    use friday_storage::Db;

    // Token-trust / reverse-integrity (audit 10A finding 5): the cost view reflects ONLY
    // real model calls. An empty `token_ledger` yields an EMPTY projection — never a
    // fabricated demo row, which would show usage/cost for a call that never happened.
    let db = Db::open_phone(db_path)?;
    Ok(db
        .list_token_usage()?
        .into_iter()
        .map(|u| TokenUsageFfi {
            provider: u.provider_kind,
            model: u.model,
            total_tokens: u.total_tokens,
            cost_estimate: u.cost_estimate,
            fallback: u.fallback,
        })
        .collect())
}

// --- internal (non-FFI) helpers retained for the phone-side runtime/tests ---

/// Open a phone-profile database. The phone schema omits the Hub-only
/// secret/audit tables entirely (gate `21` §2).
pub fn open_phone_db(path: &str) -> friday_storage::Result<friday_storage::Db> {
    friday_storage::Db::open_phone(path)
}

/// Generate a fresh phone-side field-encryption data key.
pub fn new_data_key() -> friday_crypto::DataKey {
    friday_crypto::DataKey::generate()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_db_opens_with_phone_profile_schema() {
        let db = open_phone_db(":memory:").unwrap();
        assert_eq!(db.profile(), friday_storage::Profile::Phone);
        let tables = db.table_names().unwrap();
        assert!(!tables.iter().any(|t| t == "audit_ledger"));
        assert!(tables.iter().any(|t| t == "offline_queue"));
    }

    #[test]
    fn ffi_connection_state_helpers() {
        assert_eq!(initial_connection_state(), ConnStateFfi::Disconnected);
        assert!(connection_is_online(ConnStateFfi::Direct));
        assert!(connection_is_online(ConnStateFfi::Relay));
        assert!(!connection_is_online(ConnStateFfi::Stale));
        assert!(connection_is_stale_or_offline(ConnStateFfi::Stale));
        assert!(connection_is_stale_or_offline(ConnStateFfi::Disconnected));
        let _ = new_data_key();
    }

    #[test]
    fn ffi_protocol_version_helpers() {
        assert_eq!(protocol_schema_version(), 2);
        assert_eq!(negotiate_schema_version(1, 3, 2, 5), Some(3));
        assert_eq!(negotiate_schema_version(1, 1, 2, 4), None);
    }

    #[test]
    fn ffi_needs_me_aggregation_is_urgency_first_and_stable() {
        let item = |src: &str, id: &str, p: u8| NeedsMeItemFfi {
            source: src.into(),
            id: id.into(),
            reason: String::new(),
            priority: p,
            destination: String::new(),
        };
        let sorted = aggregate_needs_me(vec![
            item("a", "1", 5),
            item("b", "2", 9),
            item("c", "3", 5),
        ]);
        assert_eq!(sorted[0].id, "2"); // priority 9 first
                                       // equal priority (5) keeps arrival order: 1 before 3
        assert_eq!(sorted[1].id, "1");
        assert_eq!(sorted[2].id, "3");
    }

    #[test]
    fn ffi_phone_activity_demo_round_trips_real_sqlite() {
        // A real on-disk phone SQLite round-trip (open + migrate + seed + read).
        let path =
            std::env::temp_dir().join(format!("friday-ffi-activity-{}.db", std::process::id()));
        let p = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);

        let r1 = phone_activity_demo(p.clone());
        assert!(r1.ok, "open/seed failed: {}", r1.error);
        assert_eq!(r1.items.len(), 3);
        assert_eq!(r1.items[0].activity_id, "a1"); // oldest-first (created_at 1)
        assert_eq!(r1.items[0].state, "done");

        // Reopen: no re-seed (count!=0 guard), same rows back.
        let r2 = phone_activity_demo(p.clone());
        assert!(r2.ok);
        assert_eq!(r2.items.len(), 3);
        assert_eq!(r2.items, r1.items);

        // Write a NON-seed row directly, then reopen via a FRESH Db: it must
        // survive — this is the true on-DISK discriminator (a non-persistent
        // store would lose it; the deterministic seed alone could not prove this).
        {
            use friday_core::{ActivityState, ActivityType};
            use friday_storage::{ActivityRow, Db};
            let db = Db::open_phone(&p).unwrap();
            db.insert_activity(&ActivityRow {
                activity_id: "extra".into(),
                session_id: None,
                kind: ActivityType::AskStatus,
                state: ActivityState::Done,
                summary: "persisted across reopen".into(),
                created_at: 99,
                updated_at: 99,
                deep_link: None,
            })
            .unwrap();
        }
        let r3 = phone_activity_demo(p.clone());
        assert!(r3.ok);
        assert_eq!(r3.items.len(), 4, "the extra row must survive a fresh open");
        assert!(r3.items.iter().any(|a| a.activity_id == "extra"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ffi_mark_activity_done_persists_across_reopen() {
        let path =
            std::env::temp_dir().join(format!("friday-ffi-markdone-{}.db", std::process::id()));
        let p = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);

        // Seed (a3 = "Queued offline" is Pending).
        let seeded = phone_activity_demo(p.clone());
        assert!(seeded.ok);
        let a3 = seeded.items.iter().find(|a| a.activity_id == "a3").unwrap();
        assert_eq!(a3.state, "pending");

        // The interactive write: mark a3 done. Returns the updated list.
        let after = mark_activity_done(p.clone(), "a3".into(), 100);
        assert!(after.ok);
        assert_eq!(
            after
                .items
                .iter()
                .find(|a| a.activity_id == "a3")
                .unwrap()
                .state,
            "done"
        );

        // Reopen via a FRESH read path: the state change persisted on disk.
        let reopened = phone_activity_demo(p.clone());
        assert_eq!(
            reopened
                .items
                .iter()
                .find(|a| a.activity_id == "a3")
                .unwrap()
                .state,
            "done"
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ffi_mark_unknown_activity_id_surfaces_not_found() {
        // file-37 NIT #4: marking an id that does not exist is no longer a silent
        // success — it surfaces ok=false + an error. (Same struct shape, so a caller
        // that branches on `ok` needs no change.)
        let path =
            std::env::temp_dir().join(format!("friday-ffi-markunknown-{}.db", std::process::id()));
        let p = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);

        let seeded = phone_activity_demo(p.clone());
        assert!(seeded.ok);

        let r = mark_activity_done(p.clone(), "does-not-exist".into(), 100);
        assert!(!r.ok, "unknown id must not silently succeed");
        assert!(
            r.error.contains("does-not-exist"),
            "the error names the missing id, got {:?}",
            r.error
        );
        assert!(r.items.is_empty());

        // A KNOWN id still succeeds (the fix did not break the happy path).
        let ok = mark_activity_done(p.clone(), "a3".into(), 100);
        assert!(ok.ok && ok.error.is_empty());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ffi_phone_token_usage_empty_is_empty_then_surfaces_real_rows() {
        let path =
            std::env::temp_dir().join(format!("friday-ffi-tokens-{}.db", std::process::id()));
        let p = path.to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);

        // Reverse-integrity (audit 10A #5): an empty ledger surfaces NOTHING — no
        // fabricated demo rows for calls that never happened.
        let r0 = phone_token_usage(p.clone());
        assert!(r0.ok, "open failed: {}", r0.error);
        assert_eq!(
            r0.items.len(),
            0,
            "empty ledger must yield an empty cost view"
        );

        // A REAL row, written via the constructor (recomputes total, fallback=false —
        // never a struct literal), surfaces correctly.
        {
            let db = friday_storage::Db::open_phone(&p).unwrap();
            let entry = friday_core::LedgerEntry::friday_route(
                "l1",
                "s1",
                "a1",
                "deepseek-v4-flash",
                1200,
                800,
                Some(0.0021),
                None,
                1,
            )
            .unwrap();
            db.insert_token_ledger(&entry).unwrap();
        }
        let r = phone_token_usage(p.clone());
        assert!(r.ok, "list failed: {}", r.error);
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].provider, "deepseek");
        assert_eq!(r.items[0].total_tokens, 2000); // recomputed 1200 + 800
        assert_eq!(r.items[0].cost_estimate, Some(0.0021));
        // The fallback flag is surfaced; Friday route => false.
        assert!(r.items.iter().all(|u| !u.fallback));

        // Reopen: persisted, still exactly one (no re-seed).
        let r2 = phone_token_usage(p.clone());
        assert_eq!(r2.items.len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn ffi_memory_decision_never_silently_writes() {
        // No decision -> stays a Candidate (NOT written).
        assert_eq!(
            decide_candidate(MemoryStateFfi::Candidate, None),
            MemoryStateFfi::Candidate
        );
        // Explicit yes -> Confirmed; explicit no -> Rejected.
        assert_eq!(
            decide_candidate(MemoryStateFfi::Candidate, Some(true)),
            MemoryStateFfi::Confirmed
        );
        assert_eq!(
            decide_candidate(MemoryStateFfi::Candidate, Some(false)),
            MemoryStateFfi::Rejected
        );
        // A terminal decision is not re-opened by a later (even contrary) signal.
        assert_eq!(
            decide_candidate(MemoryStateFfi::Confirmed, Some(false)),
            MemoryStateFfi::Confirmed
        );
    }

    #[test]
    fn ffi_sample_memory_review_is_all_pending_candidates() {
        let review = sample_memory_review();
        assert!(!review.is_empty());
        // Nothing is auto-confirmed: every item awaits the user's decision.
        assert!(review.iter().all(|m| m.state == MemoryStateFfi::Candidate));
        assert!(review
            .iter()
            .all(|m| !m.preview.is_empty() && !m.memory_id.is_empty()));
    }

    #[test]
    fn ffi_needs_me_item_round_trips_losslessly() {
        let ffi = NeedsMeItemFfi {
            source: "claude".into(),
            id: "c1".into(),
            reason: "a question".into(),
            priority: 7,
            destination: "session/x".into(),
        };
        let core: NeedsMeItem = ffi.clone().into();
        let back: NeedsMeItemFfi = core.into();
        assert_eq!(ffi, back); // every field survives both conversions
    }

    #[test]
    fn ffi_sample_inbox_is_nonempty_and_urgency_ordered() {
        let inbox = sample_activity_inbox();
        assert!(!inbox.is_empty());
        for w in inbox.windows(2) {
            assert!(w[0].priority >= w[1].priority, "must be urgency-first");
        }
        assert_eq!(inbox[0].source, "claude"); // highest priority (9)
                                               // detail is carried, never dropped.
        assert!(!inbox[0].reason.is_empty() && !inbox[0].destination.is_empty());
    }

    #[test]
    fn context_passport_projection_redacts_secrets_never_leaves_hub() {
        let proj = sample_context_passport();
        // a provider-secret item is present, redacted, and non-transferable.
        let secret = proj
            .iter()
            .find(|i| i.kind == "provider_secret")
            .expect("secret item present in the passport");
        assert_eq!(secret.label, "[redacted: provider secret]");
        assert!(secret.redacted && !secret.transferable);
        let token = proj.iter().find(|i| i.kind == "raw_token").unwrap();
        assert!(token.redacted && !token.transferable);
        // ordinary items keep their real label + are transferable.
        let mem = proj.iter().find(|i| i.kind == "memory_snippet").unwrap();
        assert_eq!(mem.label, "Prefers Rust for new services");
        assert!(mem.transferable && !mem.redacted);
        // ADVERSE: the secret/token VALUE never appears anywhere in the projected labels.
        for i in &proj {
            for leaked in ["FIXTURE-PROVIDER-VALUE", "FIXTURE-TOKEN-VALUE"] {
                assert!(
                    !i.label.contains(leaked),
                    "redacted material leaked: {} in {}",
                    leaked,
                    i.label
                );
            }
        }
    }
}
