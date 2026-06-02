// Friday — native Android shell (emulator proof).
//
// A minimal Activity whose screen is computed by the ALL-RUST core through the
// generated UniFFI Kotlin bindings (uniffi.friday_ffi): connection/protocol
// state, the sample Needs-Me + Memory-Review surfaces, and a LIVE activity list
// read from the phone's own SQLite store — plus a real WRITE path ("mark done")
// that persists to that store. No model call, no provider secret on the phone.

package com.friday.shell

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import uniffi.friday_ffi.connectionIsOnline
import uniffi.friday_ffi.connectionIsStaleOrOffline
import uniffi.friday_ffi.initialConnectionState
import uniffi.friday_ffi.markActivityDone
import uniffi.friday_ffi.negotiateSchemaVersion
import uniffi.friday_ffi.phoneActivityDemo
import uniffi.friday_ffi.protocolSchemaVersion
import uniffi.friday_ffi.sampleActivityInbox
import uniffi.friday_ffi.sampleMemoryReview

class MainActivity : Activity() {
    private val dbPath by lazy { java.io.File(filesDir, "friday.db").absolutePath }
    private var note: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // JNA (5.18.1@aar) loads jnidispatch on Android via System.loadLibrary from
        // the bundled jniLib; point JNA's library search at the native-lib dir.
        System.setProperty("jna.library.path", applicationInfo.nativeLibraryDir)

        val tv = TextView(this).apply { textSize = 15f }

        // Real WRITE path control: mark the oldest pending activity done, persist,
        // and refresh from the store.
        val markBtn = Button(this).apply {
            text = "Mark oldest pending → done"
            setOnClickListener {
                markOldestPendingDone()
                tv.text = render()
            }
        }

        // On launch, perform ONE real persisted write so the screen shows a live
        // state change through SQLite (the same write path the button uses).
        markOldestPendingDone()
        tv.text = render()

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // API 36 edge-to-edge: pad the top to clear the status/action bars.
            setPadding(56, 300, 56, 56)
            addView(markBtn)
            addView(tv)
        }
        setContentView(ScrollView(this).apply { addView(column) })
    }

    /** Find the oldest still-pending activity and mark it done (a real SQLite write). */
    private fun markOldestPendingDone() {
        val cur = phoneActivityDemo(dbPath)
        if (!cur.ok) return
        val pending = cur.items.firstOrNull { it.state == "pending" } ?: return
        val after = markActivityDone(dbPath, pending.activityId, 200L)
        if (after.ok) note = "✓ marked “${pending.summary}” done (persisted)"
    }

    /** Build the screen text, reading the LIVE activity list fresh from the store. */
    private fun render(): String {
        val state = initialConnectionState()
        val online = connectionIsOnline(state)
        val stale = connectionIsStaleOrOffline(state)
        val schemaVersion = protocolSchemaVersion()
        val negotiated = negotiateSchemaVersion(1.toUShort(), 3.toUShort(), 2.toUShort(), 5.toUShort())
        val inbox = sampleActivityInbox()
        val memReview = sampleMemoryReview()
        val phoneActivity = phoneActivityDemo(dbPath)

        return buildString {
            appendLine("connection:   ${state.name.lowercase()}")
            appendLine("online?       ${if (online) "yes" else "no"}")
            appendLine("stale/offline? ${if (stale) "yes" else "no"}")
            appendLine("schema ver:   $schemaVersion")
            appendLine("negotiated:   ${negotiated?.toString() ?: "incompatible"}")
            appendLine()
            appendLine("Needs Me (${inbox.size}, sample):")
            for (item in inbox) {
                appendLine("  p${item.priority} [${item.source}] ${item.reason}")
            }
            appendLine()
            appendLine("Memory Review (${memReview.size}, sample):")
            appendLine("  awaiting confirm/reject — never auto-saved")
            for (m in memReview) {
                appendLine("  [${m.scope}] ${m.preview} (${m.confidence} · ${m.state.name.lowercase()})")
            }
            appendLine()
            if (phoneActivity.ok) {
                appendLine("Activity (${phoneActivity.items.size}, live · phone SQLite):")
                for (a in phoneActivity.items) {
                    appendLine("  [${a.state}] ${a.summary} (${a.kind})")
                }
                if (note.isNotEmpty()) appendLine("  $note")
            } else {
                appendLine("Activity (live store error): ${phoneActivity.error}")
            }
            appendLine()
            append("rendered from Rust ✓")
        }
    }
}
