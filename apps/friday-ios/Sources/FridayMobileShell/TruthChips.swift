import FridayMobileShellCore
import SwiftUI

// Honest truth rendering for the projection enums. These MIRROR the desktop
// sibling's TruthChips (#676) so mobile and desktop render the same truth the
// same way: done/proof → calm green; warn/blocked/error → coral; pending → cyan;
// unknown/neutral → grey. Truth is NEVER upgraded.

extension MissionLifecycleState {
  var displayText: String {
    switch self {
    case .ready: return "ready"
    case .queued: return "queued"
    case .providerAck: return "provider ack"
    case .waiting: return "waiting"
    case .stale: return "stale"
    case .reconnecting: return "reconnecting"
    case .timelineRead: return "timeline read"
    case .completedWithProof: return "completed · proof"
    case .blocked: return "blocked"
    case .error: return "error"
    case .unknown: return "unavailable"
    }
  }

  /// Lifecycle chip. Only `completed_with_proof` earns the green "done" chip.
  /// provider_ack / waiting / queued are PENDING (cyan), never done.
  /// blocked / error are honest WARN; stale / reconnecting / unknown are neutral —
  /// never ready-green.
  @ViewBuilder var chip: some View {
    switch self {
    case .completedWithProof:
      StatusChip(text: displayText, bg: MobileTheme.chipDoneBG, fg: MobileTheme.chipDoneFG)
    case .blocked, .error:
      StatusChip(text: displayText, bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
    case .stale, .reconnecting, .unknown:
      StatusChip(text: displayText, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
    case .ready, .queued, .providerAck, .waiting, .timelineRead:
      StatusChip(text: displayText, bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
    }
  }
}

extension MissionTruthLabel {
  var displayText: String {
    switch self {
    case .fridayOwned: return "friday owned"
    case .fridayAdopted: return "friday adopted"
    case .observedOnly: return "observed only"
    case .linkedOnly: return "linked only"
    case .unknown: return "unknown owner"
    }
  }

  /// Owner chip. Only friday_owned/adopted is the "owned" green tone; linked_only /
  /// observed_only are explicitly NOT owned (neutral); unknown is honest coral.
  @ViewBuilder var chip: some View {
    switch self {
    case .fridayOwned, .fridayAdopted:
      StatusChip(text: displayText, bg: MobileTheme.chipDoneBG, fg: MobileTheme.chipDoneFG)
    case .linkedOnly, .observedOnly:
      StatusChip(text: displayText, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
    case .unknown:
      StatusChip(text: displayText, bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
    }
  }
}

extension MissionWorkbenchStatusLabel {
  var displayText: String {
    switch self {
    case .stale: return "STALE"
    case .offline: return "OFFLINE"
    case .error: return "ERROR"
    case .unknown: return "UNAVAILABLE"
    }
  }
}

extension MissionWorkbenchRuntimeFeedStatus {
  var displayText: String {
    switch self {
    case .liveRustHubProjection: return "live rust hub projection"
    case .pendingRustHubProjection: return "pending rust hub projection"
    case .unknown: return "feed unavailable"
    }
  }
}
