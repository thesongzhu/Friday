# Data-universe schema — INV-DATA-001 (P0)

Schema, policy-dimension model, and blocker vocabulary for the deterministic
STATIC-SOURCE data-universe census + reconcile gate implemented in
[`data-universe-census.mjs`](./data-universe-census.mjs). Sibling of the
artifact-inventory gate ([`reconcile.mjs`](./reconcile.mjs), INV-ARTIFACT-001):
same pure keyed set-difference discipline, applied to the DATA universe.

## Honest scoping — the GATED remainder (read first)

This slice ships the **static-source census + the deterministic reconciler + a
red-first behavioral negative control on fixtures**. INV-DATA-001's
**authoritative** acceptance —

> every DB / table / **column** / file / keychain / cache / index / attachment /
> queue / backup / log / audit / telemetry / **payload field** has
> `{owner, encryption, retention, export/delete/backup}` policy, with zero
> unresolved gaps

— can only be **closed** by work that is **LIVE / SIGNED / OPERATOR-GATED and is
explicitly NOT in scope here**:

- a **live runtime crawl** of the running Hub (actual on-disk DBs, keychain
  entries, caches, queues, attachment dirs, log/telemetry sinks),
- an **unpacked signed-artifact scan** (what the shipped build actually bundles),
- a **prod-path authoritative readback** (the real file/keychain locations), and
- an **operator seal** over the resolved, zero-gap universe.

A GREEN verdict from this tool means only *"the declared registry reconciles
with the data surface **discoverable from source**"*. It authorizes **nothing**
about the real runtime universe and **does not close INV-DATA-001**. In
particular the static engine, by construction, can classify **only** what static
schema declares, so two things are **deferred to the gated closure**:

1. **Per-column / per-payload-FIELD policy.** Columns are enumerated (every table
   carries its full column manifest), but policy is classified at the **table /
   retention-category** granularity — the unit at which Friday's *source* actually
   declares governance. The policy of fields nested inside JSON blob columns
   (`payload_json`, `details_json`, `context_json`, `metadata_json`, …) is **not
   derivable from static schema** and is resolved by the live crawl.
2. **The `export` / `delete` / `backup` dimensions.** Static source does not
   declare an export or backup policy, and the *authoritative* delete/erasure
   policy (Delete-All content-free checkpoint semantics, cascade behaviour) is a
   runtime/operator concern. These three dimensions are recorded with the honest
   literal value **`gated`** (never fabricated) and are resolved by the closure.
   Partial static signals exist (soft-delete `deleted_at`/`deleted_by` columns,
   `ON DELETE` foreign-key actions) and inform — but do not replace — that gated
   determination.

## Two universes

The reconciler consumes two element universes that share one key space:

- **CENSUS** (discovered / derived) — enumerated from source by the crawler:
  SQLite migrations (`src/state/sqlite/migrations/v*.ts`), the Rust-owned schema
  (`rust-core/crates/friday-storage/src/schema.rs`), and the retention policy
  (`src/jobs/retention/*`). Each element carries the source-**derived** static
  dims. In this slice the census is the live source crawl; the *authoritative*
  census (runtime + signed artifact) is out of scope.
- **REGISTRY** (declared / expected) — the checked-in
  [`data-universe-registry.json`](./data-universe-registry.json): the **declared**
  policy classification for every known element. Seeded from the source-derived
  signals (`node data-universe-census.mjs emit-registry`) and **hand-owned going
  forward** — when source changes, the census diverges from the frozen registry
  and the reconcile turns RED until a human re-classifies.

## Element model

```
kind ∈ { table, retention-category }
key  = "sqlite:<table>"        // a table defined in a v*.ts migration
     | "rust:<table>"          // a table defined in friday-storage schema.rs
     | "retention:<category>"  // a reaper-governed retention category
```

The `source:` prefix namespaces the key so a table named the same in the TS and
Rust stores never collides. Reconciliation is a keyed set-difference over `key`.

The census nets out **transient migration scaffolds** (a `x_new` table that is
created, back-filled, then swapped in via `DROP x` + `RENAME x_new → x`) by
**replaying** `CREATE` / `ADD COLUMN` / `RENAME TO` / `DROP TABLE` in source
order — so the census reflects the **net** schema. A table renamed to a `_legacy`
name and **not** dropped correctly remains a discoverable (lingering) data
surface (e.g. `oauth_credentials_v010_legacy`).

### Census element shape

```jsonc
{
  "key": "sqlite:secrets",
  "kind": "table",
  "source": "sqlite",
  "table": "secrets",
  "columns": ["created_at", "encrypted_value", "id", "key_id", "…"], // sorted, unioned
  "columnCount": 9,
  "derived": {            // source-derived STATIC dims (the reconcile's drift oracle)
    "owner": "hub-sqlite",
    "encryption": "column-encrypted",
    "retention": "permanent-default"
  }
}
```

### Registry element shape

```jsonc
{
  "key": "sqlite:secrets",
  "kind": "table",
  "source": "sqlite",
  "owner": "hub-sqlite",            // REQUIRED static dim
  "encryption": "column-encrypted", // REQUIRED static dim
  "retention": "permanent-default", // REQUIRED static dim
  "export": "gated",                // closure-gated
  "delete": "gated",                // closure-gated
  "backup": "gated"                 // closure-gated
}
```

## Policy dimensions

| dimension    | class            | allowed values                                                                 |
| ------------ | ---------------- | ------------------------------------------------------------------------------ |
| `owner`      | required, static | `hub-sqlite`, `hub-rust`, `shared-rust`, `friday-retention`, `unknown`          |
| `encryption` | required, static | `plaintext`, `hashed`, `column-encrypted`, `not-applicable`, `unknown`         |
| `retention`  | required, static | `permanent-default`, `content-opt-in`, `security-lifecycle-ttl`, `unknown`     |
| `export`     | gated            | `gated`, `not-applicable`, `unknown`                                           |
| `delete`     | gated            | `gated`, `not-applicable`, `unknown`                                           |
| `backup`     | gated            | `gated`, `not-applicable`, `unknown`                                           |

A required dim left **missing** or set to the sentinel **`unknown`** is a RED
`policy_incomplete` — it is a real, fail-closed gap, matching the "zero
unresolved gaps" acceptance semantics. `not-applicable` is a *resolved* value
(a retention-category has no physical bytes to encrypt/export) and is **not** a
gap.

### How the static dims are derived (from source, never fabricated)

- **owner** — the owning store, from where the table is defined. SQLite tables →
  `hub-sqlite` (the single Hub SQLite DB). Rust tables → `hub-rust` if the name
  is in `HUB_ONLY_TABLES` (parsed from `schema.rs`), else `shared-rust` (created
  in both the Hub and phone profiles). Retention categories → `friday-retention`.
- **encryption** — a **column NAME-signal** heuristic: a column matching
  `/(ciphertext|encrypt|enc_alg|sealed_key)/i` → `column-encrypted`; else a
  column matching `/hash/i` → `hashed`; else `plaintext`. This reflects the
  at-rest posture *visible in schema*; the true at-rest posture (whole-DB
  encryption, OS-keychain sealing) is part of the gated closure.
- **retention** — the reaper mapping in `src/jobs/retention/*`: the seven
  owner-configurable CONTENT categories (`learning_events`, `satellite_heartbeats`,
  `skill_run_snapshots`, `audit_logs`, `friday_agent_runs`, `llm_usage_records`,
  `error_incidents`) → `content-opt-in`; the three SECURITY-LIFECYCLE TTL tables
  (`satellite_pairing_requests`, `outbox_messages`, `friday_setup_bootstrap_nonces`)
  → `security-lifecycle-ttl`; everything else → `permanent-default` (the
  DATA-RETENTION-001 default: local data is default-permanent, auto-cleanup is
  opt-in per category).

## Blocker vocabulary

| code                | meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `unregistered`      | key in CENSUS but not in REGISTRY (a discovered element never classified)       |
| `ghost`             | key in REGISTRY but not in CENSUS (a declared element no longer in source)       |
| `policy_incomplete` | a registered element whose required dim is missing or `unknown`                 |
| `policy_drift`      | a declared static dim ≠ the source-derived static dim (the `sha_mismatch` analog) |
| `duplicate_key`     | the same key appears twice within one universe                                 |

`policy_drift` is the load-bearing tie between the frozen registry and live
source: if a table gains an encrypted column, is moved under a reaper category,
or changes ownership, the census re-derives the new value and the drift REDs
until the registry is re-classified.

## Verdict

- **GREEN** iff `unregistered == ghost == policy_incomplete == policy_drift ==
  duplicate_key == 0` → `status: "passed"`.
- Otherwise `status: "blocked"` with the sorted `blockers` list.
- Malformed input → `status: "error"` and exit **3**, unconditionally
  (fail-closed: a malformed inventory can never read as passed).

## Determinism

The census and the verdict body are a **pure function** of the source files (and,
for reconcile, the registry file). Files are read in sorted order, elements are
keyed and iterated in canonical `sort()` order, columns are de-duplicated +
sorted, and blockers are sorted by `(code, detail)`. No clock or random is
consulted in the pass/fail path — `generated_at_utc` in the report is **metadata
only**.

## CLI

```
# Emit the static-source census (deterministic).
node tools/inventory/data-universe-census.mjs [census] [--out=/abs/census.json]

# Re-seed the registry from current source-derived signals.
node tools/inventory/data-universe-census.mjs emit-registry [--out=/abs/registry.json]

# Reconcile the declared registry against the source-discoverable census.
node tools/inventory/data-universe-census.mjs reconcile \
  --registry=/abs/data-universe-registry.json \
  [--census=/abs/census.json]   # omit to crawl the live source tree
  [--out=/abs/reconcile-report.json] [--allow-blocked]
```

Exit codes: `0` passed (or blocked under `--allow-blocked`), `2` blocked
(any RED), `3` malformed input (fail-closed). Paths must be absolute
(a relative path is rejected fail-closed).
