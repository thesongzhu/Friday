import FridayHubConsoleCore
import SwiftUI

/// The center pane: Operations Overview — a READ-ONLY typed projection of hub truth.
///
/// Truth rules enforced here:
///  - projection refs only; answer text appears only via the owner-gated answer-body readback arm,
///  - 503 / stale / offline render AS truth (honest unavailable banner/state),
///  - the only actions are RefreshStatus and OpenEvidence-class selection,
///  - NO mutating action, NO provider-admin exec, NO NO-GO row made executable.
struct OperationsOverviewScreen: View {
  @ObservedObject var viewModel: OperationsOverviewViewModel
  /// The operator-typed Mission-intake draft (the spine-WRITE compose field).
  @State private var intentDraft: String = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header

      Group {
        switch viewModel.state {
        case .idle, .loading:
          loadingView
        case let .loaded(snapshot):
          loadedView(snapshot)
        case let .unavailable(reason):
          UnavailableView(reason: reason)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(HubTheme.backgroundWarmOffWhite)
  }

  // MARK: Header (title + the single read-only refresh action)

  private var header: some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Operations Overview")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Text("Read-only projection of Rust Hub Mission truth")
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
      Spacer()
      Button {
        Task { await viewModel.refresh() }
      } label: {
        Label("Refresh Status", systemImage: "arrow.clockwise")
      }
      .buttonStyle(.borderedProminent)
      .tint(HubTheme.cyan)
      .disabled(viewModel.state.isLoading)
      .accessibilityLabel("Refresh Operations Overview")
      .accessibilityIdentifier("friday.desktop.refresh")
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
  }

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading hub projection…")
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: Loaded

  @ViewBuilder
  private func loadedView(_ snapshot: WorkbenchSnapshot) -> some View {
    ScrollView {
      loadedContent(snapshot)
    }
  }

  /// The loaded card stack. Factored out of `ScrollView` so the visual-QA proof harness can
  /// rasterize it directly (`ImageRenderer` does not expand a `ScrollView`'s lazy content).
  @ViewBuilder
  func loadedContent(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      // Honest status banner — stale/offline/error labels render AS truth.
      if !snapshot.statusLabels.isEmpty || !snapshot.runtimeFeedStatus.isHealthy {
        StatusBanner(snapshot: snapshot)
      }

      devicePairingCard(viewModel.devicePairing)
      t3ProvisioningCard(snapshot.t3ProvisioningStatus)
      attentionCard(snapshot)
      missionCard(snapshot)
      if snapshot.isLoadedEmpty {
        loadedEmptyCard(snapshot)
      }
      routeDecisionCard(snapshot)
      workItemsCard(snapshot)
      capabilityCard(snapshot)
      receiptsCard(snapshot)
      transcriptCard(snapshot)
      memoryCard(snapshot)
      runOutcomeLearningCard(snapshot)
    }
    .padding(20)
  }

  private func missionCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Mission")
        HStack(spacing: 8) {
          snapshot.runtimeFeedStatus.isHealthy
            ? StatusChip(
              text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipPendingBG,
              fg: HubTheme.chipPendingFG)
            : StatusChip(
              text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipWarnBG,
              fg: HubTheme.chipWarnFG)
        }
        RefPill(label: "mission_id", ref: snapshot.missionId)
        RefPill(label: "friday_conversation_id", ref: snapshot.fridayConversationId)

        Divider().opacity(0.3).padding(.vertical, 2)
        missionIntakeCompose
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Mission \(snapshot.missionId)")
    .accessibilityIdentifier("friday.desktop.mission-card")
  }

  private func devicePairingCard(_ readiness: DesktopDevicePairingReadiness) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Device Pairing Readiness")
          Spacer()
          StatusChip(
            text: readiness.mode.rawValue,
            bg: readiness.mode == .ready ? HubTheme.chipPendingBG : HubTheme.chipWarnBG,
            fg: readiness.mode == .ready ? HubTheme.chipPendingFG : HubTheme.chipWarnFG)
        }
        Text(readiness.reason)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
        if let publicKeyHex = readiness.publicKeyHex {
          RefPill(label: "desktop_peer_pubkey", ref: publicKeyHex)
        }
        HStack(spacing: 8) {
          RefPill(label: "owner", ref: readiness.ownerPrincipal)
          RefPill(label: "read_seam", ref: "\(readiness.readHost):\(readiness.readPort)")
        }
        Text(readiness.nextStep)
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Device pairing readiness \(readiness.mode.rawValue). \(readiness.reason)")
    .accessibilityIdentifier("friday.desktop.device-pairing-readiness")
  }

  private func t3ProvisioningCard(_ status: MissionWorkbenchT3ProvisioningStatus?) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("T3 Provisioning")
          Spacer()
          StatusChip(
            text: status?.desktopStatusLabel ?? "not projected",
            bg: status?.isFullyProvisioned == true ? HubTheme.chipPendingBG : HubTheme.chipWarnBG,
            fg: status?.isFullyProvisioned == true ? HubTheme.chipPendingFG : HubTheme.chipWarnFG)
        }

        if let status {
          Text(status.truthLabel)
            .font(.system(size: 10))
            .foregroundStyle(HubTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 8) {
            StatusChip(
              text: status.paired ? "paired" : "not paired",
              bg: status.paired ? HubTheme.chipPendingBG : HubTheme.chipWarnBG,
              fg: status.paired ? HubTheme.chipPendingFG : HubTheme.chipWarnFG)
            StatusChip(
              text: "active devices \(status.activeTrustedDeviceCount)",
              bg: HubTheme.chipPendingBG,
              fg: HubTheme.chipPendingFG)
            StatusChip(
              text: "active grants \(status.activeTrustGrantCount)",
              bg: status.activeTrustGrantCount > 0 ? HubTheme.chipPendingBG : HubTheme.chipWarnBG,
              fg: status.activeTrustGrantCount > 0 ? HubTheme.chipPendingFG : HubTheme.chipWarnFG)
            StatusChip(
              text: "passports \(status.contextPassportCount)",
              bg: status.contextPassportCount > 0 ? HubTheme.chipPendingBG : HubTheme.chipWarnBG,
              fg: status.contextPassportCount > 0 ? HubTheme.chipPendingFG : HubTheme.chipWarnFG)
          }
          .lineLimit(1)

          if let device = status.latestDevice {
            RefPill(label: "latest_device", ref: device.deviceId)
            HStack(spacing: 8) {
              RefPill(label: "device_label", ref: device.label.isEmpty ? "unlabeled" : device.label)
              RefPill(label: "pubkey_fingerprint", ref: device.pubkeyFingerprint)
            }
          } else {
            Text("No active trusted device row is visible in the Hub projection.")
              .font(.system(size: 12))
              .foregroundStyle(HubTheme.textSecondary)
          }

          Text(status.desktopSummary)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(status.isFullyProvisioned ? HubTheme.textSecondary : HubTheme.coral)
            .fixedSize(horizontal: false, vertical: true)

          Text("Read-only status from Hub DB; trust grant and context passport minting remain operator CLI ceremonies.")
            .font(.system(size: 10))
            .foregroundStyle(HubTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          Text("This Hub projection does not expose T3 provisioning status yet.")
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "T3 provisioning \(status?.isFullyProvisioned == true ? "fully provisioned" : "operator gated")")
    .accessibilityIdentifier("friday.desktop.t3-provisioning-status")
  }

  private func loadedEmptyCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack(spacing: 8) {
          Image(systemName: "tray")
            .foregroundStyle(HubTheme.textSecondary)
            .accessibilityHidden(true)
          Text("No active Friday work yet")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(HubTheme.textPrimary)
        }
        Text("Connected to \(snapshot.runtimeFeedStatus.displayText); this owner has no visible work items, receipts, candidates, capabilities, or transcript events in the current projection.")
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday is connected, with no active desktop work for this owner")
    .accessibilityIdentifier("friday.desktop.loaded-empty")
  }

  private func attentionCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Needs Attention")
          Spacer()
          let count = snapshot.attentionWorkItems.count
          StatusChip(
            text: count == 0 ? "clear" : "\(count) open",
            bg: count == 0 ? HubTheme.chipDoneBG : HubTheme.chipWarnBG,
            fg: count == 0 ? HubTheme.chipDoneFG : HubTheme.chipWarnFG)
        }
        Text(snapshot.attentionSummary)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)

        if snapshot.attentionWorkItems.isEmpty {
          Text("No blocked, stale, waiting, or provider-ack work items are visible in this projection.")
            .font(.system(size: 10))
            .foregroundStyle(HubTheme.textSecondary)
        } else {
          ForEach(snapshot.attentionWorkItems.prefix(5)) { item in
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 6) {
                item.state.chip
                item.owner.chip
                Text(item.title)
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(HubTheme.textPrimary)
                  .lineLimit(1)
              }
              Text(item.attentionReason)
                .font(.system(size: 10))
                .foregroundStyle(HubTheme.textSecondary)
              RefPill(label: "workItemId", ref: item.id)
              if let proof = item.proofRef {
                RefPill(label: "proofRef", ref: proof)
              }
            }
            .padding(.vertical, 2)
          }
          if snapshot.attentionWorkItems.count > 5 {
            Text("+ \(snapshot.attentionWorkItems.count - 5) more attention item(s) in Work Items.")
              .font(.system(size: 10))
              .foregroundStyle(HubTheme.textSecondary)
          }
        }

        Text("Read-only recovery visibility; no dispatch, retry, signing, or close action is exposed here.")
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Needs attention. \(snapshot.attentionSummary)")
    .accessibilityIdentifier("friday.desktop.needs-attention")
  }

  /// The spine-WRITE compose affordance — an operator types an intent and submits it as a
  /// `MissionIntakeRequest` over the sealed WRITE seam (:48750). The result renders HONESTLY below:
  /// pending while sent, the refs on a confirm, the questions on needs-clarification, and the truth
  /// on an error/blocked. The button disables while in flight or on an empty draft.
  @ViewBuilder
  private var missionIntakeCompose: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Submit Mission Intent")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(HubTheme.textSecondary)
      HStack(spacing: 8) {
        TextField("Describe what Friday should coordinate…", text: $intentDraft)
          .textFieldStyle(.roundedBorder)
          .font(.system(size: 12))
          .disabled(viewModel.intakeState.isSent)
        Button {
          Task { await viewModel.submitIntake(intent: intentDraft) }
        } label: {
          Label("Submit Intent", systemImage: "paperplane")
        }
        .buttonStyle(.borderedProminent)
        .tint(HubTheme.cyan)
        .disabled(
          viewModel.intakeState.isSent
            || intentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Submit mission intent")
        .accessibilityIdentifier("friday.desktop.submit-intent")
      }
      WriteActionStateView(state: viewModel.intakeState, pendingText: "Submitting intake…")
      Text("Births a Mission + WorkItem(Draft), then dispatches the governed model run when configured.")
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .accessibilityIdentifier("friday.desktop.mission-intake")
  }

  private func routeDecisionCard(_ snapshot: WorkbenchSnapshot) -> some View {
    SelectableCard(isSelected: viewModel.selection == .routeDecision) {
      viewModel.select(.routeDecision)
    } content: {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Route Decision")
          Spacer()
          snapshot.routeDecision.truthLabel.chip
        }
        Text(snapshot.routeDecision.advisorSummary)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
        RefPill(label: "selectedRoute", ref: snapshot.routeDecision.selectedRoute)
        Text("Advisory only — the UI does not choose routes.")
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
      }
    }
  }

  private func workItemsCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Work Items")
        ForEach(snapshot.workItems) { item in
          WorkItemRow(
            item: item,
            isSelected: viewModel.selection == .workItem(id: item.id),
            recoveryState: viewModel.workItemStatusStates[item.id] ?? .ready,
            onRetry: { Task { await viewModel.retryWorkItem(item) } },
            onCancel: { Task { await viewModel.cancelWorkItem(item) } }
          ) {
            viewModel.select(.workItem(id: item.id))
          }
        }
      }
    }
  }

  private func capabilityCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Capabilities")
        Text("Approval / dispatch state shown as status only — never executable from here.")
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
        ForEach(snapshot.capabilityStates) { cap in
          CapabilityRow(
            capability: cap,
            isSelected: viewModel.selection == .capability(id: cap.id)
          ) {
            viewModel.select(.capability(id: cap.id))
          }
        }
      }
    }
  }

  private func receiptsCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Receipt Refs")
        if !snapshot.providerReceiptRefs.isEmpty {
          Text("Provider").font(.system(size: 11, weight: .semibold)).foregroundStyle(
            HubTheme.textSecondary)
          ForEach(snapshot.providerReceiptRefs, id: \.self) { RefPill(label: nil, ref: $0) }
        }
        if !snapshot.channelReceiptRefs.isEmpty {
          Text("Channel").font(.system(size: 11, weight: .semibold)).foregroundStyle(
            HubTheme.textSecondary)
          ForEach(snapshot.channelReceiptRefs, id: \.self) { RefPill(label: nil, ref: $0) }
        }
      }
    }
  }

  private func transcriptCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Transcript Sections")
        ForEach(snapshot.transcriptSections) { section in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(section.title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(HubTheme.textPrimary)
              Spacer()
              section.status.chip
            }
            ForEach(section.events) { event in
              TranscriptEventRow(
                event: event,
                isSelected: viewModel.selection == .transcriptEvent(id: event.id)
              ) {
                viewModel.select(.transcriptEvent(id: event.id))
              }
            }
          }
          .padding(.vertical, 4)
        }
      }
    }
  }

  private func memoryCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Memory Candidates")
        ForEach(snapshot.memoryCandidates) { candidate in
          MemoryCandidateRow(
            candidate: candidate,
            state: viewModel.memoryDecisionStates[candidate.id] ?? .ready,
            onConfirm: {
              Task {
                await viewModel.decideMemory(
                  candidateId: candidate.id, memoryId: candidate.id, confirm: true)
              }
            },
            onReject: {
              Task {
                await viewModel.decideMemory(
                  candidateId: candidate.id, memoryId: candidate.id, confirm: false)
              }
            })
        }
        Text(
          "Confirm/reject drives the owner decision through the Rust spine. The projection "
            + "surfaces the durable memory id; stale or out-of-scope candidates still render "
            + "as a server block.")
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
      }
    }
  }

  private func runOutcomeLearningCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Run Outcome Learning")
        if snapshot.runOutcomeLearningCandidates.isEmpty {
          Text("No pending run-outcome learning candidates.")
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        } else {
          ForEach(snapshot.runOutcomeLearningCandidates) { candidate in
            RunOutcomeLearningCandidateRow(
              candidate: candidate,
              state: viewModel.runOutcomeLearningDecisionStates[candidate.id] ?? .ready,
              onConfirm: {
                Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: true) }
              },
              onReject: {
                Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: false) }
              })
          }
        }
      }
    }
  }

  private func cardTitle(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(HubTheme.textPrimary)
  }
}

// MARK: - Honest unavailable + status banner

/// Rendered when `fetchWorkbench()` throws (503 / offline / projection error).
/// This is the honest "unavailable" state — never a fake-ready screen.
struct UnavailableView: View {
  let reason: String
  private var labels: [MissionWorkbenchStatusLabel] {
    MissionWorkbenchStatusLabel.unavailableReasonLabels(reason)
  }

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 28))
        .foregroundStyle(HubTheme.coral)
      Text("Connect Friday Hub")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(HubTheme.textPrimary)
      Text(userFacingReason)
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
        .multilineTextAlignment(.center)
      HStack(spacing: 6) {
        ForEach(labels, id: \.rawValue) { label in
          StatusChip(text: label.userFacingText, bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
            .accessibilityIdentifier("friday.desktop.status-label.\(label.rawValue)")
        }
      }
      Text("Friday is showing a live-only safe view until the Hub refreshes.")
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .padding(28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Connect Friday Hub. \(userFacingReason)")
    .accessibilityIdentifier("friday.desktop.unavailable")
  }

  private var userFacingReason: String {
    let normalized = reason.lowercased()
    if normalized.contains("offline") || normalized.contains("connection") || normalized.contains("transport") {
      return "Friday cannot reach the live Hub from this window. Check the Hub connection, then refresh."
    }
    if normalized.contains("503") || normalized.contains("service") {
      return "The Hub is starting or busy. Refresh once it is ready."
    }
    if normalized.contains("projection") {
      return "Friday needs a fresh Hub projection before this screen can show current work."
    }
    return "Friday needs a fresh live Hub view before this screen can show current work."
  }
}

/// Honest banner for stale/offline/error labels and pending feeds.
struct StatusBanner: View {
  let snapshot: WorkbenchSnapshot

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.circle")
        .foregroundStyle(HubTheme.chipWarnFG)
      ForEach(snapshot.statusLabels, id: \.rawValue) { label in
        StatusChip(text: label.userFacingText, bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
      }
      if !snapshot.runtimeFeedStatus.isHealthy {
        StatusChip(
          text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipWarnBG,
          fg: HubTheme.chipWarnFG)
      }
      Text("This Hub view needs attention before acting.")
        .font(.system(size: 11))
        .foregroundStyle(HubTheme.textSecondary)
      Spacer()
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
        .fill(HubTheme.coralSoft)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Workbench projection flagged")
    .accessibilityIdentifier("friday.desktop.status-banner")
  }
}

// MARK: - Spine-WRITE controls (honest pending / confirmed / error rendering)

/// Renders a `WriteActionState` AS truth — pending spinner while sent, a calm-green confirm chip +
/// refs-only summary on success (plus any clarification questions), a coral error chip + reason on
/// failure (incl. a server `blocked`). Never upgrades an error/blocked to a ready look.
struct WriteActionStateView: View {
  let state: WriteActionState
  let pendingText: String

  var body: some View {
    switch state {
    case .ready:
      EmptyView()
    case .sent:
      HStack(spacing: 8) {
        ProgressView().scaleEffect(0.6)
        Text(pendingText)
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
      }
    case let .confirmed(summary, clarificationQuestions, answerBody):
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          StatusChip(
            text: clarificationQuestions.isEmpty ? "submitted" : "needs clarification",
            bg: clarificationQuestions.isEmpty ? HubTheme.chipDoneBG : HubTheme.chipNeutralBG,
            fg: clarificationQuestions.isEmpty ? HubTheme.chipDoneFG : HubTheme.chipNeutralFG)
          Text(summary)
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
            .textSelection(.enabled)
        }
        ForEach(clarificationQuestions, id: \.self) { question in
          Text("• \(question)")
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textPrimary)
        }
        if let answerBody,
          !answerBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
          Text(answerBody)
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textPrimary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2)
        }
      }
    case let .error(reason):
      HStack(spacing: 8) {
        StatusChip(text: "needs attention", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
        Text(reason)
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
          .textSelection(.enabled)
      }
    }
  }
}

/// One memory-candidate row with the spine-WRITE confirm/reject control. The buttons drive the
/// owner decision over the sealed WRITE seam; the per-candidate state renders AS truth (pending /
/// confirmed / error|blocked) and the buttons disable while in flight and after a terminal outcome.
struct MemoryCandidateRow: View {
  let candidate: MissionWorkbenchMemoryCandidate
  let state: WriteActionState
  let onConfirm: () -> Void
  let onReject: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(candidate.preview)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textPrimary)
        Spacer()
        HStack(spacing: 6) {
          Button("Confirm", action: onConfirm)
            .buttonStyle(.borderedProminent)
            .tint(HubTheme.cyan)
            .controlSize(.small)
            .disabled(controlsDisabled)
            .accessibilityLabel("Confirm memory candidate")
          Button("Reject", action: onReject)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(controlsDisabled)
            .accessibilityLabel("Reject memory candidate")
        }
      }
      RefPill(label: "evidenceRef", ref: candidate.evidenceRef)
      WriteActionStateView(state: state, pendingText: "Applying decision…")
    }
    .padding(.vertical, 2)
  }

  /// Disabled while in flight or after a terminal outcome (a decision is applied once).
  private var controlsDisabled: Bool { state.isSent || state.isTerminal }
}

/// One A1 run-outcome learning candidate row. The row remains refs-only: it shows the candidate's
/// coarse summary, counters, and redacted evidence ref; confirm/reject is a governed WRITE call.
struct RunOutcomeLearningCandidateRow: View {
  let candidate: MissionWorkbenchRunOutcomeLearningCandidate
  let state: WriteActionState
  let onConfirm: () -> Void
  let onReject: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 8) {
        VStack(alignment: .leading, spacing: 4) {
          Text(candidate.summary)
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textPrimary)
          HStack(spacing: 6) {
            StatusChip(text: candidate.kind, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
            StatusChip(text: candidate.state, bg: HubTheme.chipPendingBG, fg: HubTheme.chipPendingFG)
            Text("turns \(candidate.turns) · tools \(candidate.executedTools)")
              .font(.system(size: 11))
              .foregroundStyle(HubTheme.textSecondary)
          }
        }
        Spacer()
        HStack(spacing: 6) {
          Button("Confirm", action: onConfirm)
            .buttonStyle(.borderedProminent)
            .tint(HubTheme.cyan)
            .controlSize(.small)
            .disabled(controlsDisabled)
            .accessibilityLabel("Confirm run outcome learning candidate")
          Button("Reject", action: onReject)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(controlsDisabled)
            .accessibilityLabel("Reject run outcome learning candidate")
        }
      }
      RefPill(label: "runId", ref: candidate.runId)
      RefPill(label: "workItemId", ref: candidate.workItemId)
      RefPill(label: "evidenceRef", ref: candidate.evidenceRef)
      WriteActionStateView(state: state, pendingText: "Applying learning decision…")
    }
    .padding(.vertical, 2)
  }

  private var controlsDisabled: Bool { state.isSent || state.isTerminal }
}

// MARK: - Rows

/// A card whose whole body is a read-only select affordance (OpenEvidence nav).
struct SelectableCard<Content: View>: View {
  let isSelected: Bool
  let onSelect: () -> Void
  let content: Content

  init(isSelected: Bool, onSelect: @escaping () -> Void, @ViewBuilder content: () -> Content) {
    self.isSelected = isSelected
    self.onSelect = onSelect
    self.content = content()
  }

  var body: some View {
    Button(action: onSelect) {
      content
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HubTheme.panelPadding)
        .background(
          RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
            .fill(HubTheme.glassPanel)
            .overlay(
              RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
                .strokeBorder(
                  isSelected ? HubTheme.cyan : HubTheme.glassPanelBorder,
                  lineWidth: isSelected ? 1.5 : 1)
            )
        )
    }
    .buttonStyle(.plain)
  }
}

struct WorkItemRow: View {
  let item: MissionWorkbenchWorkItem
  let isSelected: Bool
  let recoveryState: WriteActionState
  let onRetry: () -> Void
  let onCancel: () -> Void
  let onSelect: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button(action: onSelect) {
        content
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)

      if item.canRetry || item.canCancel {
        HStack(spacing: 8) {
          if item.canRetry {
            Button(action: onRetry) {
              Label("Retry", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .disabled(recoveryControlsDisabled)
            .accessibilityLabel("Retry WorkItem")
            .accessibilityIdentifier("friday.desktop.workItem.retry.\(item.id)")
          }
          if item.canCancel {
            Button(action: onCancel) {
              Label("Cancel", systemImage: "stop.circle")
            }
            .buttonStyle(.bordered)
            .disabled(recoveryControlsDisabled)
            .accessibilityLabel("Cancel WorkItem")
            .accessibilityIdentifier("friday.desktop.workItem.cancel.\(item.id)")
          }
        }
        WriteActionStateView(state: recoveryState, pendingText: "Updating WorkItem...")
      }
    }
    .padding(10)
    .background(rowBackground)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(item.title)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(HubTheme.textPrimary)
        Spacer()
        // `done` strictly from the projection's done field — provider_ack/linked
        // items are explicitly NOT done.
        if item.done {
          StatusChip(text: "done", bg: HubTheme.chipDoneBG, fg: HubTheme.chipDoneFG)
        } else {
          StatusChip(text: "not done", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
        }
      }
      HStack(spacing: 6) {
        item.state.chip
        item.owner.chip
        if item.recoveryKind != "none" {
          StatusChip(text: item.recoveryKind, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
        }
      }
      if !item.blockingReason.isEmpty {
        Text(item.blockingReason)
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if item.canRetry || item.canCancel {
        HStack(spacing: 6) {
          if item.canRetry {
            StatusChip(text: "retry available", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
          }
          if item.canCancel {
            StatusChip(text: "cancel available", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
          }
        }
      }
      if let proof = item.proofRef {
        RefPill(label: "proofRef", ref: proof)
      }
    }
  }

  private var recoveryControlsDisabled: Bool {
    recoveryState.isSent || recoveryState.isTerminal
  }

  private var rowBackground: some View {
    RoundedRectangle(cornerRadius: 8, style: .continuous)
      .fill(isSelected ? HubTheme.cyanSoft : Color.black.opacity(0.02))
  }
}

struct CapabilityRow: View {
  let capability: MissionWorkbenchCapabilityState
  let isSelected: Bool
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(capability.label)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(HubTheme.textPrimary)
          Spacer()
          // dispatchAllowed shown as a STATUS indicator only — never a button.
          StatusChip(
            text: capability.dispatchAllowed ? "dispatch allowed" : "dispatch gated",
            bg: capability.dispatchAllowed ? HubTheme.chipPendingBG : HubTheme.chipNeutralBG,
            fg: capability.dispatchAllowed ? HubTheme.chipPendingFG : HubTheme.chipNeutralFG)
        }
        HStack(spacing: 6) {
          StatusChip(
            text: capability.approvalState.displayText, bg: HubTheme.chipNeutralBG,
            fg: HubTheme.chipNeutralFG)
          capability.truthLabel.chip
        }
        RefPill(label: "proofRef", ref: capability.proofRef)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(isSelected ? HubTheme.cyanSoft : Color.black.opacity(0.02)))
    }
    .buttonStyle(.plain)
  }
}

struct TranscriptEventRow: View {
  let event: MissionTranscriptEvent
  let isSelected: Bool
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(event.summary)
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
            .lineLimit(2)
          Spacer()
          event.truthLabel.chip
        }
        RefPill(label: "activity_id", ref: event.id)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .background(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(isSelected ? HubTheme.cyanSoft : Color.clear))
    }
    .buttonStyle(.plain)
  }
}
