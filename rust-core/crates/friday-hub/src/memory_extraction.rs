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
//! ## Honest scope (disclosed deviations from the TS oracle)
//! - **Source table.** The Rust schema has no `session_messages` table (with the
//!   `memory_extract_status`/`is_inherited` columns the TS reads). This slice reads
//!   `agent_session_message` via `load_session_messages` — ALL messages in `seq`
//!   order. Consequences (disclosed): there is NO pending/inherited pre-filter, and
//!   messages are NOT marked extracted/skipped after a run, so a RE-RUN may
//!   re-extract + duplicate candidates. Idempotency / status-marking is a follow-on
//!   slice (it would need a storage change, which is out of scope here).
//! - **No tags / metadata persisted.** The Rust `memory_item` row has no
//!   tags/metadata columns; the TS tags/metadata are simply not stored in slice-1.
//! - **One concatenated prompt.** The Rust [`DeepSeekClient::chat`] takes a single
//!   prompt (no system/user split, no `response_format`/`temperature`); the system
//!   + user prompt are concatenated. The JSON-only contract is carried in the
//!   prompt text, and parsing tolerates fenced / surrounded JSON like the TS.
//! - **Queue / auto mode NOT included.** Only the inline manual path. The
//!   queue/job-retry machine is a follow-on slice.
//! - **PII redaction stays at RECALL time** (cognition::rank_recall), NOT at store
//!   time — faithful to the TS, which stores raw non-keyword PII and redacts on
//!   recall. The sensitivity guard here drops KEYWORD-bearing items (passwords,
//!   tokens, SSN/credit-card words, medical/financial/…), matching the TS guard.
//!
//! Truth label: Rust-owned INLINE extraction, FIRST slice. The TS extraction path
//! STAYS LIVE (parity pending). PROOF-ONLY — NOT a v1 GO.

use friday_core::MemoryScope;
use friday_deepseek::{DeepSeekClient, DeepSeekError, Transport};
use friday_storage::agent_session::{load_session_messages, StoredSessionMessage};
use friday_storage::memory::{record_candidate, NewMemoryCandidate};
use friday_storage::StorageError;
use serde_json::Value;
use std::collections::HashSet;

use crate::sensitive_guard::is_sensitive_learning_candidate;

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
    /// Token usage of the single extraction call (ledgered separately).
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    /// The reported model id (a safe label — never a secret).
    pub model: String,
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
    /// `--principal` / session id was blank.
    BadInput(&'static str),
}

impl std::fmt::Display for ExtractionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractionError::Storage(_) => write!(f, "storage error"),
            ExtractionError::Provider(e) => write!(f, "provider error: {e}"),
            ExtractionError::Parse => write!(f, "model output parse error"),
            ExtractionError::BadInput(w) => write!(f, "bad input: {w}"),
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

/// Run one INLINE manual extraction for a session: read messages → prompt →
/// provider call (ledgered) → parse → sensitivity-filter → persist candidates.
///
/// `client` is generic over [`Transport`] so tests inject a mock provider and the
/// bin passes a live `DeepSeekClient::from_env()`. The call+ledger reuses
/// [`DeepSeekClient::run_friday_ask`]; the resulting [`friday_core::LedgerEntry`]
/// is persisted via [`friday_storage::Db::insert_token_ledger`] — the same ledger
/// the ask path writes (`fallback = false`).
///
/// `candidate_id_prefix` namespaces the minted `memory_id`s (e.g.
/// `"<session>:extract:<now_ms>"`), so a re-run mints distinct ids (idempotency
/// across re-runs is a follow-on slice — disclosed in the module docs).
#[allow(clippy::too_many_arguments)]
pub fn extract_inline<T: Transport>(
    db: &mut friday_storage::Db,
    session_id: &str,
    principal_id: &str,
    client: &DeepSeekClient<T>,
    max_items: usize,
    candidate_id_prefix: &str,
    ledger_id: &str,
    now_ms: i64,
) -> Result<ExtractionOutcome, ExtractionError> {
    if session_id.trim().is_empty() {
        return Err(ExtractionError::BadInput("session_id"));
    }
    if principal_id.trim().is_empty() {
        return Err(ExtractionError::BadInput("principal_id"));
    }

    let messages = load_session_messages(db.conn(), session_id)?;
    let messages_read = messages.len();

    // Empty session: nothing to extract (TS `messages.length === 0` early return).
    if messages.is_empty() {
        return Ok(ExtractionOutcome {
            messages_read: 0,
            items_parsed: 0,
            sensitive_dropped: 0,
            candidates_created: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            model: String::new(),
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

    // Persist each surviving item as a CANDIDATE (state = Candidate). Reuses the
    // existing memory spine — nothing here makes it durable.
    let mut candidates_created = 0usize;
    for (i, item) in safe_items.iter().enumerate() {
        let memory_id = format!("{candidate_id_prefix}:c{i}");
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: &memory_id,
                scope: MemoryScope::Session,
                content_ref: None,
                // The recallable inline text; raw PII (non-keyword) is redacted at
                // RECALL time by cognition::rank_recall (parity with the TS).
                content: Some(item.content.as_str()),
                principal_id: Some(principal_id),
                // slice-1 stores no sensitive content (sensitive items are DROPPED
                // above), so the column is always false here.
                sensitive: false,
                created_at: now_ms,
            },
        )?;
        candidates_created += 1;
    }

    Ok(ExtractionOutcome {
        messages_read,
        items_parsed,
        sensitive_dropped,
        candidates_created,
        prompt_tokens: outcome.prompt_tokens,
        completion_tokens: outcome.completion_tokens,
        total_tokens: outcome.total_tokens,
        model: outcome.model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_deepseek::{DeepSeekClient, Transport};
    use friday_storage::agent_session::{append_session_message, ensure_session, SessionMessage};
    use friday_storage::memory::{confirm, pending_review, recall_confirmed};
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

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

    fn seed_session(db: &friday_storage::Db, session: &str) -> Vec<String> {
        ensure_session(db.conn(), session, 1).unwrap();
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
        let mut db = friday_storage::Db::open_hub(&tmp("consistency")).unwrap();
        let ids = seed_session(&db, "s1");
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

        let out = extract_inline(
            &mut db,
            "s1",
            "alice",
            &c,
            DEFAULT_MAX_ITEMS,
            "s1:ex:100",
            "led-1",
            100,
        )
        .unwrap();
        assert_eq!(out.messages_read, 2);
        assert_eq!(out.items_parsed, 1);
        assert_eq!(out.sensitive_dropped, 0);
        assert_eq!(out.candidates_created, 1);
        assert_eq!(out.total_tokens, 55);

        // The token ledger row was written (the extraction call is ledgered).
        let ledger_rows = db.count("token_ledger").unwrap();
        assert_eq!(ledger_rows, 1);

        // Existing spine: the candidate shows up as pending_review (NOT durable yet).
        let pending = pending_review(db.conn()).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].memory_id, "s1:ex:100:c0");
        assert_eq!(pending[0].principal_id.as_deref(), Some("alice"));
        // recall_confirmed returns NOTHING until the candidate is confirmed.
        assert!(recall_confirmed(db.conn(), "alice").unwrap().is_empty());

        // Confirm via the existing path → it becomes recallable (consistency proof).
        confirm(db.conn(), "s1:ex:100:c0", 200).unwrap();
        let recalled = recall_confirmed(db.conn(), "alice").unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(
            recalled[0].content.as_deref(),
            Some("User's project codename is Falcon.")
        );
    }

    #[test]
    fn sensitive_item_is_dropped_not_stored() {
        let mut db = friday_storage::Db::open_hub(&tmp("sensitive")).unwrap();
        let ids = seed_session(&db, "s2");
        // Two items: one benign, one whose content carries a sensitive KEYWORD.
        let content = json!({
            "items": [
                {"kind":"fact","content":"User prefers Rust for new services.","sourceMessageIds":[ids[0]]},
                {"kind":"fact","content":"User's API key rotation is monthly.","sourceMessageIds":[ids[1]]}
            ]
        })
        .to_string();
        let c = client(content);

        let out = extract_inline(
            &mut db,
            "s2",
            "bob",
            &c,
            DEFAULT_MAX_ITEMS,
            "s2:ex:100",
            "led-2",
            100,
        )
        .unwrap();
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
        let mut db = friday_storage::Db::open_hub(&tmp("pii")).unwrap();
        let ids = seed_session(&db, "s3");
        let content = json!({
            "items": [{
                "kind":"fact",
                "content":"User can be reached at alice@example.com.",
                "sourceMessageIds":[ids[0]]
            }]
        })
        .to_string();
        let c = client(content);

        let out = extract_inline(
            &mut db,
            "s3",
            "carol",
            &c,
            DEFAULT_MAX_ITEMS,
            "s3:ex:100",
            "led-3",
            100,
        )
        .unwrap();
        assert_eq!(out.candidates_created, 1);
        // The email keyword guard does NOT match a bare email, so it is stored.
        assert_eq!(out.sensitive_dropped, 0);

        confirm(db.conn(), "s3:ex:100:c0", 200).unwrap();
        let rows = recall_confirmed(db.conn(), "carol").unwrap();
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
        let mut db = friday_storage::Db::open_hub(&tmp("empty")).unwrap();
        ensure_session(db.conn(), "s4", 1).unwrap();
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
        let out = extract_inline(
            &mut db,
            "s4",
            "dave",
            &c,
            DEFAULT_MAX_ITEMS,
            "s4:ex:100",
            "led-4",
            100,
        )
        .unwrap();
        assert_eq!(out.messages_read, 0);
        assert_eq!(out.candidates_created, 0);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
    }

    #[test]
    fn blank_session_or_principal_is_bad_input() {
        let mut db = friday_storage::Db::open_hub(&tmp("blank")).unwrap();
        let c = client(r#"{"items":[]}"#);
        assert!(matches!(
            extract_inline(&mut db, "  ", "x", &c, DEFAULT_MAX_ITEMS, "p", "l", 1),
            Err(ExtractionError::BadInput("session_id"))
        ));
        assert!(matches!(
            extract_inline(&mut db, "s", "  ", &c, DEFAULT_MAX_ITEMS, "p", "l", 1),
            Err(ExtractionError::BadInput("principal_id"))
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
}
