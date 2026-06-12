# Friday — Android MOCK shell (`:mock`)

A minimal **Jetpack Compose** app whose only job for v1 is to prove the
**device-pairing + Hub↔phone sync FLOW** runs on the Android **emulator**. It
mirrors the design intent of `apps/friday-ios` (PR #679) at a minimal level:
Cyan + Coral palette, warm off-white background, glass cards, light theme, a
small retro-LCD pet, Home = Status + a chat-entry affordance.

## This is a MOCK — read this before trusting anything it shows

- **Pairing (QR / passkey) is MOCKED.** `PairingState.kt` is a deterministic
  in-memory state machine (`UNPAIRED → SCANNING → PASSKEY → PAIRING → PAIRED`).
  There is **no camera**, **no WebAuthn/passkey**, and the "QR" is a decorative
  pixel grid, not a scannable code.
- **Hub↔phone sync is MOCKED.** The sync indicator (`OFFLINE/STALE/SYNCING/SYNCED`)
  is driven by scripted delays, not a transport.
- **No real Hub connectivity.** There is **no sealed-WS client**. The real
  Kotlin sealed-WS Hub client is a **DEFERRED** acceptance criterion (post-v1;
  v1 ships **iOS** as the real client).
- **refs-only · read-only.** The shell renders state and shows references; it
  performs **no mutating action** against any Hub. (Contrast the sibling `:app`,
  which has a real `markActivityDone` write over UniFFI.)

## Relationship to the existing `:app` module (coexistence, nothing destroyed)

`apps/friday-android` already contains `:app` — the **real-UniFFI Unit-5c**
shell that renders values from the all-Rust core via generated Kotlin bindings
and is built/screenshotted by `build-emu.sh` (NDK cross-compile). That module is
**left fully intact**. This `:mock` module is added **alongside** it as a
separate, self-contained Gradle module so the two never interfere:

| | `:app` (Unit-5c) | `:mock` (this) |
|---|---|---|
| UI | Android Views | Jetpack Compose |
| Data | real Rust core via UniFFI | in-memory MOCK |
| Build | `build-emu.sh` (NDK cross-compile) | `gradle :mock:assembleDebug` (Maven only) |
| Purpose | Kotlin↔Rust bridge proof | pairing + sync FLOW proof |

## Build

```sh
cd apps/friday-android
gradle :mock:assembleDebug    # -> mock/build/outputs/apk/debug/mock-debug.apk
```

No Rust, no NDK, no UniFFI — dependencies come from Google Maven + Maven Central.
Verified green with **AGP 9.2.1 / Gradle 9.5.1 / Kotlin compose plugin 2.2.0 /
Compose BOM 2024.09.03 / compileSdk 36**.

## Emulator run + screenshot

Emulator screenshot capture is a **follow-up** (the coordinator runs the
emulator). To install + launch on a running emulator:

```sh
adb install -r mock/build/outputs/apk/debug/mock-debug.apk
adb shell am start -n com.friday.mock/.MainActivity
```

## Honest status

Emulator-level FLOW proof of the pairing + sync **shape** only. Overall Friday
v1 is **NO-GO**. Real pairing ceremony, real sync transport, and the Kotlin
sealed-WS Hub client are all post-v1.
