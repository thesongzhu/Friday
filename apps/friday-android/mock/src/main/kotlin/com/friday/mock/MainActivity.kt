// Friday — Android MOCK shell (Compose), v1 device-proof surface.
//
// Goal: prove the device-pairing + Hub<->phone sync FLOW runs on the Android
// emulator. It mirrors the design intent of apps/friday-ios at a MINIMAL level:
// Cyan+Coral palette, warm off-white bg, glass cards, light theme, a small
// v9 dog pet, Home = Status + a chat-entry affordance.
//
// HONEST SCOPE (do not mistake this for the real app):
//  - Pairing (QR/passkey) and Hub<->phone sync are MOCKED — a deterministic
//    in-memory state machine (PairingViewModel), not a real ceremony / WS.
//  - refs-only + read-only: the phone renders state and shows references; it
//    performs NO mutating action against any Hub (unlike the sibling :app,
//    which has a real markActivityDone write over UniFFI).
//  - The real Kotlin sealed-WS Hub client is DEFERRED (post-v1; iOS is the v1
//    real client). See README + PR body.
package com.friday.mock

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { RootScreen() }
    }
}

private enum class Tab(val title: String) {
    HOME("Friday"), PAIR("Pair"), SYNC("Sync")
}

@Composable
fun RootScreen(vm: PairingViewModel = viewModel()) {
    var tab by remember { mutableStateOf(Tab.HOME) }
    Column(
        Modifier
            .fillMaxSize()
            .background(Theme.bg)
            .padding(top = 36.dp),
    ) {
        TopBar(tab) { tab = it }
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 18.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            when (tab) {
                Tab.HOME -> HomeScreen(vm) { tab = Tab.PAIR }
                Tab.PAIR -> PairScreen(vm)
                Tab.SYNC -> SyncScreen(vm)
            }
            Footer()
        }
    }
}

// Top bar: brand mark + the three minimal destinations (command-sheet direction).
@Composable
private fun TopBar(tab: Tab, onSelect: (Tab) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(12.dp).clip(CircleShape).background(Theme.coral)) // Small Mark
        Spacer(Modifier.width(10.dp))
        Text("Friday", color = Theme.ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Text("  mock", color = Theme.cyan, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        Spacer(Modifier.weight(1f))
        Tab.entries.forEach { t ->
            val sel = t == tab
            Text(
                t.title,
                color = if (sel) Theme.cyan else Theme.sub,
                fontSize = 14.sp,
                fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal,
                modifier = Modifier
                    .padding(start = 12.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (sel) Theme.cyan.copy(alpha = 0.12f) else Color.Transparent)
                    .padding(horizontal = 8.dp, vertical = 4.dp)
                    .clickableNoRipple { onSelect(t) },
            )
        }
    }
}

// --- Home: Status + a chat-entry affordance (minimal) --------------------------

@Composable
private fun HomeScreen(vm: PairingViewModel, onPair: () -> Unit) {
    val online = vm.online

    HeroPet(online)

    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Status", color = Theme.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            Chip(connectionLabel(vm), Theme.risk(connectionLabel(vm)))
        }
        Spacer(Modifier.height(8.dp))
        StatusRow(if (online) "online · paired" else pairHint(vm), Theme.risk(connectionLabel(vm)))
        StatusRow("hub: ${vm.mockHubName}", Theme.sub)
        StatusRow("sync: ${syncLabel(vm.sync)}", Theme.risk(syncLabel(vm.sync)))
    }

    // Chat-entry affordance (honest: real chat needs a connected Hub).
    GlassCard {
        Text("Chat", color = Theme.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0x14808080))
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Ask Friday…", color = Theme.sub, fontSize = 15.sp)
            Spacer(Modifier.weight(1f))
            Box(Modifier.size(22.dp).clip(CircleShape).background(Theme.cyan.copy(alpha = 0.4f)))
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "connect a Hub to chat — pairing + Hub↔phone sync are MOCKED in this shell",
            color = Theme.sub, fontSize = 12.sp,
        )
    }

    GlassCard {
        Text("Device", color = Theme.ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text(
            if (online) "Paired to the mock Hub. Open Sync to re-run the (mock) sync."
            else "Not paired. Pair this phone to a Hub to demonstrate the flow.",
            color = Theme.sub, fontSize = 13.sp,
        )
        Spacer(Modifier.height(10.dp))
        Button(
            onClick = onPair,
            colors = ButtonDefaults.buttonColors(containerColor = Theme.cyan),
        ) { Text(if (online) "View pairing" else "Pair a device") }
    }
}

// --- Pairing ceremony (QR / passkey), MOCKED ----------------------------------

@Composable
private fun PairScreen(vm: PairingViewModel) {
    SectionTitle("Device pairing", "QR + passkey ceremony — MOCKED (no camera, no WebAuthn)")

    // Step indicator.
    GlassCard {
        StepDots(vm.step)
        Spacer(Modifier.height(12.dp))
        when (vm.step) {
            PairStep.UNPAIRED -> {
                Text("Pair this phone to a Hub", color = Theme.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(6.dp))
                Text("On the Hub, open Settings → Devices → Add phone to show a QR. (Mock: tap below.)",
                    color = Theme.sub, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { vm.beginScan() }, colors = ButtonDefaults.buttonColors(containerColor = Theme.cyan)) {
                    Text("Scan QR")
                }
            }
            PairStep.SCANNING -> {
                Text("Scan the Hub QR", color = Theme.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(10.dp))
                QrPlaceholder()
                Spacer(Modifier.height(10.dp))
                Text("MOCK camera frame — no real scanning. Tap to simulate a detected QR.",
                    color = Theme.sub, fontSize = 12.sp)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { vm.qrDetected() }, colors = ButtonDefaults.buttonColors(containerColor = Theme.cyan)) {
                    Text("Simulate QR detected")
                }
            }
            PairStep.PASSKEY -> {
                Text("Confirm passkey", color = Theme.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                Text("Pairing code from the Hub:", color = Theme.sub, fontSize = 13.sp)
                Spacer(Modifier.height(6.dp))
                Text(vm.mockPairingCode, color = Theme.cyan, fontSize = 26.sp,
                    fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text("MOCK passkey prompt — a real build uses WebAuthn/platform passkey. " +
                    "Confirm that this code matches the Hub.", color = Theme.sub, fontSize = 12.sp)
                Spacer(Modifier.height(12.dp))
                Button(onClick = { vm.confirmPasskey() }, colors = ButtonDefaults.buttonColors(containerColor = Theme.cyan)) {
                    Text("Confirm passkey & pair")
                }
            }
            PairStep.PAIRING -> {
                Text("Pairing…", color = Theme.ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                Text("MOCK handshake (no sealed-WS). Establishing the (mock) session…",
                    color = Theme.sub, fontSize = 13.sp)
            }
            PairStep.PAIRED -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(14.dp).clip(CircleShape).background(Theme.cyan))
                    Spacer(Modifier.width(10.dp))
                    Text("Paired", color = Theme.cyan, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(8.dp))
                Text("Paired to ${vm.mockHubName} (mock). The phone holds a device ref only — " +
                    "no provider secret on the phone.", color = Theme.sub, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { vm.unpair() }) { Text("Unpair", color = Theme.coral) }
            }
        }
    }

    GlassCard {
        Text("Trust boundary", color = Theme.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text("refs-only · read-only · no mutating action from this shell. The real " +
            "Kotlin sealed-WS Hub client is DEFERRED (post-v1; iOS is the v1 real client).",
            color = Theme.sub, fontSize = 12.sp)
    }
}

// --- Sync indicator (Hub<->phone), MOCKED -------------------------------------

@Composable
private fun SyncScreen(vm: PairingViewModel) {
    SectionTitle("Hub ↔ phone sync", "sync indicator — MOCKED (no real transport)")

    GlassCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(14.dp).clip(CircleShape).background(Theme.risk(syncLabel(vm.sync))))
            Spacer(Modifier.width(10.dp))
            Text(syncLabel(vm.sync).replaceFirstChar { it.uppercase() },
                color = Theme.risk(syncLabel(vm.sync)), fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            Chip(syncLabel(vm.sync), Theme.risk(syncLabel(vm.sync)))
        }
        Spacer(Modifier.height(10.dp))
        StatusRow("last sync: ${vm.lastSync ?: "—"}", Theme.sub)
        StatusRow(
            when (vm.sync) {
                SyncState.SYNCED -> "Phone state is up to date with the Hub (mock)."
                SyncState.SYNCING -> "Pulling the latest Hub state (mock)…"
                SyncState.STALE -> "Phone state is stale — reconnect to refresh."
                SyncState.OFFLINE -> "Offline — pair a device first."
            },
            Theme.sub,
        )
    }

    GlassCard {
        Text("Sync actions", color = Theme.ink, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(8.dp))
        if (vm.step != PairStep.PAIRED) {
            Text("Pair a device (Pair tab) to enable the (mock) sync.", color = Theme.sub, fontSize = 13.sp)
        } else {
            Text("Re-run a mock sync to see the indicator cycle syncing → synced.",
                color = Theme.sub, fontSize = 13.sp)
            Spacer(Modifier.height(10.dp))
            Button(
                onClick = { vm.resync() },
                enabled = vm.sync != SyncState.SYNCING,
                colors = ButtonDefaults.buttonColors(containerColor = Theme.cyan),
            ) { Text(if (vm.sync == SyncState.SYNCING) "Syncing…" else "Sync now") }
        }
    }
}

// --- shared bits --------------------------------------------------------------

private fun connectionLabel(vm: PairingViewModel): String = when {
    vm.online -> "online"
    vm.step == PairStep.PAIRED -> syncLabel(vm.sync)
    vm.step == PairStep.UNPAIRED -> "offline"
    else -> "pairing"
}

private fun pairHint(vm: PairingViewModel): String = when (vm.step) {
    PairStep.UNPAIRED -> "offline · not paired"
    PairStep.PAIRED -> "paired · ${syncLabel(vm.sync)}"
    else -> "pairing in progress"
}

private fun syncLabel(s: SyncState): String = when (s) {
    SyncState.OFFLINE -> "offline"
    SyncState.STALE -> "stale"
    SyncState.SYNCING -> "syncing"
    SyncState.SYNCED -> "synced"
}

@Composable
private fun StatusRow(text: String, color: Color) {
    Text(text, color = color, fontSize = 14.sp, modifier = Modifier.padding(vertical = 3.dp))
}

@Composable
private fun SectionTitle(title: String, sub: String) {
    Column(Modifier.padding(top = 8.dp, bottom = 2.dp)) {
        Text(title, color = Theme.ink, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(sub, color = Theme.sub, fontSize = 12.sp)
    }
}

@Composable
private fun Footer() {
    Text(
        "MOCK device-proof shell · pairing + sync stubbed · refs-only · v1 NO-GO (greenfield)",
        color = Theme.sub, fontSize = 11.sp, modifier = Modifier.padding(top = 18.dp),
    )
}

// Step dots for the pairing ceremony (1=scan, 2=passkey, 3=paired).
@Composable
private fun StepDots(step: PairStep) {
    val active = when (step) {
        PairStep.UNPAIRED -> 0
        PairStep.SCANNING -> 1
        PairStep.PASSKEY -> 2
        PairStep.PAIRING, PairStep.PAIRED -> 3
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        listOf("Scan", "Passkey", "Paired").forEachIndexed { i, label ->
            val done = active >= i + 1
            Box(Modifier.size(12.dp).clip(CircleShape).background(if (done) Theme.cyan else Theme.sub.copy(alpha = 0.3f)))
            Spacer(Modifier.width(6.dp))
            Text(label, color = if (done) Theme.cyan else Theme.sub, fontSize = 12.sp)
            if (i < 2) { Spacer(Modifier.width(8.dp)); Text("›", color = Theme.sub, fontSize = 14.sp); Spacer(Modifier.width(8.dp)) }
        }
    }
}

// A MOCK QR frame — decorative pixel grid, NOT a real/scannable QR code.
@Composable
private fun QrPlaceholder() {
    Box(
        Modifier
            .size(160.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color.White)
            .border(1.dp, Theme.cyan.copy(alpha = 0.25f), RoundedCornerShape(12.dp))
            .padding(12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) { drawMockQr() }
    }
}

private fun DrawScope.drawMockQr() {
    val n = 11
    val cell = size.minDimension / n
    // Deterministic checker-ish pattern + finder squares (purely decorative).
    for (r in 0 until n) for (c in 0 until n) {
        val finder = (r < 3 && c < 3) || (r < 3 && c >= n - 3) || (r >= n - 3 && c < 3)
        val on = finder || ((r * 7 + c * 3) % 5 == 0)
        if (on) drawRectAt(r, c, cell)
    }
}

private fun DrawScope.drawRectAt(r: Int, c: Int, cell: Float) {
    drawRect(
        color = Color(0xFF1C1E22),
        topLeft = Offset(c * cell, r * cell),
        size = Size(cell * 0.9f, cell * 0.9f),
    )
}

// v9 dog Hero Pet — decorative companion, not a status source of truth.
@Composable
private fun HeroPet(online: Boolean) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .padding(top = 6.dp)
                .size(width = 150.dp, height = 110.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(Theme.dogStage)
                .border(1.dp, Theme.cyan.copy(alpha = 0.18f), RoundedCornerShape(14.dp))
                .padding(12.dp),
        ) {
            Canvas(Modifier.fillMaxSize()) { drawV9Dog() }
        }
        Spacer(Modifier.height(6.dp))
        Text(if (online) "Friday is here" else "Friday is offline", color = Theme.sub, fontSize = 12.sp)
    }
}

private fun DrawScope.drawV9Dog() {
    val cx = size.width / 2f
    val cy = size.height / 2f
    val s = size.minDimension / 100f
    drawOval(color = Theme.dogFur, topLeft = Offset(cx - 38 * s, cy - 16 * s), size = Size(24 * s, 42 * s))
    drawOval(color = Theme.dogFur, topLeft = Offset(cx + 14 * s, cy - 16 * s), size = Size(24 * s, 42 * s))
    drawOval(color = Theme.dogFur, topLeft = Offset(cx - 32 * s, cy - 28 * s), size = Size(64 * s, 58 * s))
    drawCircle(color = Theme.ink, radius = 4 * s, center = Offset(cx - 16 * s, cy - 5 * s))
    drawCircle(color = Theme.ink, radius = 4 * s, center = Offset(cx + 16 * s, cy - 5 * s))
    drawOval(color = Theme.dogShadow, topLeft = Offset(cx - 7 * s, cy + 6 * s), size = Size(14 * s, 10 * s))
    drawCircle(color = Theme.coral.copy(alpha = 0.30f), radius = 5 * s, center = Offset(cx - 24 * s, cy + 12 * s))
    drawCircle(color = Theme.coral.copy(alpha = 0.30f), radius = 5 * s, center = Offset(cx + 24 * s, cy + 12 * s))
    drawOval(color = Theme.dogFur, topLeft = Offset(cx - 22 * s, cy + 28 * s), size = Size(18 * s, 24 * s))
    drawOval(color = Theme.dogFur, topLeft = Offset(cx + 4 * s, cy + 28 * s), size = Size(18 * s, 24 * s))
}

// A tiny no-ripple clickable for the top-bar tabs (keeps deps minimal).
private fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier =
    this.clickable(
        interactionSource = MutableInteractionSource(),
        indication = null,
        onClick = onClick,
    )

// Preview renders against a directly-constructed VM (no ViewModelStoreOwner needed
// in the preview pane, unlike the viewModel() default used at runtime).
@Preview(showBackground = true)
@Composable
private fun HomePreview() {
    RootScreen(vm = PairingViewModel())
}
