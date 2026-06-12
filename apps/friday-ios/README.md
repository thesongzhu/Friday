# Friday — native iOS app (the v1 mobile UI), wired to the REAL Rust clients

A SwiftUI iOS app implementing the **LOCKED mobile design baseline**
(`friday-design-handoff-20260602/saved/mobile-selection.json`) and the mobile
**real-client + Friday Chat read-WRITE + S6** integration (a redo of #683 onto the
current `FridayMobileShell` shell):

- **Launch = Home** (locked). Home = the **155px pure-dog Hero Pet card** (always
  on, a local zero-token v9 companion) over **Status** reading the refs-only
  Mission Workbench projection on the package's `SealedWSReadClient`. The
  **Friday Chat entry is the top-bar 💬** — there is NO on-Home chat card.
- **The Hero Pet (I4 / mirrors desktop D-PR1 #690)** is the locked 155px animated
  v9 dog: a `WKWebView` (`MobilePetView` `UIViewRepresentable`) loads the bundled
  mobile `pet-host.html` over a custom `friday-pet://` scheme (`MobilePetScheme`,
  `Bundle.module`) and runs the EXISTING `pet-stage-engine.js` VERBATIM against the
  bundled v9 assets, calling the locked design API exactly:
  `createStage(stage, {surface:"mobile", height:155, behavior:"locked-core-only",
  ecoAllowlist:[]})`. Zero token, pure-local CSS-JS-canvas, assets unmodified
  (ONE size, 155px). The pet stage carries no text/status badges — the honest
  status truth lives in the Status card below (the pet is a mood companion, NOT a
  status source of truth).
- The composer lives in a separate **full-screen, pet-centered Friday Chat**
  surface that drives the **4-state read-WRITE / S6 loop**: compose → send →
  refs-only answer; mutating → `AgentRunPaused` → S6 approval card →
  operator-signs (relay-only) → `resumeWithApproval` VERBATIM → refs-only receipt.
- The **Command Sheet** is a full-screen grid launcher opened from the top-left.
- Tokens: cyanCoral palette · warmOffWhite background · glassNative form · light
  theme · the 155px v9 Hero Pet (`petStageBg` `#eef3e8`).

## The integration (the package's types WIN)

The shell depends on the **`FridayRustClient`** SPM package (the sealed-WS read +
write clients + crypto, shared with the desktop). There is **ONE**
`WorkbenchSnapshot` + `FridayRustReadClient` / `FridayRustWriteClient` across desktop
and mobile — the package's. The shell **adapter-bridges** the package's
(non-`Sendable`, refs-only) `WorkbenchSnapshot` to a small `Sendable` `HomeProjection`
for the UI (the same lift #683 used; the desktop #682 console is the D-PR1 mock shell
and does not yet wire the package, so #683's `HomeProjection` pattern — not #682 — is
the integration reference). The `: Sendable` mismatch is resolved on the **consumer**
side with `nonisolated(unsafe) let` clients (the package is never edited).

## Truth rules (binding)

- **Refs only (INV-5)** — every surfaced field is a ref/label/count/fingerprint;
  the answer is `{status, answer_sha256, answer_len, turns}`, never an inline body;
  the pause is `{summary, action_digest}`; the receipt is `{op, accepted, status,
  audit_ref}`. There is no body/content field anywhere.
- **No signing key on the app (INV-1)** — the phone is a PURE COURIER for S6
  approvals: it holds no key and mints no signature. The only source of approval
  bytes is the injected `OperatorSigner`, relayed VERBATIM to `resumeWithApproval`.
  The shipped signer is a clearly-labeled `MockOperatorSigner` (NOT a real
  signature); the real desktop signer (PR #671) is the slice-6 / operator-key gate.
- **Mutation ONLY via approval (INV-2)** — a mutation executes ONLY via the resume
  path, reachable ONLY from `.pendingApproval`, reached ONLY by a server pause.
  `approve()` is a no-op without a pending pause; there is no bypass.
- **Honest-unavailable** — the Rust read/write servers are DARK until the slice-6
  flip, so `fetchWorkbench()` / `dispatchAgentRun()` / `resumeWithApproval()` are
  EXPECTED to throw; every throw renders a first-class `.unavailable` state, never a
  fabricated answer/approval/receipt, never a truth-label upgrade. `runtimeFeedStatus`
  + `statusLabels` ride AS-IS.

## Module layout

- `Sources/FridayMobileShellCore/` — **UI-free** SwiftPM library (depends on
  `FridayRustClient`): the integration factory (`FridayClientFactory`), the
  operator-signing relay seam (`OperatorSigner` / `MockOperatorSigner`), and the
  view models (`HomeViewModel` + `HomeProjection`, `FridayChatViewModel` + the
  4-state `ChatPhase` + the refs-only `ApprovalCard` / receipts). Kept UI-free so the
  truth rules + the S6 loop are unit-testable on a mac host with no Xcode/simulator:

  ```sh
  swift build && swift test    # -> 19 XCTest cases (chat-S6 loop + home read + factory)
  ```

- `Sources/FridayMobileShell/` — the SwiftUI iOS app (Home, the Friday Chat
  read-WRITE/S6 surface, Command Sheet, Hero Pet, design tokens). iOS-only APIs, so
  it is **not** a SwiftPM target — it is compiled against the iOS Simulator SDK by
  `build-sim.sh`.

## Build + screenshot (simulator)

```sh
apps/friday-ios/build-sim.sh   # -> .build-sim/friday-ios-sim.png
```

Because the core now depends on `FridayRustClient` → swift-sodium (libsodium via the
vendored `Clibsodium.xcframework`), the script first cross-compiles the whole SPM
dependency graph for `arm64-apple-ios17.0-simulator` via `swift build --triple …`
(resolving swift-sodium + linking the xcframework's ios-simulator libsodium slice),
then compiles the SwiftUI app against those sim-built modules with `swiftc`, assembles
`FridayShell.app`, and installs/launches/screenshots it on a booted simulator.

**Device/simulator screenshot proof is operator-gated** (it needs Xcode + a booted
simulator or a physical device); it is a deferred acceptance criterion. The
load-bearing local checks are host `swift build` + `swift test` (the truth rules + the
S6 loop) and the swiftc compile/link of the app against the simulator SDK (both proven
locally).

## Not built in CI

The simulator build needs Xcode, so `build-sim.sh` is a local proof, not a CI step.
The live `NWConnection` transport against running Rust servers (with the UI peer
pubkey enrolled + the operator signer provisioned) is the slice-6 deferred AC.
Overall Friday v1 remains **NO-GO**.
