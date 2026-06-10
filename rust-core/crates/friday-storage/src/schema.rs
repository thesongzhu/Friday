//! Foundation schema + migration sets (gate 21 §2.1).
//!
//! Two profiles. **Location = which process the table physically exists in.**
//! The phone profile OMITS the secret-/sensitive-bearing tables entirely
//! (`trusted_device`, `audit_ledger`, `memory_item`), so "what is never on the
//! phone" is partly enforced by those tables simply not existing there
//! (gate 21 §2 / §3). No table in *either* profile stores a provider secret —
//! provider creds live only on the Hub via OS secure storage, never in SQLite.

use crate::migrate::Migration;
use rusqlite::Transaction;

/// Tables present only on the Hub (never created on a phone). Workflow runs are
/// Hub-coordinated (gate 21 §9 / `08`), so they are Hub-only too.
pub const HUB_ONLY_TABLES: &[&str] = &[
    "trusted_device",
    "audit_ledger",
    "memory_item",
    "workflow_run",
    "workflow_step",
    "consumed_approval",
    // S6b: pending operator-approval requests (the offline operator's to-sign work
    // items). Hub-only — they reference the bound principal + paused run and exist only
    // where the gate runs. Holds NO secret/key material (only the nonce + action digest
    // the operator signs over).
    "pending_approval_request",
    // PR-5: agent-loop substrate. Agent runs are Hub-coordinated (gate 21 §9),
    // so the run + its event log are Hub-only (never created on a phone).
    "agent_run",
    "agent_run_event",
    // Channels A-PR1: a channel binding holds the owner principal + inbound-auth
    // reference (Hub-only; never on a phone). NOT a secret store — the bearer secret
    // lives in OS secure storage; the table holds only an opaque `webhook_auth_ref`.
    "channel_binding",
    // PNS-001: provider session links + event mirror (Hub-only; may hold provider
    // account hashes, cwd, external urls/ids — never created on a phone).
    "provider_session_link",
    "provider_session_event",
    // Mission Spine: Hub-owned product conversation truth. Phone/channel surfaces
    // consume projections only; they do not own canonical conversations/missions.
    "friday_conversation",
    "mission",
    "work_item",
    "surface_thread",
    "surface_event",
    "mission_link",
    "route_decision",
    // Process Registry: Hub-owned workspace/process/port truth. Phone/channel
    // surfaces may see projections; only the Hub can own/control claims.
    "workspace_claim",
    "process_lease",
    "process_observation",
    // D1-substrate: the durable Hub-side ANSWER STORE keyed by `run_id`. Holds the
    // run's result/answer text Hub-side (plus its sha256 + length + status); the
    // phone never runs the agent loop and the TS-facing readback is refs-only, so
    // the body-bearing table is never created on a phone.
    "run_result",
    // S5: minimal agent-loop SESSION + its conversation messages. A session groups
    // runs and stores their prior messages (role + content + refs) Hub-side so a
    // session can RESUME with multi-turn inbound history. The message `content` is
    // a body kept Hub-side (like `run_result.answer`); the phone never runs the loop
    // and there is no answer-body-over-wire, so the tables are never on a phone.
    "agent_session",
    "agent_session_message",
    // SMOOTH-001: Hub-only durable provider-session timeline (file 83). The parent
    // `provider_timeline` row + its ordered `provider_timeline_event` log + the
    // `provider_timeline_pending` action table persist the in-memory timeline state
    // machine so a Friday-canonical provider timeline survives a Hub restart. The
    // rows are refs-only (the body-bearing column is a `body_ref`, never raw
    // transcript text, by the source module's invariant), but they may reference
    // provider event ids / dispatch refs, so the tables are Hub-only (never on a
    // phone).
    "provider_timeline",
    "provider_timeline_event",
    "provider_timeline_pending",
    // S8: versioned workflow DEFINITION store (DARK substrate). Workflow runs are
    // Hub-coordinated (gate 21 §9 / `08`), so their definitions are Hub-only too.
    // `definition_json` is the executable linear definition body kept Hub-side
    // (like `run_result.answer`); readbacks/projections are refs-only. The table
    // holds NO secret/key material — step params are tool-call arguments whose
    // execution is still governed by the gate at run time.
    "workflow_definition",
];

/// Tables present only on a phone (never created on the Hub).
pub const PHONE_ONLY_TABLES: &[&str] = &["offline_queue"];

pub fn hub_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            name: "init_hub",
            destructive: false,
            up: m0001_init_hub,
        },
        // Unit 9: workflow runs + steps (additive forward migration over v1).
        Migration {
            version: 2,
            name: "workflow",
            destructive: false,
            up: m0002_workflow,
        },
        // Unit 10: memory lifecycle `state` column (additive; backfills existing
        // confirmed rows so a confirmed memory is never silently demoted).
        Migration {
            version: 3,
            name: "memory_state",
            destructive: false,
            up: m0003_memory_state,
        },
        // PR-3b: single-use canonical-approval replay store (additive). The
        // `use_key` PRIMARY KEY makes a replayed approval an INSERT uniqueness
        // violation — double-spend is unrepresentable, not a check-then-consume race.
        Migration {
            version: 4,
            name: "consumed_approval",
            destructive: false,
            up: m0004_consumed_approval,
        },
        // PR-5: agent-loop substrate (additive forward migration adding the
        // Hub-only agent_run + agent_run_event tables). Purely additive.
        Migration {
            version: 5,
            name: "agent_run",
            destructive: false,
            up: m0005_agent_run,
        },
        // Memory recall (PROOF-MEMORY-001): additive fields that make a confirmed
        // memory RECALLABLE — the inline `content` (the text a recall injects), the
        // owning `principal_id` (the axis the cross-principal-no-recall invariant
        // keys on), and a `sensitive` flag (so a recalled item routes through the
        // Context Passport gate). Purely additive; pre-existing rows get NULL
        // content / NULL principal / sensitive=0 and are therefore NOT recallable
        // (fail-closed: no captured content + no owner ⇒ never injected).
        Migration {
            version: 6,
            name: "memory_recall_fields",
            destructive: false,
            up: m0006_memory_recall_fields,
        },
        // Channels A-PR1 (additive): the Hub-only `channel_binding` table — a channel
        // tied to its bound owner principal + allowlist + an opaque inbound-auth
        // reference (NOT the secret material). Purely additive.
        Migration {
            version: 7,
            name: "channel_binding",
            destructive: false,
            up: m0007_channel_binding,
        },
        // PNS-001: Hub-only provider session links + event mirror. These rows
        // may contain provider account hashes, cwd, and external urls/ids, so
        // the tables are never created in the phone profile. Renumbered to v8 on the
        // pre-PR rebase (channel_binding took v7 on main); purely additive.
        Migration {
            version: 8,
            name: "provider_session_contract",
            destructive: false,
            up: m0008_provider_session_contract,
        },
        // Mission Spine slice 2: Hub-only canonical conversation/mission/work-item
        // graph. Purely additive; provider/channel/memory/proof streams attach by refs.
        Migration {
            version: 9,
            name: "mission_spine",
            destructive: false,
            up: m0009_mission_spine,
        },
        // Process Registry slice 7: Hub-only workspace/process ownership and
        // observation tables. Purely additive; observed processes are inspect-only
        // until a Hub-owned claim/lease exists with safe-stop/release proof.
        Migration {
            version: 10,
            name: "process_registry",
            destructive: false,
            up: m0010_process_registry,
        },
        // Mission Spine slice 11: durable route-decision trace. Rebuilds the
        // `mission_link` CHECK constraint to admit route_decision links while
        // preserving existing rows in-transaction; guarded with a verified backup.
        Migration {
            version: 11,
            name: "route_decision_trace",
            destructive: true,
            up: m0011_route_decision_trace,
        },
        // Mission Spine slice 16A: refs-only surface events. This lets mobile,
        // desktop, and channels share one Mission timeline without copying raw
        // provider/channel transcripts into product conversation state.
        Migration {
            version: 12,
            name: "surface_event_trace",
            destructive: false,
            up: m0012_surface_event_trace,
        },
        // S1.2 loop-billing: run-attributable `token_ledger`. Adds a nullable `run_id`
        // column so an agent-loop model call's ledger row can be attributed to its run
        // (S2 readback flagged `token_ledger` had NO run_id ⇒ DB-wide, not
        // run-attributable). Purely additive: the ask path keeps writing rows with a
        // NULL `run_id` (no run), pre-existing rows backfill to NULL, and every existing
        // query (incl. `db_wide_token_totals` / `list_token_usage`) is unchanged.
        Migration {
            version: 13,
            name: "token_ledger_run_id",
            destructive: false,
            up: m0013_token_ledger_run_id,
        },
        // S6b: Hub-only `pending_approval_request` table. When a mutating action Pauses,
        // the gate persists what the OFFLINE operator needs to sign an approval for THAT
        // exact action (the nonce + action digest + expiry + context) — never any key or
        // mint material. Purely additive (CREATE TABLE only).
        Migration {
            version: 14,
            name: "pending_approval_request",
            destructive: false,
            up: m0014_pending_approval_request,
        },
        // D1-substrate: Hub-only `run_result` answer store keyed by `run_id`. The
        // run's result/answer is persisted Hub-side (with a derived sha256 + length
        // so the refs-only readback never needs the body). Purely additive (CREATE
        // TABLE only) — it touches no existing table, so v14 rows/queries are
        // unaffected.
        Migration {
            version: 15,
            name: "run_result",
            destructive: false,
            up: m0015_run_result,
        },
        // S6d: add the executable tool call (`tool_params`, the raw key/value pairs as
        // JSON) to a Hub-only pending request, so the resume/ingestion entrypoint can
        // re-execute the EXACT mutation the operator approved after the run Paused. The
        // `action_digest` already binds these params transitively, so the resume path
        // cross-checks the reconstructed digest against the stored one; this column only
        // makes the call REPLAYABLE Hub-side (it never crosses the wire). Purely additive
        // (a nullable ALTER) — pre-S6d `pending_approval_request` rows read back with
        // `tool_params = NULL` and every existing query is unaffected.
        Migration {
            version: 16,
            name: "pending_approval_tool_params",
            destructive: false,
            up: m0016_pending_approval_tool_params,
        },
        // D1-Q1: add the run's bound OWNER principal to `run_result` so the
        // authenticated answer-body read can enforce `caller_principal == owner`.
        // `ALTER TABLE ... ADD COLUMN` with no default is additive and back-compatible:
        // existing v15 `run_result` rows read back as `owner_principal = NULL`, which
        // FAILS CLOSED on the body read (an unowned answer is released to no one).
        Migration {
            version: 17,
            name: "run_result_owner_principal",
            destructive: false,
            up: m0017_run_result_owner_principal,
        },
        // S5: Hub-only minimal agent-loop `agent_session` + `agent_session_message`
        // tables. A session groups runs and stores their prior conversation messages
        // (role + content + refs) so a session can RESUME with multi-turn inbound
        // history. Purely additive (CREATE TABLE + INDEX only) — touches no existing
        // table, so v17 rows/queries are unaffected.
        Migration {
            version: 18,
            name: "agent_session",
            destructive: false,
            up: m0018_agent_session,
        },
        // SMOOTH-001: Hub-only durable provider-session timeline tables (file 83) —
        // the parent `provider_timeline` row (its monotonic seq/retention/revision
        // scalars) + the ordered `provider_timeline_event` log + the
        // `provider_timeline_pending` action table. This persists the in-memory
        // `ProviderTimeline` state so a Friday-canonical timeline survives a Hub
        // restart. Purely additive (CREATE TABLE + INDEX only) — touches no existing
        // table, so v18 rows/queries are unaffected. The rows are refs-only.
        Migration {
            version: 19,
            name: "provider_timeline",
            destructive: false,
            up: m0019_provider_timeline,
        },
        // Session-memory slice-2 (dedup): add the `memory_extract_status` column to
        // `agent_session_message`, mirroring the TS `session_messages.memory_extract_status`.
        // This is what makes a re-run of the inline memory extraction SKIP already-processed
        // messages (no duplicate candidates). `ALTER TABLE ... ADD COLUMN ... DEFAULT 'pending'`
        // is additive and back-compatible: every existing v18 message row reads back as
        // 'pending' (so the FIRST extraction still reads the full history), and the next run
        // marks the processed messages terminal so they are not re-extracted. The CHECK
        // enumerates the full TS status vocabulary so the deferred queue/retry slice
        // ('queued'/'skipped'/'failed') is not foreclosed; slice-2's inline path uses only
        // the 'pending' -> 'extracted' transition. Hub-only — `agent_session_message` is a
        // Hub-only table (never created on a phone), so this migration has no phone twin.
        Migration {
            version: 20,
            name: "session_message_memory_extract_status",
            destructive: false,
            up: m0020_session_message_memory_extract_status,
        },
        // Session-memory slice-3 (ownership-binding): add the session OWNER fields
        // (`account_id`, `channel`, `user_id`) to `agent_session`, mirroring the TS
        // `FridaySessionRecord` axes the memory namespace is DERIVED from. This is what
        // lets the inline extraction compute its store SCOPE from the SESSION (a composite
        // `tenant.<account>.channel.<channel>.user.<user>.shared` namespace) instead of
        // trusting a caller-supplied principal — faithful to the TS production model where
        // extraction is job-driven and the session is the source of truth.
        //
        // All three columns are NULLABLE additive `ALTER`s: every existing v20
        // `agent_session` row reads back `account_id = NULL`, `channel = NULL`,
        // `user_id = NULL`. A NULL `user_id` FAILS CLOSED at namespace resolution (the TS
        // throws `MEMORY_NAMESPACE_UNRESOLVABLE`), so a pre-slice-3 session is never
        // silently bound to a default/anonymous scope — it simply cannot be extracted until
        // its owner is set. Purely additive (ALTER only) — touches no other table, so v20
        // rows/queries are unaffected. Hub-only — `agent_session` is a Hub-only table.
        Migration {
            version: 21,
            name: "agent_session_owner",
            destructive: false,
            up: m0021_agent_session_owner,
        },
        // S8: Hub-only versioned `workflow_definition` store (DARK substrate — no
        // production route, no scheduler/trigger work, no live flip; workflow
        // execution remains fenced in TS and is NOT product-replaced). Storage
        // previously persisted workflow runs/steps ONLY; this adds the DEFINITION
        // layer the `friday-hub::workflow_def` loader feeds to the EXISTING
        // `workflow_exec` engine. Purely additive (CREATE TABLE + INDEX only) —
        // touches no existing table, so v21 rows/queries are unaffected.
        Migration {
            version: 22,
            name: "workflow_definition",
            destructive: false,
            up: m0022_workflow_definition,
        },
    ]
}

pub fn phone_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            name: "init_phone",
            destructive: false,
            up: m0001_init_phone,
        },
        // S1.2: `token_ledger` is a SHARED table (both profiles) and the single insert
        // chokepoint now writes a `run_id` column. The phone never runs the agent loop, so
        // its rows always carry `run_id = NULL` — the column exists ONLY so the shared insert
        // has the same shape on both profiles. Same additive ALTER as hub v13.
        Migration {
            version: 2,
            name: "token_ledger_run_id",
            destructive: false,
            up: m0013_token_ledger_run_id,
        },
    ]
}

// --- shared table fragments -------------------------------------------------

const DDL_DEVICE_IDENTITY: &str = "
CREATE TABLE device_identity (
    device_id    TEXT PRIMARY KEY,
    role         TEXT NOT NULL,
    public_key   BLOB NOT NULL,
    created_at   INTEGER NOT NULL,
    display_name TEXT NOT NULL DEFAULT ''
);";

const DDL_SESSION: &str = "
CREATE TABLE session (
    session_id TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'mac_live'
);
CREATE INDEX idx_session_updated ON session(updated_at);";

const DDL_ACTIVITY_ITEM: &str = "
CREATE TABLE activity_item (
    activity_id TEXT PRIMARY KEY,
    session_id  TEXT,
    type        TEXT NOT NULL,
    state       TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deep_link   TEXT
);
CREATE INDEX idx_activity_state_updated ON activity_item(state, updated_at);
CREATE INDEX idx_activity_session ON activity_item(session_id);";

const DDL_TOKEN_LEDGER: &str = "
CREATE TABLE token_ledger (
    ledger_id        TEXT PRIMARY KEY,
    session_id       TEXT,
    activity_id      TEXT,
    provider_kind    TEXT NOT NULL,
    model            TEXT NOT NULL,
    base_url_host    TEXT NOT NULL,
    prompt_tokens    INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens     INTEGER NOT NULL,
    cost_estimate    REAL,
    fallback         INTEGER NOT NULL,
    result_link      TEXT,
    created_at       INTEGER NOT NULL
);
CREATE INDEX idx_ledger_session_created ON token_ledger(session_id, created_at);
CREATE INDEX idx_ledger_created ON token_ledger(created_at);";

const DDL_BLOB: &str = "
CREATE TABLE blob_index (
    blob_id       TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    enc_alg       TEXT NOT NULL,
    nonce         BLOB NOT NULL,
    size          INTEGER NOT NULL,
    access_policy TEXT NOT NULL DEFAULT 'hub_only',
    created_at    INTEGER NOT NULL,
    path_or_ref   TEXT
);
CREATE INDEX idx_blob_kind ON blob_index(kind);
-- SQLite-backed ciphertext store (foundation backend; the index above holds
-- metadata + access policy only, gate 21 §2.1).
CREATE TABLE blob_store (
    blob_id    TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL
);";

// --- Hub-only fragments -----------------------------------------------------

const DDL_TRUSTED_DEVICE: &str = "
CREATE TABLE trusted_device (
    device_id      TEXT PRIMARY KEY,
    public_key     BLOB NOT NULL,
    paired_at      INTEGER NOT NULL,
    revoked_at     INTEGER,
    key_rotated_at INTEGER,
    sealed_key_ref TEXT,            -- OS-secure-storage key id; never plaintext
    label          TEXT NOT NULL DEFAULT ''
);";

const DDL_AUDIT_LEDGER: &str = "
CREATE TABLE audit_ledger (
    audit_id    TEXT PRIMARY KEY,
    prev_hash   BLOB NOT NULL,
    entry_hash  BLOB NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    payload_ref TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_ledger(created_at);";

const DDL_MEMORY_ITEM: &str = "
CREATE TABLE memory_item (
    memory_id    TEXT PRIMARY KEY,
    scope        TEXT NOT NULL,
    content_ref  TEXT,
    confidence   TEXT,
    created_at   INTEGER NOT NULL,
    confirmed_at INTEGER
);";

// --- phone-only fragments ---------------------------------------------------

const DDL_OFFLINE_QUEUE: &str = "
CREATE TABLE offline_queue (
    queue_id           TEXT PRIMARY KEY,
    action_kind        TEXT NOT NULL,
    payload_ref        TEXT,
    msg_id             TEXT NOT NULL,
    approval_scope_ref TEXT,
    state              TEXT NOT NULL,
    created_at         INTEGER NOT NULL
);
CREATE INDEX idx_offline_state_created ON offline_queue(state, created_at);";

// --- Unit-9 workflow fragments (Hub-only) -----------------------------------

const DDL_WORKFLOW: &str = "
CREATE TABLE workflow_run (
    run_id     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    state      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workflow_run_state ON workflow_run(state, updated_at);
CREATE TABLE workflow_step (
    step_id         TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    has_side_effect INTEGER NOT NULL,
    status          TEXT NOT NULL,
    evidence_ref    TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_workflow_step_run ON workflow_step(run_id, seq);";

// --- PR-5 agent-loop fragments (Hub-only) -----------------------------------

const DDL_AGENT_RUN: &str = "
CREATE TABLE agent_run (
    run_id     TEXT PRIMARY KEY,
    task       TEXT NOT NULL,
    state      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_run_state ON agent_run(state, updated_at);
CREATE TABLE agent_run_event (
    event_id   TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(run_id, seq)
);
CREATE INDEX idx_agent_run_event_run ON agent_run_event(run_id, seq);";

// --- D1-substrate run-result fragment (Hub-only) ----------------------------

// The durable answer store keyed by `run_id` (PK ⇒ one result per run). `answer`
// is the result body (Hub-side only; never crosses the refs-only readback);
// `answer_sha256` (lowercase-hex, 64 chars) + `answer_len` (>= 0) are the
// refs-only fingerprint the wire projection exposes instead of the body; `status`
// is a coarse outcome label; `audit_ref` is a soft link (no FK) to the run's
// audit-ledger receipt. The CHECK constraints make a hand-built INSERT with a
// malformed fingerprint unrepresentable (the typed `persist_run_result` derives
// both from the body, so they are always well-formed via the API).
const DDL_RUN_RESULT: &str = "
CREATE TABLE run_result (
    run_id        TEXT PRIMARY KEY,
    status        TEXT NOT NULL,
    answer        TEXT NOT NULL DEFAULT '',
    answer_sha256 TEXT NOT NULL CHECK(length(answer_sha256) = 64),
    answer_len    INTEGER NOT NULL CHECK(answer_len >= 0),
    audit_ref     TEXT,
    created_at    INTEGER NOT NULL
);
CREATE INDEX idx_run_result_created ON run_result(created_at);";

// --- S5 agent-session fragments (Hub-only) ----------------------------------

// A session groups agent-loop runs and stores their prior conversation messages so
// a session can RESUME with multi-turn inbound history. `agent_session` is the
// lightweight parent row (timestamps only — the foundation `session` table is a
// separate UI/activity grouping and is NOT reused). `agent_session_message` holds
// the ordered conversation turns: `role` (e.g. user/assistant), the message `content`
// kept Hub-side (like `run_result.answer`; NEVER an answer-body-over-wire), an
// optional `refs` soft-link (e.g. the producing run id — no FK, the `*_ref`
// convention), and a per-session monotonic `seq` so the prior history loads in order.
// `UNIQUE(agent_session_id, seq)` makes a duplicate ordinal a fail-closed insert.
const DDL_AGENT_SESSION: &str = "
CREATE TABLE agent_session (
    agent_session_id TEXT PRIMARY KEY,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

CREATE TABLE agent_session_message (
    message_id       TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL,
    seq              INTEGER NOT NULL CHECK(seq >= 0),
    role             TEXT NOT NULL CHECK(length(trim(role)) > 0),
    content          TEXT NOT NULL DEFAULT '',
    refs             TEXT,
    created_at       INTEGER NOT NULL,
    UNIQUE(agent_session_id, seq),
    FOREIGN KEY(agent_session_id) REFERENCES agent_session(agent_session_id)
);
CREATE INDEX idx_agent_session_message_seq
    ON agent_session_message(agent_session_id, seq);";

// --- SMOOTH-001 provider-timeline fragments (Hub-only) ----------------------

// Durable persistence of the in-memory `friday_hub::ProviderTimeline` state machine
// (file 83), so a Friday-canonical provider-session timeline survives a Hub restart.
//
// THREE tables (all keyed on `session_id` = the `friday_session_id`):
//
// * `provider_timeline` is the parent row holding the timeline-level SCALARS that are
//   NOT recoverable from the event rows alone: `next_seq` (the monotonic seq counter,
//   never reset even after pruning), `retained_from_seq` (the prune watermark — events
//   below it were dropped from hydration), and `revision` (bumped on EVERY mutation,
//   INCLUDING a pending submit / a status-only advance, so the live revision can be
//   HIGHER than the last event's revision and must be persisted explicitly).
//
// * `provider_timeline_event` is the append-only, immutable event log: a per-session
//   monotonic `seq` (from 1), the `revision` at which it was appended, a coarse
//   `event_kind` + `actor` label, and the refs-only `body_ref` / `provider_event_id`.
//   `UNIQUE(session_id, seq)` makes a duplicate ordinal a fail-closed insert.
//
// * `provider_timeline_pending` is the MUTABLE Friday-originated action store keyed by
//   `(session_id, request_id)`: the action advances through the `PendingState` machine
//   across restarts, so this table is UPSERTed (not immutable like the event log /
//   run_result). The `state` CHECK enumerates the 11 snake_case `PendingState` labels
//   (mirrors `provider_session_link.sync_mode`), so a hand-built INSERT with a bogus
//   state is unrepresentable.
//
// REFS-ONLY discipline (mirrors run_result / provider_session_event / channel_event):
// NO raw transcript text / message body / PII is stored. `body_ref` /
// `provider_event_id` / `dispatch_ref` are refs/ids; `event_kind` / `actor` / `action`
// / `state` are coarse labels; `blocker` is a coarse reason (same shape as the existing
// `work_item.blocking_reason`). The only transcript-bearing field is `body_ref`, which
// is a REF by the source module's invariant ("Events carry only refs, never raw
// transcript text").
const DDL_PROVIDER_TIMELINE: &str = "
CREATE TABLE provider_timeline (
    session_id        TEXT PRIMARY KEY CHECK(length(trim(session_id)) > 0),
    next_seq          INTEGER NOT NULL CHECK(next_seq >= 1),
    retained_from_seq INTEGER NOT NULL CHECK(retained_from_seq >= 1),
    revision          INTEGER NOT NULL CHECK(revision >= 0),
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

CREATE TABLE provider_timeline_event (
    session_id        TEXT NOT NULL,
    seq               INTEGER NOT NULL CHECK(seq >= 1),
    revision          INTEGER NOT NULL CHECK(revision >= 1),
    event_kind        TEXT NOT NULL CHECK(length(trim(event_kind)) > 0),
    actor             TEXT NOT NULL CHECK(length(trim(actor)) > 0),
    body_ref          TEXT,
    provider_event_id TEXT,
    created_at        INTEGER NOT NULL,
    PRIMARY KEY(session_id, seq),
    FOREIGN KEY(session_id) REFERENCES provider_timeline(session_id)
);
CREATE INDEX idx_provider_timeline_event_seq
    ON provider_timeline_event(session_id, seq);

CREATE TABLE provider_timeline_pending (
    session_id          TEXT NOT NULL,
    request_id          TEXT NOT NULL CHECK(length(trim(request_id)) > 0),
    client_msg_id       TEXT NOT NULL CHECK(length(trim(client_msg_id)) > 0),
    action              TEXT NOT NULL CHECK(length(trim(action)) > 0),
    state               TEXT NOT NULL CHECK(state IN (
        'draft',
        'pending_local',
        'sent_to_hub',
        'accepted_by_hub',
        'routed_to_provider',
        'waiting_provider',
        'provider_completed',
        'blocked',
        'failed_retryable',
        'failed_terminal',
        'cancelled'
    )),
    dispatch_ref        TEXT,
    blocker             TEXT,
    base_revision       INTEGER NOT NULL CHECK(base_revision >= 0),
    updated_at_revision INTEGER NOT NULL CHECK(updated_at_revision >= 0),
    created_at          INTEGER NOT NULL,
    PRIMARY KEY(session_id, request_id),
    FOREIGN KEY(session_id) REFERENCES provider_timeline(session_id)
);
CREATE INDEX idx_provider_timeline_pending_session
    ON provider_timeline_pending(session_id, request_id);";

// --- S8 workflow-definition fragment (Hub-only) ------------------------------

// Versioned workflow DEFINITION store (S8, DARK substrate). One row per
// `(workflow_id, version)`; a version row is IMMUTABLE once created (the typed
// API is create / read / publish-flag flip / delete — never UPDATE of the body),
// mirroring the TS published-version model (`workflow_versions` in
// `src/state/sqlite/migrations/v001-initial.ts`: id / workflow_id /
// version_number / checksum / graph_json / is_published).
//
// * `definition_json` is the Rust LINEAR definition body (schema_version-tagged
//   JSON, parsed fail-closed by `friday-hub::workflow_def`) kept Hub-side like
//   `run_result.answer` — it never crosses a refs-only readback.
// * `checksum` is the sha256 (lowercase hex, 64 chars) of `definition_json`,
//   DERIVED by the typed `create_definition` API (like `run_result.answer_sha256`);
//   the CHECK makes a malformed hand-built fingerprint unrepresentable, and the
//   typed readers re-derive + compare so a tampered body fails closed on read.
// * `source` records provenance: `rust_native` (authored against the Rust types)
//   or `ts_translated` (ingested from a TS published-version graph by the
//   linear-only translator). `source_meta` preserves refs-only provenance for a
//   translated definition (ids / counts / coarse labels — never raw node
//   configs, prompts, or secrets).
// * `is_published` marks at most one published version per `workflow_id`
//   (enforced by the typed `set_published`, exercised by tests).
const DDL_WORKFLOW_DEFINITION: &str = "
CREATE TABLE workflow_definition (
    workflow_id     TEXT NOT NULL CHECK(length(trim(workflow_id)) > 0),
    version         INTEGER NOT NULL CHECK(version >= 1),
    name            TEXT NOT NULL CHECK(length(trim(name)) > 0),
    definition_json TEXT NOT NULL CHECK(length(definition_json) > 0),
    checksum        TEXT NOT NULL CHECK(length(checksum) = 64),
    source          TEXT NOT NULL CHECK(source IN ('rust_native', 'ts_translated')),
    source_meta     TEXT,
    is_published    INTEGER NOT NULL CHECK(is_published IN (0, 1)),
    created_at      INTEGER NOT NULL,
    PRIMARY KEY(workflow_id, version)
);
CREATE INDEX idx_workflow_definition_published
    ON workflow_definition(workflow_id, is_published);";

// --- PNS-001 provider-session fragments (Hub-only) --------------------------

const DDL_PROVIDER_SESSION: &str = "
CREATE TABLE provider_session_link (
    friday_session_id     TEXT PRIMARY KEY,
    provider              TEXT NOT NULL CHECK(length(trim(provider)) > 0),
    account_key_hash      TEXT NOT NULL CHECK(length(trim(account_key_hash)) > 0),
    workspace_id          TEXT NOT NULL CHECK(length(trim(workspace_id)) > 0),
    cwd                   TEXT,
    external_session_id   TEXT,
    external_thread_id    TEXT,
    external_url          TEXT,
    sync_mode             TEXT NOT NULL CHECK(sync_mode IN (
        'provider_native_synced',
        'provider_app_server_local',
        'friday_local_mirror',
        'provider_native_link_only',
        'unsupported_truth_labeled'
    )),
    capability_snapshot   TEXT NOT NULL DEFAULT '',
    last_provider_seen_at INTEGER,
    last_friday_event_id  TEXT,
    truth_label           TEXT NOT NULL CHECK(length(trim(truth_label)) > 0)
);
CREATE INDEX idx_provider_session_provider_seen
    ON provider_session_link(provider, last_provider_seen_at);

CREATE TABLE provider_session_event (
    friday_session_id     TEXT NOT NULL,
    provider_event_id     TEXT NOT NULL,
    provider              TEXT NOT NULL CHECK(length(trim(provider)) > 0),
    event_kind            TEXT NOT NULL CHECK(length(trim(event_kind)) > 0),
    transcript_item_kind  TEXT NOT NULL CHECK(length(trim(transcript_item_kind)) > 0),
    body_ref              TEXT NOT NULL DEFAULT '',
    redaction_level       TEXT NOT NULL CHECK(length(trim(redaction_level)) > 0),
    token_ledger_ref      TEXT,
    approval_ref          TEXT,
    audit_receipt_ref     TEXT,
    observed_at           INTEGER NOT NULL,
    PRIMARY KEY(friday_session_id, provider_event_id),
    FOREIGN KEY(friday_session_id) REFERENCES provider_session_link(friday_session_id)
);
CREATE INDEX idx_provider_session_event_session_seen
    ON provider_session_event(friday_session_id, observed_at, provider_event_id);";

// --- Mission Spine fragments (Hub-only) -------------------------------------

const DDL_MISSION_SPINE: &str = "
CREATE TABLE friday_conversation (
    friday_conversation_id TEXT PRIMARY KEY
        CHECK(friday_conversation_id LIKE 'fconv_%'),
    owner_principal        TEXT NOT NULL CHECK(length(trim(owner_principal)) > 0),
    title                  TEXT NOT NULL DEFAULT '',
    current_focus_summary  TEXT NOT NULL DEFAULT '',
    active_mission_ids     TEXT NOT NULL DEFAULT '[]',
    surface_thread_ids     TEXT NOT NULL DEFAULT '[]',
    memory_scope_ref       TEXT,
    truth_status           TEXT NOT NULL CHECK(truth_status IN (
        'proven',
        'design_proof',
        'wired_registry',
        'NO-GO',
        'operator_gated',
        'external_blocked',
        'historical'
    )),
    proof_refs             TEXT NOT NULL DEFAULT '[]',
    created_at_ms          INTEGER NOT NULL,
    updated_at_ms          INTEGER NOT NULL
);
CREATE INDEX idx_friday_conversation_owner_updated
    ON friday_conversation(owner_principal, updated_at_ms);

CREATE TABLE mission (
    mission_id              TEXT PRIMARY KEY,
    friday_conversation_id  TEXT NOT NULL,
    title                   TEXT NOT NULL DEFAULT '',
    intent                  TEXT NOT NULL CHECK(length(trim(intent)) > 0),
    status                  TEXT NOT NULL CHECK(status IN (
        'active',
        'waiting_for_user',
        'blocked',
        'paused',
        'done',
        'archived',
        'merged'
    )),
    why_now                 TEXT NOT NULL DEFAULT '',
    decision_path_summary   TEXT NOT NULL DEFAULT '',
    considered_options      TEXT NOT NULL DEFAULT '[]',
    deferred_options        TEXT NOT NULL DEFAULT '[]',
    known_pitfalls          TEXT NOT NULL DEFAULT '[]',
    handoff_inheritance     TEXT NOT NULL DEFAULT '[]',
    work_item_ids           TEXT NOT NULL DEFAULT '[]',
    memory_candidate_refs   TEXT NOT NULL DEFAULT '[]',
    context_passport_refs   TEXT NOT NULL DEFAULT '[]',
    proof_refs              TEXT NOT NULL DEFAULT '[]',
    created_at_ms           INTEGER NOT NULL,
    updated_at_ms           INTEGER NOT NULL,
    FOREIGN KEY(friday_conversation_id)
        REFERENCES friday_conversation(friday_conversation_id)
);
CREATE INDEX idx_mission_conversation_status
    ON mission(friday_conversation_id, status, updated_at_ms);
CREATE INDEX idx_mission_conversation_intent
    ON mission(friday_conversation_id, intent);

CREATE TABLE work_item (
    work_item_id                           TEXT PRIMARY KEY,
    mission_id                             TEXT NOT NULL,
    lane                                   TEXT NOT NULL CHECK(lane IN (
        'friday_hub',
        'codex',
        'claude',
        'deepseek',
        'workflow',
        'channel',
        'human',
        'future_api'
    )),
    target_provider_or_agent               TEXT,
    status                                 TEXT NOT NULL CHECK(status IN (
        'draft',
        'preflight_blocked',
        'waiting_for_user',
        'ready_to_dispatch',
        'dispatched',
        'hub_accepted',
        'provider_routed',
        'provider_waiting',
        'completed_with_proof',
        'failed_retryable',
        'failed_terminal',
        'cancelled',
        'merged',
        'archived'
    )),
    owner_claim_ids                        TEXT NOT NULL DEFAULT '[]',
    workspace_refs                         TEXT NOT NULL DEFAULT '[]',
    capability_id                          TEXT,
    risk_level                             TEXT NOT NULL CHECK(risk_level IN (
        'read_only',
        'low',
        'medium',
        'high',
        'critical'
    )),
    approval_state                         TEXT NOT NULL CHECK(approval_state IN (
        'not_required',
        'required',
        'approved',
        'rejected'
    )),
    blocking_reason                        TEXT,
    input_refs                             TEXT NOT NULL DEFAULT '[]',
    output_refs                            TEXT NOT NULL DEFAULT '[]',
    proof_requirements                     TEXT NOT NULL DEFAULT '[]',
    proof_receipts                         TEXT NOT NULL DEFAULT '[]',
    judgment_task                          TEXT NOT NULL DEFAULT '',
    judgment_current_blocker               TEXT,
    judgment_target_lane_thread_agent_provider TEXT NOT NULL DEFAULT '',
    judgment_read_first_files              TEXT NOT NULL DEFAULT '[]',
    judgment_required_output               TEXT NOT NULL DEFAULT '',
    judgment_done_criteria                 TEXT NOT NULL DEFAULT '[]',
    judgment_red_lines                     TEXT NOT NULL DEFAULT '[]',
    judgment_why_this_route                TEXT NOT NULL DEFAULT '',
    judgment_considered_options            TEXT NOT NULL DEFAULT '[]',
    judgment_deferred_options              TEXT NOT NULL DEFAULT '[]',
    judgment_previous_pitfalls             TEXT NOT NULL DEFAULT '[]',
    judgment_inheritable_context           TEXT NOT NULL DEFAULT '[]',
    judgment_proof_requirements            TEXT NOT NULL DEFAULT '[]',
    judgment_ownership_claim_ids           TEXT NOT NULL DEFAULT '[]',
    created_at_ms                          INTEGER NOT NULL,
    updated_at_ms                          INTEGER NOT NULL,
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id)
);
CREATE INDEX idx_work_item_mission_status
    ON work_item(mission_id, status, updated_at_ms);
CREATE INDEX idx_work_item_duplicate_preflight
    ON work_item(mission_id, lane, target_provider_or_agent, status);

CREATE TABLE surface_thread (
    surface_thread_id          TEXT PRIMARY KEY,
    friday_conversation_id     TEXT NOT NULL,
    mission_id                 TEXT,
    surface_kind               TEXT NOT NULL CHECK(surface_kind IN (
        'mobile',
        'desktop',
        'telegram',
        'discord',
        'lark',
        'web_chat',
        'provider_workspace',
        'future_channel'
    )),
    channel_binding_id         TEXT,
    delivery_route             TEXT NOT NULL DEFAULT '',
    visibility_policy          TEXT NOT NULL CHECK(visibility_policy IN (
        'compact',
        'rich_proof',
        'status_only',
        'hidden_trace_only'
    )),
    allowed_actions            TEXT NOT NULL DEFAULT '[]',
    last_seen_at_ms            INTEGER,
    last_delivered_event_seq   INTEGER,
    created_at_ms              INTEGER NOT NULL,
    updated_at_ms              INTEGER NOT NULL,
    FOREIGN KEY(friday_conversation_id)
        REFERENCES friday_conversation(friday_conversation_id),
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id)
);
CREATE INDEX idx_surface_thread_conversation
    ON surface_thread(friday_conversation_id, surface_kind, updated_at_ms);
CREATE INDEX idx_surface_thread_mission
    ON surface_thread(mission_id, surface_kind);

CREATE TABLE mission_link (
    link_id        TEXT PRIMARY KEY,
    mission_id     TEXT NOT NULL,
    work_item_id   TEXT,
    link_kind      TEXT NOT NULL CHECK(link_kind IN (
        'provider_session',
        'provider_timeline',
        'channel_inbound',
        'workflow_run',
        'memory_candidate',
        'memory_decision',
        'confirmed_memory',
        'context_passport',
        'proof_receipt',
        'workspace_claim',
        'handoff_artifact'
    )),
    target_ref     TEXT NOT NULL CHECK(length(trim(target_ref)) > 0),
    proof_ref      TEXT,
    created_at_ms  INTEGER NOT NULL,
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id),
    FOREIGN KEY(work_item_id) REFERENCES work_item(work_item_id)
);
CREATE INDEX idx_mission_link_mission_kind
    ON mission_link(mission_id, link_kind, created_at_ms);";

const DDL_ROUTE_DECISION_TRACE: &str = "
CREATE TABLE route_decision (
    decision_id                  TEXT PRIMARY KEY,
    mission_id                   TEXT NOT NULL,
    work_item_id                 TEXT NOT NULL,
    selected_lane                TEXT NOT NULL CHECK(selected_lane IN (
        'friday_hub',
        'codex',
        'claude',
        'deepseek',
        'workflow',
        'channel',
        'human',
        'future_api'
    )),
    selected_provider_or_agent   TEXT,
    why_this_route               TEXT NOT NULL CHECK(length(trim(why_this_route)) > 0),
    considered_options           TEXT NOT NULL DEFAULT '[]',
    deferred_options             TEXT NOT NULL DEFAULT '[]',
    previous_pitfalls            TEXT NOT NULL DEFAULT '[]',
    inheritable_context          TEXT NOT NULL DEFAULT '[]',
    conflict_refs                TEXT NOT NULL DEFAULT '[]',
    proof_requirements           TEXT NOT NULL DEFAULT '[]',
    ownership_claim_ids          TEXT NOT NULL DEFAULT '[]',
    trace_refs                   TEXT NOT NULL DEFAULT '[]',
    created_at_ms                INTEGER NOT NULL,
    expires_at_ms                INTEGER,
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id),
    FOREIGN KEY(work_item_id) REFERENCES work_item(work_item_id)
);
CREATE INDEX idx_route_decision_mission_created
    ON route_decision(mission_id, created_at_ms, decision_id);
CREATE INDEX idx_route_decision_work_item_created
    ON route_decision(work_item_id, created_at_ms, decision_id);";

const DDL_REBUILD_MISSION_LINK_WITH_ROUTE_DECISION: &str = "
CREATE TABLE mission_link_new (
    link_id        TEXT PRIMARY KEY,
    mission_id     TEXT NOT NULL,
    work_item_id   TEXT,
    link_kind      TEXT NOT NULL CHECK(link_kind IN (
        'route_decision',
        'provider_session',
        'provider_timeline',
        'channel_inbound',
        'workflow_run',
        'memory_candidate',
        'memory_decision',
        'confirmed_memory',
        'context_passport',
        'proof_receipt',
        'workspace_claim',
        'handoff_artifact'
    )),
    target_ref     TEXT NOT NULL CHECK(length(trim(target_ref)) > 0),
    proof_ref      TEXT,
    created_at_ms  INTEGER NOT NULL,
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id),
    FOREIGN KEY(work_item_id) REFERENCES work_item(work_item_id)
);
INSERT INTO mission_link_new
    (link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref, created_at_ms)
SELECT link_id, mission_id, work_item_id, link_kind, target_ref, proof_ref, created_at_ms
FROM mission_link;
DROP TABLE mission_link;
ALTER TABLE mission_link_new RENAME TO mission_link;
CREATE INDEX idx_mission_link_mission_kind
    ON mission_link(mission_id, link_kind, created_at_ms);";

const DDL_SURFACE_EVENT_TRACE: &str = "
CREATE TABLE surface_event (
    surface_event_id       TEXT PRIMARY KEY,
    friday_conversation_id TEXT NOT NULL
        CHECK(friday_conversation_id LIKE 'fconv_%'),
    mission_id             TEXT NOT NULL,
    work_item_id           TEXT,
    surface_thread_id      TEXT NOT NULL,
    source_surface         TEXT NOT NULL CHECK(source_surface IN (
        'mobile',
        'desktop',
        'telegram',
        'discord',
        'lark',
        'web_chat',
        'provider_workspace',
        'future_channel'
    )),
    event_kind             TEXT NOT NULL CHECK(event_kind IN (
        'user_message',
        'friday_reply',
        'system_status',
        'channel_inbound',
        'provider_trace',
        'proof_receipt',
        'memory_decision',
        'needs_me',
        'handoff'
    )),
    body_ref               TEXT,
    visibility_policy      TEXT NOT NULL CHECK(visibility_policy IN (
        'compact',
        'rich_proof',
        'status_only',
        'hidden_trace_only'
    )),
    proof_ref              TEXT,
    created_at_ms          INTEGER NOT NULL,
    FOREIGN KEY(friday_conversation_id)
        REFERENCES friday_conversation(friday_conversation_id),
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id),
    FOREIGN KEY(work_item_id) REFERENCES work_item(work_item_id),
    FOREIGN KEY(surface_thread_id) REFERENCES surface_thread(surface_thread_id)
);
CREATE INDEX idx_surface_event_conversation_created
    ON surface_event(friday_conversation_id, created_at_ms, surface_event_id);
CREATE INDEX idx_surface_event_mission_created
    ON surface_event(mission_id, created_at_ms, surface_event_id);
CREATE INDEX idx_surface_event_surface_thread_created
    ON surface_event(surface_thread_id, created_at_ms, surface_event_id);";

// --- Process Registry fragments (Hub-only) ---------------------------------

const DDL_PROCESS_REGISTRY: &str = "
CREATE TABLE workspace_claim (
    claim_id              TEXT PRIMARY KEY,
    mission_id            TEXT NOT NULL,
    work_item_id          TEXT,
    owner_principal       TEXT NOT NULL CHECK(length(trim(owner_principal)) > 0),
    owner_agent           TEXT NOT NULL CHECK(length(trim(owner_agent)) > 0),
    workspace_ref         TEXT NOT NULL CHECK(length(trim(workspace_ref)) > 0),
    claim_kind            TEXT NOT NULL CHECK(claim_kind IN (
        'workspace',
        'worktree',
        'port',
        'process',
        'provider_session',
        'design_server',
        'friday_launchd_service'
    )),
    state                 TEXT NOT NULL CHECK(state IN (
        'active',
        'pending_adoption',
        'needs_owner_decision',
        'released',
        'stale',
        'blocked'
    )),
    reason                TEXT NOT NULL DEFAULT '',
    safe_release_policy   TEXT NOT NULL DEFAULT '',
    proof_requirements    TEXT NOT NULL DEFAULT '[]',
    proof_refs            TEXT NOT NULL DEFAULT '[]',
    created_at_ms         INTEGER NOT NULL,
    updated_at_ms         INTEGER NOT NULL,
    released_at_ms        INTEGER,
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id),
    FOREIGN KEY(work_item_id) REFERENCES work_item(work_item_id)
);
CREATE INDEX idx_workspace_claim_mission_state
    ON workspace_claim(mission_id, state, updated_at_ms);
CREATE INDEX idx_workspace_claim_workspace_state
    ON workspace_claim(workspace_ref, state, updated_at_ms);

CREATE TABLE process_lease (
    lease_id                       TEXT PRIMARY KEY,
    claim_id                       TEXT NOT NULL,
    mission_id                     TEXT NOT NULL,
    work_item_id                   TEXT,
    pid                            INTEGER,
    process_group_id               INTEGER,
    process_kind                   TEXT NOT NULL CHECK(process_kind IN (
        'codex_cli',
        'codex_app_server',
        'claude',
        'friday_hub',
        'friday_companion',
        'design_save_server',
        'dev_server',
        'workflow_worker',
        'other_observed'
    )),
    command_ref                    TEXT,
    command_hash                   TEXT,
    cwd_ref                        TEXT NOT NULL CHECK(length(trim(cwd_ref)) > 0),
    port_bindings                  TEXT NOT NULL DEFAULT '[]',
    started_by_surface_thread_id   TEXT,
    started_by_provider_session_id TEXT,
    health_check_ref               TEXT,
    safe_stop_ref                  TEXT,
    last_observed_at_ms            INTEGER,
    stale_after_ms                 INTEGER,
    state                          TEXT NOT NULL CHECK(state IN (
        'claimed',
        'running',
        'healthy',
        'needs_owner_decision',
        'stopping_requested',
        'stopped_with_proof',
        'stale',
        'blocked'
    )),
    proof_refs                     TEXT NOT NULL DEFAULT '[]',
    created_at_ms                  INTEGER NOT NULL,
    updated_at_ms                  INTEGER NOT NULL,
    FOREIGN KEY(claim_id) REFERENCES workspace_claim(claim_id),
    FOREIGN KEY(mission_id) REFERENCES mission(mission_id),
    FOREIGN KEY(work_item_id) REFERENCES work_item(work_item_id),
    FOREIGN KEY(started_by_surface_thread_id)
        REFERENCES surface_thread(surface_thread_id),
    FOREIGN KEY(started_by_provider_session_id)
        REFERENCES provider_session_link(friday_session_id)
);
CREATE INDEX idx_process_lease_claim_state
    ON process_lease(claim_id, state, updated_at_ms);
CREATE INDEX idx_process_lease_pid_state
    ON process_lease(pid, state, updated_at_ms);
CREATE INDEX idx_process_lease_mission_state
    ON process_lease(mission_id, state, updated_at_ms);

CREATE TABLE process_observation (
    observation_id      TEXT PRIMARY KEY,
    pid                 INTEGER NOT NULL,
    ppid                INTEGER,
    process_kind        TEXT NOT NULL CHECK(process_kind IN (
        'codex_cli',
        'codex_app_server',
        'claude',
        'friday_hub',
        'friday_companion',
        'design_save_server',
        'dev_server',
        'workflow_worker',
        'other_observed'
    )),
    cwd_ref             TEXT NOT NULL CHECK(length(trim(cwd_ref)) > 0),
    port_bindings       TEXT NOT NULL DEFAULT '[]',
    command_hash        TEXT,
    observed_at_ms      INTEGER NOT NULL,
    matched_claim_id    TEXT,
    ownership_status    TEXT NOT NULL CHECK(ownership_status IN (
        'observed_unowned',
        'unowned_agent_process',
        'unowned_friday_process',
        'friday_owned_launchd',
        'friday_owned_claimed'
    )),
    FOREIGN KEY(matched_claim_id) REFERENCES workspace_claim(claim_id)
);
CREATE INDEX idx_process_observation_pid_seen
    ON process_observation(pid, observed_at_ms);
CREATE INDEX idx_process_observation_owner_seen
    ON process_observation(ownership_status, observed_at_ms);";

// --- migration bodies -------------------------------------------------------

fn m0001_init_hub(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_DEVICE_IDENTITY)?;
    tx.execute_batch(DDL_TRUSTED_DEVICE)?;
    tx.execute_batch(DDL_SESSION)?;
    tx.execute_batch(DDL_ACTIVITY_ITEM)?;
    tx.execute_batch(DDL_TOKEN_LEDGER)?;
    tx.execute_batch(DDL_AUDIT_LEDGER)?;
    tx.execute_batch(DDL_MEMORY_ITEM)?;
    tx.execute_batch(DDL_BLOB)?;
    Ok(())
}

fn m0001_init_phone(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_DEVICE_IDENTITY)?;
    tx.execute_batch(DDL_SESSION)?;
    tx.execute_batch(DDL_ACTIVITY_ITEM)?;
    tx.execute_batch(DDL_TOKEN_LEDGER)?;
    tx.execute_batch(DDL_OFFLINE_QUEUE)?;
    tx.execute_batch(DDL_BLOB)?;
    Ok(())
}

// Unit 9: additive forward migration (v1 -> v2) adding the Hub workflow tables.
fn m0002_workflow(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_WORKFLOW)?;
    Ok(())
}

// Unit 10: additive forward migration (v2 -> v3) adding the memory lifecycle
// `state` column. SQLite `ADD COLUMN ... DEFAULT 'candidate'` sets EVERY existing
// row to the default, so we backfill in the SAME transaction — otherwise an
// already-confirmed memory (`confirmed_at` set) would be silently demoted to a
// candidate (a data-correctness regression). `confirmed_at` is the authoritative
// pre-migration signal of "the user confirmed this".
//
// The migration is the ONLY writer of these columns besides the typed repo, so it
// must uphold the same `(confidence, state)` consistency the repo guarantees —
// otherwise it could mint the very divergent pair the repo makes unrepresentable
// (`memory_item` has existed since v1 with a nullable, repo-unenforced
// `confidence`). So we also normalize `confidence`: a confirmed row gets
// `confidence='confirmed'`; a non-confirmed row never keeps a `confirmed` (or
// NULL) confidence. Post-migration: `confidence='confirmed'` IFF
// `state='confirmed'` IFF `confirmed_at IS NOT NULL`, and `confidence` is never NULL.
fn m0003_memory_state(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE memory_item ADD COLUMN state TEXT NOT NULL DEFAULT 'candidate';
         UPDATE memory_item
            SET state = 'confirmed', confidence = 'confirmed'
            WHERE confirmed_at IS NOT NULL;
         UPDATE memory_item
            SET confidence = 'candidate'
            WHERE confirmed_at IS NULL AND (confidence IS NULL OR confidence = 'confirmed');",
    )
}

fn m0004_consumed_approval(tx: &Transaction) -> rusqlite::Result<()> {
    // `use_key` PRIMARY KEY: a single approval is spendable exactly once — a second
    // grant attempt collides on the PK (INSERT-as-grant), so replay is unrepresentable.
    tx.execute_batch(
        "CREATE TABLE consumed_approval (
            use_key       TEXT PRIMARY KEY,
            approval_id   TEXT NOT NULL,
            action_digest TEXT NOT NULL,
            consumed_at   INTEGER NOT NULL
         );",
    )
}

// PR-5: additive forward migration adding the Hub-only agent_run +
// agent_run_event tables. Purely additive (CREATE TABLE only) — it touches no
// existing table, so pre-existing rows are untouched.
fn m0005_agent_run(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_AGENT_RUN)?;
    Ok(())
}

// Additive recall fields on `memory_item` (PROOF-MEMORY-001). `content` is the
// inline recallable text (the marker a recall injects); `principal_id` is the
// owner the same-principal-only recall keys on; `sensitive` (0/1) routes a
// recalled item through the Context Passport gate. Pre-existing rows backfill to
// NULL/NULL/0 — not recallable (no content, no owner) — which is the fail-closed
// default. An index on (principal_id, state) keeps the recall query cheap.
fn m0006_memory_recall_fields(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE memory_item ADD COLUMN content TEXT;
         ALTER TABLE memory_item ADD COLUMN principal_id TEXT;
         ALTER TABLE memory_item ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
         CREATE INDEX idx_memory_principal_state ON memory_item(principal_id, state);",
    )
}

// Channels A-PR1: the Hub-only `channel_binding` table. `bound_principal_id` is the
// owner the trusted-inbound invariant binds to (non-anonymous, enforced by the repo);
// `allowlist` is newline-joined sender ids; `webhook_auth_ref` is an OPAQUE reference
// to the inbound bearer secret in OS secure storage — NEVER the secret material (so the
// no-provider-secret-table invariant holds). Purely additive.
fn m0007_channel_binding(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE channel_binding (
            channel_id          TEXT PRIMARY KEY,
            kind                TEXT NOT NULL,
            bound_principal_id  TEXT NOT NULL,
            allowlist           TEXT NOT NULL DEFAULT '',
            webhook_auth_ref    TEXT,
            status              TEXT NOT NULL,
            created_at          INTEGER NOT NULL
        );",
    )
}

// PNS-001: Hub-only provider session links + event mirror (renumbered v7→v8 on the
// pre-PR rebase; channel_binding took v7 on main). Purely additive.
fn m0008_provider_session_contract(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_PROVIDER_SESSION)?;
    Ok(())
}

// Mission Spine slice 2: additive Hub-owned conversation graph tables.
fn m0009_mission_spine(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_MISSION_SPINE)?;
    Ok(())
}

// Process Registry slice 7: additive Hub-owned workspace/process registry.
fn m0010_process_registry(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_PROCESS_REGISTRY)?;
    Ok(())
}

// Mission Spine route-decision trace. The route_decision row is not memory and
// not completion proof; it is the durable "why this route now" evidence a later
// agent/UI can inspect before continuing work.
fn m0011_route_decision_trace(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_ROUTE_DECISION_TRACE)?;
    tx.execute_batch(DDL_REBUILD_MISSION_LINK_WITH_ROUTE_DECISION)?;
    Ok(())
}

// Mission Spine surface-event trace. This is the refs-only bridge that lets a
// mobile/channel event appear in the same Mission timeline on desktop without
// turning raw external chat ids into Friday conversation ids.
fn m0012_surface_event_trace(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_SURFACE_EVENT_TRACE)?;
    Ok(())
}

// S1.2: run-attributable token ledger. `ALTER TABLE ... ADD COLUMN` appends a
// nullable `run_id` at the END of the row, so positional reads of the existing 13
// columns are unaffected and every existing explicit-column query keeps working.
// The ask path (single-shot `record_model_call`) writes NULL `run_id` (no run); the
// agent loop (`record_run_model_call`) writes the owning `run_id` so per-run billing
// becomes queryable. Pre-existing rows backfill to NULL. The index keeps the
// per-run total (`run_token_totals`) cheap.
fn m0013_token_ledger_run_id(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE token_ledger ADD COLUMN run_id TEXT;
         CREATE INDEX idx_ledger_run ON token_ledger(run_id);",
    )
}

// S6b: additive Hub-only `pending_approval_request` table. `approval_id` (the single-use
// nonce the operator signs over) is the PRIMARY KEY, so a duplicate nonce is a fail-closed
// insert error — a nonce is never silently reused. The row holds NO key/secret/mint
// material: only the nonce, the `action_digest` (which binds the exact action), the expiry
// + issuer the eventual approval carries, and operator-facing decision context (action /
// principal / scope / surface / run). Purely additive (CREATE TABLE only).
fn m0014_pending_approval_request(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE pending_approval_request (
            approval_id   TEXT PRIMARY KEY,
            run_id        TEXT NOT NULL,
            action        TEXT NOT NULL,
            action_digest TEXT NOT NULL,
            principal_id  TEXT,
            surface       TEXT NOT NULL,
            resource_type TEXT,
            resource_id   TEXT,
            expires_at    INTEGER NOT NULL,
            issuer        TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'pending',
            created_at    INTEGER NOT NULL
         );
         CREATE INDEX idx_pending_approval_run ON pending_approval_request(run_id, created_at);",
    )
}

// D1-substrate: additive Hub-only `run_result` answer store keyed by `run_id`.
// Purely additive (CREATE TABLE + INDEX only) — touches no existing table, so
// pre-existing rows and every existing query are unaffected.
fn m0015_run_result(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_RUN_RESULT)?;
    Ok(())
}

// S6d: additive nullable `tool_params` column on `pending_approval_request` (the raw
// tool-call key/value pairs as JSON), so the resume entrypoint can re-execute the exact
// approved mutation. `ALTER TABLE ... ADD COLUMN` with no default is additive and
// back-compatible: existing v14 rows read back as `NULL`.
fn m0016_pending_approval_tool_params(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch("ALTER TABLE pending_approval_request ADD COLUMN tool_params TEXT;")
}

// D1-Q1: additive nullable `owner_principal` column on `run_result` — the run's bound
// OWNER principal the authenticated answer-body read (`get_run_answer_for_principal`)
// matches the caller against. `ALTER TABLE ... ADD COLUMN` with no default is additive
// and back-compatible: existing v15 rows read back as `owner_principal = NULL`. A NULL
// (or empty / `public`) owner FAILS CLOSED on the body read, so the column never weakens
// the refs-only proof projection (which does not select it at all).
fn m0017_run_result_owner_principal(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch("ALTER TABLE run_result ADD COLUMN owner_principal TEXT;")
}

// S5: additive Hub-only `agent_session` + `agent_session_message` tables. A session
// groups runs and stores their prior conversation messages (role + content + refs)
// keyed by `agent_session_id`, so a session can RESUME with multi-turn inbound
// history. Purely additive (CREATE TABLE + INDEX only) — touches no existing table.
fn m0018_agent_session(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_AGENT_SESSION)
}

// SMOOTH-001: additive Hub-only provider-timeline tables (`provider_timeline` +
// `provider_timeline_event` + `provider_timeline_pending`). They persist the in-memory
// `friday_hub::ProviderTimeline` state machine so a Friday-canonical provider-session
// timeline survives a Hub restart. Purely additive (CREATE TABLE + INDEX only) — touches
// no existing table, so pre-existing rows/queries are unaffected.
fn m0019_provider_timeline(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_PROVIDER_TIMELINE)
}

// Session-memory slice-2 (dedup): additive `memory_extract_status` column on the
// Hub-only `agent_session_message` table (mirrors the TS
// `session_messages.memory_extract_status`). The inline memory extraction reads only
// 'pending' messages and marks the processed ones 'extracted', so a RE-RUN reads no
// pending and produces no duplicate candidates. `ADD COLUMN ... DEFAULT 'pending'`
// sets EVERY existing row to 'pending' (so the first run after upgrade still reads the
// full history); the column is `NOT NULL` so a message always has a definite status.
// The CHECK enumerates the full TS status vocabulary (`'pending','queued','extracted',
// 'skipped','failed'`) so the deferred queue/retry slice is not foreclosed — slice-2's
// inline path uses only the 'pending'->'extracted' transition. A partial index on the
// 'pending' rows keeps the per-session pending SELECT cheap without indexing the
// terminal rows. Purely additive (ALTER + INDEX only) — touches no other table.
fn m0020_session_message_memory_extract_status(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE agent_session_message
            ADD COLUMN memory_extract_status TEXT NOT NULL DEFAULT 'pending'
            CHECK(memory_extract_status IN (
                'pending', 'queued', 'extracted', 'skipped', 'failed'
            ));
         CREATE INDEX idx_agent_session_message_pending
            ON agent_session_message(agent_session_id, seq)
            WHERE memory_extract_status = 'pending';",
    )
}

// Session-memory slice-3 (ownership-binding): additive NULLABLE owner columns on the
// Hub-only `agent_session` table (`account_id`, `channel`, `user_id`). These mirror the
// TS `FridaySessionRecord` axes the memory namespace is derived from. The memory store
// SCOPE (the `principal_id` recall axis) is now DERIVED from these — a composite
// `tenant.<account>.channel.<channel>.user.<user>.shared` namespace — instead of a
// caller-supplied principal. `ALTER TABLE ... ADD COLUMN` with no default is additive and
// back-compatible: every existing v20 row reads back NULL for all three. A NULL `user_id`
// FAILS CLOSED at namespace resolution (TS throws `MEMORY_NAMESPACE_UNRESOLVABLE`), so a
// pre-slice-3 session is never bound to a default scope — it cannot be extracted until its
// owner is set. The `agent_session` CREATE-DDL const stays FROZEN at its pre-v21 shape, so
// a fresh install runs the base CREATE then this ALTER (no duplicate-column on fresh
// install) — mirrors how m0017 added `run_result.owner_principal`.
fn m0021_agent_session_owner(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE agent_session ADD COLUMN account_id TEXT;
         ALTER TABLE agent_session ADD COLUMN channel TEXT;
         ALTER TABLE agent_session ADD COLUMN user_id TEXT;",
    )
}

// S8: additive Hub-only versioned `workflow_definition` store (see the DDL const's
// docs). Purely additive (CREATE TABLE + INDEX only) — touches no existing table,
// so pre-existing rows and every existing query are unaffected.
fn m0022_workflow_definition(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_WORKFLOW_DEFINITION)
}
