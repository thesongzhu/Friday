# Friday Rust Core — Units 2–4 (foundation, DeepSeek route, transport)

This is the all-Rust Friday product core (the v1 source of truth) for the Friday
Rust/mobile rewrite. Goal folder:
`/Users/jarvis/Desktop/friday-rust-mobile-rewrite-goals-20260601` (files `03`, `15`,
architecture gate `21`; continuation artifact `27`).

> **Overall product status: `NO-GO` (greenfield).** Units 2–4 (core + DeepSeek
> route + protocol/transport/pairing/offline) are implemented and tested; Units
> 5–11 (native iOS/Android, Codex/Claude adapters, full parity, device proof) are
> not built. This is **not** Friday v1 and does not imply v1 readiness. The
> TypeScript Friday repo remains the reference oracle / migration source.

## Crates

| Crate | Role | Status |
|---|---|---|
| `friday-core` | Pure domain types + state machines (no I/O): device identity, session/activity/offline-queue/connection state machines, token-ledger entry. | implemented + tested |
| `friday-crypto` | XChaCha20-Poly1305 field/blob encryption, KEK wrap/rotation, OS-secure-storage trait; X25519+HKDF E2E session keys (`session`); HMAC pairing proof (`pairing`). Keys `ZeroizeOnDrop`, no `Debug`. | implemented + tested |
| `friday-protocol` | Versioned E2E envelope + message kinds, JSON (de)serialize, version negotiation, idempotency, resumable-stream replay. | implemented + tested |
| `friday-transport` | Length-prefixed frames carrying session-sealed envelopes over a socket + relay model. Proven over real loopback. | implemented + tested |
| `friday-storage` | SQLite (bundled): migrations + destructive-backup guard + refuse-when-newer; hash-chained audit ledger; token ledger; encrypted blobs; atomic multi-table write; Hub-vs-Phone schema split; offline-queue execution engine (`offline`); trusted-device pairing/revoke/rotation (`pairing`). | implemented + tested |
| `friday-deepseek` | DeepSeek Friday-provider route (Hub-only): runtime `/models` discovery, chat, usage→ledger `fallback=false`, no fallback. Live route smoke gated `#[ignore]`. | implemented + tested (live gated) |
| `friday-ffi` | Phone-side FFI surface. **Dependency-boundary stub**; UniFFI bindings + slice API land in Unit 5. | stub (Unit 5) |
| `friday-arch-tests` | Architecture-invariant tests: `friday-ffi`'s dependency closure excludes `friday-deepseek` ("no provider secret on phone" = compile-time property). | implemented + tested |

## Key security properties

- `friday-deepseek` (provider-secret-bearing, Hub-only) is **not** in `friday-ffi`'s
  dependency graph (asserted by `friday-arch-tests`; shown by `cargo tree -p friday-ffi`).
  No SQLite table stores a provider secret; the phone schema omits Hub-only secret/audit tables.
- E2E: X25519/HKDF session keys; a **passive relay (public keys only) cannot decrypt** —
  proven over a real loopback socket. Active MITM is blocked by **authenticated pairing**
  (HMAC binding the device pubkey to the out-of-band QR secret; substituted-key Pair rejected).

## Build & test

```sh
cargo test --workspace        # 92 tests (+1 #[ignore]d live DeepSeek route test)
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
cargo tree -p friday-ffi      # confirm friday-deepseek absent
# live DeepSeek route (mandatory Unit-3 proof), key sourced per-command:
#   set -a; . /private/tmp/friday-closure-20260530/.deepseek-env; set +a
#   cargo test -p friday-deepseek --test live_route -- --ignored --nocapture
```

## Explicitly deferred

- **Unit 4 remaining:** the WebSocket upgrade/handshake framing wrapper around the proven
  frame+seal contract; the real-network LAN/Tailscale/SSH transports; and the
  `Direct|Relay|Stale` connection-state machine over live sockets (gate `21` §4 is
  "first slice only"). The security/reconnect/resume *properties* are proven over loopback.
- **Unit 5:** UniFFI bindings + native iOS/Android shells + design-baseline screenshots
  (needs `rustup` iOS/Android targets + Xcode/Android SDK + simulators).
- **Units 6/7:** Codex/Claude adapters + auth (operator-gated login).
- **Units 9/10/11:** memory review / Context Passport, workflows/activity taxonomy, channels,
  full TS→Rust parity matrix, physical-device proof, release gates.

True multi-writer (WAL) concurrency for the audit chain is a Hub-runtime concern (Unit 4
live transport); the storage layer asserts **sequential** append integrity (incl.
within-transaction) only.
