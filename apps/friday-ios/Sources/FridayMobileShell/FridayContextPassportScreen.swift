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
            title: "Connect Context Passport",
            detail: "Friday needs the live Hub projection to show PairAck, trust grant, and passport readiness.",
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
      refsCard(status)
      truthCard(status)
    } else {
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          Text("Waiting for provisioning")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("PairAck, trust grant, and context passport status will appear after the Hub projection refreshes.")
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
          Text("Context Passport")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("governed device and shared-context readiness")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
        StatusChip(
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
        Text("Reading provisioning truth")
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
                StatusChip(
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

  private func refsCard(_ status: HomeT3ProvisioningStatus) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Device", count: nil)
        if let device = status.latestDevice {
          RefPill(label: "device_id", ref: device.deviceId)
          RefPill(label: "label", ref: device.label)
          RefPill(label: "fingerprint", ref: device.pubkeyFingerprint)
        } else {
          Text("No trusted device ref is present in this projection.")
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
        cardHeader("Governed Ceremonies", count: nil)
        ceremonyRow(
          title: "Trust grant",
          value: "\(status.activeTrustGrantCount) active / \(status.trustGrantCount) total",
          satisfied: status.activeTrustGrantCount > 0,
          detail: "Authorizes scoped Friday work; mobile only reads the Hub projection.")
        ceremonyRow(
          title: "Context passport",
          value: "\(status.contextPassportCount) minted",
          satisfied: status.contextPassportCount > 0,
          detail: "Shares non-sensitive mission context to the governed destination lane.")
        ceremonyRow(
          title: "Shared context items",
          value: "\(status.contextPassportItemCount) item(s)",
          satisfied: status.contextPassportItemCount > 0,
          detail: "Refs-only readiness evidence, not proof of END-BAR adoption.")
        Text("This screen never mints grants, passports, or signatures. It only renders operator-created Hub rows.")
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
          StatusChip(
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
    let missing = status?.missingOperatorSteps.joined(separator: ", ") ?? "T3 projection"
    return GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Send", count: 3)
        Button {
          Task { await viewModel.submitContextPassportTransfer(for: projection) }
        } label: {
          Label("Send with 3 items", systemImage: "checkmark.seal")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
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
      StatusChip(text: "sending", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
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

  private func truthCard(_ status: HomeT3ProvisioningStatus) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Truth", count: nil)
        Text(status.homeSummary)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        RefPill(label: "truth", ref: status.truthLabel)
        if !status.missingOperatorSteps.isEmpty {
          RefPill(label: "missing", ref: status.missingOperatorSteps.joined(separator: ", "))
        }
      }
    }
  }

  private func cardHeader(_ title: String, count: Int?) -> some View {
    HStack {
      Text(title)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      if let count {
        StatusChip(text: "\(count)/4", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }
}
