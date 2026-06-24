import SwiftUI

/// The full-screen grid launcher (locked: menuModel = commandSheet) opened from the
/// top-left of Home.
///
/// The launcher surfaces all selected mobile destinations. `isBuilt` only means the route is
/// present and openable; `closureTier` is the product truth used to avoid counting a projection
/// or readiness shell as an END-BAR closed loop.
enum MobileDestinationClosureTier {
  case liveWriteRead
  case liveReadProjection
  case providerWorkspace
  case governedActionGated
  case readinessOnly
  case statusProjection
  case navigationShell

  var label: String {
    switch self {
    case .liveWriteRead: return "live write"
    case .liveReadProjection: return "live read"
    case .providerWorkspace: return "workspace"
    case .governedActionGated: return "action gated"
    case .readinessOnly: return "readiness"
    case .statusProjection: return "projection"
    case .navigationShell: return "shell"
    }
  }

  var summary: String {
    switch self {
    case .liveWriteRead:
      return "Real read/write loop exists when the governed live seams are configured."
    case .liveReadProjection:
      return "Reads real Hub projection state; it does not create or mutate work."
    case .providerWorkspace:
      return "Opens provider readiness, route/session refs, and native-control truth; read-only pieces are labeled."
    case .governedActionGated:
      return "Shows governed action controls; mutations require the live write seam and approval gates."
    case .readinessOnly:
      return "Reports device/provider readiness only; it is not a completed product loop."
    case .statusProjection:
      return "Shows current status from projection refs; no product action is completed here."
    case .navigationShell:
      return "Route exists for selected UI coverage, but closed-loop product behavior is still pending."
    }
  }

  var isClosedLoopProductReady: Bool {
    switch self {
    case .liveWriteRead: return true
    case .liveReadProjection, .providerWorkspace, .governedActionGated, .readinessOnly, .statusProjection, .navigationShell:
      return false
    }
  }
}

enum MobileDestination: String, CaseIterable, Identifiable {
  case home
  case missions
  case session
  case contextPassport
  case tokenLedger
  case shareIntake
  case voice
  case pairing
  case needsMe
  case memory
  case platform
  case providerAuth
  case activity
  case workflows
  case onboarding
  case settings

  var id: String { rawValue }

  var title: String {
    switch self {
    case .home: return "Friday Home"
    case .missions: return "Missions"
    case .session: return "Session"
    case .contextPassport: return "Context Passport"
    case .tokenLedger: return "Token Ledger"
    case .shareIntake: return "Share Intake"
    case .voice: return "Voice"
    case .pairing: return "Device Pairing"
    case .needsMe: return "Needs Me"
    case .memory: return "Memory"
    case .platform: return "Platform"
    case .providerAuth: return "Provider Workspace"
    case .activity: return "Activity"
    case .workflows: return "Workflows"
    case .onboarding: return "Onboarding"
    case .settings: return "Settings"
    }
  }

  var systemImage: String {
    switch self {
    case .home: return "house"
    case .missions: return "list.bullet.rectangle"
    case .session: return "rectangle.connected.to.line.below"
    case .contextPassport: return "checklist.checked"
    case .tokenLedger: return "chart.bar.doc.horizontal"
    case .shareIntake: return "square.and.arrow.down"
    case .voice: return "waveform"
    case .pairing: return "qrcode.viewfinder"
    case .needsMe: return "person.crop.circle.badge.exclamationmark"
    case .memory: return "brain.head.profile"
    case .platform: return "square.grid.2x2"
    case .providerAuth: return "person.badge.key"
    case .activity: return "bell.badge"
    case .workflows: return "arrow.triangle.branch"
    case .onboarding: return "sparkles.rectangle.stack"
    case .settings: return "gearshape"
    }
  }

  var closureTier: MobileDestinationClosureTier {
    switch self {
    case .home:
      return .liveWriteRead
    case .session:
      return .governedActionGated
    case .missions, .contextPassport, .tokenLedger, .memory, .activity:
      return .liveReadProjection
    case .providerAuth:
      return .providerWorkspace
    case .shareIntake, .needsMe:
      return .governedActionGated
    case .voice, .pairing:
      return .readinessOnly
    case .platform, .settings:
      return .statusProjection
    case .workflows, .onboarding:
      return .navigationShell
    }
  }

  var productReadinessSummary: String { closureTier.summary }

  /// Route coverage only. This must not be used as a closed-loop product-completion signal.
  var isBuilt: Bool { true }
}

/// The Command Sheet: a full-screen 2-column grid launcher.
struct CommandSheet: View {
  @Binding var destination: MobileDestination
  @Binding var isOpen: Bool

  private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVGrid(columns: columns, spacing: 14) {
          ForEach(MobileDestination.allCases) { dest in
            Button {
              if dest.isBuilt { destination = dest }
              isOpen = false
            } label: {
              tile(dest)
            }
            .buttonStyle(.plain)
            .disabled(!dest.isBuilt)
          }
        }
        .padding(16)

        Text("Route coverage is not END-BAR. Each tile shows the current runtime contract.")
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .padding(.top, 8)
      }
      .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
      .navigationTitle("Friday")
      .navigationBarTitleDisplayMode(.large)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { isOpen = false }.tint(MobileTheme.cyan)
        }
      }
    }
  }

  private func tile(_ dest: MobileDestination) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Image(systemName: dest.systemImage)
          .font(.system(size: 26))
          .foregroundStyle(dest.isBuilt ? MobileTheme.cyan : MobileTheme.textSecondary)
        Spacer()
        if dest == destination {
          StatusChip(text: "open", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
        }
      }
      Text(dest.title)
        .font(.headline)
        .foregroundStyle(dest.isBuilt ? MobileTheme.textPrimary : MobileTheme.textSecondary)
      StatusChip(
        text: dest.closureTier.label,
        bg: dest.closureTier.isClosedLoopProductReady ? MobileTheme.chipDoneBG : MobileTheme.chipNeutralBG,
        fg: dest.closureTier.isClosedLoopProductReady ? MobileTheme.chipDoneFG : MobileTheme.chipNeutralFG)
      Text(dest.productReadinessSummary)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .lineLimit(3)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
    .padding(16)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .strokeBorder(MobileTheme.glassPanelBorder, lineWidth: 1))
  }
}
