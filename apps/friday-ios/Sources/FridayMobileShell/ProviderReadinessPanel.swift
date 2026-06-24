import FridayMobileShellCore
import SwiftUI

struct ProviderReadinessPanel: View {
  let detail: HomeProviderReadinessDetail

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        statusChip(detail.truthLabel)
        statusChip(detail.proofOnly ? "proof only" : "not proof only")
        StatusChip(
          text: detail.ok ? "doctor ok" : "doctor not ok",
          bg: detail.ok ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: detail.ok ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
      HStack(spacing: 6) {
        statusChip(detail.anyAuthenticated ? "some auth" : "none auth")
        statusChip(detail.allAuthenticated ? "all auth" : "partial auth")
      }
      if !detail.readyProviders.isEmpty {
        Text("ready: \(detail.readyProviders.joined(separator: ", "))")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let suggestedTextRoute = detail.suggestedTextRoute {
        Text("text route: \(suggestedTextRoute)")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let suggestedStrongRoute = detail.suggestedStrongRoute {
        Text("strong route: \(suggestedStrongRoute)")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let keyValidationProbed = detail.keyValidationProbed {
        statusChip(keyValidationProbed ? "keys probed" : "keys not probed")
      }
      providerRows
      routeRows
      failoverRows
    }
  }

  private var providerRows: some View {
    ForEach(detail.detected) { provider in
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(provider.provider)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: provider.authenticated ? "authenticated" : "not authenticated",
            bg: provider.authenticated ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: provider.authenticated ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
        }
        Text(provider.detail)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 6) {
          statusChip(provider.installed ? "installed" : "not installed")
          statusChip(provider.truthLabel)
        }
      }
      .padding(.vertical, 3)
    }
  }

  private var routeRows: some View {
    ForEach(detail.routes) { route in
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(route.providerId)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: route.dispatchable ? "dispatchable" : "blocked",
            bg: route.dispatchable ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: route.dispatchable ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
        }
        Text("\(route.model) - \(route.modelSize) - \(route.strength)")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if !route.blockers.isEmpty {
          Text("blockers: \(route.blockers.joined(separator: ", "))")
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.vertical, 3)
    }
  }

  private var failoverRows: some View {
    ForEach(detail.failovers) { failover in
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(failover.direction)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: failover.flagEnabled ? "armed" : "off",
            bg: failover.flagEnabled ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
            fg: failover.flagEnabled ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
        }
        HStack(spacing: 6) {
          statusChip(failover.canEnable ? "can enable" : "blocked")
          if !failover.blockers.isEmpty {
            statusChip("blockers \(failover.blockers.count)")
          }
        }
      }
      .padding(.vertical, 3)
    }
  }

  private func statusChip(_ text: String) -> some View {
    StatusChip(text: text, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
  }
}
