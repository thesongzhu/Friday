import FridayHubConsoleCore
import FridayRustClient
import SwiftUI

/// The three-pane Hub Console shell (locked: layout = threePane):
///   [ nav rail ] · [ main work area ] · [ right-docked proof inspector ]
///
/// Default screen = Operations Overview (locked: screen = operations).
struct HubConsoleShell: View {
  @State private var destination: HubDestination = .operations
  @StateObject private var operationsVM: OperationsOverviewViewModel

  init(
    client: FridayRustReadClient,
    writeClient: FridayMissionSpineWriteClient? = nil,
    missionRunClient: FridayMissionBoundRunWriteClient? = nil,
    approvalSigner: OperatorApprovalSigner? = nil,
    approvalResumeClient: FridayRustWriteClient? = nil
  ) {
    _operationsVM = StateObject(
      wrappedValue: OperationsOverviewViewModel(
        client: client,
        writeClient: writeClient,
        missionRunClient: missionRunClient,
        approvalSigner: approvalSigner,
        approvalResumeClient: approvalResumeClient))
  }

  var body: some View {
    HStack(spacing: 0) {
      NavRail(selection: $destination)
        .frame(width: 220)

      Divider().opacity(0.4)

      mainPane
        .frame(minWidth: 520, maxWidth: .infinity, maxHeight: .infinity)

      Divider().opacity(0.4)

      ProofInspector(
        state: operationsVM.state,
        selection: operationsVM.selection,
        refs: operationsVM.inspectorRefs
      )
      .frame(width: 300)
    }
    .frame(minWidth: 1080, minHeight: 680)
    .background(HubTheme.backgroundWarmOffWhite)
    .task {
      // Initial read on launch.
      if case .idle = operationsVM.state {
        await operationsVM.refresh()
      }
    }
  }

  @ViewBuilder
  private var mainPane: some View {
    switch destination {
    case .operations:
      OperationsOverviewScreen(viewModel: operationsVM)
    case .chat:
      DesktopChatScreen(viewModel: operationsVM)
    case .pairingProvisioning:
      PairingProvisioningScreen()
    default:
      DesktopProjectionScreen(destination: destination, viewModel: operationsVM)
    }
  }
}

/// The left nav rail.
struct NavRail: View {
  @Binding var selection: HubDestination

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Circle().fill(HubTheme.cyan).frame(width: 10, height: 10)
        Text("Friday Hub Console")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
      }
      .padding(.horizontal, 14)
      .padding(.top, 18)
      .padding(.bottom, 10)

      ForEach(HubDestination.allCases) { dest in
        NavRailItem(
          destination: dest,
          isSelected: selection == dest
        ) {
          selection = dest
        }
      }

      Spacer()

      VStack(alignment: .leading, spacing: 3) {
        Text("Governed workbench")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Text(readinessFooterText)
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
      }
      .padding(14)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Governed workbench. Live read plus gated writes.")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(HubTheme.navRailBackground)
  }

  private var readinessFooterText: String {
    let snapshot = DesktopProductEndBarSnapshot()
    return "\(snapshot.routeCoverageCount)/\(snapshot.totalCount) routes · \(snapshot.endBarReadyCount)/\(snapshot.totalCount) END-BAR"
  }
}

struct NavRailItem: View {
  let destination: HubDestination
  let isSelected: Bool
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      HStack(spacing: 10) {
        Image(systemName: destination.systemImage)
          .frame(width: 18)
          .foregroundStyle(isSelected ? HubTheme.cyan : HubTheme.textSecondary)
        Text(destination.title)
          .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
          .foregroundStyle(isSelected ? HubTheme.textPrimary : HubTheme.textSecondary)
        Spacer()
        if !destination.isBuilt {
          Text("soon")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(HubTheme.textSecondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.black.opacity(0.05)))
        } else if !destination.contract.blockers.isEmpty {
          Text(destination.contract.tier.label)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(HubTheme.textSecondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.black.opacity(0.05)))
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(isSelected ? HubTheme.cyanSoft : Color.clear)
      )
      .padding(.horizontal, 8)
    }
    .buttonStyle(.plain)
  }
}

// MARK: - Previews

#Preview("Operations Overview · loaded") {
  HubConsoleShell(client: MockReadClient(behavior: .loaded))
    .frame(width: 1180, height: 720)
}

#Preview("Operations Overview · unavailable (503)") {
  HubConsoleShell(
    client: MockReadClient(behavior: .unavailable(.hubUnavailable(statusCode: 503)))
  )
  .frame(width: 1180, height: 720)
}

#Preview("Operations Overview · offline") {
  HubConsoleShell(client: MockReadClient(behavior: .unavailable(.offline)))
    .frame(width: 1180, height: 720)
}
