import FridayMobileShellCore
import SwiftUI

/// The full-screen grid launcher (locked: menuModel = commandSheet) opened from the
/// top-left of Home.
///
/// The launcher surfaces all selected mobile destinations. `isBuilt` only means the route is
/// present and openable; `closureTier` is the product truth used to avoid counting a projection
/// or readiness shell as an END-BAR closed loop.
enum MobileDestination: String, CaseIterable, Identifiable {
  case home
  case missions
  case session
  case contextPassport
  case tokenLedger
  case shareIntake
  case voice
  case pairing
  case newSession
  case needsMe
  case memory
  case platform
  case providerAuth
  case activity
  case workflows
  case onboarding
  case settings
  case petEditor
  case proofViewer
  case entrypoints

  var id: String { rawValue }

  var contract: MobileProductDestinationContract {
    MobileProductDestinationID(rawValue: rawValue)?.contract
      ?? MobileProductDestinationContract(
        id: rawValue,
        title: rawValue,
        systemImage: "questionmark.square.dashed",
        tier: .navigationShell,
        routeBuilt: false,
        selectedDesignLocked: false,
        runtimeActionIds: [],
        blockers: [
          MobileProductBlocker(.needsNativeSurface, label: "missing native route contract"),
        ])
  }

  var title: String {
    contract.title
  }

  var systemImage: String {
    contract.systemImage
  }

  var closureTier: MobileProductLoopTier { contract.tier }

  var productReadinessSummary: String { contract.productReadinessSummary }

  /// Route coverage only. This must not be used as a closed-loop product-completion signal.
  var isBuilt: Bool { contract.routeBuilt }
}

/// The Command Sheet: a full-screen 2-column grid launcher.
struct CommandSheet: View {
  @Binding var destination: MobileDestination
  @Binding var isOpen: Bool

  private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]
  private let sections: [(String, [MobileDestination])] = [
    ("Command", [.home, .newSession, .voice, .shareIntake]),
    ("Work", [.missions, .needsMe, .activity, .workflows]),
    ("Providers", [.platform, .providerAuth, .session]),
    ("Trust", [.contextPassport, .memory, .tokenLedger]),
    ("Setup", [.pairing, .onboarding, .settings, .petEditor]),
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          ForEach(sections, id: \.0) { section in
            VStack(alignment: .leading, spacing: 10) {
              Text(section.0.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(MobileTheme.textSecondary)
                .tracking(3)
                .accessibilityHidden(true)
              LazyVGrid(columns: columns, spacing: 14) {
                ForEach(section.1) { dest in
                  Button {
                    if dest.isBuilt { destination = dest }
                    isOpen = false
                  } label: {
                    tile(dest)
                  }
                  .buttonStyle(.plain)
                  .disabled(!dest.isBuilt)
                  .accessibilityIdentifier("friday.command-sheet.destination.\(dest.rawValue)")
                }
              }
            }
          }
        }
        .padding(16)
      }
      .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
      .navigationTitle("Friday")
      .navigationBarTitleDisplayMode(.large)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { isOpen = false }
            .tint(MobileTheme.cyan)
            .accessibilityIdentifier("friday.command-sheet.done")
        }
      }
    }
  }

  private func tile(_ dest: MobileDestination) -> some View {
    let contract = dest.contract
    return VStack(alignment: .leading, spacing: 10) {
      HStack {
        Image(systemName: contract.systemImage)
          .font(.system(size: 26))
          .foregroundStyle(dest.isBuilt ? MobileTheme.cyan : MobileTheme.textSecondary)
        Spacer()
        if dest == destination {
          FridayChip(text: "open", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
        }
      }
      Text(contract.title)
        .font(.headline)
        .foregroundStyle(dest.isBuilt ? MobileTheme.textPrimary : MobileTheme.textSecondary)
      FridayChip(
        text: contract.tier.label,
        bg: contract.isEndBarReady ? MobileTheme.chipDoneBG : MobileTheme.chipNeutralBG,
        fg: contract.isEndBarReady ? MobileTheme.chipDoneFG : MobileTheme.chipNeutralFG)
      Text(contract.productReadinessSummary)
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
