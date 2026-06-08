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
