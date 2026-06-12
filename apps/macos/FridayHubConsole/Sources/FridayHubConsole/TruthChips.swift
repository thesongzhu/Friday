import FridayHubConsoleCore
import SwiftUI

/// A small status chip. Color is chosen to render truth HONESTLY:
/// done/proof → calm green; warn/blocked/error → coral; pending → cyan;
/// everything unknown/neutral → grey. Truth is never upgraded.
struct StatusChip: View {
  let text: String
  let bg: Color
  let fg: Color

  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .medium))
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(Capsule().fill(bg))
      .foregroundStyle(fg)
  }
}

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
  /// blocked / error / stale / unknown are honest WARN/neutral — never ready-green.
  @ViewBuilder var chip: some View {
    switch self {
    case .completedWithProof:
      StatusChip(text: displayText, bg: HubTheme.chipDoneBG, fg: HubTheme.chipDoneFG)
    case .blocked, .error:
      StatusChip(text: displayText, bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
    case .stale, .reconnecting, .unknown:
      StatusChip(text: displayText, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
    case .ready, .queued, .providerAck, .waiting, .timelineRead:
      StatusChip(text: displayText, bg: HubTheme.chipPendingBG, fg: HubTheme.chipPendingFG)
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

  /// Owner chip. Only `friday_owned` is the "owned" green tone; linked_only /
  /// observed_only are explicitly NOT owned (neutral), and unknown is honest grey.
  @ViewBuilder var chip: some View {
    switch self {
    case .fridayOwned, .fridayAdopted:
      StatusChip(text: displayText, bg: HubTheme.chipDoneBG, fg: HubTheme.chipDoneFG)
    case .linkedOnly, .observedOnly:
      StatusChip(text: displayText, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
    case .unknown:
      StatusChip(text: displayText, bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
    }
  }
}

extension MissionWorkbenchApprovalState {
  var displayText: String {
    switch self {
    case .notRequired: return "not required"
    case .required: return "approval required"
    case .approved: return "approved"
    case .blocked: return "blocked"
    case .unknown: return "unavailable"
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

  /// Pending / unknown feeds render as a calm warning — never as "live/ready".
  var isHealthy: Bool { self == .liveRustHubProjection }
}

/// A monospaced redacted-ref pill. Refs only — there is no expand/load affordance.
struct RefPill: View {
  let label: String?
  let ref: String

  var body: some View {
    HStack(spacing: 6) {
      if let label {
        Text(label)
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(HubTheme.textSecondary)
      }
      Text(ref)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(HubTheme.textMono)
        .textSelection(.enabled)
        .lineLimit(1)
        .truncationMode(.middle)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: 7, style: .continuous)
        .fill(Color.black.opacity(0.04))
    )
  }
}
