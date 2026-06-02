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
import uniffi.friday_ffi.phoneActivityDemo
import uniffi.friday_ffi.protocolSchemaVersion
import uniffi.friday_ffi.sampleActivityInbox
import uniffi.friday_ffi.sampleMemoryReview

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // JNA (5.18.1@aar) loads its jnidispatch on Android via System.loadLibrary
        // from the bundled jniLib. Our Rust lib (libfriday_ffi.so) is also a jniLib,
        // extracted on disk via useLegacyPackaging; point JNA's library search at
        // that dir so it is found.
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
        // Urgency-first Needs-Me inbox, built + sorted by Rust (08 §1/§2).
        val inbox = sampleActivityInbox()
        // Memory candidates awaiting the user's review (07 §6/§7).
        val memReview = sampleMemoryReview()
        // LIVE data: read back from the phone's own SQLite store (not a fixture).
        val phoneActivity = phoneActivityDemo(java.io.File(filesDir, "friday.db").absolutePath)

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
            appendLine("Needs Me (${inbox.size}, sample):")
            for (item in inbox) {
                appendLine("  p${item.priority} [${item.source}] ${item.reason}")
                appendLine("      → ${item.destination}")
            }
            appendLine()
            appendLine("Memory Review (${memReview.size}, sample):")
            appendLine("  awaiting confirm/reject — never auto-saved")
            for (m in memReview) {
                // Show confidence AND lifecycle state (parity with iOS); state is
                // the field the no-silent-write story turns on (07 §6/§7).
                appendLine("  [${m.scope}] ${m.preview}")
                appendLine("      ${m.confidence} · ${m.state.name.lowercase()}")
            }
            appendLine()
            if (phoneActivity.ok) {
                appendLine("Activity (${phoneActivity.items.size}, live · phone SQLite):")
                for (a in phoneActivity.items) {
                    appendLine("  [${a.state}] ${a.summary} (${a.kind})")
                }
            } else {
                appendLine("Activity (live store error): ${phoneActivity.error}")
            }
            appendLine()
            append("rendered from Rust ✓")
        }

        val tv = TextView(this).apply {
            text = body
            textSize = 15f
            // API 36 enforces edge-to-edge, so the content view draws behind the
            // status + action bars; pad the top enough to clear them so every
            // value is visible (this is a minimal proof shell, not production UI).
            setPadding(56, 320, 56, 56)
        }
        setContentView(tv)
    }
}
