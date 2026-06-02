// Friday — Unit 5c native Android shell (emulator proof).
//
// A minimal Activity whose entire screen is computed by the ALL-RUST core through
// the generated UniFFI Kotlin bindings (uniffi.friday_ffi). It mirrors the iOS
// shell: connection-state projection + protocol schema version/negotiation,
// proving the Kotlin <-> Rust bridge runs on the Android emulator. No model call,
// no provider secret on the phone (friday-ffi excludes the Hub-only crates).

package com.friday.shell

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import uniffi.friday_ffi.connectionIsOnline
import uniffi.friday_ffi.connectionIsStaleOrOffline
import uniffi.friday_ffi.initialConnectionState
import uniffi.friday_ffi.negotiateSchemaVersion
import uniffi.friday_ffi.protocolSchemaVersion

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // JNA on Android loads its own jnidispatch from a CLASSPATH RESOURCE
        // (com/sun/jna/android-aarch64/libjnidispatch.so — staged by build-emu.sh).
        // Our Rust lib (libfriday_ffi.so) is a jniLib, extracted on disk via
        // useLegacyPackaging; point JNA's library search at that dir to find it.
        System.setProperty("jna.library.path", applicationInfo.nativeLibraryDir)

        // Every value below comes from the Rust core via UniFFI — not hardcoded.
        val state = initialConnectionState()
        val online = connectionIsOnline(state)
        val stale = connectionIsStaleOrOffline(state)
        val schemaVersion = protocolSchemaVersion()
        // 1..3 vs 2..5 -> highest common = 3 (never silently downgrades).
        val negotiated = negotiateSchemaVersion(
            1.toUShort(), 3.toUShort(), 2.toUShort(), 5.toUShort()
        )

        // (The app identity "FridayShell" is shown in the action bar; the body is
        // exactly the values the all-Rust core computes, so the rendered screen
        // matches this source line-for-line.)
        val body = buildString {
            appendLine("connection:   ${state.name.lowercase()}")
            appendLine("online?       ${if (online) "yes" else "no"}")
            appendLine("stale/offline? ${if (stale) "yes" else "no"}")
            appendLine("schema ver:   $schemaVersion")
            appendLine("negotiated:   ${negotiated?.toString() ?: "incompatible"}")
            appendLine()
            append("rendered from Rust ✓")
        }

        val tv = TextView(this).apply {
            text = body
            textSize = 20f
            // API 36 enforces edge-to-edge, so the content view draws behind the
            // status + action bars; pad the top enough to clear them so every
            // value is visible (this is a minimal proof shell, not production UI).
            setPadding(56, 320, 56, 56)
        }
        setContentView(tv)
    }
}
