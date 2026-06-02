# Friday Rust Core — Unit 2 foundation

This is the start of the all-Rust Friday product core (the v1 source of truth) for
the Friday Rust/mobile rewrite. It corresponds to **Unit 2 — Rust Core foundation**
in the goal folder `/Users/jarvis/Desktop/friday-rust-mobile-rewrite-goals-20260601`
(files `03`, `15` §6, and the architecture gate `21`).

> **Overall product status: `NO-GO` (greenfield).** This workspace implements only
> the foundation slice. It is **not** Friday v1 and does not imply v1 readiness.
> The TypeScript Friday repo remains the reference oracle / migration source.

## What this unit implements (and tests)

| Crate | Role | Status |
|---|---|---|
| `friday-core` | Pure domain types + state machines (no I/O): device identity, session/activity/offline-queue/connection state machines, token-ledger entry. | implemented + unit-tested |
| `friday-crypto` | XChaCha20-Poly1305 field/blob encryption, data-key wrap/rotation under a KEK, `SecureStore` trait + in-memory impl. | implemented + unit-tested |
| `friday-storage` | SQLite (bundled): schema, forward migrations + destructive-backup guard + refuse-when-newer, hash-chained append-only audit ledger, token ledger, encrypted blob store, atomic multi-table write, Hub-vs-Phone schema split. | implemented + integration-tested |
| `friday-deepseek` | DeepSeek Friday-provider route. **Dependency-boundary stub only**; the live route lands in Unit 3. Present now so the trust boundary exists. | stub (route deferred to Unit 3) |
| `friday-ffi` | Phone-side FFI surface. **Dependency-boundary stub only**; UniFFI bindings + slice API land in Unit 5. | stub (bindings deferred to Unit 5) |
| `friday-arch-tests` | Architecture-invariant tests: asserts `friday-ffi`'s dependency closure excludes `friday-deepseek` ("no provider secret on phone" as a compile-time property). | implemented + tested |

## Key security property

`friday-deepseek` (provider-secret-bearing, Hub-only) is **not** in `friday-ffi`'s
dependency graph, so DeepSeek-calling code cannot compile into the phone artifact.
This is asserted by `friday-arch-tests` and shown by `cargo tree -p friday-ffi`.
No SQLite table (Hub or Phone) stores a provider secret; the phone schema also omits
the Hub-only secret/audit tables entirely.

## Build & test

```sh
cargo test --workspace        # 52 tests
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
cargo tree -p friday-ffi      # confirm friday-deepseek absent
```

## Explicitly deferred (per architecture gate 21 §9)

DeepSeek live route (Unit 3); E2E transport / QR pairing / offline-queue execution
engine (Unit 4); UniFFI bindings + native iOS/Android shells (Unit 5); Codex/Claude
adapters (Units 6/7); memory review, workflows/activity taxonomy, channels, and the
full TS→Rust parity matrix (later units). Each carries its own exit gate.

True multi-writer (WAL) concurrency for the audit chain is a Hub-runtime concern
(Unit 4); this foundation asserts **sequential** append integrity only.
