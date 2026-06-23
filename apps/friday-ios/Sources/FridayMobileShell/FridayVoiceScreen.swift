import FridayMobileShellCore
import SwiftUI

struct FridayVoiceScreen: View {
  @ObservedObject var viewModel: VoiceReadinessViewModel

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
      UnavailableView(reason: reason)
    case let .loaded(readiness):
      readinessCard(readiness)
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
        Text("Readiness only; realtime voice starts after capture and TTS gates are ready.")
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
          title: "TTS provider",
          value: readiness.ttsProviderConfigured ? "configured" : "not configured in this build",
          healthy: readiness.ttsProviderConfigured)
        readinessRow(
          title: "Realtime loop",
          value: readiness.voiceLoopReady ? "ready" : "blocked until capture and TTS are ready",
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
