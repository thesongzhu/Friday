# Friday — native iOS shell (Unit 5b, simulator)

A SwiftUI app that renders values computed by the **all-Rust core** (`friday-ffi`)
through the generated **UniFFI Swift bindings**, AND integrates the **real sealed-WS
Rust client** for the Home read surface + the **Friday Chat read-WRITE S6 loop**.

## Real-client integration (`FridayiOSCore`)

`Package.swift` builds a UI-free **`FridayiOSCore`** library (host-buildable +
host-testable with plain `swift build` / `swift test` — no Xcode/simulator/bindings)
that depends on the local **`FridayRustClient`** SPM package (the real sealed-WS
read+write client + Swift↔Rust crypto-parity stack). The package's types WIN — there
is ONE `WorkbenchSnapshot` / one client protocol across desktop + mobile.

- **Home** → the real `SealedWSReadClient` (`HomeViewModel`): reads the refs-only
  Mission Workbench projection; a dark/offline/503/stale throw renders **honest-
  unavailable**, never a fabricated snapshot.
- **Friday Chat** → the real `SealedWSWriteClient` + the `OperatorSigner` relay
  (`FridayChatViewModel`): the 4-state S6 loop — compose→send→answer (refs-only),
  mutating→paused→**approval card**, approve→**resume relays the operator's opaque
  signed blob VERBATIM**→receipt.

**Invariants enforced at the view-model level:** the app NEVER mints/holds a signing
key (INV-1, relay-only); mutating actions ALWAYS pause for approval (INV-2, no
bypass); everything is refs-only (INV-5); honest-unavailable when the server is dark.

The `OperatorSigner` is a **mock** today (`MockOperatorSigner` — a clearly-labeled
NON-real placeholder, not a signature). The **real** signer is the desktop
operator-signer helper (PR #671) reading the operator's isolated SecureStore; wiring
it + the live `NWConnection` transport + a live, server-accepted S6 resume is the
**slice-6 / operator-key gate** (deferred).

The `: Sendable` mismatch (the package's read/write client protocols + `WorkbenchSnapshot`
are not `Sendable`) is resolved on the CONSUMER side: the `@MainActor` view models hold
the clients `nonisolated(unsafe)` (sound — the package clients are immutable `final class`
and build a FRESH transport per call) and surface `Sendable` value projections. The #677
package is never edited.

This is **simulator-level** proof only. Physical-device proof and App Store
release remain operator-gated. Overall Friday v1 is **NO-GO**.

## Build + screenshot (simulator)

```sh
apps/friday-ios/build-sim.sh   # -> .build/friday-ios-sim.png
```

The script: cross-compiles the `aarch64-apple-ios-sim` staticlib, generates the
Swift bindings, compiles `Sources/FridayApp.swift` + the bindings with `swiftc`
against the simulator SDK (linking `libfriday_ffi.a`), assembles `FridayShell.app`,
then installs/launches/screenshots it on a booted simulator.

### Toolchain note (important)
iOS cross-compile needs the **rustup stable** toolchain (it has the iOS std),
but a Homebrew `rust` 1.95.0 can shadow it on `PATH`. The script puts the
toolchain's own bin dir first:

```sh
PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" cargo build ...
```

`rust-toolchain.toml` (pinned 1.95.0) is intentionally left untouched so CI stays
reproducible; only the local iOS build overrides the toolchain via `PATH`.

## Trust boundary
`friday-ffi` is the phone-side library; its dependency graph **excludes**
`friday-deepseek` and `friday-providers` (Hub-only, provider-secret-bearing), so
"no provider secret on the phone" is a compile-time property asserted by
`friday-arch-tests`. This app links only `friday-ffi`.

## Not built in CI
The simulator build needs Xcode + the iOS toolchain, so `build-sim.sh` is a local
proof, not a CI step. CI builds/tests the Rust workspace (host) as usual.
