//! Rust-owned INLINE session-memory extraction (FIRST slice — Rust-ownership of
//! the "memory moat" feature). Hub-only, secret-bearing (the provider call).
//!
//! This is the smallest-viable first slice that makes Rust OWN the memory
//! extraction feature: a manual-trigger, single-session, INLINE extraction that
//!   1. reads the session's messages from `agent_session_message`
//!      ([`friday_storage::agent_session::load_session_messages`]),
//!   2. builds the EXTRACT prompt ported faithfully from the TS oracle
//!      (`friday-session-memory-extraction-llm-client.ts`),
//!   3. calls the provider (one structured-inference [`DeepSeekClient`] call) and
//!      ledgers the token usage ([`friday_storage::Db::insert_token_ledger`]),
//!   4. parses the candidate items (the same JSON shape + validation as the TS
//!      `validateLlmResponse`),
//!   5. runs the SENSITIVITY filter ported from `friday-sensitive-learning-guard.ts`
//!      — a matched item is DROPPED (never stored), exactly as the TS does, so no
//!      sensitive raw content is persisted beyond what TS persisted (i.e. none),
//!   6. persists each surviving item as a CANDIDATE via the EXISTING memory spine
//!      ([`friday_storage::memory::record_candidate`], `state = Candidate`).
//!
//! ## Reuse, not rebuild
//! The persist/confirm/recall/redact lifecycle is UNCHANGED and reused as-is:
//! a stored candidate is non-durable (`07` §6/§7 — no silent long-term write);
//! it becomes recallable ONLY via [`friday_storage::memory::confirm`] and is then
//! read back by [`friday_storage::memory::recall_confirmed`] +
//! [`crate::cognition::rank_recall`] (which redacts PII at RECALL time — the same
//! point the TS does, so this slice adds NO store-time redaction; parity is clean).
//!
//! ## Slice-2 (dedup + transactional) — closes slice-1's two caveats
//! - **Dedup via extraction-status.** The `agent_session_message` table now carries a
//!   `memory_extract_status` column (v20 migration; mirrors the TS
//!   `session_messages.memory_extract_status`). This slice reads only PENDING messages
//!   ([`friday_storage::agent_session::load_pending_session_messages`]) and, after a
//!   successful run, marks EVERY processed message `'extracted'`
//!   ([`friday_storage::agent_session::mark_messages_extracted`]). So a RE-RUN reads no
//!   pending → 0 new candidates, 0 provider calls (no duplicate candidates).
//! - **Atomic persist.** The candidate inserts AND the extracted-marks run in ONE
//!   `unchecked_transaction`: a mid-persist error rolls BOTH back (no partial candidates,
//!   no orphaned marks). The token-ledger row is written BEFORE the tx (the call's cost
//!   is real regardless of the persist outcome).
//!
//! ## Honest scope (disclosed deviations from the TS oracle)
//! - **Source table.** The Rust schema has no full `session_messages` table (with the
//!   TS `is_inherited` column etc.); this slice adds only the `memory_extract_status`
//!   column to `agent_session_message`. There is no `is_inherited` pre-filter — every
//!   message is extractable. The TS extracted/skipped distinction is collapsed to one
//!   terminal `'extracted'` status (a processed message — referenced, unreferenced, or
//!   sensitivity-dropped — is consumed and not re-extracted, matching the TS "still
//!   leaves the pending set" semantics).
//! - **No `'failed'`/retry transition.** On a persist error the tx rolls back, leaving
//!   the messages `'pending'`, and that attempt's ledger row persists — so a retry
//!   re-calls the provider. The TS `'failed'`-status + queue/retry machine is DEFERRED
//!   to a follow-on slice.
//! - **No tags / metadata persisted.** The Rust `memory_item` row has no
//!   tags/metadata columns; the TS tags/metadata are simply not stored in slice-1.
//! - **One concatenated prompt.** The Rust [`DeepSeekClient::chat`] takes a single
//!   prompt (no system/user split, no `response_format`/`temperature`); the system
//!   + user prompt are concatenated. The JSON-only contract is carried in the
//!   prompt text, and parsing tolerates fenced / surrounded JSON like the TS.
//! - **PII redaction stays at RECALL time** (cognition::rank_recall), NOT at store
//!   time — faithful to the TS, which stores raw non-keyword PII and redacts on
//!   recall. The sensitivity guard here drops KEYWORD-bearing items (passwords,
//!   tokens, SSN/credit-card words, medical/financial/…), matching the TS guard.
//!
//! ## Slice-3 (ownership-binding) — the store SCOPE is DERIVED from the SESSION
//! The extraction's memory store scope is no longer a caller-supplied principal: it is
//! DERIVED from the session's OWNER axes via [`crate::session_namespace`], a faithful port
//! of the TS `resolveFridaySessionMemoryNamespace`. The Rust recall axis is a single
//! `principal_id` string, so slice-3 sets **`principal_id` := the composite namespace**
//! `tenant.<account>.channel.<channel>.user.<user>.shared` (with `scope` still
//! `MemoryScope::Session`). This preserves per-(account, channel, user) isolation on the
//! existing recall axis — faithful to the TS production model where extraction is
//! job-driven (there is NO caller principal) and the session is the source of truth.
//!
//! **Fail-closed on no userId (PARITY).** If the session has no `user_id`, the namespace
//! is UNRESOLVABLE and extraction FAILS CLOSED ([`ExtractionError::NamespaceUnresolvable`])
//! — mirroring the TS `MEMORY_NAMESPACE_UNRESOLVABLE` throw. A session is never silently
//! bound to a default/anonymous scope.
//!
//! **Effective-userId fallbacks (owner-wiring lane — now PORTED).** The TS
//! `resolveEffectiveUserId` is fully ported in
//! [`crate::session_namespace::resolve_effective_user_id`]: direct `user_id`, the
//! DM-chatId fallback (`chat_kind == "dm"` conversation → `chat_id`), and the subagent
//! parent-walk (`parent_session_id` chain → nearest ancestor userId / DM chat_id) — all
//! DETERMINISTIC and FAIL-CLOSED when underivable (the v23 columns model the TS
//! `chatKind`/`chatId`/`parentSessionKey` axes). `run_session_loop` can now BIND a
//! session owner at creation (the owner-wiring lane), so loop-created sessions are
//! extractable once their owner axes are supplied.
//!
//! - **Queue / auto mode still DEFERRED.** Only the inline manual path; the
//!   queue/job-retry/auto machine is a follow-on slice.
//!
//! Truth label: Rust-owned INLINE extraction, slice-3 + owner-wiring (dedup +
//! transactional + ownership-binding + DM/subagent userId fallbacks). The TS extraction
//! path STAYS LIVE (queue/auto parity pending; this flips NO TS-retirement state).
//! PROOF-ONLY — NOT a v1 GO.

use friday_core::{
    memory_review_needs_me, ActivityState, ActivityType, MemoryScope, MemoryState, NeedsMeItem,
};
use friday_deepseek::{DeepSeekClient, DeepSeekError, Transport};
use friday_storage::agent_session::{
    load_pending_session_messages, load_session_owner, mark_messages_extracted,
    StoredSessionMessage,
};
use friday_storage::memory::{record_candidate, NewMemoryCandidate};
use friday_storage::{ActivityRow, StorageError};
use serde_json::Value;
use std::collections::HashSet;

use crate::sensitive_guard::is_sensitive_learning_candidate;
use crate::session_namespace::{
    resolve_effective_user_id, resolve_session_memory_namespace, NamespaceError,
};

/// The valid item kinds (ported from the TS `VALID_KINDS`).
const VALID_KINDS: &[&str] = &["fact", "decision", "preference", "action_item"];

/// Default max items per extraction batch (ported from
/// `FRIDAY_SESSION_MEMORY_EXTRACTION_DEFAULT_MAX_ITEMS_PER_BATCH`). Bounds how many
/// candidates one call may produce.
pub const DEFAULT_MAX_ITEMS: usize = 10;

/// Max tokens for the single extraction completion (bounds the provider cost of one
/// inline extraction — recall/extraction adds tokens which must stay bounded,
/// `07` §1/§3).
pub const EXTRACTION_MAX_TOKENS: u32 = 1024;

/// The EXTRACT system prompt, ported verbatim from the TS oracle
/// `EXTRACTION_SYSTEM_PROMPT`. The JSON-only response contract is carried in the
/// prompt text (the Rust client has no `response_format` knob).
pub const EXTRACTION_SYSTEM_PROMPT: &str = "You are a memory extraction assistant. Your job is to extract durable, reusable facts from conversation messages.

Extract key facts, decisions, preferences, and action items from this conversation.

Rules:
- Each extracted item must be a self-contained, useful memory.
- Use \"kind\" to classify: \"fact\", \"decision\", \"preference\", or \"action_item\".
- Reference the source message IDs that contributed to each item.
- Content should be concise but complete enough to be useful without the original conversation.
- Preserve the exact user-stated value for names, codenames, labels, and stylistic preferences when those specifics matter.
- Do not generalize a concrete preference into a broader summary. For example, if the user specifies a release-note style, keep that wording instead of replacing it with something vague like \"concise release notes.\"
- Do not extract secrets, credentials, passphrases, API keys, tokens, financial identifiers, medical details, identity documents, political/religious traits, or other high-risk sensitive facts or preferences.
- Do not extract trivial greetings, acknowledgments, or filler.
- If there is nothing meaningful to extract, return an empty items array.

Respond with strict JSON only:
{
  \"items\": [
    {
      \"kind\": \"fact|decision|preference|action_item\",
      \"content\": \"short durable memory\",
      \"sourceMessageIds\": [\"msg-1\", \"msg-2\"],
      \"tags\": [\"optional.lowercase.tag\"]
    }
  ]
}";

/// A validated candidate item parsed from the model output (the Rust mirror of the
/// TS `FridaySessionMemoryExtractionLlmItem`). `content` and `kind` are validated;
/// `source_message_ids` are filtered to the loaded message-id set; `tags` are kept
/// only for the sensitivity check (they are NOT persisted in slice-1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractedItem {
    pub kind: String,
    pub content: String,
    pub source_message_ids: Vec<String>,
    pub tags: Vec<String>,
}

/// Refs-only outcome of an inline extraction — counts and labels only, NEVER raw
/// message or candidate content. This is what a bin renders.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtractionOutcome {
    /// Messages read from the session (input size).
    pub messages_read: usize,
    /// Items the model returned that passed the JSON/kind/source-id validation.
    pub items_parsed: usize,
    /// Of the parsed items, how many were DROPPED by the sensitivity guard.
    pub sensitive_dropped: usize,
    /// Candidates actually persisted via `record_candidate` (`state = Candidate`).
    pub candidates_created: usize,
    /// Source messages marked `'extracted'` this run (the dedup mark). Equals the
    /// number of PENDING messages read — every processed message is consumed so a
    /// re-run reads no pending and creates no duplicate candidates.
    pub messages_marked_extracted: usize,
    /// Token usage of the single extraction call (ledgered separately).
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    /// The reported model id (a safe label — never a secret).
    pub model: String,
    /// The DERIVED memory namespace (slice-3) under which candidates were stored as
    /// `principal_id` — `tenant.<account>.channel.<channel>.user.<user>.shared`. This is a
    /// store-scope LABEL (composed from normalized session-owner ids), NOT a body, so it is
    /// refs-only safe to render. ALWAYS non-empty on a successful return: it is resolved
    /// (fail-closed if unresolvable) BEFORE the no-pending early return, so even the
    /// nothing-to-extract path reports the namespace the session WOULD store under.
    pub derived_namespace: String,
}

/// Errors specific to the extraction engine (provider/storage/parse). Coarse and
/// secret-free — a provider error carries only its [`DeepSeekError`] variant
/// (already secret-free by construction).
#[derive(Debug)]
pub enum ExtractionError {
    Storage(StorageError),
    Provider(DeepSeekError),
    /// The model output did not parse into the documented `{ "items": [...] }`
    /// shape. Carries NO model text (coarse, never echoes the body).
    Parse,
    /// session id was blank.
    BadInput(&'static str),
    /// Slice-3: the session's memory namespace could not be resolved (no `user_id` on the
    /// session). FAILS CLOSED — parity with the TS `MEMORY_NAMESPACE_UNRESOLVABLE` throw.
    /// Carries the typed [`NamespaceError`] (coarse + secret-free by construction).
    NamespaceUnresolvable(NamespaceError),
}

impl std::fmt::Display for ExtractionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractionError::Storage(_) => write!(f, "storage error"),
            ExtractionError::Provider(e) => write!(f, "provider error: {e}"),
            ExtractionError::Parse => write!(f, "model output parse error"),
            ExtractionError::BadInput(w) => write!(f, "bad input: {w}"),
            ExtractionError::NamespaceUnresolvable(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ExtractionError {}

impl From<StorageError> for ExtractionError {
    fn from(e: StorageError) -> Self {
        ExtractionError::Storage(e)
    }
}
impl From<DeepSeekError> for ExtractionError {
    fn from(e: DeepSeekError) -> Self {
        ExtractionError::Provider(e)
    }
}
impl From<NamespaceError> for ExtractionError {
    fn from(e: NamespaceError) -> Self {
        ExtractionError::NamespaceUnresolvable(e)
    }
}

/// Build the single extraction prompt: the ported system prompt + the user prompt
/// (`Extract up to N memory items from these messages:` followed by one
/// `[id] (role) text` line per message — mirrors the TS `buildUserPrompt`).
pub fn build_extraction_prompt(messages: &[StoredSessionMessage], max_items: usize) -> String {
    let mut lines = String::new();
    for m in messages {
        lines.push_str(&format!("[{}] ({}) {}\n", m.message_id, m.role, m.content));
    }
    // Trim the trailing newline so the prompt matches the TS `.join("\n")` shape.
    let lines = lines.trim_end_matches('\n');
    format!(
        "{EXTRACTION_SYSTEM_PROMPT}\n\nExtract up to {max_items} memory items from these messages:\n\n{lines}"
    )
}

/// Parse + validate the model output into candidate items. Ported faithfully from
/// the TS `parseJsonFromText` + `validateLlmResponse`:
/// - tolerate a fenced ```json block or JSON surrounded by prose (slice
///   first-`{` .. last-`}`);
/// - require an `items` array;
/// - per item: `kind` must be one of [`VALID_KINDS`]; `content` must be a non-empty
///   string (trimmed); `sourceMessageIds` filtered to `valid_ids` and non-empty
///   after filtering; `tags` kept as strings (for the sensitivity check only).
pub fn parse_items(
    raw: &str,
    valid_ids: &HashSet<String>,
) -> Result<Vec<ExtractedItem>, ExtractionError> {
    let parsed = parse_json_from_text(raw).ok_or(ExtractionError::Parse)?;
    let obj = parsed.as_object().ok_or(ExtractionError::Parse)?;
    let raw_items = obj
        .get("items")
        .and_then(Value::as_array)
        .ok_or(ExtractionError::Parse)?;

    let mut items = Vec::new();
    for raw in raw_items {
        let Some(item) = raw.as_object() else {
            continue;
        };

        let kind = match item.get("kind").and_then(Value::as_str) {
            Some(k) if VALID_KINDS.contains(&k) => k.to_string(),
            _ => continue,
        };

        let content = match item.get("content").and_then(Value::as_str) {
            Some(c) if !c.trim().is_empty() => c.trim().to_string(),
            _ => continue,
        };

        let source_message_ids: Vec<String> = match item.get("sourceMessageIds") {
            Some(Value::Array(ids)) => ids
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| valid_ids.contains(*id))
                .map(str::to_string)
                .collect(),
            _ => continue,
        };
        // Skip items with no VALID source-message reference (TS `validIds.length === 0`).
        if source_message_ids.is_empty() {
            continue;
        }

        let tags: Vec<String> = match item.get("tags") {
            Some(Value::Array(t)) => t
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        };

        items.push(ExtractedItem {
            kind,
            content,
            source_message_ids,
            tags,
        });
    }
    Ok(items)
}

/// Tolerant JSON extraction (ported from TS `parseJsonFromText`): try a strict
/// parse, then a ```json fenced block, then the first-`{` .. last-`}` slice.
/// Returns `None` on total failure (the caller maps it to [`ExtractionError::Parse`]).
fn parse_json_from_text(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }
    // A fenced block: ```json\n...\n``` (or bare ```). Take the inner text.
    if let Some(inner) = fenced_json(trimmed) {
        if let Ok(v) = serde_json::from_str::<Value>(inner.trim()) {
            return Some(v);
        }
    }
    // First `{` .. last `}` slice.
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if end > start {
            if let Ok(v) = serde_json::from_str::<Value>(&trimmed[start..=end]) {
                return Some(v);
            }
        }
    }
    None
}

/// Extract the inner text of the first ```json (or bare ```) fenced block.
fn fenced_json(text: &str) -> Option<&str> {
    let after_open = text.find("```").map(|i| i + 3)?;
    let rest = &text[after_open..];
    // Optional `json` language tag immediately after the opening fence.
    let body_start = rest.strip_prefix("json").unwrap_or(rest);
    let close = body_start.find("```")?;
    Some(&body_start[..close])
}

/// Run the SENSITIVITY filter ported from `isFridaySensitiveLearningCandidate`:
/// an item is dropped if the guard matches over (content + tags + the SOURCE
/// message texts it references). Returns the surviving (safe) items and the count
/// dropped. A dropped item's raw content is NEVER persisted (parity with the TS,
/// which stores zero sensitive content).
pub fn filter_sensitive(
    items: Vec<ExtractedItem>,
    messages: &[StoredSessionMessage],
) -> (Vec<ExtractedItem>, usize) {
    let text_by_id: std::collections::HashMap<&str, &str> = messages
        .iter()
        .map(|m| (m.message_id.as_str(), m.content.as_str()))
        .collect();

    let mut safe = Vec::new();
    let mut dropped = 0usize;
    for item in items {
        // The values the TS guard joins: item.content, item.tags, and the source
        // message texts (only those present + non-empty), mirroring
        // `isSensitiveExtractionItem`.
        let mut values: Vec<&str> = vec![item.content.as_str()];
        for t in &item.tags {
            values.push(t.as_str());
        }
        for id in &item.source_message_ids {
            if let Some(text) = text_by_id.get(id.as_str()) {
                if !text.is_empty() {
                    values.push(text);
                }
            }
        }
        if is_sensitive_learning_candidate(&values) {
            dropped += 1;
        } else {
            safe.push(item);
        }
    }
    (safe, dropped)
}

/// The `FRIDAY_MEMORY_REVIEW_NEEDS_ME` env var (NS-8 — the memory-confirm loop closure).
/// When ON, a post-run extraction that records a fresh `Candidate` ALSO surfaces ONE
/// [`ActivityType::MemoryReview`] activity row per candidate on the operator's Needs-Me /
/// review surface (so a freshly-recorded pending candidate becomes visible review work, not
/// just a `memory_item` row). DEFAULT-OFF: unset / empty / `"0"` / any value other than the
/// exact opt-in `"1"` ⇒ OFF, and the extraction is BYTE-IDENTICAL to the pre-NS-8 baseline
/// (no [`memory_review_needs_me`] call, NO activity row, no extra query). It is read ONCE in
/// the public [`extract_inline`] (the chokepoint every production extraction caller — the bin — goes
/// through) and threaded as a pure bool to [`extract_inline_flagged`] — the "split env-read
/// from pure logic" idiom (mirroring NS-7's `activity_needs_me_from`), so the behavioral tests
/// inject the bool directly and never race `std::env`.
pub const FRIDAY_MEMORY_REVIEW_NEEDS_ME: &str = "FRIDAY_MEMORY_REVIEW_NEEDS_ME";

/// Pure flag-matcher for [`FRIDAY_MEMORY_REVIEW_NEEDS_ME`] (env read split out so it is
/// unit-testable without `set_var` — the env-race-free idiom this codebase uses). DEFAULT-OFF:
/// `None` (unset) ⇒ false; ON ONLY for the exact opt-in value `"1"` (after trim); everything
/// else (empty, `"0"`, `"true"`, any other token) ⇒ false.
fn memory_review_needs_me_from(raw: Option<&str>) -> bool {
    matches!(raw.map(str::trim), Some("1"))
}

/// Pure projection: turn a freshly-recorded candidate into the ONE [`ActivityRow`] that
/// surfaces it on the operator's Needs-Me / Memory-Review surface — or `None` when it must
/// NOT surface. The candidate's [`MemoryState`] is threaded through the proven producer
/// [`memory_review_needs_me`]: a pending `Candidate` ⇒ `Some(NeedsMeItem)` ⇒ a `Pending`
/// [`ActivityType::MemoryReview`] row; a terminal `Confirmed`/`Rejected` candidate ⇒ `None`
/// (the decision is made — it never re-surfaces, the terminal-is-final invariant). The
/// row carries the producer's content-free `reason` as the `summary` and its
/// `destination` (`memory/{scope}/{id}`, a refs-only label — never candidate content) in
/// BOTH the `summary` (so the [`Db::list_activity`] projection, which drops `deep_link`,
/// surfaces it) and `deep_link`. The `activity_id` is keyed on the candidate's `memory_id`
/// (`activity_item.activity_id` is the PRIMARY KEY), so re-surfacing the SAME candidate is a
/// fail-closed duplicate insert (idempotent — no duplicate row; mirrors NS-7's nonce key).
fn memory_review_activity_row(
    memory_id: &str,
    state: MemoryState,
    scope: MemoryScope,
    summary: &str,
    now_ms: i64,
) -> Option<ActivityRow> {
    let NeedsMeItem {
        reason,
        destination,
        ..
    } = memory_review_needs_me(memory_id, state, scope, summary)?;
    Some(ActivityRow {
        activity_id: format!("memory-review-needs-me-{memory_id}"),
        // The candidate's memory id is the binding ref (a safe id, not a body).
        session_id: None,
        kind: ActivityType::MemoryReview,
        state: ActivityState::Pending,
        // The projection drops `deep_link`, so the destination lives in the summary too.
        summary: format!("{reason} ({destination})"),
        created_at: now_ms,
        updated_at: now_ms,
        deep_link: Some(destination),
    })
}

/// Run one INLINE manual extraction for a session (public entrypoint). Reads the NS-8
/// [`FRIDAY_MEMORY_REVIEW_NEEDS_ME`] flag ONCE here (the only env read; semantics in
/// [`memory_review_needs_me_from`]) and delegates to [`extract_inline_flagged`]. The flag is
/// **default-OFF**: when off the extraction is BYTE-IDENTICAL to the pre-NS-8 baseline (no
/// `memory_review_needs_me` call, NO activity row, no extra query).
///
/// ## `db: &Db` (NS8-WIRE-1 — relaxed from `&mut Db`, behavior unchanged)
/// The `db` handle is a SHARED `&Db`. This entire extraction path uses ONLY `&self` storage
/// operations — `db.conn()` (a `&Connection`), the `&Connection`-based
/// `unchecked_transaction`, and `db.insert_token_ledger` / `db.insert_activity` (both `&self`)
/// — so the previous `&mut Db` receiver was gratuitous. It is relaxed to `&Db` so the live
/// sessioned run loop's `&self` runtime caller can fire this post-run (NS8-WIRE-1) WITHOUT a
/// `&mut self` rewrite. Pre-existing `&mut db` call sites (the `hub_extract_memory` bin + the
/// in-crate tests) reborrow `&mut Db → &Db` at the call automatically, so they are untouched
/// and behavior is byte-identical.
#[allow(clippy::too_many_arguments)]
pub fn extract_inline<T: Transport>(
    db: &friday_storage::Db,
    session_id: &str,
    client: &DeepSeekClient<T>,
    max_items: usize,
    candidate_id_prefix: &str,
    ledger_id: &str,
    now_ms: i64,
) -> Result<ExtractionOutcome, ExtractionError> {
    // Read the NS-8 flag ONCE here; the body is pure on the resulting bool.
    let memory_review =
        memory_review_needs_me_from(std::env::var(FRIDAY_MEMORY_REVIEW_NEEDS_ME).ok().as_deref());
    extract_inline_flagged(
        db,
        session_id,
        client,
        max_items,
        candidate_id_prefix,
        ledger_id,
        now_ms,
        memory_review,
    )
}

/// The flag-parameterized extraction body: derive namespace → read messages → prompt →
/// provider call (ledgered) → parse → sensitivity-filter → persist candidates → (NS-8,
/// flag-gated) surface each freshly-recorded candidate on the Needs-Me surface.
///
/// `client` is generic over [`Transport`] so tests inject a mock provider and the
/// bin passes a live `DeepSeekClient::from_env()`. The call+ledger reuses
/// [`DeepSeekClient::run_friday_ask`]; the resulting [`friday_core::LedgerEntry`]
/// is persisted via [`friday_storage::Db::insert_token_ledger`] — the same ledger
/// the ask path writes (`fallback = false`).
///
/// `candidate_id_prefix` namespaces the minted `memory_id`s (e.g.
/// `"<session>:extract:<now_ms>"`). Slice-2 makes re-runs IDEMPOTENT at the source:
/// only PENDING messages are read, and a successful run marks the processed messages
/// `'extracted'`, so a second run reads no pending and creates no duplicate candidates.
///
/// ## NS-8 — flag-gated Memory-Review Needs-Me surfacing ([`FRIDAY_MEMORY_REVIEW_NEEDS_ME`])
/// `memory_review` is supplied by the public [`extract_inline`] (from the env flag) and
/// injected directly by the NS-8 behavioral tests (so they never mutate `std::env`). When
/// TRUE, AFTER the candidates commit, each candidate FRESHLY recorded by THIS extraction is
/// projected through [`memory_review_activity_row`] (the proven [`memory_review_needs_me`]
/// producer) and persisted as ONE `Pending` [`ActivityType::MemoryReview`] activity row, so a
/// pending candidate becomes visible review work. ONLY this run's freshly-recorded candidate
/// ids are surfaced (collected inside the record loop — never a re-query of pending
/// candidates, which would re-surface earlier runs' items). The write is best-effort
/// (`let _`): a surfacing/duplicate error can NEVER roll back the committed candidates nor
/// flip the run outcome. When FALSE the surfacing block is skipped entirely and the path is
/// byte-identical to the pre-NS-8 baseline.
///
/// ### Seam boundary (what this surfacing covers — and what it does NOT)
/// This is the only production EXTRACTION `record_candidate` loop, so NS-8's surfacing is
/// wired here and here only (the `runtime.rs` `record_candidate` sites are test-only
/// `seed_confirmed` helpers, not a production extraction path). Two OTHER production-API
/// candidate-creators exist — [`friday_storage::memory::edit_candidate`] and
/// [`friday_storage::memory::repropose_from_rejected`] (the memory-confirmation
/// edit / re-propose actions, `07` §6/§7) — but both are currently DORMANT: their ONLY
/// callers are tests, they are NOT wired to any runtime handler, and so they are OUTSIDE
/// NS-8's seam. When either action IS wired into a runtime handler, that wiring MUST ALSO
/// surface the freshly-created candidate as a [`ActivityType::MemoryReview`] Needs-Me item
/// (calling [`memory_review_activity_row`] / the same surfacing step), else those candidates
/// will record but never appear on the operator's review surface.
///
/// ## Slice-3 ownership-binding (the store SCOPE is DERIVED from the SESSION)
/// There is NO caller-supplied principal: the store scope (`principal_id`) is DERIVED
/// from the session's OWNER axes (loaded via [`load_session_owner`]) through
/// [`resolve_effective_user_id`] (direct `user_id` → DM-chatId fallback → subagent
/// parent-walk; the TS `resolveEffectiveUserId` port) and
/// [`resolve_session_memory_namespace`] —
/// `tenant.<account>.channel.<channel>.user.<user>.shared`. If NO userId is derivable
/// (the namespace is unresolvable), extraction FAILS CLOSED
/// ([`ExtractionError::NamespaceUnresolvable`]) BEFORE any provider call — parity with the
/// TS `MEMORY_NAMESPACE_UNRESOLVABLE`. The derived namespace is echoed in
/// [`ExtractionOutcome::derived_namespace`].
#[allow(clippy::too_many_arguments)]
pub fn extract_inline_flagged<T: Transport>(
    db: &friday_storage::Db,
    session_id: &str,
    client: &DeepSeekClient<T>,
    max_items: usize,
    candidate_id_prefix: &str,
    ledger_id: &str,
    now_ms: i64,
    memory_review: bool,
) -> Result<ExtractionOutcome, ExtractionError> {
    if session_id.trim().is_empty() {
        return Err(ExtractionError::BadInput("session_id"));
    }

    // Slice-3 ownership-binding: DERIVE the store scope from the SESSION (not a caller
    // principal). Load the session's owner axes, resolve the EFFECTIVE userId (direct →
    // DM-chatId fallback → subagent parent-walk, the TS `resolveEffectiveUserId` port —
    // deterministic, fail-closed when underivable), then resolve the composite namespace.
    // A session with no derivable userId FAILS CLOSED here — BEFORE any provider call —
    // mirroring the TS `MEMORY_NAMESPACE_UNRESOLVABLE` throw. An absent session row also
    // has no owner, so it fails closed identically (None owner → unresolvable). The
    // namespace's account/channel stay the SESSION'S OWN axes even when the userId came
    // from a parent (faithful to the TS resolver).
    let owner = load_session_owner(db.conn(), session_id)?.unwrap_or_default();
    let effective_user_id =
        resolve_effective_user_id(&owner, &mut |key: &str| load_session_owner(db.conn(), key))?;
    let derived_namespace = resolve_session_memory_namespace(
        owner.account_id.as_deref(),
        owner.channel.as_deref(),
        effective_user_id.as_deref(),
    )?;
    // The derived namespace IS the store key (the Rust recall axis is a single
    // `principal_id` string; slice-3 sets it to the composite namespace).
    let principal_id = derived_namespace.as_str();

    // Slice-2 dedup: read only the messages not yet consumed by a prior extraction.
    let messages = load_pending_session_messages(db.conn(), session_id)?;
    let messages_read = messages.len();

    // No PENDING messages: nothing to extract — and CRUCIALLY no provider call. On a
    // second run of an already-extracted session every message is terminal, so this is
    // the empty early-return (TS `messages.length === 0`), and the provider is never hit.
    if messages.is_empty() {
        return Ok(ExtractionOutcome {
            messages_read: 0,
            items_parsed: 0,
            sensitive_dropped: 0,
            candidates_created: 0,
            messages_marked_extracted: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            model: String::new(),
            derived_namespace,
        });
    }

    let prompt = build_extraction_prompt(&messages, max_items);

    // One structured-inference call. `run_friday_ask` discovers → selects → chats →
    // builds the (fallback=false) ledger entry. `session_id`/`activity_id` are the
    // ledger's grouping refs (safe ids, not bodies).
    let (outcome, ledger_entry) = client.run_friday_ask(
        ledger_id,
        session_id,
        format!("{candidate_id_prefix}:extract"),
        &prompt,
        EXTRACTION_MAX_TOKENS,
        now_ms,
    )?;

    // Ledger the token usage (reuse the existing single-row insert).
    db.insert_token_ledger(&ledger_entry)?;

    let valid_ids: HashSet<String> = messages.iter().map(|m| m.message_id.clone()).collect();
    let items = parse_items(&outcome.content, &valid_ids)?;
    let items_parsed = items.len();

    let (safe_items, sensitive_dropped) = filter_sensitive(items, &messages);

    // ATOMIC persist (slice-2): record every surviving candidate AND mark ALL the
    // processed source messages `'extracted'` in ONE transaction. Either the whole
    // batch + marks commit, or a mid-loop error drops the tx and rolls BOTH back — so
    // there is never a partial state (orphaned candidates, or marks without candidates).
    //
    // We mark EVERY pending message we read — not just the ones a safe item referenced —
    // because all of them were processed this run (referenced, unreferenced, and
    // sensitivity-DROPPED alike). Leaving any `'pending'` would re-call the provider and
    // re-duplicate on the next run; marking them all is the dedup guarantee.
    //
    // `record_candidate` is a single `INSERT` (no inner transaction), and
    // `mark_messages_extracted` is a single `UPDATE`, so both compose safely inside the
    // `unchecked_transaction` (the same mechanism `record_run_model_call` already uses).
    // The token-ledger row was written ABOVE, outside this tx (the call's cost is real
    // regardless of whether the persist commits).
    let message_ids: Vec<String> = messages.iter().map(|m| m.message_id.clone()).collect();
    let tx = db
        .conn()
        .unchecked_transaction()
        .map_err(StorageError::from)?;
    let mut candidates_created = 0usize;
    // NS-8: capture EXACTLY the candidate ids this extraction freshly records (the `Some`
    // set surfaced below). Built INSIDE the record loop — never a re-query of pending
    // candidates afterward, which could include earlier runs' pending items the task
    // forbids re-surfacing. Each carries the candidate's `kind` (a fixed VALID_KINDS token,
    // never content/PII) as the content-free card label. Empty + cheap when the flag is OFF.
    let mut fresh_candidate_ids: Vec<(String, String)> = Vec::new();
    for (i, item) in safe_items.iter().enumerate() {
        let memory_id = format!("{candidate_id_prefix}:c{i}");
        record_candidate(
            &tx,
            &NewMemoryCandidate {
                memory_id: &memory_id,
                scope: MemoryScope::Session,
                content_ref: None,
                // The recallable inline text; raw PII (non-keyword) is redacted at
                // RECALL time by cognition::rank_recall (parity with the TS).
                content: Some(item.content.as_str()),
                // Slice-3: the store scope is the SESSION-DERIVED namespace (not a caller
                // principal). This is what makes recall isolated per (account, channel, user).
                principal_id: Some(principal_id),
                // Sensitive items are DROPPED above (never persisted), so the column is
                // always false for a stored candidate.
                sensitive: false,
                created_at: now_ms,
            },
        )?;
        candidates_created += 1;
        if memory_review {
            fresh_candidate_ids.push((memory_id, item.kind.clone()));
        }
    }
    let messages_marked_extracted = mark_messages_extracted(&tx, &message_ids)?;
    tx.commit().map_err(StorageError::from)?;

    // NS-8 (flag-gated, default-OFF): AFTER the candidates are durably committed, surface
    // each freshly-recorded candidate as ONE Needs-Me / Memory-Review activity row. Each
    // candidate was just written by `record_candidate` as `state = Candidate` (always — it
    // has no other state), so it is threaded as `MemoryState::Candidate` through the proven
    // `memory_review_needs_me` producer (terminal states yield `None`; that branch is
    // exercised by the unit test, not reachable here by construction). Best-effort
    // (`let _`): a duplicate insert (same candidate re-surfaced) or any activity-write error
    // can NEVER roll back the committed candidates nor flip the run outcome — the candidates
    // already persisted. When `memory_review` is FALSE this loop is empty and skipped, so the
    // path is byte-identical to the pre-NS-8 baseline.
    for (memory_id, label) in &fresh_candidate_ids {
        if let Some(row) = memory_review_activity_row(
            memory_id,
            MemoryState::Candidate,
            MemoryScope::Session,
            label,
            now_ms,
        ) {
            let _ = db.insert_activity(&row);
        }
    }

    Ok(ExtractionOutcome {
        messages_read,
        items_parsed,
        sensitive_dropped,
        candidates_created,
        messages_marked_extracted,
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        total_tokens: outcome.total_tokens,
        model: outcome.model,
        derived_namespace,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_deepseek::{DeepSeekClient, Transport};
    use friday_storage::agent_session::{
        append_session_message, ensure_session_with_owner, SessionMessage, SessionOwner,
    };
    use friday_storage::memory::{confirm, pending_review, recall_confirmed};
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// The namespace a `seed_session`-created session resolves to (its owner is
    /// account="default", channel="discord", user=<user_id>). Centralized so the slice-3
    /// derived-`principal_id` assertions stay byte-aligned with the resolver.
    fn ns_for(user_id: &str) -> String {
        crate::session_namespace::resolve_session_memory_namespace(
            Some("default"),
            Some("discord"),
            Some(user_id),
        )
        .unwrap()
    }

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-mem-extract-{}-{}-{}-{nanos}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed),
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// A scripted mock Transport: serves `/models` (for `discover_models`) then a
    /// canned chat completion whose content is the supplied extraction JSON.
    struct ScriptedTransport {
        chat_content: String,
    }

    impl ScriptedTransport {
        fn new(chat_content: impl Into<String>) -> Self {
            ScriptedTransport {
                chat_content: chat_content.into(),
            }
        }
    }

    impl Transport for ScriptedTransport {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            Ok(json!({"object":"list","data":[
                {"id":"deepseek-v4-flash","object":"model","owned_by":"deepseek"}
            ]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            Ok(json!({
                "id":"chatcmpl-x","object":"chat.completion","model":"deepseek-v4-flash",
                "choices":[{"index":0,"message":{"role":"assistant","content":self.chat_content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":42,"completion_tokens":13,"total_tokens":55}
            }))
        }
    }

    fn client(content: impl Into<String>) -> DeepSeekClient<ScriptedTransport> {
        DeepSeekClient::with_transport(ScriptedTransport::new(content), "test-key-not-real".into())
    }

    /// Seed a session WITH an owner (slice-3: extraction now requires a resolvable
    /// namespace). The owner is account="default", channel="discord", user=`user_id`, so
    /// the derived store scope is `ns_for(user_id)`.
    fn seed_session(db: &friday_storage::Db, session: &str, user_id: &str) -> Vec<String> {
        ensure_session_with_owner(
            db.conn(),
            session,
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("discord".into()),
                user_id: Some(user_id.into()),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        let m0 = append_session_message(
            db.conn(),
            session,
            &SessionMessage::new("user", "Call my project Codename Falcon from now on.", None),
            10,
        )
        .unwrap();
        let m1 = append_session_message(
            db.conn(),
            session,
            &SessionMessage::new("assistant", "Got it, I'll use Codename Falcon.", None),
            11,
        )
        .unwrap();
        vec![m0, m1]
    }

    #[test]
    fn extract_persists_candidates_and_recall_reads_them_back_after_confirm() {
        let db = friday_storage::Db::open_hub(&tmp("consistency")).unwrap();
        let ids = seed_session(&db, "s1", "alice");
        // Slice-3: the store scope is the SESSION-DERIVED namespace, not a caller principal.
        let ns = ns_for("alice");
        // Mock extraction returns one valid item referencing a real message id.
        let content = json!({
            "items": [{
                "kind": "preference",
                "content": "User's project codename is Falcon.",
                "sourceMessageIds": [ids[0]],
                "tags": ["naming"]
            }]
        })
        .to_string();
        let c = client(content);

        let out =
            extract_inline(&db, "s1", &c, DEFAULT_MAX_ITEMS, "s1:ex:100", "led-1", 100).unwrap();
        assert_eq!(out.messages_read, 2);
        assert_eq!(out.items_parsed, 1);
        assert_eq!(out.sensitive_dropped, 0);
        assert_eq!(out.candidates_created, 1);
        // slice-2: ALL processed messages are marked extracted (not just the one the
        // single item referenced) — the dedup mark.
        assert_eq!(out.messages_marked_extracted, 2);
        assert_eq!(out.total_tokens, 55);
        // slice-3: the outcome echoes the derived namespace (the store scope).
        assert_eq!(out.derived_namespace, ns);

        // The token ledger row was written (the extraction call is ledgered).
        let ledger_rows = db.count("token_ledger").unwrap();
        assert_eq!(ledger_rows, 1);

        // Existing spine: the candidate shows up as pending_review (NOT durable yet), stored
        // under the DERIVED namespace as its `principal_id` (slice-3 ownership-binding).
        let pending = pending_review(db.conn()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].memory_id, "s1:ex:100:c0");
        assert_eq!(pending[0].principal_id.as_deref(), Some(ns.as_str()));
        // recall_confirmed returns NOTHING until the candidate is confirmed.
        assert!(recall_confirmed(db.conn(), &ns).unwrap().is_empty());

        // Confirm via the existing path → it becomes recallable under the namespace
        // (consistency proof: store→confirm→recall keyed by the SESSION-derived scope).
        confirm(db.conn(), "s1:ex:100:c0", 200).unwrap();
        let recalled = recall_confirmed(db.conn(), &ns).unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(
            recalled[0].content.as_deref(),
            Some("User's project codename is Falcon.")
        );
        // ISOLATION: a DIFFERENT user's namespace recalls nothing (per-(account,channel,user)).
        assert!(recall_confirmed(db.conn(), &ns_for("mallory"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn sensitive_item_is_dropped_not_stored() {
        let db = friday_storage::Db::open_hub(&tmp("sensitive")).unwrap();
        let ids = seed_session(&db, "s2", "bob");
        // Two items: one benign, one whose content carries a sensitive KEYWORD.
        let content = json!({
            "items": [
                {"kind":"fact","content":"User prefers Rust for new services.","sourceMessageIds":[ids[0]]},
                {"kind":"fact","content":"User's API key rotation is monthly.","sourceMessageIds":[ids[1]]}
            ]
        })
        .to_string();
        let c = client(content);

        let out =
            extract_inline(&db, "s2", &c, DEFAULT_MAX_ITEMS, "s2:ex:100", "led-2", 100).unwrap();
        assert_eq!(out.items_parsed, 2);
        assert_eq!(out.sensitive_dropped, 1, "the API-key item must be dropped");
        assert_eq!(out.candidates_created, 1);

        // Only the benign candidate is persisted; the sensitive content never stored.
        let pending = pending_review(db.conn()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].content.as_deref(),
            Some("User prefers Rust for new services.")
        );
        for row in &pending {
            assert!(
                !row.content.as_deref().unwrap_or("").contains("API key"),
                "sensitive content leaked into storage: {:?}",
                row.content
            );
        }
    }

    #[test]
    fn pii_in_candidate_is_redacted_at_recall_matching_ts() {
        // A non-keyword PII value (an email) is NOT sensitive by the keyword guard, so
        // it IS stored raw (parity with the TS) — and the EXISTING recall path redacts
        // it via cognition::rank_recall. This proves the store→confirm→recall→redact
        // loop is consistent end-to-end with no new store-time redaction.
        let db = friday_storage::Db::open_hub(&tmp("pii")).unwrap();
        let ids = seed_session(&db, "s3", "carol");
        let ns = ns_for("carol");
        let content = json!({
            "items": [{
                "kind":"fact",
                "content":"User can be reached at alice@example.com.",
                "sourceMessageIds":[ids[0]]
            }]
        })
        .to_string();
        let c = client(content);

        let out =
            extract_inline(&db, "s3", &c, DEFAULT_MAX_ITEMS, "s3:ex:100", "led-3", 100).unwrap();
        assert_eq!(out.candidates_created, 1);
        // The email keyword guard does NOT match a bare email, so it is stored.
        assert_eq!(out.sensitive_dropped, 0);

        confirm(db.conn(), "s3:ex:100:c0", 200).unwrap();
        let rows = recall_confirmed(db.conn(), &ns).unwrap();
        let ranked = crate::cognition::rank_recall(
            &rows,
            300,
            crate::cognition::DEFAULT_RECALL_TOP_K,
            crate::cognition::DEFAULT_HALF_LIFE_MS,
        );
        assert_eq!(ranked.len(), 1);
        assert!(ranked[0].redacted, "the recalled email must be redacted");
        assert!(ranked[0].content.contains("[EMAIL]"));
        assert!(!ranked[0].content.contains("alice@example.com"));
    }

    #[test]
    fn empty_session_extracts_nothing_without_calling_provider() {
        let db = friday_storage::Db::open_hub(&tmp("empty")).unwrap();
        // Slice-3: the session must have a RESOLVABLE owner (else it fails closed BEFORE
        // the empty-message early-return). Bind an owner, then leave the session message-less.
        ensure_session_with_owner(
            db.conn(),
            "s4",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("discord".into()),
                user_id: Some("dave".into()),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        // A transport that PANICS if posted to — proves the empty-session path makes
        // ZERO provider calls (it must early-return before any chat/discover).
        struct PanicTransport;
        impl Transport for PanicTransport {
            fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
                panic!("empty session must not discover models");
            }
            fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
                panic!("empty session must not call the provider");
            }
        }
        let c = DeepSeekClient::with_transport(PanicTransport, "test-key-not-real".into());
        let out =
            extract_inline(&db, "s4", &c, DEFAULT_MAX_ITEMS, "s4:ex:100", "led-4", 100).unwrap();
        assert_eq!(out.messages_read, 0);
        assert_eq!(out.candidates_created, 0);
        assert_eq!(out.messages_marked_extracted, 0);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        // Even with no messages, the derived namespace is echoed (it was resolved first).
        assert_eq!(out.derived_namespace, ns_for("dave"));
    }

    #[test]
    fn session_without_user_id_fails_closed_before_any_provider_call() {
        // Slice-3 PARITY: a session with NO owner user_id has an UNRESOLVABLE memory
        // namespace, so extraction FAILS CLOSED (mirrors the TS MEMORY_NAMESPACE_UNRESOLVABLE
        // throw) BEFORE the provider is ever contacted — even though the session has messages.
        let db = friday_storage::Db::open_hub(&tmp("nouser")).unwrap();
        // Owner-less session (account/channel set but user_id absent) WITH a message.
        ensure_session_with_owner(
            db.conn(),
            "s1",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("discord".into()),
                user_id: None,
                ..Default::default()
            },
            1,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "s1",
            &SessionMessage::new("user", "remember 47", None),
            10,
        )
        .unwrap();

        struct PanicTransport;
        impl Transport for PanicTransport {
            fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
                panic!("unresolvable namespace must fail closed before discover");
            }
            fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
                panic!("unresolvable namespace must fail closed before provider call");
            }
        }
        let c = DeepSeekClient::with_transport(PanicTransport, "test-key-not-real".into());
        let err = extract_inline(&db, "s1", &c, DEFAULT_MAX_ITEMS, "s1:ex:100", "led-1", 100)
            .unwrap_err();
        assert!(
            matches!(
                err,
                ExtractionError::NamespaceUnresolvable(NamespaceError::UnresolvableNoUserId)
            ),
            "no user_id must be a fail-closed namespace error, got {err:?}"
        );
        // No provider call, no ledger row, no candidate.
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("memory_item").unwrap(), 0);
        // ...and the message is NOT consumed (it stays pending for a retry once owned).
        assert_eq!(status_of(&db, "s1:m0"), "pending");
    }

    // --- owner-wiring (DM-chatId + subagent parent-walk userId fallbacks) ----

    #[test]
    fn dm_session_without_user_id_derives_namespace_from_chat_id() {
        // DM fallback e2e: a `chat_kind == "dm"` conversation with NO user_id stores its
        // candidates under the chat-id-derived namespace (TS: parts.chatId), end-to-end
        // through the real extraction path.
        let db = friday_storage::Db::open_hub(&tmp("dm-fallback")).unwrap();
        ensure_session_with_owner(
            db.conn(),
            "dm-s",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("telegram".into()),
                user_id: None,
                chat_kind: Some("dm".into()),
                chat_id: Some("dm-user-7".into()),
                parent_session_id: None,
                // Structural kind: a CONVERSATION (TS `parts.kind === "conversation"`) — what
                // gates the DM-chatId fallback (NOT inferred from the parent link).
                session_kind: Some("conversation".into()),
            },
            1,
        )
        .unwrap();
        let m0 = append_session_message(
            db.conn(),
            "dm-s",
            &SessionMessage::new("user", "Call my project Codename Falcon.", None),
            10,
        )
        .unwrap();
        let content = json!({
            "items": [{
                "kind": "preference",
                "content": "User's project codename is Falcon.",
                "sourceMessageIds": [m0]
            }]
        })
        .to_string();
        let c = client(content);
        let out = extract_inline(
            &db,
            "dm-s",
            &c,
            DEFAULT_MAX_ITEMS,
            "dm-s:ex:100",
            "led-dm",
            100,
        )
        .unwrap();
        assert_eq!(out.candidates_created, 1);
        // The namespace user segment is the DM chat id — on the session's OWN channel.
        let ns = crate::session_namespace::resolve_session_memory_namespace(
            Some("default"),
            Some("telegram"),
            Some("dm-user-7"),
        )
        .unwrap();
        assert_eq!(out.derived_namespace, ns);
        let pending = pending_review(db.conn()).unwrap();
        assert_eq!(pending[0].principal_id.as_deref(), Some(ns.as_str()));
    }

    #[test]
    fn subagent_session_derives_user_from_parent_walk() {
        // Subagent fallback e2e: a child session with NO user_id walks `parent_session_id`
        // to the parent's user — and the namespace keeps the CHILD's own account/channel
        // (only the userId comes from the parent, faithful to the TS resolver).
        let db = friday_storage::Db::open_hub(&tmp("subagent-fallback")).unwrap();
        // The parent session (a normal owned conversation).
        ensure_session_with_owner(
            db.conn(),
            "parent-s",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("discord".into()),
                user_id: Some("alice".into()),
                ..Default::default()
            },
            1,
        )
        .unwrap();
        // The subagent child: no user_id, linked to the parent.
        ensure_session_with_owner(
            db.conn(),
            "child-s",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("discord".into()),
                user_id: None,
                chat_kind: None,
                chat_id: None,
                parent_session_id: Some("parent-s".into()),
                // Structural kind: a SUBAGENT (TS `parts.kind === "subagent"`) — what gates
                // the parent-walk (NOT inferred from the parent link's presence).
                session_kind: Some("subagent".into()),
            },
            2,
        )
        .unwrap();
        let m0 = append_session_message(
            db.conn(),
            "child-s",
            &SessionMessage::new("user", "Budget for the falcon task is 500.", None),
            10,
        )
        .unwrap();
        let content = json!({
            "items": [{
                "kind": "fact",
                "content": "The falcon task budget is 500.",
                "sourceMessageIds": [m0]
            }]
        })
        .to_string();
        let c = client(content);
        let out = extract_inline(
            &db,
            "child-s",
            &c,
            DEFAULT_MAX_ITEMS,
            "child-s:ex:100",
            "led-sub",
            100,
        )
        .unwrap();
        assert_eq!(out.candidates_created, 1);
        // Parent-derived user, CHILD's account/channel ("default"/"discord" here).
        assert_eq!(out.derived_namespace, ns_for("alice"));
        let pending = pending_review(db.conn()).unwrap();
        assert_eq!(
            pending[0].principal_id.as_deref(),
            Some(ns_for("alice").as_str())
        );
    }

    #[test]
    fn underivable_fallbacks_fail_closed_before_any_provider_call() {
        // The fallbacks NEVER guess: a group chat (chat_id present but kind != dm) and a
        // dangling subagent parent both fail closed BEFORE the provider is contacted.
        struct PanicTransport;
        impl Transport for PanicTransport {
            fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
                panic!("underivable namespace must fail closed before discover");
            }
            fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
                panic!("underivable namespace must fail closed before provider call");
            }
        }

        let db = friday_storage::Db::open_hub(&tmp("underivable")).unwrap();
        // (a) A GROUP chat: multi-user — attributing it to the chat id would merge users.
        ensure_session_with_owner(
            db.conn(),
            "group-s",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("telegram".into()),
                user_id: None,
                chat_kind: Some("group".into()),
                chat_id: Some("group-42".into()),
                parent_session_id: None,
                // A CONVERSATION (group): no DM fallback (group is multi-user) — fail closed.
                session_kind: Some("conversation".into()),
            },
            1,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "group-s",
            &SessionMessage::new("user", "remember 47", None),
            10,
        )
        .unwrap();
        // (b) A subagent whose parent link DANGLES (no such session row).
        ensure_session_with_owner(
            db.conn(),
            "orphan-s",
            &SessionOwner {
                account_id: Some("default".into()),
                channel: Some("discord".into()),
                user_id: None,
                chat_kind: None,
                chat_id: None,
                parent_session_id: Some("ghost-parent".into()),
                // A SUBAGENT whose parent link dangles — the walk ends fail closed.
                session_kind: Some("subagent".into()),
            },
            1,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            "orphan-s",
            &SessionMessage::new("user", "remember 48", None),
            10,
        )
        .unwrap();

        for sid in ["group-s", "orphan-s"] {
            let c = DeepSeekClient::with_transport(PanicTransport, "test-key-not-real".into());
            let err = extract_inline(
                &db,
                sid,
                &c,
                DEFAULT_MAX_ITEMS,
                &format!("{sid}:ex:100"),
                &format!("led-{sid}"),
                100,
            )
            .unwrap_err();
            assert!(
                matches!(
                    err,
                    ExtractionError::NamespaceUnresolvable(NamespaceError::UnresolvableNoUserId)
                ),
                "{sid}: underivable fallback must fail closed, got {err:?}"
            );
        }
        // No provider call, no ledger row, no candidate — and messages stay pending.
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("memory_item").unwrap(), 0);
        assert_eq!(status_of(&db, "group-s:m0"), "pending");
        assert_eq!(status_of(&db, "orphan-s:m0"), "pending");
    }

    /// Read one message's `memory_extract_status` (test-only helper for the slice-2
    /// dedup/rollback assertions).
    fn status_of(db: &friday_storage::Db, message_id: &str) -> String {
        db.conn()
            .query_row(
                "SELECT memory_extract_status FROM agent_session_message WHERE message_id = ?1",
                [message_id],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
    }

    #[test]
    fn re_run_reads_no_pending_and_creates_no_duplicate_candidates() {
        // DEDUP proof. The mock refs ONLY ids[0]; ids[1] is processed-but-unreferenced.
        // After run 1 BOTH must be marked extracted (so run 2 sees zero pending and never
        // calls the provider). seed_session gives a referenced + an unreferenced message,
        // so the unchanged-ledger assertion catches "marked only the referenced id".
        let db = friday_storage::Db::open_hub(&tmp("dedup")).unwrap();
        let ids = seed_session(&db, "s1", "alice");
        let content = json!({
            "items": [{
                "kind": "preference",
                "content": "User's project codename is Falcon.",
                "sourceMessageIds": [ids[0]],
                "tags": ["naming"]
            }]
        })
        .to_string();
        let c = client(content);

        // Run 1: reads both pending, creates 1 candidate, marks BOTH messages extracted.
        let out1 =
            extract_inline(&db, "s1", &c, DEFAULT_MAX_ITEMS, "s1:ex:100", "led-1", 100).unwrap();
        assert_eq!(out1.messages_read, 2);
        assert_eq!(out1.candidates_created, 1);
        assert_eq!(out1.messages_marked_extracted, 2, "both messages consumed");
        assert_eq!(status_of(&db, &ids[0]), "extracted");
        assert_eq!(
            status_of(&db, &ids[1]),
            "extracted",
            "the unreferenced message must also be marked (else it stays pending)"
        );
        assert_eq!(db.count("token_ledger").unwrap(), 1);
        assert_eq!(pending_review(db.conn()).unwrap().len(), 1);

        // Run 2 with a PANIC transport: if it reads any pending it would call the
        // provider and panic. It must read 0 pending → 0 candidates → 0 provider calls.
        struct PanicTransport;
        impl Transport for PanicTransport {
            fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
                panic!("re-run must not discover models (no pending messages)");
            }
            fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
                panic!("re-run must not call the provider (no pending messages)");
            }
        }
        let c2 = DeepSeekClient::with_transport(PanicTransport, "test-key-not-real".into());
        let out2 =
            extract_inline(&db, "s1", &c2, DEFAULT_MAX_ITEMS, "s1:ex:200", "led-2", 200).unwrap();
        assert_eq!(out2.messages_read, 0, "no pending messages on re-run");
        assert_eq!(out2.candidates_created, 0, "no duplicate candidates");
        assert_eq!(out2.messages_marked_extracted, 0);
        // No second ledger row (no provider call), and still exactly one candidate.
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "no second provider call"
        );
        assert_eq!(
            pending_review(db.conn()).unwrap().len(),
            1,
            "no duplicate row"
        );
        assert_eq!(db.count("memory_item").unwrap(), 1);
    }

    #[test]
    fn persist_error_mid_loop_rolls_back_both_candidates_and_marks() {
        // TRANSACTIONAL proof. The mock returns TWO safe items → the loop mints `:c0`
        // then `:c1`. We pre-insert a memory_item at `:c1` so the c1 INSERT collides on
        // the PRIMARY KEY mid-loop → the whole tx drops → BOTH the c0 candidate AND the
        // extracted-marks roll back (all-or-nothing). No test seam in `extract_inline`.
        let db = friday_storage::Db::open_hub(&tmp("rollback")).unwrap();
        let ids = seed_session(&db, "s1", "alice");
        let content = json!({
            "items": [
                {"kind":"fact","content":"first item","sourceMessageIds":[ids[0]]},
                {"kind":"fact","content":"second item","sourceMessageIds":[ids[1]]}
            ]
        })
        .to_string();
        let c = client(content);

        // Pre-seed the row the loop will try to mint at i==1, forcing a PK collision. The
        // pre-seeded `principal_id` is arbitrary (the collision is on the memory_id PK).
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: "s1:ex:100:c1",
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some("pre-existing collision row"),
                principal_id: Some("pre-seeded"),
                sensitive: false,
                created_at: 50,
            },
        )
        .unwrap();

        let err = extract_inline(&db, "s1", &c, DEFAULT_MAX_ITEMS, "s1:ex:100", "led-1", 100)
            .unwrap_err();
        assert!(
            matches!(err, ExtractionError::Storage(_)),
            "PK collision is a storage error"
        );

        // FULL ROLLBACK: the c0 candidate the loop inserted before the collision is gone
        // (only the pre-seeded c1 remains), and NO message was marked — both still pending.
        assert!(
            friday_storage::memory::get(db.conn(), "s1:ex:100:c0")
                .unwrap()
                .is_none(),
            "the c0 candidate must be rolled back (no partial persist)"
        );
        assert_eq!(
            db.count("memory_item").unwrap(),
            1,
            "only the pre-seeded collision row survives"
        );
        assert_eq!(
            status_of(&db, &ids[0]),
            "pending",
            "no message marked on rollback"
        );
        assert_eq!(
            status_of(&db, &ids[1]),
            "pending",
            "no message marked on rollback"
        );
        // The ledger row was written BEFORE the tx, so it survives (disclosed: a retry
        // re-calls the provider; slice-2 defers the 'failed'/queue machine).
        assert_eq!(db.count("token_ledger").unwrap(), 1);
    }

    #[test]
    fn sensitivity_dropped_source_is_marked_extracted_not_re_extracted() {
        // A session whose ONLY extracted item is sensitivity-DROPPED still consumes its
        // source messages: they are marked extracted so a re-run does not re-extract them
        // (matches the TS — a dropped item still leaves the pending set).
        let db = friday_storage::Db::open_hub(&tmp("dropped")).unwrap();
        let ids = seed_session(&db, "s1", "bob");
        let content = json!({
            "items": [
                {"kind":"fact","content":"User's API key rotation is monthly.","sourceMessageIds":[ids[0]]}
            ]
        })
        .to_string();
        let c = client(content);

        let out =
            extract_inline(&db, "s1", &c, DEFAULT_MAX_ITEMS, "s1:ex:100", "led-1", 100).unwrap();
        assert_eq!(out.items_parsed, 1);
        assert_eq!(out.sensitive_dropped, 1, "the API-key item is dropped");
        assert_eq!(out.candidates_created, 0, "nothing safe to persist");
        // Even with zero candidates, EVERY processed message is consumed (marked).
        assert_eq!(out.messages_marked_extracted, 2);
        assert_eq!(status_of(&db, &ids[0]), "extracted");
        assert_eq!(status_of(&db, &ids[1]), "extracted");
        assert_eq!(
            db.count("memory_item").unwrap(),
            0,
            "no sensitive content stored"
        );

        // Re-run sees no pending and makes no provider call (proves not re-extracted).
        struct PanicTransport;
        impl Transport for PanicTransport {
            fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
                panic!("dropped-source re-run must not call the provider");
            }
            fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
                panic!("dropped-source re-run must not call the provider");
            }
        }
        let c2 = DeepSeekClient::with_transport(PanicTransport, "test-key-not-real".into());
        let out2 =
            extract_inline(&db, "s1", &c2, DEFAULT_MAX_ITEMS, "s1:ex:200", "led-2", 200).unwrap();
        assert_eq!(out2.messages_read, 0, "dropped source is not re-extracted");
    }

    #[test]
    fn blank_session_is_bad_input() {
        // Slice-3 removed the caller `principal_id` arg (the store scope is now session-
        // derived), so only the blank-session-id bad-input remains.
        let db = friday_storage::Db::open_hub(&tmp("blank")).unwrap();
        let c = client(r#"{"items":[]}"#);
        assert!(matches!(
            extract_inline(&db, "  ", &c, DEFAULT_MAX_ITEMS, "p", "l", 1),
            Err(ExtractionError::BadInput("session_id"))
        ));
    }

    #[test]
    fn parse_tolerates_fenced_and_surrounded_json_and_filters_invalid_items() {
        let mut valid = HashSet::new();
        valid.insert("m0".to_string());

        // Fenced block.
        let fenced = "```json\n{\"items\":[{\"kind\":\"fact\",\"content\":\"x\",\"sourceMessageIds\":[\"m0\"]}]}\n```";
        let items = parse_items(fenced, &valid).unwrap();
        assert_eq!(items.len(), 1);

        // Surrounded by prose.
        let prose = "Here is the result: {\"items\":[{\"kind\":\"fact\",\"content\":\"y\",\"sourceMessageIds\":[\"m0\"]}]} done.";
        assert_eq!(parse_items(prose, &valid).unwrap().len(), 1);

        // Invalid items are filtered: bad kind, empty content, unknown source id,
        // missing source ids.
        let mixed = json!({"items":[
            {"kind":"bogus","content":"a","sourceMessageIds":["m0"]},
            {"kind":"fact","content":"   ","sourceMessageIds":["m0"]},
            {"kind":"fact","content":"b","sourceMessageIds":["unknown"]},
            {"kind":"fact","content":"c","sourceMessageIds":[]},
            {"kind":"fact","content":"keeper","sourceMessageIds":["m0"]}
        ]})
        .to_string();
        let kept = parse_items(&mixed, &valid).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].content, "keeper");
    }

    #[test]
    fn unparseable_model_output_is_parse_error() {
        let valid = HashSet::new();
        assert!(matches!(
            parse_items("not json at all", &valid),
            Err(ExtractionError::Parse)
        ));
        assert!(matches!(
            parse_items("{\"no_items_key\":true}", &valid),
            Err(ExtractionError::Parse)
        ));
    }

    // ── NS-8: surface a Memory-Review Needs-Me item per freshly-recorded candidate ──────
    // (FRIDAY_MEMORY_REVIEW_NEEDS_ME, default-OFF). The flag bool is INJECTED into
    // `extract_inline_flagged` directly so the tests never mutate `std::env` (no in-process
    // race) — the codebase's split-env-read-from-pure-logic idiom (mirrors NS-7).

    /// The `memory_review` activity rows on the surface, via the same `list_activity`
    /// projection the operator's Needs-Me surface reads (drops `deep_link`/`session_id`).
    fn memory_review_rows(db: &friday_storage::Db) -> Vec<friday_storage::ActivitySummary> {
        db.list_activity()
            .unwrap()
            .into_iter()
            .filter(|a| a.kind == ActivityType::MemoryReview.as_str())
            .collect()
    }

    #[test]
    fn ns8_pure_flag_matcher_is_default_off_and_only_exact_one_enables() {
        assert!(
            !memory_review_needs_me_from(None),
            "unset ⇒ OFF (prod default)"
        );
        assert!(!memory_review_needs_me_from(Some("")), "empty ⇒ OFF");
        assert!(!memory_review_needs_me_from(Some("0")), "0 ⇒ OFF");
        assert!(!memory_review_needs_me_from(Some("off")), "off ⇒ OFF");
        assert!(
            !memory_review_needs_me_from(Some("true")),
            "true ⇒ OFF (exact-1 only)"
        );
        assert!(memory_review_needs_me_from(Some("1")), "1 ⇒ ON");
        assert!(memory_review_needs_me_from(Some("  1  ")), "trimmed 1 ⇒ ON");
    }

    #[test]
    fn ns8_pure_row_builder_surfaces_candidate_and_skips_terminal() {
        // A pending Candidate ⇒ ONE Pending memory_review row whose summary + deep_link carry
        // the refs-only destination `memory/{scope}/{id}` (the `list_activity` projection
        // drops `deep_link`, so the destination must also be in the summary).
        let row = memory_review_activity_row(
            "s1:ex:100:c0",
            MemoryState::Candidate,
            MemoryScope::Session,
            "preference",
            100,
        )
        .expect("a pending candidate surfaces");
        assert_eq!(row.activity_id, "memory-review-needs-me-s1:ex:100:c0");
        assert_eq!(row.kind.as_str(), "memory_review");
        assert_eq!(row.state.as_str(), "pending");
        assert_eq!(
            row.deep_link.as_deref(),
            Some("memory/session/s1:ex:100:c0")
        );
        assert!(
            row.summary.contains("memory/session/s1:ex:100:c0"),
            "destination must be in the (projection-surfaced) summary: {}",
            row.summary
        );
        // TERMINAL candidate ⇒ None ⇒ never surfaced (terminal-is-final; producer's branch).
        assert!(
            memory_review_activity_row(
                "s1:ex:100:c0",
                MemoryState::Confirmed,
                MemoryScope::Session,
                "preference",
                100,
            )
            .is_none(),
            "a confirmed (terminal) candidate must NOT surface"
        );
        assert!(memory_review_activity_row(
            "s1:ex:100:c0",
            MemoryState::Rejected,
            MemoryScope::Session,
            "preference",
            100,
        )
        .is_none());
    }

    #[test]
    fn ns8_flag_on_surfaces_one_memory_review_row_per_fresh_candidate() {
        let db = friday_storage::Db::open_hub(&tmp("ns8-on")).unwrap();
        let ids = seed_session(&db, "s1", "alice");
        let content = json!({
            "items": [{
                "kind": "preference",
                "content": "User's project codename is Falcon.",
                "sourceMessageIds": [ids[0]],
                "tags": ["naming"]
            }]
        })
        .to_string();
        let c = client(content);

        let out = extract_inline_flagged(
            &db,
            "s1",
            &c,
            DEFAULT_MAX_ITEMS,
            "s1:ex:100",
            "led-1",
            100,
            true, // flag ON
        )
        .unwrap();
        assert_eq!(out.candidates_created, 1);

        // EXACTLY one memory_review row, Pending, tied to THIS candidate via its destination
        // `memory/{scope}/{id}` (scope = session; id = the freshly-minted candidate id).
        let rows = memory_review_rows(&db);
        assert_eq!(rows.len(), 1, "one row per freshly-recorded candidate");
        assert_eq!(rows[0].activity_id, "memory-review-needs-me-s1:ex:100:c0");
        assert_eq!(rows[0].state, "pending");
        assert!(
            rows[0].summary.contains("memory/session/s1:ex:100:c0"),
            "row references the candidate's destination: {}",
            rows[0].summary
        );
        // The candidate content must NEVER leak into the surfaced summary (PII-safe label).
        assert!(
            !rows[0].summary.contains("Falcon"),
            "candidate content must not leak into the Needs-Me card: {}",
            rows[0].summary
        );
    }

    #[test]
    fn ns8_flag_on_terminal_candidate_is_not_surfaced() {
        // Drive the surfacing projection with a TERMINAL state directly (the proven producer
        // returns None) — the honest exercise of terminal-is-final. `extract_inline` only ever
        // freshly records `Candidate`s, so a terminal candidate cannot arise in that loop; the
        // skip lives in `memory_review_activity_row` and is verified here end-to-end on the DB.
        let db = friday_storage::Db::open_hub(&tmp("ns8-terminal")).unwrap();
        for state in [MemoryState::Confirmed, MemoryState::Rejected] {
            if let Some(row) =
                memory_review_activity_row("m-terminal", state, MemoryScope::Session, "fact", 10)
            {
                db.insert_activity(&row).unwrap();
            }
        }
        assert!(
            memory_review_rows(&db).is_empty(),
            "a terminal candidate yields no memory_review row"
        );
    }

    #[test]
    fn ns8_flag_off_is_byte_identical_no_review_row() {
        let db = friday_storage::Db::open_hub(&tmp("ns8-off")).unwrap();
        let ids = seed_session(&db, "s1", "alice");
        let content = json!({
            "items": [{
                "kind": "preference",
                "content": "User's project codename is Falcon.",
                "sourceMessageIds": [ids[0]]
            }]
        })
        .to_string();
        let c = client(content);

        let before = db.list_activity().unwrap();
        let out = extract_inline_flagged(
            &db,
            "s1",
            &c,
            DEFAULT_MAX_ITEMS,
            "s1:ex:100",
            "led-1",
            100,
            false, // flag OFF (default)
        )
        .unwrap();
        // The candidate still records exactly as today — the flag governs ONLY surfacing.
        assert_eq!(out.candidates_created, 1);
        assert_eq!(pending_review(db.conn()).unwrap().len(), 1);
        // No memory_review row, and the activity surface is unchanged (byte-identical).
        assert!(
            memory_review_rows(&db).is_empty(),
            "flag OFF ⇒ no review row"
        );
        assert_eq!(
            db.list_activity().unwrap(),
            before,
            "flag OFF ⇒ activity surface byte-identical"
        );
    }

    #[test]
    fn ns8_re_surfacing_same_candidate_is_idempotent_one_row() {
        // The activity_id is keyed on the candidate's memory_id (the PRIMARY KEY), so a
        // second insert of the SAME candidate's row is a fail-closed duplicate — swallowed by
        // the best-effort `let _` in the surfacing step, leaving exactly one row. `extract_inline`
        // cannot naturally re-surface a candidate (unique `now_ms` prefix + message dedup), so
        // this drives the insert path directly.
        let db = friday_storage::Db::open_hub(&tmp("ns8-dedup")).unwrap();
        let row = memory_review_activity_row(
            "s1:ex:100:c0",
            MemoryState::Candidate,
            MemoryScope::Session,
            "preference",
            100,
        )
        .unwrap();
        db.insert_activity(&row).unwrap();
        // Re-surface the SAME candidate: best-effort swallow of the duplicate-PK error.
        let _ = db.insert_activity(&row);
        assert_eq!(
            memory_review_rows(&db).len(),
            1,
            "re-surfacing the same candidate must not duplicate the row"
        );
    }

    #[test]
    fn ns8_only_freshly_recorded_candidates_surface_not_prior_run_pending() {
        // PINS NS-8's core anti-nagging faithfulness: a review item surfaces ONLY for the
        // candidates THIS extraction freshly recorded — a still-PENDING candidate that already
        // existed (e.g. recorded by an EARLIER run, with NO surfaced row) is NOT re-surfaced.
        //
        // This is the DISCRIMINATING construction (the task's "minimal faithful equivalent"):
        // a 2nd extraction over the SAME already-extracted session is NOT discriminating —
        // it early-returns at the empty-pending guard and never reaches the surfacing loop, so
        // it can't distinguish "surfacing iterates only fresh ids" from a (forbidden) re-query
        // of `pending_review()`. Instead we (a) pre-seed a PENDING candidate X with NO surfaced
        // row, then (b) run a flag-ON extraction over FRESH pending messages whose provider
        // returns ZERO items — so the surfacing loop IS reached (messages non-empty ⇒ no early
        // return) but `fresh_candidate_ids` is empty (0 candidates recorded this run). The
        // correct impl (surface only freshly-recorded ids) leaves X UN-surfaced; a `pending_
        // review()` re-query mutation would WRONGLY surface the pre-existing pending X. So this
        // assertion kills that mutation.
        let db = friday_storage::Db::open_hub(&tmp("ns8-fresh-only")).unwrap();

        // (a) A still-PENDING candidate from an earlier run — recorded directly via the spine,
        // with NO accompanying memory_review activity row (it was never surfaced).
        // `pending_review` is principal-agnostic, so the namespace here is arbitrary.
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: "prior-run:c0",
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some("a leftover pending candidate from a prior run"),
                principal_id: Some("prior-run-principal"),
                sensitive: false,
                created_at: 50,
            },
        )
        .unwrap();
        assert_eq!(
            pending_review(db.conn()).unwrap().len(),
            1,
            "the pre-existing candidate is pending"
        );
        assert_eq!(
            memory_review_rows(&db).len(),
            0,
            "the pre-existing pending candidate has NO surfaced review row"
        );

        // (b) A flag-ON extraction over FRESH pending messages whose provider returns ZERO
        // items: messages are non-empty (no early return ⇒ the surfacing loop RUNS), but the
        // record loop records 0 candidates ⇒ `fresh_candidate_ids` is empty ⇒ the surfacing
        // loop is a no-op. Uses the normal mock client (the provider IS called).
        let _ids = seed_session(&db, "s1", "alice");
        let c = client(json!({ "items": [] }).to_string());
        let out = extract_inline_flagged(
            &db,
            "s1",
            &c,
            DEFAULT_MAX_ITEMS,
            "s1:ex:100",
            "led-1",
            100,
            true, // flag ON
        )
        .unwrap();
        assert!(
            out.messages_read >= 1,
            "the surfacing loop is reached (messages non-empty)"
        );
        assert_eq!(
            out.candidates_created, 0,
            "this extraction freshly records ZERO candidates"
        );

        // The pre-existing pending candidate X must NOT be surfaced: only THIS run's freshly-
        // recorded ids surface, and this run recorded none. A `pending_review()` re-query would
        // wrongly surface X here (count would become 1) — so this pins the freshly-recorded-only
        // property, not merely "a re-run adds no rows".
        assert_eq!(
            memory_review_rows(&db).len(),
            0,
            "a pre-existing pending candidate (not freshly recorded this run) is NOT surfaced"
        );
        // X is still pending (untouched by the surfacing step).
        assert_eq!(pending_review(db.conn()).unwrap().len(), 1);
    }
}
