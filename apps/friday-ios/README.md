# Friday — native iOS app shell (M-PR1, the v1 mobile UI)

A SwiftUI iOS app shell implementing the **LOCKED mobile design baseline**
(`friday-design-handoff-20260602/saved/mobile-selection.json`):

- **Launch = Home** (locked). Home = **Status + heroPet + cardsQueues** (provider
  cards + "Needs Me" / "Running" queues). The **Friday Chat entry is the top-bar
  💬** — there is NO on-Home chat card.
- The composer lives in a separate **full-screen, pet-centered Friday Chat**
  surface (M-PR1: a **skeleton** — the chat read-WRITE loop + S6 approval is a
  later slice; the composer is honestly inert).
- The **Command Sheet** is a full-screen grid launcher opened from the top-left.
- Tokens: cyanCoral palette · warmOffWhite background · glassNative form · light
  theme · retroLcd Hero Pet.

This is the **read-only shell**. It reads a `WorkbenchSnapshot` projection through
the **`FridayRustReadClient`** protocol — the SAME protocol shape the desktop
sibling (`apps/macos/FridayHubConsole`, PR #676) and the sealed-WS read client
(`apps/macos/FridayRustClient`, PR #677) use — backed here by a `MockReadClient`
with representative sample data. The real `FridayRustClient` package is integrated
in a later PR via the same protocol; the snapshot model + mock are **byte-identical**
to the desktop sibling so both decode the future Rust Hub Mission Workbench
projection JSON the same way.

## Truth rules (binding, mirror #676)

- **Refs only** — `proofRef` / evidence refs / receipt refs are carried; never
  inline bodies. There is no body/content field anywhere.
- **truth_status is never upgraded** — unknown enum values decode to `.unknown`
  and render as honest "unavailable"; provider_ack ≠ done; linked_only ≠ owned.
- **503 / stale / offline render AS truth** — a `fetchWorkbench()` throw lands in
  an honest `.unavailable` Home; `[.stale]` drives a visible banner; the UI never
  falls back to a fabricated ready snapshot.
- **Read-only actions only** — the only action is Refresh (re-read). There is NO
  mutating action, NO dispatch/approve, and NO NO-GO row is executable.

## Module layout

- `Sources/FridayMobileShellCore/` — **UI-free** SwiftPM library: the snapshot
  truth model, the read-only client protocol, the mock, and the view models
  (`HomeViewModel`, `ChatViewModel`). Kept UI-free so the M-PR1 truth rules are
  unit-testable on a mac host with no Xcode/simulator:

  ```sh
  swift test          # -> 13 truth tests
  ```

- `Sources/FridayMobileShell/` — the SwiftUI iOS app (Home, Friday Chat skeleton,
  Command Sheet, Hero Pet, design tokens, truth chips). iOS-only APIs, so it is
  **not** a SwiftPM target — it is compiled against the iOS Simulator SDK by
  `build-sim.sh`.

## Build + screenshot (simulator)

```sh
apps/friday-ios/build-sim.sh   # -> .build-sim/friday-ios-sim.png
```

The script compiles `FridayMobileShellCore` as a Swift module, compiles the SwiftUI
app against it for the `arm64-apple-ios17.0-simulator` SDK, assembles
`FridayShell.app`, then installs/launches/screenshots it on a booted simulator.

**Device/simulator screenshot proof is operator-gated** (it needs Xcode + a booted
simulator or a physical device); it is a deferred acceptance criterion. The
load-bearing local checks are `swift test` (the truth rules) and the swiftc compile
of the app against the simulator SDK.

## Not built in CI

The simulator build needs Xcode, so `build-sim.sh` is a local proof, not a CI step
(matching the desktop sibling #676). Overall Friday v1 remains **NO-GO**.
