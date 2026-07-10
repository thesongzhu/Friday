// Friday — native Android app, operator-selected design baseline (file 17 §3 / 06).
//
// Native Cousin of the iOS baseline (not pixel-perfect): Cyan+Coral palette,
// Glass-ish rounded cards, v9 dog Hero Pet (custom Canvas view), Command-Sheet
// menu (Friday/Platform/Workflows/Activity/Settings), Friday-first launch,
// Friday Home = Hero Pet + Status + Needs-Me, Platform = Cards+Queues, Activity
// urgency-first with the REAL mark-done write, Workflows = Memory Review, Settings
// = token/cost ledger. Every value comes from the all-Rust core via UniFFI.

package com.friday.shell

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
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
import uniffi.friday_ffi.phoneTokenUsage
import uniffi.friday_ffi.protocolSchemaVersion
import uniffi.friday_ffi.sampleActivityInbox
import uniffi.friday_ffi.sampleMemoryReview

private object Palette {
    val cyan = Color.rgb(15, 125, 140)
    val coral = Color.rgb(216, 99, 77)
    val warn = Color.rgb(168, 106, 29)
    val ok = Color.rgb(39, 122, 93)
    val dogStage = Color.rgb(238, 243, 232)
    val dogFur = Color.rgb(246, 213, 166)
    val dogShadow = Color.rgb(139, 82, 46)
    val ink = Color.rgb(28, 30, 34)
    val sub = Color.rgb(120, 128, 134)
    val bg = Color.rgb(247, 248, 247)
    val card = Color.WHITE
    fun risk(s: String) = when (s) {
        "done", "success" -> ok
        "direct" -> cyan
        "running", "pending", "warning" -> warn
        "failed", "fallback", "danger" -> coral
        else -> sub
    }
}

// v9 dog Hero Pet: a small friendly companion; decorative only, never truth state.
private class V9DogPet(ctx: Activity) : View(ctx) {
    private val fur = Paint().apply { color = Palette.dogFur; isAntiAlias = true }
    private val shadow = Paint().apply { color = Palette.dogShadow; isAntiAlias = true }
    private val ink = Paint().apply { color = Palette.ink; isAntiAlias = true }
    private val blush = Paint().apply { color = Color.argb(90, 216, 99, 77); isAntiAlias = true }
    override fun onDraw(c: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val s = minOf(width, height) / 120f
        c.drawOval(cx - 44 * s, cy - 18 * s, cx - 18 * s, cy + 32 * s, fur)
        c.drawOval(cx + 18 * s, cy - 18 * s, cx + 44 * s, cy + 32 * s, fur)
        c.drawOval(cx - 36 * s, cy - 30 * s, cx + 36 * s, cy + 38 * s, fur)
        c.drawOval(cx - 25 * s, cy - 4 * s, cx - 15 * s, cy + 6 * s, ink)
        c.drawOval(cx + 15 * s, cy - 4 * s, cx + 25 * s, cy + 6 * s, ink)
        c.drawOval(cx - 8 * s, cy + 8 * s, cx + 8 * s, cy + 20 * s, shadow)
        c.drawCircle(cx - 26 * s, cy + 16 * s, 6 * s, blush)
        c.drawCircle(cx + 26 * s, cy + 16 * s, 6 * s, blush)
        c.drawOval(cx - 28 * s, cy + 36 * s, cx - 8 * s, cy + 62 * s, fur)
        c.drawOval(cx + 8 * s, cy + 36 * s, cx + 28 * s, cy + 62 * s, fur)
    }
}

enum class Dest(val title: String) {
    FRIDAY("Friday"), PLATFORM("Platform"), WORKFLOWS("Workflows"),
    ACTIVITY("Activity"), SETTINGS("Settings")
}

class MainActivity : Activity() {
    private val dbPath by lazy { java.io.File(filesDir, "friday.db").absolutePath }
    private var dest = Dest.FRIDAY
    private var note = ""
    private lateinit var content: LinearLayout
    private lateinit var titleView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        System.setProperty("jna.library.path", applicationInfo.nativeLibraryDir)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Palette.bg)
            setPadding(0, 96, 0, 0) // clear status bar (edge-to-edge)
        }
        root.addView(topBar())
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(36, 12, 36, 48) }
        root.addView(ScrollView(this).apply { addView(content) })
        setContentView(root)
        render()
    }

    private fun topBar(): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(28, 8, 28, 16)
        addView(Button(this@MainActivity).apply {
            text = "⌘"; textSize = 20f; setTextColor(Palette.cyan)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { showCommandSheet() }
        })
        titleView = TextView(this@MainActivity).apply {
            text = dest.title; textSize = 20f; setTextColor(Palette.ink)
            setPadding(8, 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        addView(titleView)
        // Small Mark (app identity).
        addView(View(this@MainActivity).apply {
            background = dot(Palette.coral); layoutParams = LinearLayout.LayoutParams(30, 30)
        })
    }

    private fun showCommandSheet() {
        val items = Dest.entries.map { it.title }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Friday — command")
            .setItems(items) { _, i ->
                dest = Dest.entries[i]; note = ""; titleView.text = dest.title; render()
            }
            .show()
    }

    // --- rendering -------------------------------------------------------

    private fun render() {
        content.removeAllViews()
        when (dest) {
            Dest.FRIDAY -> fridayHome()
            Dest.PLATFORM -> platform()
            Dest.WORKFLOWS -> memoryReview()
            Dest.ACTIVITY -> activity()
            Dest.SETTINGS -> settings()
        }
        content.addView(footer("rendered from Rust ✓ · v1 NO-GO (greenfield)"))
    }

    private fun fridayHome() {
        val st = initialConnectionState()
        val online = connectionIsOnline(st)
        // Hero Pet
        content.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            addView(V9DogPet(this@MainActivity).apply {
                background = rounded(Palette.dogStage, Color.argb(45, 15, 125, 140), 14)
                layoutParams = LinearLayout.LayoutParams(360, 260).apply { topMargin = 8 }
                setPadding(16, 16, 16, 16)
            })
            addView(label(if (online) "Friday is here" else "Friday is offline", 13f, Palette.sub).apply { gravity = Gravity.CENTER })
        })
        content.addView(card {
            it.addView(rowHeader("Status", st.name.lowercase(), if (online) Palette.cyan else Palette.coral))
            it.addView(label(if (online) "online" else "offline / stale", 16f, if (online) Palette.cyan else Palette.coral))
            it.addView(label("protocol v${protocolSchemaVersion()}", 15f, Palette.sub))
            it.addView(label("negotiated " + (negotiateSchemaVersion(1.toUShort(), 3.toUShort(), 2.toUShort(), 5.toUShort())?.toString() ?: "—"), 15f, Palette.sub))
        })
        content.addView(card {
            it.addView(label("Chat", 17f, Palette.ink))
            it.addView(label("Ask Friday…", 15f, Palette.sub))
            it.addView(label("connect a Hub to chat (sync operator/env-gated)", 12f, Palette.sub))
        })
        content.addView(card {
            it.addView(rowHeader("Needs Me", "${sampleActivityInbox().size}", Palette.coral))
            it.addView(label("urgency-first · sample", 12f, Palette.sub))
            for (n in sampleActivityInbox().take(3)) it.addView(label("p${n.priority} [${n.source}] ${n.reason}", 14f, Palette.ink))
        })
    }

    private fun platform() {
        content.addView(sectionTitle("Providers", "cards open the provider workspace"))
        for ((id, name) in listOf("codex" to "Codex", "claude" to "Claude", "deepseek" to "DeepSeek")) {
            content.addView(card {
                val r = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                r.addView(View(this).apply { background = dot(providerColor(id)); layoutParams = LinearLayout.LayoutParams(28, 28).apply { rightMargin = 18 } })
                r.addView(label(name + (if (id == "deepseek") "  · live route" else "  · session-control"), 16f, Palette.ink))
                it.addView(r)
            })
        }
        content.addView(sectionTitle("Queues", "Needs-Me · urgency-first"))
        for (n in sampleActivityInbox()) content.addView(card { it.addView(label("p${n.priority} [${n.source}] ${n.reason}\n   → ${n.destination}", 14f, Palette.ink)) })
    }

    private fun activity() {
        content.addView(sectionTitle("Activity", "live · phone SQLite · tap a row to mark done"))
        val r = phoneActivityDemo(dbPath)
        if (!r.ok) { content.addView(label("error: ${r.error}", 14f, Palette.coral)); return }
        var items = r.items
        if (note.isEmpty()) {
            r.items.firstOrNull { it.state == "pending" }?.let { p ->
                val after = markActivityDone(dbPath, p.activityId, 100L)
                if (after.ok) { items = after.items; note = "✓ marked “${p.summary}” done (persisted)" }
            }
        }
        if (note.isNotEmpty()) content.addView(label(note, 13f, Palette.cyan))
        for (a in items) {
            content.addView(card {
                val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                row.addView(chip(a.state, Palette.risk(a.state)))
                row.addView(label("  ${a.summary}  (${a.kind})", 14f, Palette.ink))
                it.addView(row)
            }.also { cv ->
                if (a.state != "done") cv.setOnClickListener {
                    val after = markActivityDone(dbPath, a.activityId, 200L)
                    if (after.ok) { note = "✓ marked “${a.summary}” done (persisted)"; render() }
                }
            })
        }
    }

    private fun memoryReview() {
        content.addView(sectionTitle("Memory Review", "recommendation-first · confirm/reject · never auto-saved"))
        for (m in sampleMemoryReview()) content.addView(card {
            it.addView(label("[${m.scope}] ${m.preview}", 15f, Palette.ink))
            it.addView(label("${m.confidence} · ${m.state.name.lowercase()}    [Confirm] [Reject]", 12f, Palette.sub))
        })
    }

    private fun settings() {
        content.addView(sectionTitle("Token / cost ledger", "live · phone ledger · fallback always shown (02 §13)"))
        val t = phoneTokenUsage(dbPath)
        if (!t.ok) { content.addView(label("error: ${t.error}", 14f, Palette.coral)); return }
        val total = t.items.sumOf { it.totalTokens }
        val cost = t.items.mapNotNull { it.costEstimate }.sum()
        content.addView(card { it.addView(label("$total total tokens", 22f, Palette.cyan)); it.addView(label("$%.4f est. cost".format(cost), 15f, Palette.sub)) })
        for (u in t.items) content.addView(card {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            row.addView(label("${u.provider}/${u.model}\n   ${u.totalTokens} tok · ${u.costEstimate?.let { "$%.4f".format(it) } ?: "—"}", 14f, Palette.ink).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })
            row.addView(chip(if (u.fallback) "fallback" else "direct", if (u.fallback) Palette.coral else Palette.cyan))
            it.addView(row)
        })
    }

    // --- view helpers ----------------------------------------------------

    private fun card(build: (LinearLayout) -> Unit): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(Palette.card, Color.argb(40, 26, 176, 194), 18)
        setPadding(28, 24, 28, 24)
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = 16 }
        build(this)
    }
    private fun rowHeader(title: String, chipText: String, c: Int): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        addView(label(title, 17f, Palette.ink).apply { layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) })
        addView(chip(chipText, c))
    }
    private fun sectionTitle(t: String, s: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(4, 20, 4, 4)
        addView(label(t, 20f, Palette.ink)); addView(label(s, 12f, Palette.sub))
    }
    private fun label(t: String, size: Float, c: Int) = TextView(this).apply { text = t; textSize = size; setTextColor(c); setPadding(0, 3, 0, 3) }
    private fun footer(t: String) = TextView(this).apply { text = t; textSize = 12f; setTextColor(Palette.sub); setPadding(4, 24, 4, 4) }
    private fun chip(t: String, c: Int) = TextView(this).apply {
        text = t.uppercase(); textSize = 11f; setTextColor(c); setPadding(16, 6, 16, 6)
        background = rounded(Color.argb(28, Color.red(c), Color.green(c), Color.blue(c)), Color.TRANSPARENT, 20)
    }
    private fun dot(c: Int) = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c) }
    private fun rounded(fill: Int, stroke: Int, radius: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE; setColor(fill); cornerRadius = radius.toFloat()
        if (stroke != Color.TRANSPARENT) setStroke(2, stroke)
    }
}

private fun providerColor(s: String) = when (s) {
    "claude" -> Palette.coral; "codex" -> Palette.cyan; "workflow" -> Color.rgb(150, 90, 200)
    "memory" -> Color.rgb(40, 160, 150); else -> Palette.sub
}
