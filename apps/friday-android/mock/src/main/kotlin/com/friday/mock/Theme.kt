// Friday mobile design tokens — minimal Compose port of the operator-locked
// baseline (friday-design-handoff-20260602/saved/mobile-selection.json):
// palette = Cyan + Coral (locked), background = Warm off-white, theme = Light,
// form = Glass Native (translucent rounded panels), pet = Retro LCD.
//
// This is the Android mirror of apps/friday-ios Theme; applied at a MINIMAL
// level (a glass-ish card + the two brand colors + warm bg), not pixel-perfect.
package com.friday.mock

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object Theme {
    val cyan = Color(0xFF1AB0C2)    // action / online / direct (locked)
    val coral = Color(0xFFF2735B)   // urgency / accent / danger (locked)
    val lcd = Color(0xFF8CF2B2)     // retro-LCD phosphor
    val lcdBg = Color(0xFF0F1A17)
    val ink = Color(0xFF1C1E22)
    val sub = Color(0xFF788086)
    val bg = Color(0xFFF7F6F2)      // warm off-white (locked)
    val card = Color(0xCCFFFFFF)    // glass-ish translucent white panel

    // Risk semantics via color (mirrors iOS Theme.risk): success/warning/danger.
    fun risk(kind: String): Color = when (kind) {
        "online", "paired", "success", "synced", "direct" -> cyan
        "syncing", "pairing", "stale", "warning", "pending" -> Color(0xFFE6961E)
        "offline", "failed", "danger", "fallback" -> coral
        else -> sub
    }
}

// Glass Native card surface — translucent rounded panel with a faint cyan hairline.
@Composable
fun GlassCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    androidx.compose.foundation.layout.Column(
        modifier
            .clip(RoundedCornerShape(18.dp))
            .background(Theme.card)
            .border(BorderStroke(1.dp, Theme.cyan.copy(alpha = 0.18f)), RoundedCornerShape(18.dp))
            .padding(18.dp)
    ) { content() }
}

// Status chip: monospaced uppercase pill (locked status-label style).
@Composable
fun Chip(text: String, color: Color) {
    Text(
        text = text.uppercase(),
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}
