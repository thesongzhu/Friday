// MOCK device-pairing + Hub<->phone sync state machine.
//
// HONEST LABEL: this is a deterministic in-memory STUB. There is no real Hub,
// no QR camera, no passkey/WebAuthn ceremony, and NO sealed-WS client. It exists
// only to demonstrate the SHAPE of the pairing + sync flow on the emulator for
// the v1 device-proof. Every transition is a scripted delay, not a network call.
// The real Kotlin sealed-WS Hub client is a DEFERRED acceptance criterion
// (post-v1; v1 ships iOS as the real client — see README / PR body).
package com.friday.mock

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The pairing ceremony states (refs-only; the phone never holds a provider secret).
enum class PairStep { UNPAIRED, SCANNING, PASSKEY, PAIRING, PAIRED }

// The Hub<->phone sync indicator states (honest: offline/stale/syncing/synced).
enum class SyncState { OFFLINE, STALE, SYNCING, SYNCED }

class PairingViewModel : ViewModel() {
    // --- device-pairing ceremony (mocked) ---
    var step by mutableStateOf(PairStep.UNPAIRED)
        private set

    // A fixed, non-secret demo pairing code — illustrative only, not a real token.
    val mockPairingCode = "FRDY-EMU-7Q2K"
    val mockHubName = "Friday Hub (mock)"

    // --- Hub<->phone sync indicator (mocked) ---
    var sync by mutableStateOf(SyncState.OFFLINE)
        private set
    var lastSync by mutableStateOf<String?>(null)
        private set

    // Step 1: user taps "Scan QR" — show the (mock) scan surface.
    fun beginScan() {
        if (step != PairStep.UNPAIRED) return
        step = PairStep.SCANNING
    }

    // Step 2: a QR is "detected" → advance to the passkey confirmation prompt.
    fun qrDetected() {
        if (step != PairStep.SCANNING) return
        step = PairStep.PASSKEY
    }

    // Step 3: user confirms the passkey prompt → run the (mock) pairing handshake.
    fun confirmPasskey() {
        if (step != PairStep.PASSKEY) return
        step = PairStep.PAIRING
        viewModelScope.launch {
            delay(900)              // mock handshake latency (no real WS)
            step = PairStep.PAIRED
            sync = SyncState.SYNCING
            delay(900)              // mock first sync
            sync = SyncState.SYNCED
            lastSync = "just now (mock)"
        }
    }

    // Re-run a (mock) sync from the paired state — demonstrates the sync indicator.
    fun resync() {
        if (step != PairStep.PAIRED || sync == SyncState.SYNCING) return
        viewModelScope.launch {
            sync = SyncState.SYNCING
            delay(900)
            sync = SyncState.SYNCED
            lastSync = "just now (mock)"
        }
    }

    // Tear the pairing down (back to the unpaired/offline state).
    fun unpair() {
        step = PairStep.UNPAIRED
        sync = SyncState.OFFLINE
        lastSync = null
    }

    // Honest connection label for the Home status card.
    val online: Boolean get() = step == PairStep.PAIRED && sync == SyncState.SYNCED
}
