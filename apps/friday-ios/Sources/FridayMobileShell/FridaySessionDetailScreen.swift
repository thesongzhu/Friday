import FridayMobileShellCore
import SwiftUI

struct FridaySessionDetailScreen: View {
  @ObservedObject var homeViewModel: HomeViewModel
  @ObservedObject var viewModel: SessionContinuationViewModel
  @State private var sessionSendText = ""

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        switch homeViewModel.state {
        case .idle, .loading:
          loadingView
        case .unavailable(let reason):
          UnavailableView(reason: reason)
        case .loaded(let projection):
          loadedContent(projection)
        }
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }

  private var loadingView: some View {
    GlassPanel {
      HStack(spacing: 12) {
        ProgressView()
        Text("Reading session refs")
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
      }
      .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
    }
  }

  @ViewBuilder
  private func loadedContent(_ projection: HomeProjection) -> some View {
    VStack(spacing: 16) {
      header(projection)
      continuationState
      learningCard(projection)
    }
    .task(id: "\(projection.agentSessionId ?? "none")|\(firstRunId(projection) ?? "none")") {
      await viewModel.refresh(
        agentSessionId: projection.agentSessionId,
        runId: firstRunId(projection))
    }
  }

  private func header(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack(spacing: 12) {
          Image(systemName: "rectangle.connected.to.line.below")
            .font(.system(size: 24, weight: .semibold))
            .foregroundStyle(MobileTheme.cyan)
            .frame(width: 34, height: 34)
          VStack(alignment: .leading, spacing: 4) {
            Text("Session")
              .font(.headline)
              .foregroundStyle(MobileTheme.textPrimary)
            Text("continuation truth")
              .font(.caption)
              .foregroundStyle(MobileTheme.textSecondary)
          }
          Spacer()
          StatusChip(
            text: projection.agentSessionId == nil ? "no session ref" : "read-only",
            bg: projection.agentSessionId == nil ? MobileTheme.chipWarnBG : MobileTheme.chipPendingBG,
            fg: projection.agentSessionId == nil ? MobileTheme.chipWarnFG : MobileTheme.chipPendingFG)
        }
        RefPill(label: "mission_id", ref: projection.missionId)
        if let agentSessionId = projection.agentSessionId {
          RefPill(label: "agent_session_id", ref: agentSessionId)
        }
        if let runId = firstRunId(projection) {
          RefPill(label: "run_id", ref: runId)
        }
        RefPill(label: "generated", ref: generatedText(projection.generatedAtMs))
      }
    }
  }

  @ViewBuilder
  private var continuationState: some View {
    switch viewModel.state {
    case .idle:
      EmptyView()
    case .loading:
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text("Reading continuation state")
            .font(.footnote)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .unavailable(let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Session Detail", count: nil)
          Text(reason)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .loaded(let snapshot):
      VStack(spacing: 16) {
        approvalPanel(snapshot)
        controlsCard(snapshot.controls)
        ForEach(snapshot.sections) { section in
          sectionCard(section)
        }
        proofRefsCard(snapshot.proofRefs)
      }
    }
  }

  @ViewBuilder
  private func approvalPanel(_ snapshot: SessionContinuationSnapshot) -> some View {
    if let approval = snapshot.pendingApproval {
      let resume = snapshot.controls.first { $0.id == "resume" }
      let reject = snapshot.controls.first { $0.id == "reject" }
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.seal")
              .font(.system(size: 22, weight: .semibold))
              .foregroundStyle(MobileTheme.coral)
              .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 3) {
              Text("Approval Required")
                .font(.headline)
                .foregroundStyle(MobileTheme.textPrimary)
              Text("operator-signed relay only")
                .font(.caption)
                .foregroundStyle(MobileTheme.textSecondary)
            }
            Spacer()
            StatusChip(
              text: resume?.truthLabel ?? "NO-GO",
              bg: resume?.isEnabled == true ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
              fg: resume?.isEnabled == true ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
          }

          if let summary = approval.summary, !summary.isEmpty {
            Text(summary)
              .font(.callout.weight(.medium))
              .foregroundStyle(MobileTheme.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
          }
          RefPill(label: "run_id", ref: approval.runId)
          RefPill(label: "approval_id", ref: approval.approvalId)
          RefPill(label: "action_digest", ref: short(approval.actionDigest))

          VStack(alignment: .leading, spacing: 5) {
            approvalCapabilityRow("Resume", control: resume)
            approvalCapabilityRow("Reject", control: reject)
          }
          Text("The app displays the paused action proof and relays an operator signature when one is available; it never holds signing key material.")
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          controlStateView(viewModel.controlStates["resume"])
          controlStateView(viewModel.controlStates["reject"])
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Approval required. \(approval.summary ?? "No summary"). Digest \(approval.actionDigest)")
      .accessibilityIdentifier("friday.session.approval-panel")
    }
  }

  @ViewBuilder
  private func approvalCapabilityRow(_ title: String, control: SessionContinuationControl?) -> some View {
    HStack(spacing: 8) {
      Image(systemName: control?.isEnabled == true ? "checkmark.circle" : "exclamationmark.triangle")
        .foregroundStyle(control?.isEnabled == true ? MobileTheme.cyan : MobileTheme.coral)
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      StatusChip(
        text: control?.truthLabel ?? "NO-GO",
        bg: control?.isEnabled == true ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
        fg: control?.isEnabled == true ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
    }
    if let reason = control?.reason {
      Text(reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func controlsCard(_ controls: [SessionContinuationControl]) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Controls", count: nil)
        if let send = controls.first(where: { $0.id == "send" }) {
          sessionSendComposer(send)
        }
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
          ForEach(controls.filter { $0.id != "send" }) { control in
            let controlState = viewModel.controlStates[control.id]
            Button {
              if control.id == "stop" {
                Task { await viewModel.stop() }
              } else if control.id == "resume" {
                Task { await viewModel.resume() }
              } else if control.id == "reject" {
                Task { await viewModel.reject() }
              }
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                HStack {
                  Image(systemName: control.systemImage)
                  Text(control.title)
                    .font(.system(size: 13, weight: .semibold))
                  Spacer()
                  controlTruthChip(control)
                }
                Text(control.reason)
                  .font(.caption2)
                  .foregroundStyle(MobileTheme.textSecondary)
                  .fixedSize(horizontal: false, vertical: true)
                controlStateView(controlState)
              }
              .frame(maxWidth: .infinity, minHeight: 70, alignment: .topLeading)
              .padding(10)
            }
            .buttonStyle(.bordered)
            .disabled(!control.isEnabled || controlStateDisablesButton(controlState))
            .accessibilityLabel("\(control.title) \(control.truthLabel). \(control.reason)")
          }
        }
      }
    }
  }

  private func sessionSendComposer(_ control: SessionContinuationControl) -> some View {
    let state = viewModel.controlStates[control.id]
    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        TextField("Continue this session", text: $sessionSendText, axis: .vertical)
          .lineLimit(1...4)
          .textInputAutocapitalization(.sentences)
          .autocorrectionDisabled(false)
          .font(.subheadline)
          .padding(10)
          .background(Color.white.opacity(0.54), in: RoundedRectangle(cornerRadius: 8))
          .accessibilityIdentifier("friday.session.send-input")
        Button {
          let text = sessionSendText
          sessionSendText = ""
          Task { await viewModel.send(text) }
        } label: {
          Image(systemName: control.systemImage)
            .frame(width: 28, height: 28)
        }
        .buttonStyle(.borderedProminent)
        .tint(MobileTheme.cyan)
        .disabled(!control.isEnabled
          || sessionSendText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || controlStateDisablesButton(state))
        .accessibilityLabel("Send session continuation")
        .accessibilityIdentifier("friday.session.send-button")
      }
      Text(control.reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      controlStateView(state)
    }
  }

  @ViewBuilder
  private func controlStateView(_ state: SessionContinuationControlState?) -> some View {
    switch state {
    case .sending:
      Text("Sending control...")
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
    case .succeeded(let summary):
      Text(summary)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
    case .error(let reason):
      Text(reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.coral)
    case .idle, nil:
      EmptyView()
    }
  }

  private func controlStateDisablesButton(_ state: SessionContinuationControlState?) -> Bool {
    guard let state else { return false }
    switch state {
    case .sending, .succeeded:
      return true
    case .idle, .error:
      return false
    }
  }

  private func sectionCard(_ section: SessionContinuationSection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          cardHeader(section.title, count: section.refs.count)
          Spacer()
          sectionStatusChip(section.status)
        }
        Text(section.summary)
          .font(.caption)
          .foregroundStyle(MobileTheme.textPrimary)
        switch section.status {
        case .loaded:
          if !section.facts.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(section.facts) { fact in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  Text(fact.label)
                    .font(.caption2)
                    .foregroundStyle(MobileTheme.textSecondary)
                    .frame(width: 74, alignment: .leading)
                  Text(fact.value)
                    .font(.caption2)
                    .foregroundStyle(MobileTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                }
              }
            }
          }
          if let generatedAtMs = section.generatedAtMs {
            RefPill(label: "generated", ref: generatedText(generatedAtMs))
          }
          ForEach(section.refs, id: \.self) { ref in
            RefPill(label: nil, ref: ref)
          }
        case .unavailable(let reason), .notRequested(let reason):
          Text(reason)
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func proofRefsCard(_ refs: [String]) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Proof Refs", count: refs.count)
        if refs.isEmpty {
          Text("No proof refs were returned by the session read arms.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        } else {
          ForEach(refs, id: \.self) { ref in
            RefPill(label: "proof", ref: ref)
          }
        }
      }
    }
  }

  private func learningCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Learning", count: projection.runOutcomeLearningCandidates.count)
        if projection.runOutcomeLearningCandidates.isEmpty {
          Text("No run-outcome learning candidates in this projection.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        } else {
          ForEach(projection.runOutcomeLearningCandidates) { candidate in
            learningCandidateRow(candidate)
          }
        }
      }
    }
  }

  private func learningCandidateRow(_ candidate: HomeRunOutcomeLearningCandidate) -> some View {
    let decisionState = homeViewModel.runOutcomeLearningDecisionStates[candidate.id]
    return VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 8) {
        Text(candidate.summary)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(MobileTheme.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 6) {
          Button {
            Task { await homeViewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: true) }
          } label: {
            Image(systemName: "checkmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(.borderedProminent)
          .tint(MobileTheme.cyan)
          .disabled(learningDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Confirm run outcome learning candidate")

          Button {
            Task { await homeViewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: false) }
          } label: {
            Image(systemName: "xmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(.bordered)
          .disabled(learningDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Reject run outcome learning candidate")
        }
      }
      HStack(spacing: 6) {
        statusChip(candidate.kind)
        statusChip(candidate.state)
      }
      learningDecisionStateView(decisionState)
      if !candidate.runId.isEmpty {
        RefPill(label: "runId", ref: candidate.runId)
      }
      if !candidate.workItemId.isEmpty {
        RefPill(label: "workItemId", ref: candidate.workItemId)
      }
      if !candidate.evidenceRef.isEmpty {
        RefPill(label: "evidenceRef", ref: candidate.evidenceRef)
      }
    }
    .padding(.vertical, 4)
  }

  private func sectionStatusChip(_ status: SessionContinuationSectionStatus) -> some View {
    switch status {
    case .loaded:
      return StatusChip(text: "loaded", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
    case .unavailable:
      return StatusChip(text: "unavailable", bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
    case .notRequested:
      return StatusChip(text: "no ref", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
    }
  }

  private func learningDecisionControlsDisabled(_ state: HomeLearningDecisionState?) -> Bool {
    guard let state else { return false }
    return state.isSent || state.isTerminal
  }

  @ViewBuilder
  private func learningDecisionStateView(_ state: HomeLearningDecisionState?) -> some View {
    switch state {
    case .sent:
      Text("Applying learning decision...")
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
    case .confirmed(let summary):
      Text(summary)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
    case .error(let reason):
      Text(reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.coral)
    case nil:
      EmptyView()
    }
  }

  private func cardHeader(_ title: String, count: Int?) -> some View {
    HStack {
      Text(title)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      if let count {
        StatusChip(text: "\(count)", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }

  private func statusChip(_ text: String) -> some View {
    StatusChip(text: text, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
  }

  private func controlTruthChip(_ control: SessionContinuationControl) -> some View {
    if control.isEnabled {
      return StatusChip(text: control.truthLabel, bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
    }
    if control.truthLabel == "read arm" {
      return StatusChip(text: control.truthLabel, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
    }
    return StatusChip(text: control.truthLabel, bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
  }

  private func short(_ s: String) -> String {
    s.count > 16 ? "\(s.prefix(10))...\(s.suffix(4))" : s
  }

  private func firstRunId(_ projection: HomeProjection) -> String? {
    projection.runOutcomeLearningCandidates.first { !$0.runId.isEmpty }?.runId
  }

  private func generatedText(_ generatedAtMs: Int64) -> String {
    guard generatedAtMs > 0 else { return "unknown" }
    let date = Date(timeIntervalSince1970: Double(generatedAtMs) / 1000.0)
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
