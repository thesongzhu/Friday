# Data-universe schema — INV-DATA-001 (P0)

Schema, policy-dimension model, and blocker vocabulary for the deterministic
data-universe census + reconcile gate. The reconcile CLI
([`data-universe-census.mjs`](./data-universe-census.mjs)) is a **thin** pure
keyed set-difference engine; the census it reconciles against is produced by an
**authoritative oracle** ([`data-universe-oracle.ts`](./data-universe-oracle.ts)).
Sibling of the artifact-inventory gate ([`reconcile.mjs`](./reconcile.mjs),
INV-ARTIFACT-001): same discipline, applied to the DATA universe.

## Authoritative census — NOT a regex parse (read second)

The SQLite half of the census is **authoritative**: the oracle EXECUTES the exact
committed migration chain (`FRIDAY_SQLITE_MIGRATIONS` via `runFridayMigrations`)
against a fresh `new Database(":memory:")` and then INTROSPECTS the resulting
schema (`sqlite_master` + `PRAGMA table_info`). What the running database reports
**is** the census. This is not a static DDL "replay": a regex parser is
structurally blind to

- **dynamic migrations** — e.g. V069 adds its metadata columns
  (`last_verified_*`, `compatibility_status`, `promotion_channel`,
  `shadow_version_id`, `canary_stats_json`) through an imperative `apply(db)` hook,
  not static `ALTER TABLE` text; and
- **FTS5 shadow tables** — `CREATE VIRTUAL TABLE … USING fts5` auto-creates
  `*_fts_data` / `*_fts_idx` / `*_fts_docsize` / `*_fts_config` tables that exist
  only once the vtable is really created.

Executing the chain recovers all of these (37 real table/column entries a regex
replay missed on the current schema).

Because the oracle imports the repo's `.ts` migration sources (and `#state`
resolves to a `dist` alias unavailable to plain node), it runs under the repo's
vitest/TS toolchain — the same way every migration test bootstraps a DB. It
regenerates a committed **snapshot** ([`data-universe-census.snapshot.json`](./data-universe-census.snapshot.json))
that the plain-node CLI reads. The snapshot carries a **`sourceFingerprint`**
(sha256 over every migration `.ts`, the runner, `schema.rs`,
`friday-retention.types.ts`, and the oracle). The CLI recomputes it from disk and
**fails closed** if it drifts, so a migration / schema / retention / oracle change
that is not followed by a snapshot regeneration turns the gate RED instead of
serving a stale (possibly false-clean) census. The contract test additionally
re-executes the migrations every CI run and asserts the snapshot equals the live
schema + fingerprint — that is what keeps the committed snapshot **LIVE**.

Regenerate the snapshot after any source change with:

```
INV_DATA_SNAPSHOT_REGEN=1 npx vitest run \
  test/contracts/inventory/friday-data-universe-reconcile.contract.test.ts
```

### Rust boundary (honest gap)

A Node in-memory DB cannot run the Rust store's rusqlite migrations, so the Rust
surface (`rust-core/crates/friday-storage/src/schema.rs`) is parsed **statically**
(CREATE / ALTER / RENAME / DROP replay of the literal SQL text). This is a
**documented gap**: if the Rust store ever adds **programmatic / conditional** DDL
(the Rust analog of V069's `apply` hook), that construct would be invisible here
and must be resolved by the gated live/operator-sealed crawl — Rust completeness
is **never** claimed from this static parse.

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

- **CENSUS** (discovered / derived) — the authoritative snapshot the oracle
  produces from source: SQLite via **real migration execution + introspection**,
  the Rust-owned schema (`schema.rs`) via static parse (documented boundary), and
  the retention categories from the **canonical governance constants**
  (`FRIDAY_RETENTION_CONTENT_CATEGORIES` + the security-lifecycle fields of
  `FRIDAY_DEFAULT_RETENTION_POLICY`). Each element carries the source-**derived**
  static dims. This is the *source-discoverable* surface; the runtime + signed
  artifact *authoritative* universe remains out of scope.
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
- **retention** — the reaper mapping keyed by the **canonical** governance
  categories. The oracle imports `FRIDAY_RETENTION_CONTENT_CATEGORIES` (the seven
  owner-configurable CONTENT categories) + the SECURITY-LIFECYCLE fields of
  `FRIDAY_DEFAULT_RETENTION_POLICY` — it never re-declares them. The hand-maintained
  category→physical-table map (`learning_events`, `satellite_heartbeats`,
  `skill_run_snapshots`, `audit_logs`, `friday_agent_runs`, `llm_usage_records`,
  `error_incidents` → `content-opt-in`; `satellite_pairing_requests`,
  `outbox_messages`, `friday_setup_bootstrap_nonces` → `security-lifecycle-ttl`) is
  **fail-closed cross-checked** against those constants: if a source category is
  added / removed / renamed, the oracle throws (`retention_*_category_drift`) so the
  change can never stay invisible (no false-green). Everything else →
  `permanent-default` (DATA-RETENTION-001: local data is default-permanent,
  auto-cleanup is opt-in per category).

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

### Fail-closed rejections (exit 3, never "passed")

Beyond the five blocker codes above (which produce `status: "blocked"`), the
engine rejects structurally / semantically invalid input **unconditionally** with
`status: "error"` and exit **3**:

| code                                                   | meaning                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `invalid_kind` / `invalid_source`                      | element `kind`/`source` missing or outside the allowed set                          |
| `invalid_key_prefix`                                   | key has no `sqlite:` / `rust:` / `retention:` prefix                                 |
| `semantic_source_mismatch` / `semantic_kind_mismatch`  | key-prefix contradicts the element's `source` / `kind` (e.g. a `sqlite:` key claiming `source=retention`) |
| `key_table_mismatch`                                   | a table element's key ≠ `source:table`                                             |
| `column_count_mismatch`                                | `columnCount` ≠ `columns.length` (a census element lying about its shape)           |
| `invalid_columns` / `invalid_table` / `retention_columns_nonempty` | malformed census shape                                            |
| `invalid_derived_value` / `invalid_policy_value`       | a dim carries a value outside its allowed set                                       |
| `snapshot_stale` / `snapshot_unreadable` / `invalid_snapshot` | the committed census snapshot's `sourceFingerprint` ≠ disk, or it is missing/corrupt |

The **semantic-identity** checks close a false-clean hole: an element with a
consistent-looking key but a flipped `kind`/`source` used to reconcile as passed.
The **`snapshot_stale`** check is the LIVE guard — the plain-node CLI cannot run
the migrations, so it proves the snapshot still matches source by fingerprint and
refuses to serve a stale census.

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
# Emit the authoritative census (from the fingerprint-guarded snapshot).
node tools/inventory/data-universe-census.mjs [census] [--out=/abs/census.json]

# Re-seed the registry from the authoritative census.
node tools/inventory/data-universe-census.mjs emit-registry [--out=/abs/registry.json]

# Reconcile the declared registry against the authoritative census.
node tools/inventory/data-universe-census.mjs reconcile \
  --registry=/abs/data-universe-registry.json \
  [--census=/abs/census.json]   # omit to use the authoritative snapshot
  [--out=/abs/reconcile-report.json] [--allow-blocked]

# Regenerate the snapshot after a migration / schema / retention / oracle change
# (runs the REAL migrations under vitest):
INV_DATA_SNAPSHOT_REGEN=1 npx vitest run \
  test/contracts/inventory/friday-data-universe-reconcile.contract.test.ts
```

Exit codes: `0` passed (or blocked under `--allow-blocked`), `2` blocked
(any RED), `3` malformed input (fail-closed). Paths must be absolute
(a relative path is rejected fail-closed).
