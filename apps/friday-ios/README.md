# Friday — native iOS shell (Unit 5b, simulator)

A minimal SwiftUI app that renders values computed by the **all-Rust core**
(`friday-ffi`) through the generated **UniFFI Swift bindings**. It is the
first native iOS proof that the Swift ↔ Rust bridge runs on-device(sim):
connection-state projection + protocol schema version/negotiation, all from Rust.

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
