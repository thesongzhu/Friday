import FridayMobileShellCore
import SwiftUI

struct FridayVoiceScreen: View {
  @ObservedObject var viewModel: VoiceReadinessViewModel
  let onOpenVoiceChat: () -> Void

  init(
    viewModel: VoiceReadinessViewModel,
    onOpenVoiceChat: @escaping () -> Void = {}
  ) {
    self.viewModel = viewModel
    self.onOpenVoiceChat = onOpenVoiceChat
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        header
        stateContent
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
    .task {
      if case .idle = viewModel.state {
        await viewModel.refresh()
      }
    }
  }

  private var header: some View {
    GlassPanel {
      HStack(spacing: 12) {
        Image(systemName: "waveform")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(MobileTheme.cyan)
          .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text("Voice")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("input and speech output readiness")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
      }
    }
  }

  @ViewBuilder
  private var stateContent: some View {
    switch viewModel.state {
    case .idle, .loading:
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text("Checking voice readiness")
            .font(.footnote)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
      }
    case let .unavailable(reason):
      UnavailableView(
        reason: reason,
        title: "Voice readiness unavailable",
        detail: "Microphone, speech, and playback gates stay local until the live voice readiness arm is available.",
        systemImage: "waveform",
        identifier: "friday.voice.unavailable")
    case let .loaded(readiness):
      readinessCard(readiness)
      actionsCard(readiness)
      gatesCard(readiness)
    }
  }

  private func readinessCard(_ readiness: MobileVoiceReadiness) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack(spacing: 8) {
          StatusChip(
            text: readiness.voiceLoopReady ? "voice ready" : "not ready",
            bg: readiness.voiceLoopReady ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: readiness.voiceLoopReady ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
          StatusChip(text: readiness.truthLabel, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
        }
        Text(readiness.summary)
          .font(.callout.weight(.medium))
          .foregroundStyle(MobileTheme.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        Text("Readiness plus local voice-loop truth: capture and speech output run from Friday Chat when these gates are ready.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if readiness.canRequestPermission {
          Button {
            Task { await viewModel.requestPermission() }
          } label: {
            Label("Allow Voice", systemImage: "mic.badge.plus")
          }
          .buttonStyle(.borderedProminent)
          .tint(MobileTheme.cyan)
          .disabled(viewModel.state == .loading)
          .accessibilityIdentifier("friday.voice.permission")
        } else {
          Button {
            Task { await viewModel.refresh() }
          } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
          }
          .disabled(viewModel.state == .loading)
        }
      }
    }
    .accessibilityIdentifier("friday.voice.readiness-card")
  }

  private func actionsCard(_ readiness: MobileVoiceReadiness) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Voice I/O Actions", count: VoiceReadinessViewModel.actionRows(for: readiness).count)
        ForEach(VoiceReadinessViewModel.actionRows(for: readiness)) { row in
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: row.enabled ? "checkmark.circle" : "lock.circle")
              .foregroundStyle(row.enabled ? MobileTheme.cyan : MobileTheme.textSecondary)
              .frame(width: 20)
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 6) {
                Text(row.title)
                  .font(.caption.weight(.semibold))
                  .foregroundStyle(MobileTheme.textPrimary)
                StatusChip(
                  text: row.truthLabel,
                  bg: row.enabled ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
                  fg: row.enabled ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
              }
              Text(row.detail)
                .font(.caption2)
                .foregroundStyle(MobileTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if row.id == "permission" {
              Button {
                Task { await viewModel.requestPermission() }
              } label: {
                Text("Allow")
              }
              .buttonStyle(.bordered)
              .disabled(!row.enabled || viewModel.state == .loading)
              .accessibilityIdentifier("friday.voice.permission")
            } else if row.id == "open-chat-loop" {
              Button {
                onOpenVoiceChat()
              } label: {
                Text("Open")
              }
              .buttonStyle(.bordered)
              .disabled(!row.enabled || viewModel.state == .loading)
              .accessibilityLabel("Open Friday Chat voice loop")
              .accessibilityIdentifier("friday.voice.open-chat-loop")
            }
          }
          .padding(.vertical, 3)
        }
      }
    }
    .accessibilityIdentifier("friday.voice.actions-card")
  }

  private func gatesCard(_ readiness: MobileVoiceReadiness) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Voice Gates", count: nil)
        readinessRow(
          title: "Microphone",
          value: readiness.microphone.rawValue,
          healthy: readiness.microphone == .authorized)
        readinessRow(
          title: "Speech recognition",
          value: readiness.speechRecognition.rawValue,
          healthy: readiness.speechRecognition == .authorized)
        readinessRow(
          title: "Speech output provider",
          value: readiness.ttsProviderConfigured ? "configured" : "not configured in this build",
          healthy: readiness.ttsProviderConfigured)
        readinessRow(
          title: "Realtime loop",
          value: readiness.voiceLoopReady ? "ready in Friday Chat" : "blocked until capture and speech output are ready",
          healthy: readiness.voiceLoopReady)
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
        StatusChip(text: "\(count)", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }

  private func readinessRow(title: String, value: String, healthy: Bool) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: healthy ? "checkmark.circle" : "exclamationmark.triangle")
        .foregroundStyle(healthy ? MobileTheme.cyan : MobileTheme.coral)
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(MobileTheme.textPrimary)
        Text(value)
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
    }
  }
}
