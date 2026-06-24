import FridayMobileShellCore
import SwiftUI

struct FridayProviderAuthScreen: View {
  @ObservedObject var viewModel: HomeViewModel

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        header
        doctorActionCard
        detailCard
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
    .task {
      if case .idle = viewModel.detailState {
        await viewModel.loadDetail(.providersDoctor(probe: nil))
      }
    }
  }

  private var header: some View {
    GlassPanel {
      HStack(spacing: 12) {
        Image(systemName: "person.badge.key")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(MobileTheme.cyan)
          .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text("Provider/Auth")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("read-only provider doctor; no secrets are stored here")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
      }
    }
    .accessibilityIdentifier("friday.provider-auth.header")
  }

  private var doctorActionCard: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        Text("Provider Doctor")
          .font(.headline)
          .foregroundStyle(MobileTheme.textPrimary)
        Text("Checks provider CLI/auth/route readiness through the Hub read arm. This surface never asks for, stores, or displays provider secrets.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Button {
          Task { await viewModel.loadDetail(.providersDoctor(probe: nil)) }
        } label: {
          Label("Check Provider Auth", systemImage: "stethoscope")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(MobileTheme.cyan)
        .disabled(viewModel.detailState.isLoading)
        .accessibilityIdentifier("friday.provider-auth.check")
      }
    }
  }

  @ViewBuilder
  private var detailCard: some View {
    switch viewModel.detailState {
    case .idle:
      EmptyView()
    case .loading:
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text("Reading provider doctor")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .loaded(let detail):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          HStack {
            Text(detail.title)
              .font(.headline)
              .foregroundStyle(MobileTheme.textPrimary)
            Spacer()
            StatusChip(
              text: detail.providerReadiness == nil ? "not provider doctor" : "read",
              bg: detail.providerReadiness == nil ? MobileTheme.chipWarnBG : MobileTheme.chipPendingBG,
              fg: detail.providerReadiness == nil ? MobileTheme.chipWarnFG : MobileTheme.chipPendingFG)
          }
          Text(detail.summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if let providerReadiness = detail.providerReadiness {
            ProviderReadinessPanel(detail: providerReadiness)
          } else {
            Text("The latest read result is not a provider doctor projection.")
              .font(.caption)
              .foregroundStyle(MobileTheme.textSecondary)
          }
          ForEach(detail.refs, id: \.self) { ref in
            RefPill(label: "proof", ref: ref)
          }
        }
      }
      .accessibilityIdentifier("friday.provider-auth.detail")
    case .unavailable(let title, let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          Text(title)
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text(reason)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}
