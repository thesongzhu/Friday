# Element-inventory schema — INV-ARTIFACT-001 (P0)

Schema and blocker vocabulary for the deterministic artifact-inventory
reconciliation gate implemented in [`reconcile.mjs`](./reconcile.mjs).

## Honest scoping (read first)

This slice ships the **pure deterministic reconciler + a red-first behavioral
negative control on fixtures only**. Producing the real **OBSERVED** universe —
unpacking a real signed DMG/AAB and crawling the installed runtime — is
**release-gated and NOT in scope**. The reconciler is the pure engine that the
operator's later real-artifact unpack will feed. A GREEN verdict from this tool
means *"the two supplied inventories reconcile"* and says **nothing** about a
real release. This tool does **not** authorize `release_status: passed`.

## Two inventories

The reconciler consumes two element inventories that share one file shape:

- **REGISTRY** (declared / expected) — what the release is supposed to contain.
  Entries may carry `required: true` to assert the element MUST be observed.
- **OBSERVED** (authoritative / enumerated) — what was actually enumerated from
  the artifact / runtime. In this slice OBSERVED is a fixture; in production it
  is the (release-gated, out-of-scope) output of a real unpack + crawl.

## File shape

```jsonc
{
  // Optional discriminators (metadata; not required by the reconciler).
  "truth": "artifact_element_inventory",
  "role": "registry",            // or "observed"
  "elements": [                   // REQUIRED — must be an array (fail-closed)
    {
      "elementType": "binary",   // REQUIRED — one of the six types below
      "id": "Friday.app/Contents/MacOS/Friday", // REQUIRED — non-empty string
      "sha256": "…64 hex…",      // OPTIONAL — content digest, if known
      "required": true            // OPTIONAL (REGISTRY only) — default false
    }
  ]
}
```

### Field rules (fail-closed — malformed input throws a typed error, exit 3)

| Field         | Rule                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| top level     | must be a JSON object (not array/null) with an `elements` **array**        |
| `elementType` | required string in the six-type set; anything else → `invalid_element_type`|
| `id`          | required non-empty string (after trim) → else `invalid_element_id`         |
| `sha256`      | optional; if present must be a non-empty string → else `invalid_sha256`    |
| `required`    | REGISTRY only; if present must be a boolean → else `invalid_required_flag` |

`required` is ignored on OBSERVED entries (only the registry declares intent).

## The six element types (contract `proof_scope`)

| elementType   | what it enumerates                                          |
| ------------- | ---------------------------------------------------------- |
| `binary`      | executables / libraries inside the packaged app            |
| `entitlement` | code-signing entitlements granted to the binary            |
| `config`      | shipped config / plist / manifest files                    |
| `asset`       | bundled static assets                                      |
| `route`       | HTTP / IPC routes the runtime exposes                      |
| `flag`        | feature flags / toggles compiled or shipped into the build |

## Element identity

```
normalizedKey = id.trim()
elementId     = "{elementType}:{normalizedKey}"
```

The `elementType` prefix namespaces the key so the same `id` string under two
different types (e.g. a `binary` and a `config` both named `friday`) never
collide. Reconciliation is a keyed set-difference over `elementId`.

## Blocker vocabulary

| code                  | meaning                                                             |
| --------------------- | ------------------------------------------------------------------ |
| `ghost_element`       | elementId in OBSERVED but not in REGISTRY (unregistered / ghost)    |
| `required_unobserved` | REGISTRY element with `required: true` that is absent from OBSERVED |
| `sha_mismatch`        | elementId in both, `sha256` declared on both, and the digests differ |
| `duplicate_id`        | the same elementId appears twice within one universe               |

A non-`required` registry element that is not observed is **not** a blocker
(it is optional / may legitimately be absent). `sha_mismatch` fires only when
BOTH sides declare a `sha256`; a missing digest on either side is not a mismatch.

## Verdict

- **GREEN** iff `ghostElementCount == requiredUnobservedCount ==
  shaMismatchCount == duplicateIdCount == 0` → `status: "passed"`.
- Otherwise `status: "blocked"` with the sorted `blockers` list.
- Malformed input → `status: "error"` and exit **3**, unconditionally
  (fail-closed: a malformed inventory can never read as passed).

## Determinism

The verdict body (status, blockers, counts) is a **pure function of the two
input files**. Universes are indexed and iterated in canonical `sort()` order
on `elementId`, and blockers are sorted by `(code, detail)`. No clock or random
is consulted in the pass/fail path — `generated_at_utc` in the report is
**metadata only** and is never read when deciding pass/fail.

## CLI

```
node tools/inventory/reconcile.mjs \
  --registry=/abs/registry-inventory.json \
  --observed=/abs/observed-inventory.json \
  [--out=/abs/reconcile-report.json] [--require-passed]
```

Exit codes: `0` passed (or blocked without `--require-passed`), `2` blocked
under `--require-passed`, `3` malformed input (fail-closed).
