import FridayMobileShellCore
import SwiftUI

struct FridayContextPassportScreen: View {
  @ObservedObject var viewModel: HomeViewModel

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        switch viewModel.state {
        case .idle, .loading:
          header(status: "loading", ready: false)
          loadingView
        case .unavailable(let reason):
          header(status: "connect", ready: false)
          UnavailableView(
            reason: reason,
            title: "Connect Shared Context",
            detail: "Friday needs the live Hub projection to show paired-device setup, approval grant, and shared-context readiness.",
            systemImage: "checklist.checked",
            identifier: "friday.context-passport.unavailable")
        case .loaded(let projection):
          loadedContent(projection)
        }
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }

  @ViewBuilder
  private func loadedContent(_ projection: HomeProjection) -> some View {
    let status = projection.t3ProvisioningStatus
    header(
      status: status?.homeStatusLabel ?? "waiting",
      ready: status?.isFullyProvisioned == true)

    if let status {
      checklistCard(status)
      governedCeremoniesCard(status)
      sendCard(projection)
      deviceCard(status)
      setupDetailsCard(status)
    } else {
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          Text("Waiting for provisioning")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("Device pairing, approval grant, and shared-context status will appear after the Hub projection refreshes.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func header(status: String, ready: Bool) -> some View {
    GlassPanel {
      HStack(spacing: 12) {
        Image(systemName: "checklist.checked")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(ready ? MobileTheme.cyan : MobileTheme.coral)
          .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text("Shared Context")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("paired device and shared-context readiness")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
        FridayChip(
          text: status,
          bg: ready ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: ready ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
    }
    .accessibilityIdentifier("friday.context-passport.header")
  }

  private var loadingView: some View {
    GlassPanel {
      HStack(spacing: 12) {
        ProgressView()
          Text("Checking shared-context status")
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
      }
      .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
    }
  }

  private func checklistCard(_ status: HomeT3ProvisioningStatus) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Checklist", count: status.checklistRows.filter(\.satisfied).count)
        ForEach(status.checklistRows) { row in
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: row.satisfied ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
              .foregroundStyle(row.satisfied ? MobileTheme.cyan : MobileTheme.coral)
              .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
              HStack {
                Text(row.title)
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(MobileTheme.textPrimary)
                Spacer()
                FridayChip(
                  text: row.statusText,
                  bg: row.satisfied ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
                  fg: row.satisfied ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
              }
              Text(row.detail)
                .font(.caption2)
                .foregroundStyle(MobileTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
    }
    .accessibilityIdentifier("friday.context-passport.checklist")
  }

  private func deviceCard(_ status: HomeT3ProvisioningStatus) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Device", count: nil)
        if let device = status.latestDevice {
          FridayProofLine(label: "device", ref: device.deviceId)
          FridayProofLine(label: "label", ref: device.label)
          FridayProofLine(label: "device key", ref: device.pubkeyFingerprint)
        } else {
          Text("No paired device is visible yet.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func governedCeremoniesCard(_ status: HomeT3ProvisioningStatus) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Operator Setup", count: nil)
        ceremonyRow(
          title: "Approval grant",
          value: "\(status.activeTrustGrantCount) active / \(status.trustGrantCount) total",
          satisfied: status.activeTrustGrantCount > 0,
          detail: "Authorizes scoped Friday work; mobile only reads the Hub projection.")
        ceremonyRow(
          title: "Shared context",
          value: status.contextPassportCount > 0 ? "\(status.contextPassportCount) ready" : "waiting",
          satisfied: status.contextPassportCount > 0,
          detail: "Shares non-sensitive mission context to the governed destination lane.")
        ceremonyRow(
          title: "Shared context items",
          value: "\(status.contextPassportItemCount) item(s)",
          satisfied: status.contextPassportItemCount > 0,
          detail: "Shares only scoped references created by the operator ceremony.")
        Text("This screen only shows setup completed by the operator. It never creates approvals or signatures.")
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityIdentifier("friday.context-passport.governed-ceremonies")
  }

  private func ceremonyRow(title: String, value: String, satisfied: Bool, detail: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: satisfied ? "checkmark.seal.fill" : "lock.trianglebadge.exclamationmark")
        .foregroundStyle(satisfied ? MobileTheme.cyan : MobileTheme.coral)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          FridayChip(
            text: value,
            bg: satisfied ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: satisfied ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
        }
        Text(detail)
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func sendCard(_ projection: HomeProjection) -> some View {
    let status = projection.t3ProvisioningStatus
    let isReady = status?.isFullyProvisioned == true
    let missing = userFacingProvisioningMissing(status?.missingOperatorSteps ?? [])
    return GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Send", count: 3)
        Button {
          Task { await viewModel.submitContextPassportTransfer(for: projection) }
        } label: {
          Label("Send with 3 items", systemImage: "checkmark.seal")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(FridayButtonStyle(variant: .primary))
        .tint(MobileTheme.cyan)
        .disabled(!isReady || viewModel.contextPassportTransferState?.isSent == true)
        .accessibilityIdentifier("friday.context-passport.send")
        if !isReady {
          Text("Send will be ready after \(missing) is visible in the Hub projection.")
            .font(.caption2)
            .foregroundStyle(MobileTheme.chipWarnFG)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let state = viewModel.contextPassportTransferState {
          candidateDecisionStateView(state)
        }
      }
    }
  }

  @ViewBuilder private func candidateDecisionStateView(_ state: HomeLearningDecisionState) -> some View {
    switch state {
    case .sent:
      FridayChip(text: "sending", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
    case .confirmed(let summary):
      Text(summary)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    case .error(let reason):
      Text(reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.chipWarnFG)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func setupDetailsCard(_ status: HomeT3ProvisioningStatus) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Setup Details", count: nil)
        Text(status.homeSummary)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        FridayProofLine(label: "status", ref: status.truthLabel)
        if !status.missingOperatorSteps.isEmpty {
          FridayProofLine(label: "needed", ref: userFacingProvisioningMissing(status.missingOperatorSteps))
        }
      }
    }
  }

  private func userFacingProvisioningMissing(_ steps: [String]) -> String {
    guard !steps.isEmpty else { return "setup" }
    return steps.map { step in
      switch step {
      case "trusted_device", "device_identity", "active_trusted_device":
        return "paired device"
      case "trust_grant", "active_trust_grant":
        return "approval grant"
      case "context_passport", "context_passport_item":
        return "shared context"
      default:
        return step.replacingOccurrences(of: "_", with: " ")
      }
    }
    .joined(separator: ", ")
  }

  private func cardHeader(_ title: String, count: Int?) -> some View {
    HStack {
      Text(title)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      if let count {
        FridayChip(text: "\(count)/4", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }
}
