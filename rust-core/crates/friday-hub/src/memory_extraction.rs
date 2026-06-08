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
//! - **Queue / auto mode + ownership-binding still DEFERRED.** Only the inline manual
//!   path; the queue/job-retry/auto machine and ownership-claim binding are follow-on
//!   slices (the principal is a caller-supplied ref).
//!
//! Truth label: Rust-owned INLINE extraction, slice-2 (dedup + transactional). The TS
//! extraction path STAYS LIVE (full parity — queue/auto + ownership-binding — pending).
//! PROOF-ONLY — NOT a v1 GO.

use friday_core::MemoryScope;
use friday_deepseek::{DeepSeekClient, DeepSeekError, Transport};
use friday_storage::agent_session::{
    load_pending_session_messages, mark_messages_extracted, StoredSessionMessage,
};
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
/// `"<session>:extract:<now_ms>"`). Slice-2 makes re-runs IDEMPOTENT at the source:
/// only PENDING messages are read, and a successful run marks the processed messages
/// `'extracted'`, so a second run reads no pending and creates no duplicate candidates.
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
                principal_id: Some(principal_id),
                // Sensitive items are DROPPED above (never persisted), so the column is
                // always false for a stored candidate.
                sensitive: false,
                created_at: now_ms,
            },
        )?;
        candidates_created += 1;
    }
    let messages_marked_extracted = mark_messages_extracted(&tx, &message_ids)?;
    tx.commit().map_err(StorageError::from)?;

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
        // slice-2: ALL processed messages are marked extracted (not just the one the
        // single item referenced) — the dedup mark.
        assert_eq!(out.messages_marked_extracted, 2);
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
        assert_eq!(out.messages_marked_extracted, 0);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
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
        let mut db = friday_storage::Db::open_hub(&tmp("dedup")).unwrap();
        let ids = seed_session(&db, "s1");
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
        let out1 = extract_inline(
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
        let out2 = extract_inline(
            &mut db,
            "s1",
            "alice",
            &c2,
            DEFAULT_MAX_ITEMS,
            "s1:ex:200",
            "led-2",
            200,
        )
        .unwrap();
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
        let mut db = friday_storage::Db::open_hub(&tmp("rollback")).unwrap();
        let ids = seed_session(&db, "s1");
        let content = json!({
            "items": [
                {"kind":"fact","content":"first item","sourceMessageIds":[ids[0]]},
                {"kind":"fact","content":"second item","sourceMessageIds":[ids[1]]}
            ]
        })
        .to_string();
        let c = client(content);

        // Pre-seed the row the loop will try to mint at i==1, forcing a PK collision.
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: "s1:ex:100:c1",
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some("pre-existing collision row"),
                principal_id: Some("alice"),
                sensitive: false,
                created_at: 50,
            },
        )
        .unwrap();

        let err = extract_inline(
            &mut db,
            "s1",
            "alice",
            &c,
            DEFAULT_MAX_ITEMS,
            "s1:ex:100",
            "led-1",
            100,
        )
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
        let mut db = friday_storage::Db::open_hub(&tmp("dropped")).unwrap();
        let ids = seed_session(&db, "s1");
        let content = json!({
            "items": [
                {"kind":"fact","content":"User's API key rotation is monthly.","sourceMessageIds":[ids[0]]}
            ]
        })
        .to_string();
        let c = client(content);

        let out = extract_inline(
            &mut db,
            "s1",
            "bob",
            &c,
            DEFAULT_MAX_ITEMS,
            "s1:ex:100",
            "led-1",
            100,
        )
        .unwrap();
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
        let out2 = extract_inline(
            &mut db,
            "s1",
            "bob",
            &c2,
            DEFAULT_MAX_ITEMS,
            "s1:ex:200",
            "led-2",
            200,
        )
        .unwrap();
        assert_eq!(out2.messages_read, 0, "dropped source is not re-extracted");
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
