# Friday — native Android shell (Unit 5c, emulator)

A minimal Activity that renders values computed by the **all-Rust core**
(`friday-ffi`) through the generated **UniFFI Kotlin** bindings — the Android
mirror of `apps/friday-ios`. It proves the Kotlin ↔ Rust bridge runs on the
Android emulator: connection-state projection + protocol schema
version/negotiation, all from Rust.

**Emulator-level** proof only. Physical-device proof and Play Store release
remain operator-gated. Overall Friday v1 is **NO-GO**.

## Build + screenshot (emulator)

```sh
apps/friday-android/build-emu.sh   # -> .build/friday-android-emu.png
```

The script: cross-compiles `libfriday_ffi.so` for `aarch64-linux-android` via the
NDK clang, generates the Kotlin bindings, stages them + the `.so`, assembles the
debug APK (Gradle + AGP), then `adb install` / `am start` / `screencap` on the
running emulator.

## Toolchain notes (important)
- **Rust cross-compile** uses the rustup **stable** toolchain (it has the Android
  std), with the NDK clang as the C compiler/linker for the bundled SQLite. brew
  rust 1.95.0 lacks the std and shadows it, so the script puts the stable
  toolchain bin first on `PATH` (same fix as iOS, goal file 33).
- **AGP 9** has built-in Kotlin — no separate Kotlin Gradle plugin is applied.
- **JNA on Android**: use `net.java.dev.jna:jna:5.18.1@aar`. Older 5.14 tried to
  load `libjnidispatch.so` from a classpath *resource* (`com/sun/jna/
  android-aarch64/...`), which AGP won't package (`.so` are jniLibs), throwing
  `UnsatisfiedLinkError ... not found in resource path`. 5.16+ loads it on Android
  via `System.loadLibrary` from the bundled jniLib. The app sets
  `jna.library.path` to the native-lib dir (+ `useLegacyPackaging=true`) so
  `libfriday_ffi.so` is found on disk.

## Trust boundary
`friday-ffi` excludes the Hub-only, provider-secret-bearing crates
(`friday-deepseek`, `friday-providers`) on the Android targets too, so "no
provider secret on the phone" is a compile-time property (`friday-arch-tests`).

## Not built in CI
The emulator build needs the Android SDK/NDK + a running emulator, so
`build-emu.sh` is a local proof, not a CI step. CI builds/tests the Rust
workspace (host) as usual.
