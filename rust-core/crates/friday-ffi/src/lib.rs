//! friday-ffi — phone-side FFI surface for Swift (iOS) / Kotlin (Android), via UniFFI.
//!
//! Unit 5a: this crate now exposes a first-slice UniFFI interface (gate `21` §5)
//! and generates idiomatic Swift + Kotlin bindings from one Rust definition
//! (`cargo run -p friday-ffi --bin uniffi-bindgen -- generate --library <cdylib>
//! --language swift|kotlin`). The exposed ops are pure, FFI-safe projections of
//! the slice's connection-state + protocol version-negotiation logic, plus the
//! native-facing `ask_friday` CLIENT ACTION contract (build the request envelope +
//! parse the Hub's refs-only response). The model call itself is Hub-owned (never on
//! the phone); the streaming-answer projection and the native app shells land with
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

/// Client-facing connection truth label. Native UI should render this label
/// directly instead of treating stale/offline/reconnecting as a live state.
#[uniffi::export]
pub fn connection_truth_label(state: ConnStateFfi) -> String {
    match state {
        ConnStateFfi::Direct | ConnStateFfi::Relay => "connected",
        ConnStateFfi::Connecting => "reconnecting",
        ConnStateFfi::Stale => "stale",
        ConnStateFfi::Disconnected => "offline",
    }
    .to_string()
}

/// Truth label for an offline action row. `acked` means the Hub saw it; it is
/// still rendered as `queued` and never as completion.
#[uniffi::export]
pub fn offline_action_truth_label(state: String) -> String {
    match state.trim() {
        "queued" | "acked" => "queued",
        "executed" => "executed",
        "failed" => "failed",
        _ => "unknown",
    }
    .to_string()
}

/// Only an execution-proof offline result can be treated as complete.
#[uniffi::export]
pub fn offline_action_state_implies_completion(state: String) -> bool {
    state.trim() == "executed"
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
            // Local phone seed — owner=NULL (legacy-allow under the local FFI mark-done path).
            owner: None,
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
    // M6: the local single-owner phone/desktop path passes `None` — this is not the network
    // WS attack surface, and the NULL-owner=legacy-allow arm preserves it as a no-op (phone
    // activity rows are only ever the FFI seeds below, all owner=NULL).
    if !db.mark_activity_done(activity_id, None, now)? {
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

// =====================================================================================
// Phase 3 (goal file 92 §Phase 3): the native-facing `ask_friday` CLIENT ACTION contract.
//
// This is a CLIENT ACTION to the Hub — a `friday_protocol::AskFridayRequest` the native
// shell seals + sends — NOT a phone-side provider adapter. The phone BUILDS the request and
// PARSES the Hub's refs-only response; it never links `friday-deepseek`/`friday-providers`/
// `friday-fs`, never holds a provider credential, and never sees the raw answer text
// (enforced at compile time by `friday-arch-tests::dep_boundary`). All wire (de)serialization
// stays inside `friday-protocol` (`Envelope::encode`/`decode`) — this crate adds no serde.
// =====================================================================================

/// A built, wire-ready Ask-Friday client action (the "action" struct of the slice).
/// `ok=false` carries a secret-safe `error` (an encode failure is surfaced, never a panic
/// across the FFI). `client_msg_id` is the idempotency key — it IS the envelope `msg_id`
/// the Hub correlates the response to; resend the SAME id to retry an ask. NOTE: end-to-end
/// replay-dedup is **not yet enforced Hub-side** (the Phase-1 serve-loop routes by kind and
/// keeps no seen-id set); this contract only EXPOSES the key the Hub would dedup on.
/// `wire_json` is the PLAINTEXT envelope JSON the native transport seals + sends — it carries
/// only the prompt (no credential, no provider material).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AskRequestFfi {
    pub ok: bool,
    pub error: String,
    pub client_msg_id: String,
    pub wire_json: String,
}

/// Legacy detached `ask_friday` builder. Detached asks are no longer product-valid:
/// callers must first resolve/create a Mission/WorkItem and then use
/// [`build_mission_ask_friday_request`].
#[uniffi::export]
pub fn build_ask_friday_request(
    client_msg_id: String,
    _prompt: String,
    _sent_at: i64,
) -> AskRequestFfi {
    AskRequestFfi {
        ok: false,
        error: "ask_friday requires Mission context; use build_mission_ask_friday_request"
            .to_string(),
        client_msg_id,
        wire_json: String::new(),
    }
}

/// Build a Mission-bound `ask_friday` client action. The model call still happens
/// Hub-side, but the Hub must first resolve this context and attach the ask proof
/// to the canonical Mission/WorkItem. Invalid Friday conversation ids or empty
/// Mission/WorkItem ids fail before any wire payload is produced.
#[uniffi::export]
pub fn build_mission_ask_friday_request(
    client_msg_id: String,
    prompt: String,
    friday_conversation_id: String,
    mission_id: String,
    work_item_id: String,
    sent_at: i64,
) -> AskRequestFfi {
    if let Err(err) = friday_core::validate_friday_conversation_id(&friday_conversation_id) {
        return AskRequestFfi {
            ok: false,
            error: err.to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if mission_id.trim().is_empty() {
        return AskRequestFfi {
            ok: false,
            error: "mission ask mission_id required".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if work_item_id.trim().is_empty() {
        return AskRequestFfi {
            ok: false,
            error: "mission ask work_item_id required".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }

    let env = friday_protocol::Envelope::new(
        client_msg_id.clone(),
        sent_at,
        friday_protocol::Message::AskFridayRequest {
            prompt,
            mission_context: Some(friday_protocol::MissionWorkItemContextWire {
                friday_conversation_id,
                mission_id,
                work_item_id,
            }),
        },
    );
    match env.encode() {
        Ok(wire_json) => AskRequestFfi {
            ok: true,
            error: String::new(),
            client_msg_id,
            wire_json,
        },
        Err(e) => AskRequestFfi {
            ok: false,
            error: e.to_string(),
            client_msg_id,
            wire_json: String::new(),
        },
    }
}

/// Build a Mission intake/preflight request from a mobile/desktop/channel surface.
/// This creates/resolves the Mission and WorkItem Hub-side, or returns a duplicate
/// blocker; it must not trigger a provider/model call.
#[uniffi::export]
#[allow(clippy::too_many_arguments)]
pub fn build_mission_intake_request(
    client_msg_id: String,
    friday_conversation_id: String,
    owner_principal: String,
    surface_thread_id: String,
    surface_kind: String,
    delivery_route: String,
    visibility_policy: String,
    mission_id: String,
    work_item_id: String,
    title: String,
    intent: String,
    lane: String,
    target_provider_or_agent: Option<String>,
    capability_id: Option<String>,
    body_ref: Option<String>,
    includes_sensitive_context: bool,
    sent_at: i64,
) -> AskRequestFfi {
    if let Err(err) = friday_core::validate_friday_conversation_id(&friday_conversation_id) {
        return AskRequestFfi {
            ok: false,
            error: err.to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    for (value, label) in [
        (&owner_principal, "mission intake owner_principal required"),
        (
            &surface_thread_id,
            "mission intake surface_thread_id required",
        ),
        (&delivery_route, "mission intake delivery_route required"),
        (&mission_id, "mission intake mission_id required"),
        (&work_item_id, "mission intake work_item_id required"),
        (&intent, "mission intake intent required"),
    ] {
        if value.trim().is_empty() {
            return AskRequestFfi {
                ok: false,
                error: label.to_string(),
                client_msg_id,
                wire_json: String::new(),
            };
        }
    }
    if !is_mission_surface_kind(&surface_kind) {
        return AskRequestFfi {
            ok: false,
            error: "mission intake surface_kind unknown".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if !is_mission_visibility_policy(&visibility_policy) {
        return AskRequestFfi {
            ok: false,
            error: "mission intake visibility_policy unknown".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if !is_work_lane(&lane) {
        return AskRequestFfi {
            ok: false,
            error: "mission intake lane unknown".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if let Some(body_ref) = body_ref.as_deref() {
        if !is_safe_body_ref(body_ref) {
            return AskRequestFfi {
                ok: false,
                error: "mission intake body_ref must be a Friday-owned body/blob ref".to_string(),
                client_msg_id,
                wire_json: String::new(),
            };
        }
    }

    let env = friday_protocol::Envelope::new(
        client_msg_id.clone(),
        sent_at,
        friday_protocol::Message::MissionIntakeRequest {
            request: friday_protocol::MissionIntakeRequestWire {
                friday_conversation_id,
                owner_principal,
                surface_thread_id,
                surface_kind,
                delivery_route,
                visibility_policy,
                mission_id,
                work_item_id,
                title,
                intent,
                lane,
                target_provider_or_agent,
                capability_id,
                body_ref,
                proof_requirements: Vec::new(),
                includes_sensitive_context,
            },
        },
    );
    match env.encode() {
        Ok(wire_json) => AskRequestFfi {
            ok: true,
            error: String::new(),
            client_msg_id,
            wire_json,
        },
        Err(e) => AskRequestFfi {
            ok: false,
            error: e.to_string(),
            client_msg_id,
            wire_json: String::new(),
        },
    }
}

/// Build the `MissionProjectionRequest` client action. This is a pure read request:
/// the Hub response must be a refs-only Mission projection and must not cause a
/// model/provider call.
#[uniffi::export]
pub fn build_mission_projection_request(
    client_msg_id: String,
    friday_conversation_id: String,
    sent_at: i64,
) -> AskRequestFfi {
    if let Err(err) = friday_core::validate_friday_conversation_id(&friday_conversation_id) {
        return AskRequestFfi {
            ok: false,
            error: err.to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    let env = friday_protocol::Envelope::new(
        client_msg_id.clone(),
        sent_at,
        friday_protocol::Message::MissionProjectionRequest {
            request: friday_protocol::MissionProjectionRequestWire {
                friday_conversation_id,
            },
        },
    );
    match env.encode() {
        Ok(wire_json) => AskRequestFfi {
            ok: true,
            error: String::new(),
            client_msg_id,
            wire_json,
        },
        Err(e) => AskRequestFfi {
            ok: false,
            error: e.to_string(),
            client_msg_id,
            wire_json: String::new(),
        },
    }
}

/// Build the `MissionTimelineRequest` client action. This is also a pure read:
/// one canonical Friday Mission is projected as refs/counts/statuses, never as a
/// provider/channel transcript and never as completion proof.
#[uniffi::export]
pub fn build_mission_timeline_request(
    client_msg_id: String,
    friday_conversation_id: String,
    mission_id: String,
    sent_at: i64,
) -> AskRequestFfi {
    build_mission_timeline_request_wire(
        client_msg_id,
        friday_conversation_id,
        mission_id,
        None,
        None,
        sent_at,
    )
}

/// Build a bounded `MissionTimelineRequest` client action. `cursor` is `None`
/// or `start`/`offset:<n>`; `limit` is Hub-capped to the safe page size.
#[uniffi::export]
pub fn build_bounded_mission_timeline_request(
    client_msg_id: String,
    friday_conversation_id: String,
    mission_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    sent_at: i64,
) -> AskRequestFfi {
    build_mission_timeline_request_wire(
        client_msg_id,
        friday_conversation_id,
        mission_id,
        cursor,
        limit,
        sent_at,
    )
}

fn build_mission_timeline_request_wire(
    client_msg_id: String,
    friday_conversation_id: String,
    mission_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
    sent_at: i64,
) -> AskRequestFfi {
    if let Err(err) = friday_core::validate_friday_conversation_id(&friday_conversation_id) {
        return AskRequestFfi {
            ok: false,
            error: err.to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if mission_id.trim().is_empty() {
        return AskRequestFfi {
            ok: false,
            error: "mission timeline mission_id required".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if limit == Some(0) {
        return AskRequestFfi {
            ok: false,
            error: "mission timeline limit must be greater than 0".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }

    let env = friday_protocol::Envelope::new(
        client_msg_id.clone(),
        sent_at,
        friday_protocol::Message::MissionTimelineRequest {
            request: friday_protocol::MissionTimelineRequestWire {
                friday_conversation_id,
                mission_id,
                cursor,
                limit,
            },
        },
    );
    match env.encode() {
        Ok(wire_json) => AskRequestFfi {
            ok: true,
            error: String::new(),
            client_msg_id,
            wire_json,
        },
        Err(e) => AskRequestFfi {
            ok: false,
            error: e.to_string(),
            client_msg_id,
            wire_json: String::new(),
        },
    }
}

/// Build a Mission lifecycle command. This is a Hub-owned mutation request, not
/// a provider/model call. Native callers must carry the actor/reason/proof refs
/// explicitly so a pause/archive/merge/done action is traceable instead of a
/// hidden local UI state change.
#[uniffi::export]
#[allow(clippy::too_many_arguments)]
pub fn build_mission_lifecycle_request(
    client_msg_id: String,
    friday_conversation_id: String,
    mission_id: String,
    target_status: String,
    actor_ref: String,
    reason: String,
    proof_ref: Option<String>,
    merged_into_mission_id: Option<String>,
    sent_at: i64,
) -> AskRequestFfi {
    if let Err(err) = friday_core::validate_friday_conversation_id(&friday_conversation_id) {
        return AskRequestFfi {
            ok: false,
            error: err.to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if mission_id.trim().is_empty() {
        return AskRequestFfi {
            ok: false,
            error: "mission lifecycle mission_id required".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if !is_mission_lifecycle_status(&target_status) {
        return AskRequestFfi {
            ok: false,
            error: "mission lifecycle target_status unknown".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if actor_ref.trim().is_empty() {
        return AskRequestFfi {
            ok: false,
            error: "mission lifecycle actor_ref required".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if reason.trim().is_empty() {
        return AskRequestFfi {
            ok: false,
            error: "mission lifecycle reason required".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if target_status == "done" && proof_ref.is_none() {
        return AskRequestFfi {
            ok: false,
            error: "mission lifecycle done requires proof_ref".to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if target_status == "merged" {
        let Some(target) = merged_into_mission_id.as_deref() else {
            return AskRequestFfi {
                ok: false,
                error: "mission lifecycle merged requires merged_into_mission_id".to_string(),
                client_msg_id,
                wire_json: String::new(),
            };
        };
        if target.trim().is_empty() {
            return AskRequestFfi {
                ok: false,
                error: "mission lifecycle merged_into_mission_id required".to_string(),
                client_msg_id,
                wire_json: String::new(),
            };
        }
    } else if merged_into_mission_id.is_some() {
        return AskRequestFfi {
            ok: false,
            error: "mission lifecycle merged_into_mission_id only valid for merged status"
                .to_string(),
            client_msg_id,
            wire_json: String::new(),
        };
    }
    if let Some(proof_ref) = proof_ref.as_deref() {
        if !is_safe_lifecycle_proof_ref(proof_ref) {
            return AskRequestFfi {
                ok: false,
                error: "mission lifecycle proof_ref must be a Friday proof/audit ref".to_string(),
                client_msg_id,
                wire_json: String::new(),
            };
        }
    }

    let env = friday_protocol::Envelope::new(
        client_msg_id.clone(),
        sent_at,
        friday_protocol::Message::MissionLifecycleRequest {
            request: friday_protocol::MissionLifecycleRequestWire {
                friday_conversation_id,
                mission_id,
                target_status,
                actor_ref,
                reason,
                proof_ref,
                merged_into_mission_id,
            },
        },
    );
    match env.encode() {
        Ok(wire_json) => AskRequestFfi {
            ok: true,
            error: String::new(),
            client_msg_id,
            wire_json,
        },
        Err(e) => AskRequestFfi {
            ok: false,
            error: e.to_string(),
            client_msg_id,
            wire_json: String::new(),
        },
    }
}

fn is_mission_lifecycle_status(value: &str) -> bool {
    matches!(
        value,
        "active" | "waiting_for_user" | "blocked" | "paused" | "done" | "archived" | "merged"
    )
}

fn is_safe_lifecycle_proof_ref(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && (trimmed.starts_with("proof://")
            || trimmed.starts_with("audit://")
            || trimmed.starts_with("friday://proof/")
            || trimmed.starts_with("friday://audit/"))
}

fn is_mission_surface_kind(value: &str) -> bool {
    matches!(
        value,
        "mobile"
            | "desktop"
            | "telegram"
            | "discord"
            | "lark"
            | "web_chat"
            | "provider_workspace"
            | "future_channel"
    )
}

fn is_mission_visibility_policy(value: &str) -> bool {
    matches!(
        value,
        "compact" | "rich_proof" | "status_only" | "hidden_trace_only"
    )
}

fn is_work_lane(value: &str) -> bool {
    matches!(
        value,
        "friday_hub"
            | "codex"
            | "claude"
            | "deepseek"
            | "workflow"
            | "channel"
            | "human"
            | "future_api"
    )
}

fn is_safe_body_ref(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && (trimmed.starts_with("friday://body/")
            || trimmed.starts_with("friday://surface-event-body/")
            || trimmed.starts_with("blob://"))
}

/// Whether a Mission intake result should allow native UI to proceed with a new
/// WorkItem route. Duplicate/conflict `blocked` results must not dispatch.
#[uniffi::export]
pub fn mission_intake_allows_new_work(status: String, created_or_ready: bool) -> bool {
    status.trim() == "ready" && created_or_ready
}

/// Whether a blocked Mission intake should open/show an existing Mission instead
/// of creating a detached duplicate row or an error-only dead end.
#[uniffi::export]
pub fn mission_intake_should_open_existing(
    status: String,
    duplicate_mission_id: Option<String>,
    duplicate_work_item_id: Option<String>,
) -> bool {
    if status.trim() != "blocked" {
        return false;
    }
    let has_duplicate_mission = duplicate_mission_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let has_duplicate_work = duplicate_work_item_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    has_duplicate_mission || has_duplicate_work
}

/// Only `completed_with_proof` means a Mission WorkItem is done. Hub/provider
/// ack states such as `hub_accepted`, `provider_routed`, and `provider_waiting`
/// are progress states, not completion.
#[uniffi::export]
pub fn mission_work_item_status_implies_completion(status: String) -> bool {
    status.trim() == "completed_with_proof"
}

/// Terminal WorkItem states for UI grouping. Terminal is not the same as done:
/// failures/cancel/archive/merge end the item but do not prove success.
#[uniffi::export]
pub fn mission_work_item_status_is_terminal(status: String) -> bool {
    matches!(
        status.trim(),
        "completed_with_proof" | "failed_terminal" | "cancelled" | "merged" | "archived"
    )
}

/// Fail-closed helper for memory authority in Mission timelines. A
/// `memory_candidate` link is never confirmed memory even if a bad projection
/// accidentally sets `grants_memory_authority=true`.
#[uniffi::export]
pub fn mission_timeline_link_grants_confirmed_memory_authority(
    link_kind: String,
    grants_memory_authority: bool,
) -> bool {
    grants_memory_authority && link_kind.trim() == "confirmed_memory"
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MissionSurfaceProjectionFfi {
    pub surface_thread_id: String,
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub surface_kind: String,
    pub visibility_policy: String,
    pub title: String,
    pub status: String,
    pub truth_status: String,
    pub current_focus_summary: String,
    pub proof_refs: Vec<String>,
    pub updated_at_ms: i64,
}

impl From<friday_protocol::MissionSurfaceProjectionWire> for MissionSurfaceProjectionFfi {
    fn from(value: friday_protocol::MissionSurfaceProjectionWire) -> Self {
        Self {
            surface_thread_id: value.surface_thread_id,
            friday_conversation_id: value.friday_conversation_id,
            mission_id: value.mission_id,
            surface_kind: value.surface_kind,
            visibility_policy: value.visibility_policy,
            title: value.title,
            status: value.status,
            truth_status: value.truth_status,
            current_focus_summary: value.current_focus_summary,
            proof_refs: value.proof_refs,
            updated_at_ms: value.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RouteActionItemFfi {
    pub description: String,
    pub target_kind: String,
    pub target_ref: String,
    pub reversibility: String,
    pub assigned_lane: String,
    pub assigned_provider_or_agent: Option<String>,
    pub route_reason: String,
}

impl From<friday_protocol::RouteActionItemWire> for RouteActionItemFfi {
    fn from(value: friday_protocol::RouteActionItemWire) -> Self {
        Self {
            description: value.description,
            target_kind: value.target_kind,
            target_ref: value.target_ref,
            reversibility: value.reversibility,
            assigned_lane: value.assigned_lane,
            assigned_provider_or_agent: value.assigned_provider_or_agent,
            route_reason: value.route_reason,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RouteDecisionProjectionFfi {
    pub route_decision_ref: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub selected_lane: String,
    pub selected_target_label: Option<String>,
    pub why_this_route: String,
    pub considered_options: Vec<String>,
    pub deferred_options: Vec<String>,
    pub previous_pitfalls: Vec<String>,
    pub inheritable_context: Vec<String>,
    pub conflict_ref_count: u64,
    pub proof_requirements: Vec<String>,
    pub ownership_claim_count: u64,
    pub trace_ref_count: u64,
    pub action_items: Vec<RouteActionItemFfi>,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

impl From<friday_protocol::RouteDecisionProjectionWire> for RouteDecisionProjectionFfi {
    fn from(value: friday_protocol::RouteDecisionProjectionWire) -> Self {
        Self {
            route_decision_ref: value.route_decision_ref,
            mission_id: value.mission_id,
            work_item_id: value.work_item_id,
            selected_lane: value.selected_lane,
            selected_target_label: value.selected_target_label,
            why_this_route: value.why_this_route,
            considered_options: value.considered_options,
            deferred_options: value.deferred_options,
            previous_pitfalls: value.previous_pitfalls,
            inheritable_context: value.inheritable_context,
            conflict_ref_count: value.conflict_ref_count,
            proof_requirements: value.proof_requirements,
            ownership_claim_count: value.ownership_claim_count,
            trace_ref_count: value.trace_ref_count,
            action_items: value.action_items.into_iter().map(Into::into).collect(),
            created_at_ms: value.created_at_ms,
            expires_at_ms: value.expires_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MissionTimelineMissionFfi {
    pub mission_id: String,
    pub friday_conversation_id: String,
    pub title: String,
    pub intent: String,
    pub status: String,
    pub why_now: String,
    pub decision_path_summary: String,
    pub proof_refs: Vec<String>,
    pub updated_at_ms: i64,
}

impl From<friday_protocol::MissionTimelineMissionWire> for MissionTimelineMissionFfi {
    fn from(value: friday_protocol::MissionTimelineMissionWire) -> Self {
        Self {
            mission_id: value.mission_id,
            friday_conversation_id: value.friday_conversation_id,
            title: value.title,
            intent: value.intent,
            status: value.status,
            why_now: value.why_now,
            decision_path_summary: value.decision_path_summary,
            proof_refs: value.proof_refs,
            updated_at_ms: value.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MissionTimelineWorkItemFfi {
    pub work_item_id: String,
    pub mission_id: String,
    pub lane: String,
    pub status: String,
    pub capability_id: Option<String>,
    pub risk_level: String,
    pub approval_state: String,
    pub has_blocker: bool,
    pub owner_claim_count: u64,
    pub workspace_ref_count: u64,
    pub input_ref_count: u64,
    pub output_ref_count: u64,
    pub proof_requirements: Vec<String>,
    pub proof_receipts: Vec<String>,
    pub updated_at_ms: i64,
}

impl From<friday_protocol::MissionTimelineWorkItemWire> for MissionTimelineWorkItemFfi {
    fn from(value: friday_protocol::MissionTimelineWorkItemWire) -> Self {
        Self {
            work_item_id: value.work_item_id,
            mission_id: value.mission_id,
            lane: value.lane,
            status: value.status,
            capability_id: value.capability_id,
            risk_level: value.risk_level,
            approval_state: value.approval_state,
            has_blocker: value.has_blocker,
            owner_claim_count: value.owner_claim_count,
            workspace_ref_count: value.workspace_ref_count,
            input_ref_count: value.input_ref_count,
            output_ref_count: value.output_ref_count,
            proof_requirements: value.proof_requirements,
            proof_receipts: value.proof_receipts,
            updated_at_ms: value.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MissionTimelineLinkFfi {
    pub link_ref: String,
    pub mission_id: String,
    pub work_item_id: Option<String>,
    pub link_kind: String,
    pub has_proof: bool,
    pub proof_ref: Option<String>,
    pub grants_memory_authority: bool,
    pub created_at_ms: i64,
}

impl From<friday_protocol::MissionTimelineLinkWire> for MissionTimelineLinkFfi {
    fn from(value: friday_protocol::MissionTimelineLinkWire) -> Self {
        Self {
            link_ref: value.link_ref,
            mission_id: value.mission_id,
            work_item_id: value.work_item_id,
            link_kind: value.link_kind,
            has_proof: value.has_proof,
            proof_ref: value.proof_ref,
            grants_memory_authority: value.grants_memory_authority,
            created_at_ms: value.created_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MissionTimelineSurfaceEventFfi {
    pub surface_event_id: String,
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub work_item_id: Option<String>,
    pub surface_thread_id: String,
    pub source_surface: String,
    pub event_kind: String,
    pub body_ref: Option<String>,
    pub visibility_policy: String,
    pub proof_ref: Option<String>,
    pub created_at_ms: i64,
}

impl From<friday_protocol::MissionTimelineSurfaceEventWire> for MissionTimelineSurfaceEventFfi {
    fn from(value: friday_protocol::MissionTimelineSurfaceEventWire) -> Self {
        Self {
            surface_event_id: value.surface_event_id,
            friday_conversation_id: value.friday_conversation_id,
            mission_id: value.mission_id,
            work_item_id: value.work_item_id,
            surface_thread_id: value.surface_thread_id,
            source_surface: value.source_surface,
            event_kind: value.event_kind,
            body_ref: value.body_ref,
            visibility_policy: value.visibility_policy,
            proof_ref: value.proof_ref,
            created_at_ms: value.created_at_ms,
        }
    }
}

/// What the Hub said back, projected SAFELY for the native UI (the slice's "result/snapshot"
/// types). Exactly one variant per response frame. NONE carries the raw answer text, usage
/// cost detail, provider account id, auth material, or private reasoning — the Hub keeps
/// those; the phone gets refs + truth labels. Consistent with the Phase-1 serve-loop's
/// refs-only projection: the answer body is followed via `result_link`, never inlined here.
/// UniFFI exposes concrete variant fields to Swift/Kotlin, so this boundary keeps the
/// generated API direct instead of boxing one large read-model variant.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum AskResponseFfi {
    /// Hub health snapshot: online + capabilities + supported schema range. No model call.
    Status {
        online: bool,
        capabilities: Vec<String>,
        min_version: u16,
        max_version: u16,
    },
    /// Terminal ask frame — REFS ONLY: a `ledger_id` + a `result_link` (`friday://activity/...`),
    /// NOT the answer. `correlation_id` matches the `client_msg_id` the phone sent (empty if none).
    AskResult {
        ledger_id: String,
        result_link: String,
        correlation_id: String,
    },
    /// Token/model ledger row projection (safe cost-view fields only; no host/key/cost-secret).
    /// `fallback` is ALWAYS surfaced — a fallback is never hidden (`02` §13).
    LedgerRef {
        ledger_id: String,
        provider_kind: String,
        model: String,
        total_tokens: i64,
        fallback: bool,
    },
    /// Activity receipt/status ref — id + type + state, NO body.
    ActivityRef {
        activity_id: String,
        item_type: String,
        state: String,
    },
    /// Ack of a queued offline action on reconnect. NOT completion (an ack is not a result).
    OfflineAck { acked_msg_id: String },
    /// Mission intake/preflight result from mobile/desktop/channel surface input.
    /// `status=blocked` means the Hub found a duplicate/conflict and did not create
    /// another WorkItem; native UI should show the existing Mission ids instead.
    MissionIntakeResult {
        friday_conversation_id: String,
        mission_id: String,
        work_item_id: Option<String>,
        surface_thread_id: String,
        status: String,
        blockers: Vec<String>,
        duplicate_mission_id: Option<String>,
        duplicate_work_item_id: Option<String>,
        created_or_ready: bool,
    },
    /// Mission projection snapshot: same Mission ids/statuses across mobile/desktop/channel
    /// surfaces, with provider/channel/process details kept behind trace refs.
    MissionProjectionSnapshot {
        friday_conversation_id: String,
        generated_at_ms: i64,
        projections: Vec<MissionSurfaceProjectionFfi>,
        route_decisions: Vec<RouteDecisionProjectionFfi>,
    },
    /// One Mission's richer timeline/read model: Mission metadata + safe surface
    /// projections + WorkItem refs/counts + redacted attached refs + route traces.
    MissionTimelineSnapshot {
        friday_conversation_id: String,
        mission_id: String,
        generated_at_ms: i64,
        requested_cursor: Option<String>,
        next_cursor: Option<String>,
        retained_from: Option<String>,
        bounded: bool,
        has_more: bool,
        mission: MissionTimelineMissionFfi,
        projections: Vec<MissionSurfaceProjectionFfi>,
        work_items: Vec<MissionTimelineWorkItemFfi>,
        links: Vec<MissionTimelineLinkFfi>,
        route_decisions: Vec<RouteDecisionProjectionFfi>,
        surface_events: Vec<MissionTimelineSurfaceEventFfi>,
    },
    /// Mission lifecycle mutation receipt: a Hub-validated state change plus
    /// active Mission list. This is not provider/workflow completion by itself.
    MissionLifecycleResult {
        friday_conversation_id: String,
        mission_id: String,
        previous_status: String,
        status: String,
        actor_ref: String,
        reason: String,
        proof_ref: Option<String>,
        merged_into_mission_id: Option<String>,
        active_mission_ids: Vec<String>,
        updated_at_ms: i64,
    },
    /// An explicit, surfaced Hub error (e.g. `PROVIDER_UNAVAILABLE`) — never a silent fallback.
    Error { code: String, message: String },
    /// A well-formed envelope whose message kind is NOT part of the ask_friday slice (a
    /// Provider Workspace frame, a streamed `AskFridayStream` chunk, pairing, …). It is
    /// truth-labeled by `kind`, never silently dropped or mis-rendered as a result. The
    /// chunk/payload of such a frame is NOT projected (no raw answer reaches the phone here).
    Unsupported { kind: String },
    /// The bytes did not decode as a protocol envelope (structural error only — no secret).
    Undecodable { error: String },
}

/// Representative Mission Spine response sequence for native UI/wire dry-runs.
/// NOT live data. It deliberately includes ready intake, duplicate-blocked intake,
/// shared mobile/desktop/channel projection, a bounded timeline, offline ack, and
/// provider error so UI code can exercise the real contracts without inventing
/// unsafe local shapes.
#[uniffi::export]
pub fn sample_mission_spine_responses() -> Vec<AskResponseFfi> {
    let fconv = "fconv_sample_mission".to_string();
    let mission_id = "mission-sample-global-secretary".to_string();
    let completed_work = "work-sample-provider-proof".to_string();
    let waiting_work = "work-sample-channel-waiting".to_string();

    let mobile_projection = MissionSurfaceProjectionFfi {
        surface_thread_id: "surface-mobile-sample".to_string(),
        friday_conversation_id: fconv.clone(),
        mission_id: mission_id.clone(),
        surface_kind: "mobile".to_string(),
        visibility_policy: "compact".to_string(),
        title: "Coordinate Friday Mission Spine".to_string(),
        status: "active".to_string(),
        truth_status: "wired_registry".to_string(),
        current_focus_summary: "same Mission, compact mobile view".to_string(),
        proof_refs: vec!["proof://sample/provider-ledger".to_string()],
        updated_at_ms: 1_700_100_000_010,
    };
    let desktop_projection = MissionSurfaceProjectionFfi {
        surface_thread_id: "surface-desktop-sample".to_string(),
        friday_conversation_id: fconv.clone(),
        mission_id: mission_id.clone(),
        surface_kind: "desktop".to_string(),
        visibility_policy: "rich_proof".to_string(),
        title: "Coordinate Friday Mission Spine".to_string(),
        status: "active".to_string(),
        truth_status: "wired_registry".to_string(),
        current_focus_summary: "same Mission, proof-rich desktop view".to_string(),
        proof_refs: vec!["proof://sample/provider-ledger".to_string()],
        updated_at_ms: 1_700_100_000_011,
    };
    let channel_projection = MissionSurfaceProjectionFfi {
        surface_thread_id: "surface-telegram-sample".to_string(),
        friday_conversation_id: fconv.clone(),
        mission_id: mission_id.clone(),
        surface_kind: "telegram".to_string(),
        visibility_policy: "status_only".to_string(),
        title: "Coordinate Friday Mission Spine".to_string(),
        status: "active".to_string(),
        truth_status: "wired_registry".to_string(),
        current_focus_summary: "same Mission, channel status view".to_string(),
        proof_refs: vec!["proof://sample/provider-ledger".to_string()],
        updated_at_ms: 1_700_100_000_012,
    };
    let route_decision = RouteDecisionProjectionFfi {
        route_decision_ref: "friday://route-decision-projection/sample/1".to_string(),
        mission_id: mission_id.clone(),
        work_item_id: completed_work.clone(),
        selected_lane: "deepseek".to_string(),
        selected_target_label: Some("bound_deepseek".to_string()),
        why_this_route: "answer the Mission-bound ask through the Hub-owned provider".to_string(),
        considered_options: vec![
            "new local chat".to_string(),
            "shared Mission timeline".to_string(),
        ],
        deferred_options: vec!["live UI/device proof".to_string()],
        previous_pitfalls: vec!["provider ack is not completion".to_string()],
        inheritable_context: vec!["carry judgment, not provider text".to_string()],
        conflict_ref_count: 1,
        proof_requirements: vec!["ledger and provider timeline proof".to_string()],
        ownership_claim_count: 0,
        trace_ref_count: 3,
        action_items: vec![],
        created_at_ms: 1_700_100_000_020,
        expires_at_ms: None,
    };

    vec![
        AskResponseFfi::Status {
            online: true,
            capabilities: vec![
                "mission_intake".to_string(),
                "mission_projection".to_string(),
                "mission_timeline".to_string(),
                "ask_friday".to_string(),
            ],
            min_version: 1,
            max_version: friday_protocol::CURRENT_SCHEMA_VERSION,
        },
        AskResponseFfi::MissionIntakeResult {
            friday_conversation_id: fconv.clone(),
            mission_id: mission_id.clone(),
            work_item_id: Some(completed_work.clone()),
            surface_thread_id: "surface-mobile-sample".to_string(),
            status: "ready".to_string(),
            blockers: Vec::new(),
            duplicate_mission_id: None,
            duplicate_work_item_id: None,
            created_or_ready: true,
        },
        AskResponseFfi::MissionIntakeResult {
            friday_conversation_id: fconv.clone(),
            mission_id: mission_id.clone(),
            work_item_id: Some(completed_work.clone()),
            surface_thread_id: "surface-desktop-sample".to_string(),
            status: "blocked".to_string(),
            blockers: vec!["duplicate_mission".to_string()],
            duplicate_mission_id: Some(mission_id.clone()),
            duplicate_work_item_id: Some(completed_work.clone()),
            created_or_ready: false,
        },
        AskResponseFfi::MissionProjectionSnapshot {
            friday_conversation_id: fconv.clone(),
            generated_at_ms: 1_700_100_000_030,
            projections: vec![
                mobile_projection.clone(),
                desktop_projection.clone(),
                channel_projection.clone(),
            ],
            route_decisions: vec![route_decision.clone()],
        },
        AskResponseFfi::MissionTimelineSnapshot {
            friday_conversation_id: fconv.clone(),
            mission_id: mission_id.clone(),
            generated_at_ms: 1_700_100_000_040,
            requested_cursor: Some("offset:0".to_string()),
            next_cursor: Some("offset:25".to_string()),
            retained_from: Some("offset:0".to_string()),
            bounded: true,
            has_more: true,
            mission: MissionTimelineMissionFfi {
                mission_id: mission_id.clone(),
                friday_conversation_id: fconv.clone(),
                title: "Coordinate Friday Mission Spine".to_string(),
                intent: "keep mobile, desktop, and channel on one Mission".to_string(),
                status: "active".to_string(),
                why_now: "avoid duplicate pinned chat debt".to_string(),
                decision_path_summary: "Mission first, provider/channel refs second".to_string(),
                proof_refs: vec!["proof://sample/provider-ledger".to_string()],
                updated_at_ms: 1_700_100_000_041,
            },
            projections: vec![mobile_projection, desktop_projection, channel_projection],
            work_items: vec![
                MissionTimelineWorkItemFfi {
                    work_item_id: completed_work.clone(),
                    mission_id: mission_id.clone(),
                    lane: "deepseek".to_string(),
                    status: "completed_with_proof".to_string(),
                    capability_id: Some("ask_friday.deepseek".to_string()),
                    risk_level: "low".to_string(),
                    approval_state: "not_required".to_string(),
                    has_blocker: false,
                    owner_claim_count: 0,
                    workspace_ref_count: 0,
                    input_ref_count: 1,
                    output_ref_count: 1,
                    proof_requirements: vec!["provider proof receipt required".to_string()],
                    proof_receipts: vec!["proof://sample/provider-ledger".to_string()],
                    updated_at_ms: 1_700_100_000_042,
                },
                MissionTimelineWorkItemFfi {
                    work_item_id: waiting_work.clone(),
                    mission_id: mission_id.clone(),
                    lane: "channel".to_string(),
                    status: "provider_waiting".to_string(),
                    capability_id: Some("channel.telegram.send".to_string()),
                    risk_level: "low".to_string(),
                    approval_state: "not_required".to_string(),
                    has_blocker: false,
                    owner_claim_count: 0,
                    workspace_ref_count: 0,
                    input_ref_count: 1,
                    output_ref_count: 0,
                    proof_requirements: vec!["channel delivery receipt required".to_string()],
                    proof_receipts: Vec::new(),
                    updated_at_ms: 1_700_100_000_043,
                },
            ],
            links: vec![
                MissionTimelineLinkFfi {
                    link_ref: "friday://mission-link-projection/sample/provider-proof".to_string(),
                    mission_id: mission_id.clone(),
                    work_item_id: Some(completed_work.clone()),
                    link_kind: "provider_timeline".to_string(),
                    has_proof: true,
                    proof_ref: Some("proof://sample/provider-ledger".to_string()),
                    grants_memory_authority: false,
                    created_at_ms: 1_700_100_000_044,
                },
                MissionTimelineLinkFfi {
                    link_ref: "friday://mission-link-projection/sample/memory-candidate"
                        .to_string(),
                    mission_id: mission_id.clone(),
                    work_item_id: None,
                    link_kind: "memory_candidate".to_string(),
                    has_proof: false,
                    proof_ref: None,
                    grants_memory_authority: false,
                    created_at_ms: 1_700_100_000_045,
                },
                MissionTimelineLinkFfi {
                    link_ref: "friday://mission-link-projection/sample/channel-inbound".to_string(),
                    mission_id: mission_id.clone(),
                    work_item_id: Some(waiting_work.clone()),
                    link_kind: "channel_inbound".to_string(),
                    has_proof: true,
                    proof_ref: Some("audit://sample/channel-redacted".to_string()),
                    grants_memory_authority: false,
                    created_at_ms: 1_700_100_000_046,
                },
            ],
            route_decisions: vec![route_decision],
            surface_events: vec![
                MissionTimelineSurfaceEventFfi {
                    surface_event_id: "surf-event-mobile-sample".to_string(),
                    friday_conversation_id: fconv.clone(),
                    mission_id: mission_id.clone(),
                    work_item_id: Some(completed_work.clone()),
                    surface_thread_id: "surface-mobile-sample".to_string(),
                    source_surface: "mobile".to_string(),
                    event_kind: "user_message".to_string(),
                    body_ref: Some("friday://body/sample/mobile-message".to_string()),
                    visibility_policy: "compact".to_string(),
                    proof_ref: Some("audit://sample/surface-mobile-redacted".to_string()),
                    created_at_ms: 1_700_100_000_047,
                },
                MissionTimelineSurfaceEventFfi {
                    surface_event_id: "surf-event-desktop-duplicate-sample".to_string(),
                    friday_conversation_id: fconv,
                    mission_id,
                    work_item_id: Some(completed_work),
                    surface_thread_id: "surface-desktop-sample".to_string(),
                    source_surface: "desktop".to_string(),
                    event_kind: "duplicate_blocked".to_string(),
                    body_ref: Some("friday://body/sample/desktop-duplicate".to_string()),
                    visibility_policy: "rich_proof".to_string(),
                    proof_ref: Some("audit://sample/surface-desktop-redacted".to_string()),
                    created_at_ms: 1_700_100_000_048,
                },
            ],
        },
        AskResponseFfi::OfflineAck {
            acked_msg_id: "offline-msg-sample".to_string(),
        },
        AskResponseFfi::Error {
            code: "PROVIDER_UNAVAILABLE".to_string(),
            message: "ask route unavailable (sample; no fallback)".to_string(),
        },
    ]
}

/// Parse a Hub→phone response envelope (the plaintext the native transport just opened) into
/// the safe [`AskResponseFfi`] projection. Decoding stays in `friday-protocol`; an undecodable
/// or out-of-slice frame is truth-labeled, never silently treated as a completed result.
#[uniffi::export]
pub fn parse_hub_response(wire_json: String) -> AskResponseFfi {
    use friday_protocol::Message;
    let env = match friday_protocol::Envelope::decode(&wire_json) {
        Ok(e) => e,
        Err(e) => {
            return AskResponseFfi::Undecodable {
                error: e.to_string(),
            }
        }
    };
    let correlation_id = env.correlation_id.unwrap_or_default();
    match env.message {
        Message::HubStatus {
            online,
            capabilities,
            min_version,
            max_version,
        } => AskResponseFfi::Status {
            online,
            capabilities,
            min_version,
            max_version,
        },
        Message::AskFridayResult {
            ledger_id,
            result_link,
        } => AskResponseFfi::AskResult {
            ledger_id,
            result_link: result_link.unwrap_or_default(),
            correlation_id,
        },
        // Drop `base_url_host` (Hub-side trust/infra detail) — the cost view needs only these,
        // matching `phone_token_usage`/`TokenUsageFfi`.
        Message::LedgerEntry {
            ledger_id,
            provider_kind,
            model,
            total_tokens,
            fallback,
            ..
        } => AskResponseFfi::LedgerRef {
            ledger_id,
            provider_kind,
            model,
            total_tokens,
            fallback,
        },
        Message::ActivityItem {
            activity_id,
            item_type,
            state,
        } => AskResponseFfi::ActivityRef {
            activity_id,
            item_type,
            state,
        },
        Message::OfflineQueueAck { acked_msg_id } => AskResponseFfi::OfflineAck { acked_msg_id },
        Message::MissionIntakeResult { result } => AskResponseFfi::MissionIntakeResult {
            friday_conversation_id: result.friday_conversation_id,
            mission_id: result.mission_id,
            work_item_id: result.work_item_id,
            surface_thread_id: result.surface_thread_id,
            status: result.status,
            blockers: result.blockers,
            duplicate_mission_id: result.duplicate_mission_id,
            duplicate_work_item_id: result.duplicate_work_item_id,
            created_or_ready: result.created_or_ready,
        },
        Message::MissionProjectionSnapshot { snapshot } => {
            AskResponseFfi::MissionProjectionSnapshot {
                friday_conversation_id: snapshot.friday_conversation_id,
                generated_at_ms: snapshot.generated_at_ms,
                projections: snapshot.projections.into_iter().map(Into::into).collect(),
                route_decisions: snapshot
                    .route_decisions
                    .into_iter()
                    .map(Into::into)
                    .collect(),
            }
        }
        Message::MissionTimelineSnapshot { snapshot } => AskResponseFfi::MissionTimelineSnapshot {
            friday_conversation_id: snapshot.friday_conversation_id,
            mission_id: snapshot.mission_id,
            generated_at_ms: snapshot.generated_at_ms,
            requested_cursor: snapshot.requested_cursor,
            next_cursor: snapshot.next_cursor,
            retained_from: snapshot.retained_from,
            bounded: snapshot.bounded,
            has_more: snapshot.has_more,
            mission: snapshot.mission.into(),
            projections: snapshot.projections.into_iter().map(Into::into).collect(),
            work_items: snapshot.work_items.into_iter().map(Into::into).collect(),
            links: snapshot.links.into_iter().map(Into::into).collect(),
            route_decisions: snapshot
                .route_decisions
                .into_iter()
                .map(Into::into)
                .collect(),
            surface_events: snapshot
                .surface_events
                .into_iter()
                .map(Into::into)
                .collect(),
        },
        Message::MissionLifecycleResult { result } => AskResponseFfi::MissionLifecycleResult {
            friday_conversation_id: result.friday_conversation_id,
            mission_id: result.mission_id,
            previous_status: result.previous_status,
            status: result.status,
            actor_ref: result.actor_ref,
            reason: result.reason,
            proof_ref: result.proof_ref,
            merged_into_mission_id: result.merged_into_mission_id,
            active_mission_ids: result.active_mission_ids,
            updated_at_ms: result.updated_at_ms,
        },
        Message::Error { code, message } => AskResponseFfi::Error {
            code: error_code_str(code).to_string(),
            message,
        },
        other => AskResponseFfi::Unsupported {
            kind: message_kind_name(&other).to_string(),
        },
    }
}

/// The wire (`SCREAMING_SNAKE_CASE`) name of an error code — surfaced, never hidden.
fn error_code_str(code: friday_protocol::ErrorCode) -> &'static str {
    use friday_protocol::ErrorCode as E;
    match code {
        E::PairingDenied => "PAIRING_DENIED",
        E::DeviceRevoked => "DEVICE_REVOKED",
        E::SchemaVersionUnsupported => "SCHEMA_VERSION_UNSUPPORTED",
        E::HubOffline => "HUB_OFFLINE",
        E::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
        E::RateLimited => "RATE_LIMITED",
        E::IdempotencyReplay => "IDEMPOTENCY_REPLAY",
        E::Internal => "INTERNAL",
    }
}

/// Truth label for an out-of-slice message kind. The exhaustive match is intentional: a new
/// protocol message variant forces this to be updated (it cannot drift to a silent "other").
fn message_kind_name(m: &friday_protocol::Message) -> &'static str {
    use friday_protocol::Message as M;
    match m {
        M::Pair { .. } => "Pair",
        M::PairAck { .. } => "PairAck",
        M::HubStatus { .. } => "HubStatus",
        M::AskFridayRequest { .. } => "AskFridayRequest",
        M::AskFridayStream { .. } => "AskFridayStream",
        M::AskFridayResult { .. } => "AskFridayResult",
        M::LedgerEntry { .. } => "LedgerEntry",
        M::ActivityItem { .. } => "ActivityItem",
        M::OfflineQueueAck { .. } => "OfflineQueueAck",
        M::ProviderWorkspaceSnapshot { .. } => "ProviderWorkspaceSnapshot",
        M::ProviderWorkspaceActionRequest { .. } => "ProviderWorkspaceActionRequest",
        M::ProviderWorkspaceActionResult { .. } => "ProviderWorkspaceActionResult",
        M::ProviderTimelineReconnect { .. } => "ProviderTimelineReconnect",
        M::MissionProjectionRequest { .. } => "MissionProjectionRequest",
        M::MissionIntakeRequest { .. } => "MissionIntakeRequest",
        M::MissionIntakeResult { .. } => "MissionIntakeResult",
        M::MissionProjectionSnapshot { .. } => "MissionProjectionSnapshot",
        M::MissionTimelineRequest { .. } => "MissionTimelineRequest",
        M::MissionTimelineSnapshot { .. } => "MissionTimelineSnapshot",
        M::MissionLifecycleRequest { .. } => "MissionLifecycleRequest",
        M::MissionLifecycleResult { .. } => "MissionLifecycleResult",
        M::WorkItemStatusRequest { .. } => "WorkItemStatusRequest",
        M::WorkItemStatusResult { .. } => "WorkItemStatusResult",
        // D20 W1-S3 route-decision control rides the sealed Mission-Spine dispatch arm, not FFI.
        // Keep it named here so unsupported out-of-slice envelopes remain truth-labeled and this
        // exhaustive match catches future protocol variants.
        M::RouteDecisionControlRequest { .. } => "RouteDecisionControlRequest",
        M::RouteDecisionControlResult { .. } => "RouteDecisionControlResult",
        // S-R1 — the DARK sealed-WS READ-seam projection kinds. NAMED here so the exhaustive match
        // holds and the truth label carries the real kind; nothing on the FFI surface constructs or
        // dispatches them (the UI reads them directly over the sealed-WS read server, not via FFI).
        M::WorkbenchProjectionRequest { .. } => "WorkbenchProjectionRequest",
        M::WorkbenchProjectionSnapshot { .. } => "WorkbenchProjectionSnapshot",
        // S-R2/S-R3 — the DARK sealed-WS READ-seam sibling projection kinds (run-readback +
        // providers-doctor). NAMED here for the same reason as S-R1: nothing on the FFI surface
        // constructs/dispatches them (the UI reads them directly over the sealed-WS read server),
        // but naming them keeps this match exhaustive and carries the real kind in the truth label.
        M::RunReadbackRequest { .. } => "RunReadbackRequest",
        M::RunReadbackSnapshot { .. } => "RunReadbackSnapshot",
        M::RunAnswerBodyRequest { .. } => "RunAnswerBodyRequest",
        M::RunAnswerBodySnapshot { .. } => "RunAnswerBodySnapshot",
        M::ProvidersDoctorRequest { .. } => "ProvidersDoctorRequest",
        M::ProvidersDoctorSnapshot { .. } => "ProvidersDoctorSnapshot",
        M::CapabilityDoctorRequest { .. } => "CapabilityDoctorRequest",
        M::CapabilityDoctorSnapshot { .. } => "CapabilityDoctorSnapshot",
        // C2I-PR2 — the 5 DARK sealed-WS READ-seam owner-gated C2 read-plane kinds. NAMED here for
        // the same reason as S-R1/S-R2/S-R3: nothing on the FFI surface constructs/dispatches them
        // (the UI reads them directly over the sealed-WS read server), but naming them keeps this
        // match exhaustive and carries the real kind in the truth label.
        M::SessionListRequest { .. } => "SessionListRequest",
        M::SessionListSnapshot { .. } => "SessionListSnapshot",
        M::SessionOpenRequest { .. } => "SessionOpenRequest",
        M::SessionOpenSnapshot { .. } => "SessionOpenSnapshot",
        M::SessionLinkStateRequest { .. } => "SessionLinkStateRequest",
        M::SessionLinkStateSnapshot { .. } => "SessionLinkStateSnapshot",
        M::RunFileViewRequest { .. } => "RunFileViewRequest",
        M::RunFileViewSnapshot { .. } => "RunFileViewSnapshot",
        M::ActivityNeedsMeRequest { .. } => "ActivityNeedsMeRequest",
        M::ActivityNeedsMeSnapshot { .. } => "ActivityNeedsMeSnapshot",
        // Activity mark-done rides the sealed-WS write surface, not FFI. Keep it named so
        // unsupported out-of-slice envelopes carry their real truth label.
        M::ActivityMarkDoneRequest { .. } => "ActivityMarkDoneRequest",
        M::ActivityMarkDoneResult { .. } => "ActivityMarkDoneResult",
        // ContextPassport transfer rides the sealed-WS write surface, not FFI. Keep it named so
        // unsupported out-of-slice envelopes carry their real truth label.
        M::ContextPassportTransferRequest { .. } => "ContextPassportTransferRequest",
        M::ContextPassportTransferResult { .. } => "ContextPassportTransferResult",
        // WS-transport substrate (S-A..S-F) message kinds. Still DARK on the FFI
        // surface (nothing here constructs or dispatches them), but they are
        // NAMED so the truth label carries the real kind — and so this match
        // stays exhaustive: the next protocol variant is a compile error here,
        // it cannot silently fall through a wildcard.
        M::AgentRunRequest { .. } => "AgentRunRequest",
        M::AgentRunResult { .. } => "AgentRunResult",
        // A1 run-controls (v13) — the on-wire control protocol. DARK on the FFI surface (nothing
        // here constructs or dispatches them); NAMED so the truth label carries the real kind and
        // this match stays exhaustive.
        M::AgentRunPaused { .. } => "AgentRunPaused",
        M::AgentRunResume { .. } => "AgentRunResume",
        M::AgentRunCancel { .. } => "AgentRunCancel",
        M::AgentRunReject { .. } => "AgentRunReject",
        M::AgentRunControlResult { .. } => "AgentRunControlResult",
        // Memory-confirmation loop terminal arm. DARK on the FFI surface (nothing here constructs or
        // dispatches them — the owner-authed decision rides the sealed-WS agent-run server arm gated
        // by FRIDAY_MEMORY_CONFIRM); NAMED so the truth label carries the real kind and this match
        // stays exhaustive.
        M::MemoryDecisionRequest { .. } => "MemoryDecisionRequest",
        M::MemoryDecisionResult { .. } => "MemoryDecisionResult",
        // (CORE-A CR-3) Session create/append lifecycle. DARK on the FFI surface (nothing here
        // constructs or dispatches them — they ride the FLAGLESS sealed-WS agent-run server arms);
        // NAMED so unsupported envelopes keep the real kind and this match stays exhaustive.
        M::SessionCreateRequest { .. } => "SessionCreateRequest",
        M::SessionCreateResult { .. } => "SessionCreateResult",
        M::SessionMessageAppendRequest { .. } => "SessionMessageAppendRequest",
        M::SessionMessageAppendResult { .. } => "SessionMessageAppendResult",
        // A1 run-outcome learning terminal decision arm. DARK on the FFI surface (the owner-authed
        // decision rides the sealed-WS agent-run server arm gated by
        // FRIDAY_RUN_OUTCOME_LEARNING_CONFIRM); NAMED so unsupported envelopes keep the real kind.
        M::RunOutcomeLearningDecisionRequest { .. } => "RunOutcomeLearningDecisionRequest",
        M::RunOutcomeLearningDecisionResult { .. } => "RunOutcomeLearningDecisionResult",
        M::Error { .. } => "Error",
    }
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
        assert_eq!(
            connection_truth_label(ConnStateFfi::Direct),
            "connected".to_string()
        );
        assert_eq!(
            connection_truth_label(ConnStateFfi::Relay),
            "connected".to_string()
        );
        assert_eq!(
            connection_truth_label(ConnStateFfi::Connecting),
            "reconnecting".to_string()
        );
        assert_eq!(
            connection_truth_label(ConnStateFfi::Stale),
            "stale".to_string()
        );
        assert_eq!(
            connection_truth_label(ConnStateFfi::Disconnected),
            "offline".to_string()
        );
        let _ = new_data_key();
    }

    #[test]
    fn ffi_status_semantics_keep_ack_blocked_and_candidates_out_of_done() {
        for state in ["queued", "acked"] {
            assert_eq!(offline_action_truth_label(state.to_string()), "queued");
            assert!(!offline_action_state_implies_completion(state.to_string()));
        }
        assert_eq!(
            offline_action_truth_label("executed".to_string()),
            "executed"
        );
        assert!(offline_action_state_implies_completion(
            "executed".to_string()
        ));
        assert_eq!(offline_action_truth_label("failed".to_string()), "failed");
        assert!(!offline_action_state_implies_completion(
            "failed".to_string()
        ));
        assert_eq!(offline_action_truth_label("mystery".to_string()), "unknown");
        assert!(!offline_action_state_implies_completion(
            "mystery".to_string()
        ));

        assert!(mission_intake_allows_new_work("ready".to_string(), true));
        assert!(!mission_intake_allows_new_work("ready".to_string(), false));
        assert!(!mission_intake_allows_new_work(
            "blocked".to_string(),
            false
        ));
        assert!(mission_intake_should_open_existing(
            "blocked".to_string(),
            Some("mission-1".to_string()),
            None
        ));
        assert!(mission_intake_should_open_existing(
            "blocked".to_string(),
            None,
            Some("work-1".to_string())
        ));
        assert!(!mission_intake_should_open_existing(
            "ready".to_string(),
            Some("mission-1".to_string()),
            None
        ));

        for status in [
            "draft",
            "preflight_blocked",
            "waiting_for_user",
            "ready_to_dispatch",
            "dispatched",
            "hub_accepted",
            "provider_routed",
            "provider_waiting",
            "failed_retryable",
        ] {
            assert!(
                !mission_work_item_status_implies_completion(status.to_string()),
                "{status} must not be rendered as done"
            );
            assert!(
                !mission_work_item_status_is_terminal(status.to_string()),
                "{status} must not be terminal"
            );
        }
        assert!(mission_work_item_status_implies_completion(
            "completed_with_proof".to_string()
        ));
        assert!(mission_work_item_status_is_terminal(
            "completed_with_proof".to_string()
        ));
        for terminal_not_done in ["failed_terminal", "cancelled", "merged", "archived"] {
            assert!(!mission_work_item_status_implies_completion(
                terminal_not_done.to_string()
            ));
            assert!(mission_work_item_status_is_terminal(
                terminal_not_done.to_string()
            ));
        }

        assert!(!mission_timeline_link_grants_confirmed_memory_authority(
            "memory_candidate".to_string(),
            false
        ));
        assert!(!mission_timeline_link_grants_confirmed_memory_authority(
            "memory_candidate".to_string(),
            true
        ));
        assert!(!mission_timeline_link_grants_confirmed_memory_authority(
            "memory_decision".to_string(),
            true
        ));
        assert!(mission_timeline_link_grants_confirmed_memory_authority(
            "confirmed_memory".to_string(),
            true
        ));
    }

    #[test]
    fn ffi_protocol_version_helpers() {
        assert_eq!(
            protocol_schema_version(),
            friday_protocol::CURRENT_SCHEMA_VERSION
        );
        assert_eq!(negotiate_schema_version(1, 4, 2, 5), Some(4));
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
                owner: None,
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
    fn ffi_sample_mission_spine_responses_cover_wire_ui_contracts() {
        let responses = sample_mission_spine_responses();
        assert!(responses.len() >= 7);
        let mut mission_id = None::<String>;
        let mut saw_ready = false;
        let mut saw_duplicate_block = false;
        let mut saw_projection = false;
        let mut saw_timeline = false;
        let mut saw_offline_ack = false;
        let mut saw_error = false;

        for response in &responses {
            match response {
                AskResponseFfi::MissionIntakeResult {
                    mission_id: id,
                    status,
                    created_or_ready,
                    duplicate_mission_id,
                    duplicate_work_item_id,
                    ..
                } => {
                    mission_id.get_or_insert_with(|| id.clone());
                    assert_eq!(mission_id.as_deref(), Some(id.as_str()));
                    if status == "ready" {
                        saw_ready = true;
                        assert!(mission_intake_allows_new_work(
                            status.clone(),
                            *created_or_ready
                        ));
                    }
                    if status == "blocked" {
                        saw_duplicate_block = true;
                        assert!(mission_intake_should_open_existing(
                            status.clone(),
                            duplicate_mission_id.clone(),
                            duplicate_work_item_id.clone()
                        ));
                    }
                }
                AskResponseFfi::MissionProjectionSnapshot { projections, .. } => {
                    saw_projection = true;
                    assert_eq!(projections.len(), 3);
                    let id = mission_id.as_deref().expect("intake before projection");
                    assert!(projections
                        .iter()
                        .all(|projection| projection.mission_id == id));
                    assert!(projections
                        .iter()
                        .any(|projection| projection.surface_kind == "mobile"));
                    assert!(projections
                        .iter()
                        .any(|projection| projection.surface_kind == "desktop"));
                    assert!(projections
                        .iter()
                        .any(|projection| projection.surface_kind == "telegram"));
                }
                AskResponseFfi::MissionTimelineSnapshot {
                    mission_id: id,
                    bounded,
                    has_more,
                    work_items,
                    links,
                    surface_events,
                    ..
                } => {
                    saw_timeline = true;
                    assert_eq!(mission_id.as_deref(), Some(id.as_str()));
                    assert!(*bounded);
                    assert!(*has_more);
                    assert!(work_items.iter().any(|item| {
                        item.status == "completed_with_proof"
                            && mission_work_item_status_implies_completion(item.status.clone())
                    }));
                    assert!(work_items.iter().any(|item| {
                        item.status == "provider_waiting"
                            && !mission_work_item_status_implies_completion(item.status.clone())
                            && !mission_work_item_status_is_terminal(item.status.clone())
                    }));
                    assert!(links.iter().any(|link| {
                        link.link_kind == "provider_timeline"
                            && link.has_proof
                            && !mission_timeline_link_grants_confirmed_memory_authority(
                                link.link_kind.clone(),
                                link.grants_memory_authority,
                            )
                    }));
                    assert!(links.iter().any(|link| {
                        link.link_kind == "memory_candidate"
                            && !mission_timeline_link_grants_confirmed_memory_authority(
                                link.link_kind.clone(),
                                true,
                            )
                    }));
                    assert!(surface_events
                        .iter()
                        .any(|event| event.source_surface == "mobile"));
                    assert!(surface_events.iter().any(|event| {
                        event.source_surface == "desktop" && event.event_kind == "duplicate_blocked"
                    }));
                }
                AskResponseFfi::OfflineAck { acked_msg_id } => {
                    saw_offline_ack = true;
                    assert_eq!(
                        offline_action_truth_label("acked".to_string()),
                        "queued".to_string()
                    );
                    assert!(!acked_msg_id.is_empty());
                }
                AskResponseFfi::Error { code, message } => {
                    saw_error = true;
                    assert_eq!(code, "PROVIDER_UNAVAILABLE");
                    assert!(message.contains("no fallback"));
                }
                _ => {}
            }
        }

        assert!(saw_ready);
        assert!(saw_duplicate_block);
        assert!(saw_projection);
        assert!(saw_timeline);
        assert!(saw_offline_ack);
        assert!(saw_error);
        let debug = format!("{responses:?}");
        for forbidden in [
            "sk-",
            "Authorization",
            "Bearer",
            "raw-chat",
            "raw transcript",
            "provider-token",
            "/Users/example/private",
        ] {
            assert!(
                !debug.contains(forbidden),
                "sample Mission Spine fixture leaked {forbidden}: {debug}"
            );
        }
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

    // --- Phase 3: native-facing ask_friday CLIENT ACTION contract ---

    #[test]
    fn ffi_detached_ask_friday_request_is_blocked_before_wire_payload() {
        let r = build_ask_friday_request("cmsg-1".into(), "hello friday".into(), 7);
        assert!(!r.ok);
        assert_eq!(r.client_msg_id, "cmsg-1");
        assert!(r.error.contains("requires Mission context"));
        assert!(r.wire_json.is_empty());
    }

    #[test]
    fn ffi_mission_ask_friday_request_carries_canonical_mission_context() {
        let r = build_mission_ask_friday_request(
            "cmsg-mission-ask".into(),
            "answer in Friday context".into(),
            "fconv_mobile_desktop".into(),
            "mission-ask".into(),
            "work-ask".into(),
            9,
        );
        assert!(r.ok, "build failed: {}", r.error);
        let env = friday_protocol::Envelope::decode(&r.wire_json).unwrap();
        match env.message {
            friday_protocol::Message::AskFridayRequest {
                prompt,
                mission_context,
            } => {
                assert_eq!(prompt, "answer in Friday context");
                let context = mission_context.expect("mission context");
                assert_eq!(context.friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(context.mission_id, "mission-ask");
                assert_eq!(context.work_item_id, "work-ask");
            }
            other => panic!("expected AskFridayRequest, got {other:?}"),
        }
    }

    #[test]
    fn ffi_mission_ask_friday_request_validates_context_before_wire() {
        let bad_conversation = build_mission_ask_friday_request(
            "cmsg-bad".into(),
            "x".into(),
            "codex-thread-raw".into(),
            "mission-ask".into(),
            "work-ask".into(),
            9,
        );
        assert!(!bad_conversation.ok);
        assert!(bad_conversation.wire_json.is_empty());
        assert!(bad_conversation.error.contains("non-canonical"));

        let bad_work = build_mission_ask_friday_request(
            "cmsg-bad-work".into(),
            "x".into(),
            "fconv_mobile_desktop".into(),
            "mission-ask".into(),
            " ".into(),
            9,
        );
        assert!(!bad_work.ok);
        assert_eq!(bad_work.error, "mission ask work_item_id required");
    }

    #[test]
    fn ffi_mission_intake_request_validates_and_carries_surface_preflight_context() {
        let r = build_mission_intake_request(
            "cmsg-intake".into(),
            "fconv_mobile_desktop".into(),
            "principal:jarvis".into(),
            "surface-mobile-1".into(),
            "mobile".into(),
            "mobile://local/thread/1".into(),
            "compact".into(),
            "mission-intake".into(),
            "work-intake".into(),
            "Coordinate Friday".into(),
            "resolve this request across surfaces".into(),
            "deepseek".into(),
            Some("deepseek".into()),
            Some("ask_friday.deepseek".into()),
            Some("friday://body/mobile/intake-1".into()),
            true,
            10,
        );
        assert!(r.ok, "build failed: {}", r.error);
        let env = friday_protocol::Envelope::decode(&r.wire_json).unwrap();
        assert_eq!(env.msg_id, "cmsg-intake");
        assert_eq!(env.schema_version, friday_protocol::CURRENT_SCHEMA_VERSION);
        match env.message {
            friday_protocol::Message::MissionIntakeRequest { request } => {
                assert_eq!(request.friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(request.owner_principal, "principal:jarvis");
                assert_eq!(request.surface_thread_id, "surface-mobile-1");
                assert_eq!(request.surface_kind, "mobile");
                assert_eq!(request.visibility_policy, "compact");
                assert_eq!(request.mission_id, "mission-intake");
                assert_eq!(request.work_item_id, "work-intake");
                assert_eq!(request.intent, "resolve this request across surfaces");
                assert_eq!(request.lane, "deepseek");
                assert_eq!(
                    request.target_provider_or_agent.as_deref(),
                    Some("deepseek")
                );
                assert_eq!(
                    request.capability_id.as_deref(),
                    Some("ask_friday.deepseek")
                );
                assert_eq!(
                    request.body_ref.as_deref(),
                    Some("friday://body/mobile/intake-1")
                );
                assert!(request.includes_sensitive_context);
            }
            other => panic!("expected MissionIntakeRequest, got {other:?}"),
        }

        let bad_body = build_mission_intake_request(
            "cmsg-intake-bad-body".into(),
            "fconv_mobile_desktop".into(),
            "principal:jarvis".into(),
            "surface-mobile-1".into(),
            "mobile".into(),
            "mobile://local/thread/1".into(),
            "compact".into(),
            "mission-intake".into(),
            "work-intake".into(),
            "Coordinate Friday".into(),
            "resolve this request across surfaces".into(),
            "deepseek".into(),
            Some("deepseek".into()),
            Some("ask_friday.deepseek".into()),
            Some("https://raw-provider.example/body".into()),
            false,
            10,
        );
        assert!(!bad_body.ok);
        assert!(bad_body.wire_json.is_empty());
        assert!(bad_body.error.contains("Friday-owned body/blob ref"));

        let bad_surface = build_mission_intake_request(
            "cmsg-intake-bad-surface".into(),
            "fconv_mobile_desktop".into(),
            "principal:jarvis".into(),
            "surface-mobile-1".into(),
            "provider_raw_chat".into(),
            "mobile://local/thread/1".into(),
            "compact".into(),
            "mission-intake".into(),
            "work-intake".into(),
            "Coordinate Friday".into(),
            "resolve this request across surfaces".into(),
            "deepseek".into(),
            None,
            None,
            None,
            false,
            10,
        );
        assert!(!bad_surface.ok);
        assert_eq!(bad_surface.error, "mission intake surface_kind unknown");
    }

    #[test]
    fn ffi_mission_projection_request_validates_canonical_conversation_id() {
        let r = build_mission_projection_request(
            "mission-proj-req".into(),
            "fconv_mobile_desktop".into(),
            7,
        );
        assert!(r.ok, "build failed: {}", r.error);
        let env = friday_protocol::Envelope::decode(&r.wire_json).unwrap();
        assert_eq!(env.schema_version, friday_protocol::CURRENT_SCHEMA_VERSION);
        match env.message {
            friday_protocol::Message::MissionProjectionRequest { request } => {
                assert_eq!(request.friday_conversation_id, "fconv_mobile_desktop");
            }
            other => panic!("expected MissionProjectionRequest, got {other:?}"),
        }

        let bad = build_mission_projection_request(
            "mission-proj-bad".into(),
            "provider-thread-123".into(),
            8,
        );
        assert!(!bad.ok);
        assert!(bad.error.contains("non-canonical Friday conversation id"));
        assert!(bad.wire_json.is_empty());
    }

    #[test]
    fn ffi_mission_timeline_request_validates_canonical_conversation_and_mission_id() {
        let r = build_mission_timeline_request(
            "mission-timeline-req".into(),
            "fconv_mobile_desktop".into(),
            "mission-1".into(),
            9,
        );
        assert!(r.ok, "build failed: {}", r.error);
        let env = friday_protocol::Envelope::decode(&r.wire_json).unwrap();
        assert_eq!(env.schema_version, friday_protocol::CURRENT_SCHEMA_VERSION);
        match env.message {
            friday_protocol::Message::MissionTimelineRequest { request } => {
                assert_eq!(request.friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(request.mission_id, "mission-1");
                assert_eq!(request.cursor, None);
                assert_eq!(request.limit, None);
            }
            other => panic!("expected MissionTimelineRequest, got {other:?}"),
        }

        let bad_conversation = build_mission_timeline_request(
            "mission-timeline-bad-conv".into(),
            "provider-thread-123".into(),
            "mission-1".into(),
            10,
        );
        assert!(!bad_conversation.ok);
        assert!(bad_conversation
            .error
            .contains("non-canonical Friday conversation id"));
        assert!(bad_conversation.wire_json.is_empty());

        let bad_mission = build_mission_timeline_request(
            "mission-timeline-bad-mission".into(),
            "fconv_mobile_desktop".into(),
            "   ".into(),
            11,
        );
        assert!(!bad_mission.ok);
        assert!(bad_mission.error.contains("mission_id required"));
        assert!(bad_mission.wire_json.is_empty());

        let bounded = build_bounded_mission_timeline_request(
            "mission-timeline-bounded".into(),
            "fconv_mobile_desktop".into(),
            "mission-1".into(),
            Some("offset:2".into()),
            Some(25),
            12,
        );
        assert!(bounded.ok, "build failed: {}", bounded.error);
        let env = friday_protocol::Envelope::decode(&bounded.wire_json).unwrap();
        match env.message {
            friday_protocol::Message::MissionTimelineRequest { request } => {
                assert_eq!(request.friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(request.mission_id, "mission-1");
                assert_eq!(request.cursor.as_deref(), Some("offset:2"));
                assert_eq!(request.limit, Some(25));
            }
            other => panic!("expected bounded MissionTimelineRequest, got {other:?}"),
        }

        let zero_limit = build_bounded_mission_timeline_request(
            "mission-timeline-zero".into(),
            "fconv_mobile_desktop".into(),
            "mission-1".into(),
            None,
            Some(0),
            13,
        );
        assert!(!zero_limit.ok);
        assert!(zero_limit.error.contains("limit must be greater than 0"));
        assert!(zero_limit.wire_json.is_empty());
    }

    #[test]
    fn ffi_mission_lifecycle_request_validates_and_round_trips() {
        let r = build_mission_lifecycle_request(
            "mission-lifecycle-req".into(),
            "fconv_mobile_desktop".into(),
            "mission-1".into(),
            "paused".into(),
            "operator:jarvis".into(),
            "pause before duplicate route review".into(),
            Some("audit://mission-lifecycle/pause".into()),
            None,
            12,
        );
        assert!(r.ok, "build failed: {}", r.error);
        let env = friday_protocol::Envelope::decode(&r.wire_json).unwrap();
        assert_eq!(env.schema_version, friday_protocol::CURRENT_SCHEMA_VERSION);
        match env.message {
            friday_protocol::Message::MissionLifecycleRequest { request } => {
                assert_eq!(request.friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(request.mission_id, "mission-1");
                assert_eq!(request.target_status, "paused");
                assert_eq!(request.actor_ref, "operator:jarvis");
                assert_eq!(request.reason, "pause before duplicate route review");
                assert_eq!(
                    request.proof_ref.as_deref(),
                    Some("audit://mission-lifecycle/pause")
                );
            }
            other => panic!("expected MissionLifecycleRequest, got {other:?}"),
        }

        let fake_done = build_mission_lifecycle_request(
            "mission-lifecycle-fake-done".into(),
            "fconv_mobile_desktop".into(),
            "mission-1".into(),
            "done".into(),
            "operator:jarvis".into(),
            "done needs proof".into(),
            None,
            None,
            13,
        );
        assert!(!fake_done.ok);
        assert_eq!(fake_done.error, "mission lifecycle done requires proof_ref");
        assert!(fake_done.wire_json.is_empty());

        let bad_merge = build_mission_lifecycle_request(
            "mission-lifecycle-bad-merge".into(),
            "fconv_mobile_desktop".into(),
            "mission-1".into(),
            "merged".into(),
            "operator:jarvis".into(),
            "merge needs target".into(),
            Some("audit://mission-lifecycle/merge".into()),
            None,
            14,
        );
        assert!(!bad_merge.ok);
        assert_eq!(
            bad_merge.error,
            "mission lifecycle merged requires merged_into_mission_id"
        );
    }

    #[test]
    fn ffi_ask_friday_idempotency_key_is_stable_across_retries() {
        // Idempotency contract: a retry reuses the SAME client_msg_id, so the envelope msg_id
        // (the dedup key) is identical even when sent_at differs. End-to-end dedup is NOT yet
        // enforced Hub-side — this only proves the key the Hub WOULD dedup on is stable.
        let a = build_mission_ask_friday_request(
            "retry-7".into(),
            "do x".into(),
            "fconv_retry".into(),
            "mission-retry".into(),
            "work-retry".into(),
            100,
        );
        let b = build_mission_ask_friday_request(
            "retry-7".into(),
            "do x".into(),
            "fconv_retry".into(),
            "mission-retry".into(),
            "work-retry".into(),
            999,
        );
        assert!(a.ok, "first build failed: {}", a.error);
        assert!(b.ok, "retry build failed: {}", b.error);
        let ea = friday_protocol::Envelope::decode(&a.wire_json).unwrap();
        let eb = friday_protocol::Envelope::decode(&b.wire_json).unwrap();
        assert_eq!(
            ea.msg_id, eb.msg_id,
            "the idempotency key must be stable across retries"
        );
        assert_ne!(
            ea.sent_at, eb.sent_at,
            "sent_at may differ; the dedup key does not"
        );
    }

    #[test]
    fn ffi_parse_hub_response_projects_safely_and_truth_labels() {
        use friday_protocol::{Envelope, ErrorCode, Message};

        // AskResult → refs only; correlation preserved; the struct has no answer-body field.
        let result = Envelope::new(
            "r1",
            1,
            Message::AskFridayResult {
                ledger_id: "ask-1".into(),
                result_link: Some("friday://activity/ask-1:activity".into()),
            },
        )
        .with_correlation("cmsg-1");
        match parse_hub_response(result.encode().unwrap()) {
            AskResponseFfi::AskResult {
                ledger_id,
                result_link,
                correlation_id,
            } => {
                assert_eq!(ledger_id, "ask-1");
                assert_eq!(result_link, "friday://activity/ask-1:activity");
                assert_eq!(correlation_id, "cmsg-1");
            }
            other => panic!("expected AskResult, got {other:?}"),
        }

        // Status snapshot — no model call implied.
        let status = Envelope::new(
            "s1",
            0,
            Message::HubStatus {
                online: true,
                capabilities: vec!["ask_friday".into()],
                min_version: 1,
                max_version: friday_protocol::CURRENT_SCHEMA_VERSION,
            },
        );
        assert!(matches!(
            parse_hub_response(status.encode().unwrap()),
            AskResponseFfi::Status { online: true, .. }
        ));

        let mission_intake = Envelope::new(
            "mission-intake",
            0,
            Message::MissionIntakeResult {
                result: friday_protocol::MissionIntakeResultWire {
                    friday_conversation_id: "fconv_mobile_desktop".into(),
                    mission_id: "mission-1".into(),
                    work_item_id: Some("work-1".into()),
                    surface_thread_id: "surface-desktop".into(),
                    status: "blocked".into(),
                    blockers: vec!["duplicate_mission".into()],
                    duplicate_mission_id: Some("mission-1".into()),
                    duplicate_work_item_id: None,
                    created_or_ready: false,
                    clarification_questions: Vec::new(),
                    selected_lane: None,
                    selected_target_provider_or_agent: None,
                },
            },
        );
        match parse_hub_response(mission_intake.encode().unwrap()) {
            AskResponseFfi::MissionIntakeResult {
                friday_conversation_id,
                mission_id,
                work_item_id,
                surface_thread_id,
                status,
                blockers,
                duplicate_mission_id,
                duplicate_work_item_id,
                created_or_ready,
            } => {
                assert_eq!(friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(mission_id, "mission-1");
                assert_eq!(work_item_id.as_deref(), Some("work-1"));
                assert_eq!(surface_thread_id, "surface-desktop");
                assert_eq!(status, "blocked");
                assert_eq!(blockers, vec!["duplicate_mission".to_string()]);
                assert_eq!(duplicate_mission_id.as_deref(), Some("mission-1"));
                assert_eq!(duplicate_work_item_id, None);
                assert!(!created_or_ready);
            }
            other => panic!("expected MissionIntakeResult, got {other:?}"),
        }

        let mission_projection = Envelope::new(
            "mission-projection",
            0,
            Message::MissionProjectionSnapshot {
                snapshot: friday_protocol::MissionProjectionSnapshotWire {
                    friday_conversation_id: "fconv_mobile_desktop".into(),
                    generated_at_ms: 123,
                    projections: vec![friday_protocol::MissionSurfaceProjectionWire {
                        surface_thread_id: "surface-mobile".into(),
                        friday_conversation_id: "fconv_mobile_desktop".into(),
                        mission_id: "mission-1".into(),
                        surface_kind: "mobile".into(),
                        visibility_policy: "compact".into(),
                        title: "Coordinate Friday".into(),
                        status: "active".into(),
                        truth_status: "wired_registry".into(),
                        current_focus_summary: "one Mission across surfaces".into(),
                        proof_refs: vec!["proof://mission".into()],
                        updated_at_ms: 124,
                    }],
                    route_decisions: vec![friday_protocol::RouteDecisionProjectionWire {
                        route_decision_ref:
                            "friday://route-decision-projection/mission-1/work-1/125".into(),
                        mission_id: "mission-1".into(),
                        work_item_id: "work-1".into(),
                        selected_lane: "channel".into(),
                        selected_target_label: Some("bound_channel".into()),
                        why_this_route: "route the same Mission into the bound channel".into(),
                        considered_options: vec![
                            "mobile-only view".into(),
                            "shared Mission view".into(),
                        ],
                        deferred_options: vec!["provider native sync proof".into()],
                        previous_pitfalls: vec!["raw channel ids must stay Hub-side".into()],
                        inheritable_context: vec!["carry judgment, not transcript".into()],
                        conflict_ref_count: 1,
                        proof_requirements: vec!["FFI exposes redacted route trace".into()],
                        ownership_claim_count: 0,
                        trace_ref_count: 2,
                        action_items: vec![],
                        created_at_ms: 125,
                        expires_at_ms: None,
                    }],
                },
            },
        );
        match parse_hub_response(mission_projection.encode().unwrap()) {
            AskResponseFfi::MissionProjectionSnapshot {
                friday_conversation_id,
                generated_at_ms,
                projections,
                route_decisions,
            } => {
                assert_eq!(friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(generated_at_ms, 123);
                assert_eq!(projections.len(), 1);
                assert_eq!(projections[0].mission_id, "mission-1");
                assert_eq!(projections[0].surface_kind, "mobile");
                assert_eq!(route_decisions.len(), 1);
                assert_eq!(route_decisions[0].selected_lane, "channel");
                assert_eq!(
                    route_decisions[0].selected_target_label.as_deref(),
                    Some("bound_channel")
                );
                assert_eq!(route_decisions[0].trace_ref_count, 2);
                let debug = format!("{projections:?}{route_decisions:?}");
                for forbidden in [
                    "provider-token",
                    "external-thread",
                    "raw-chat",
                    "/Users/example/private",
                ] {
                    assert!(!debug.contains(forbidden));
                }
            }
            other => panic!("expected MissionProjectionSnapshot, got {other:?}"),
        }

        let mission_timeline = Envelope::new(
            "mission-timeline",
            0,
            Message::MissionTimelineSnapshot {
                snapshot: friday_protocol::MissionTimelineSnapshotWire {
                    friday_conversation_id: "fconv_mobile_desktop".into(),
                    mission_id: "mission-1".into(),
                    generated_at_ms: 126,
                    requested_cursor: Some("offset:0".into()),
                    next_cursor: Some("offset:3".into()),
                    retained_from: Some("offset:0".into()),
                    bounded: true,
                    has_more: true,
                    mission: friday_protocol::MissionTimelineMissionWire {
                        mission_id: "mission-1".into(),
                        friday_conversation_id: "fconv_mobile_desktop".into(),
                        title: "Coordinate Friday".into(),
                        intent: "keep one Mission across surfaces".into(),
                        status: "active".into(),
                        why_now: "avoid pinned chat debt".into(),
                        decision_path_summary: "Mission first, provider/channel refs second".into(),
                        proof_refs: vec!["proof://mission".into()],
                        updated_at_ms: 127,
                    },
                    projections: vec![friday_protocol::MissionSurfaceProjectionWire {
                        surface_thread_id: "surface-mobile".into(),
                        friday_conversation_id: "fconv_mobile_desktop".into(),
                        mission_id: "mission-1".into(),
                        surface_kind: "mobile".into(),
                        visibility_policy: "compact".into(),
                        title: "Coordinate Friday".into(),
                        status: "active".into(),
                        truth_status: "wired_registry".into(),
                        current_focus_summary: "one Mission across surfaces".into(),
                        proof_refs: vec!["proof://mission".into()],
                        updated_at_ms: 128,
                    }],
                    work_items: vec![friday_protocol::MissionTimelineWorkItemWire {
                        work_item_id: "work-1".into(),
                        mission_id: "mission-1".into(),
                        lane: "provider".into(),
                        status: "provider_waiting".into(),
                        capability_id: Some("provider.codex.send_turn".into()),
                        risk_level: "low".into(),
                        approval_state: "not_required".into(),
                        has_blocker: false,
                        owner_claim_count: 0,
                        workspace_ref_count: 1,
                        input_ref_count: 2,
                        output_ref_count: 0,
                        proof_requirements: vec!["proof receipt before done".into()],
                        proof_receipts: vec![],
                        updated_at_ms: 129,
                    }],
                    links: vec![
                        friday_protocol::MissionTimelineLinkWire {
                            link_ref:
                                "friday://mission-link-projection/mission-1/channel_inbound/1/0"
                                    .into(),
                            mission_id: "mission-1".into(),
                            work_item_id: Some("work-1".into()),
                            link_kind: "channel_inbound".into(),
                            has_proof: true,
                            proof_ref: Some("audit://channel-redacted".into()),
                            grants_memory_authority: false,
                            created_at_ms: 130,
                        },
                        friday_protocol::MissionTimelineLinkWire {
                            link_ref:
                                "friday://mission-link-projection/mission-1/memory_candidate/2/1"
                                    .into(),
                            mission_id: "mission-1".into(),
                            work_item_id: None,
                            link_kind: "memory_candidate".into(),
                            has_proof: false,
                            proof_ref: None,
                            grants_memory_authority: false,
                            created_at_ms: 131,
                        },
                    ],
                    route_decisions: vec![friday_protocol::RouteDecisionProjectionWire {
                        route_decision_ref:
                            "friday://route-decision-projection/mission-1/work-1/132".into(),
                        mission_id: "mission-1".into(),
                        work_item_id: "work-1".into(),
                        selected_lane: "provider".into(),
                        selected_target_label: Some("bound_provider_session".into()),
                        why_this_route: "continue the same Mission through provider workspace"
                            .into(),
                        considered_options: vec![
                            "new chat per surface".into(),
                            "Mission timeline projection".into(),
                        ],
                        deferred_options: vec!["provider native sync proof".into()],
                        previous_pitfalls: vec!["raw target refs must stay Hub-side".into()],
                        inheritable_context: vec!["carry judgment, not transcript".into()],
                        conflict_ref_count: 1,
                        proof_requirements: vec!["FFI timeline redaction test".into()],
                        ownership_claim_count: 0,
                        trace_ref_count: 2,
                        action_items: vec![],
                        created_at_ms: 132,
                        expires_at_ms: None,
                    }],
                    surface_events: vec![friday_protocol::MissionTimelineSurfaceEventWire {
                        surface_event_id: "surf-event-mobile-1".into(),
                        friday_conversation_id: "fconv_mobile_desktop".into(),
                        mission_id: "mission-1".into(),
                        work_item_id: Some("work-1".into()),
                        surface_thread_id: "surface-mobile".into(),
                        source_surface: "mobile".into(),
                        event_kind: "user_message".into(),
                        body_ref: Some("friday://body/mobile-message/1".into()),
                        visibility_policy: "compact".into(),
                        proof_ref: Some("audit://surface-event-redacted".into()),
                        created_at_ms: 133,
                    }],
                },
            },
        );
        match parse_hub_response(mission_timeline.encode().unwrap()) {
            AskResponseFfi::MissionTimelineSnapshot {
                friday_conversation_id,
                mission_id,
                generated_at_ms,
                requested_cursor,
                next_cursor,
                retained_from,
                bounded,
                has_more,
                mission,
                projections,
                work_items,
                links,
                route_decisions,
                surface_events,
            } => {
                assert_eq!(friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(mission_id, "mission-1");
                assert_eq!(generated_at_ms, 126);
                assert_eq!(requested_cursor.as_deref(), Some("offset:0"));
                assert_eq!(next_cursor.as_deref(), Some("offset:3"));
                assert_eq!(retained_from.as_deref(), Some("offset:0"));
                assert!(bounded);
                assert!(has_more);
                assert_eq!(mission.status, "active");
                assert_eq!(projections.len(), 1);
                assert_eq!(work_items.len(), 1);
                assert_eq!(work_items[0].status, "provider_waiting");
                assert!(!work_items[0].has_blocker);
                assert_eq!(work_items[0].output_ref_count, 0);
                assert_eq!(links.len(), 2);
                assert!(links.iter().any(|link| link.link_kind == "channel_inbound"
                    && link.has_proof
                    && !link.grants_memory_authority));
                assert!(links.iter().any(|link| link.link_kind == "memory_candidate"
                    && !link.has_proof
                    && !link.grants_memory_authority));
                assert_eq!(route_decisions.len(), 1);
                assert_eq!(surface_events.len(), 1);
                assert_eq!(surface_events[0].source_surface, "mobile");
                assert_eq!(
                    surface_events[0].body_ref.as_deref(),
                    Some("friday://body/mobile-message/1")
                );
                let debug = format!(
                    "{mission:?}{projections:?}{work_items:?}{links:?}{route_decisions:?}{surface_events:?}"
                );
                for forbidden in [
                    "provider-token",
                    "external-thread",
                    "raw-chat",
                    "telegram:raw-chat-123",
                    "raw-private-candidate",
                    "link-with-raw-channel-id",
                    "/Users/example/private",
                    "sk-",
                ] {
                    assert!(!debug.contains(forbidden));
                }
            }
            other => panic!("expected MissionTimelineSnapshot, got {other:?}"),
        }

        let lifecycle = Envelope::new(
            "ml1",
            0,
            Message::MissionLifecycleResult {
                result: friday_protocol::MissionLifecycleResultWire {
                    friday_conversation_id: "fconv_mobile_desktop".into(),
                    mission_id: "mission-1".into(),
                    previous_status: "active".into(),
                    status: "paused".into(),
                    actor_ref: "operator:jarvis".into(),
                    reason: "pause before duplicate route review".into(),
                    proof_ref: Some("audit://mission-lifecycle/pause".into()),
                    merged_into_mission_id: None,
                    active_mission_ids: vec!["mission-1".into()],
                    updated_at_ms: 134,
                },
            },
        );
        match parse_hub_response(lifecycle.encode().unwrap()) {
            AskResponseFfi::MissionLifecycleResult {
                friday_conversation_id,
                mission_id,
                previous_status,
                status,
                actor_ref,
                proof_ref,
                active_mission_ids,
                updated_at_ms,
                ..
            } => {
                assert_eq!(friday_conversation_id, "fconv_mobile_desktop");
                assert_eq!(mission_id, "mission-1");
                assert_eq!(previous_status, "active");
                assert_eq!(status, "paused");
                assert_eq!(actor_ref, "operator:jarvis");
                assert_eq!(
                    proof_ref.as_deref(),
                    Some("audit://mission-lifecycle/pause")
                );
                assert_eq!(active_mission_ids, vec!["mission-1".to_string()]);
                assert_eq!(updated_at_ms, 134);
            }
            other => panic!("expected MissionLifecycleResult, got {other:?}"),
        }

        // Error is surfaced (never a silent fallback) with the SCREAMING_SNAKE code.
        let err = Envelope::new(
            "e1",
            0,
            Message::Error {
                code: ErrorCode::ProviderUnavailable,
                message: "ask route unavailable".into(),
            },
        );
        match parse_hub_response(err.encode().unwrap()) {
            AskResponseFfi::Error { code, message } => {
                assert_eq!(code, "PROVIDER_UNAVAILABLE");
                assert!(message.contains("unavailable"));
            }
            other => panic!("expected Error, got {other:?}"),
        }

        // A LedgerEntry projects the cost-view fields only (base_url_host dropped).
        let ledger = Envelope::new(
            "l1",
            0,
            Message::LedgerEntry {
                ledger_id: "ask-1".into(),
                provider_kind: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                base_url_host: "api.deepseek.example".into(),
                total_tokens: 19,
                fallback: false,
            },
        );
        match parse_hub_response(ledger.encode().unwrap()) {
            AskResponseFfi::LedgerRef {
                provider_kind,
                total_tokens,
                fallback,
                ..
            } => {
                assert_eq!(provider_kind, "deepseek");
                assert_eq!(total_tokens, 19);
                assert!(!fallback);
            }
            other => panic!("expected LedgerRef, got {other:?}"),
        }

        // OfflineQueueAck is NOT completion → its own label, never AskResult.
        let ack = Envelope::new(
            "o1",
            0,
            Message::OfflineQueueAck {
                acked_msg_id: "q1".into(),
            },
        );
        assert!(matches!(
            parse_hub_response(ack.encode().unwrap()),
            AskResponseFfi::OfflineAck { .. }
        ));

        // An out-of-slice kind (a streamed chunk) is truth-labeled Unsupported, NOT a result.
        let stream = Envelope::new(
            "st1",
            0,
            Message::AskFridayStream {
                seq: 0,
                chunk: "later".into(),
            },
        );
        match parse_hub_response(stream.encode().unwrap()) {
            AskResponseFfi::Unsupported { kind } => assert_eq!(kind, "AskFridayStream"),
            other => panic!("expected Unsupported, got {other:?}"),
        }

        // Undecodable garbage → structural error, never a result.
        assert!(matches!(
            parse_hub_response("not a protocol envelope".into()),
            AskResponseFfi::Undecodable { .. }
        ));
    }

    #[test]
    fn ffi_unsupported_kind_carries_the_real_message_kind_name_for_ws_substrate() {
        // The WS-substrate kinds (S-A) are out-of-slice on the FFI surface, but the
        // truth label must carry the REAL kind name — a regression to a wildcard arm
        // would collapse these to a generic label and let future variants silently
        // fall through. (The match in `message_kind_name` is exhaustive by
        // construction; this pins the observable names.)
        use friday_protocol::{Envelope, Message};
        let result = Envelope::new(
            "ar1",
            0,
            Message::AgentRunResult {
                run_id: "r1".into(),
                status: "completed".into(),
                answer_sha256: None,
                answer_len: None,
                turns: None,
                executed_tools: None,
                prompt_tokens: None,
                completion_tokens: None,
            },
        );
        match parse_hub_response(result.encode().unwrap()) {
            AskResponseFfi::Unsupported { kind } => assert_eq!(kind, "AgentRunResult"),
            other => panic!("expected Unsupported, got {other:?}"),
        }
        let request = Envelope::new(
            "ar2",
            0,
            Message::AgentRunRequest {
                run_id: "r2".into(),
                task: "t".into(),
                forwarded_principal: "p".into(),
                auth_proof: vec![],
                session_id: None,
                constraints: None,
                mission_context: None,
            },
        );
        match parse_hub_response(request.encode().unwrap()) {
            AskResponseFfi::Unsupported { kind } => assert_eq!(kind, "AgentRunRequest"),
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    #[test]
    fn ffi_unsupported_kind_carries_the_real_message_kind_name_for_a1_learning_decisions() {
        use friday_protocol::{
            Envelope, Message, RunOutcomeLearningDecisionRequestWire,
            RunOutcomeLearningDecisionResultWire,
        };

        let request = Envelope::new(
            "a1d1",
            0,
            Message::RunOutcomeLearningDecisionRequest {
                request: RunOutcomeLearningDecisionRequestWire {
                    candidate_id: "cand-1".into(),
                    decision: "confirm".into(),
                    reason: Some("useful".into()),
                },
            },
        );
        match parse_hub_response(request.encode().unwrap()) {
            AskResponseFfi::Unsupported { kind } => {
                assert_eq!(kind, "RunOutcomeLearningDecisionRequest")
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }

        let result = Envelope::new(
            "a1d2",
            0,
            Message::RunOutcomeLearningDecisionResult {
                result: RunOutcomeLearningDecisionResultWire {
                    candidate_id: "cand-1".into(),
                    run_id: Some("run-1".into()),
                    kind: Some("preference".into()),
                    state: "confirmed".into(),
                    status: "ok".into(),
                    blocker: None,
                },
            },
        );
        match parse_hub_response(result.encode().unwrap()) {
            AskResponseFfi::Unsupported { kind } => {
                assert_eq!(kind, "RunOutcomeLearningDecisionResult")
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    #[test]
    fn ffi_parse_hub_response_never_surfaces_raw_answer_text() {
        // ADVERSE: even if a (wrong) Hub stuffed answer text into a streamed chunk, the phone
        // projection never carries it — the chunk kind is Unsupported and its content is NOT
        // projected into any FFI field (consistent with the Phase-1 refs-only stance).
        use friday_protocol::{Envelope, Message};
        let stream = Envelope::new(
            "st1",
            0,
            Message::AskFridayStream {
                seq: 1,
                chunk: "SECRET-ANSWER-TEXT".into(),
            },
        );
        let projected = parse_hub_response(stream.encode().unwrap());
        assert!(
            !format!("{projected:?}").contains("SECRET-ANSWER-TEXT"),
            "raw answer leaked into the projection"
        );
    }
}
