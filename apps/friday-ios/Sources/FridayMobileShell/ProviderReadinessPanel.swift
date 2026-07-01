import FridayMobileShellCore
import SwiftUI

struct ProviderReadinessPanel: View {
  let detail: HomeProviderReadinessDetail

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        statusChip(detail.truthLabel)
        statusChip(detail.proofOnly ? "verification view" : "work route view")
        FridayChip(
          text: detail.ok ? "doctor ok" : "doctor not ok",
          bg: detail.ok ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: detail.ok ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
      HStack(spacing: 6) {
        statusChip(detail.anyAuthenticated ? "connected" : "connect accounts")
        statusChip(detail.allAuthenticated ? "all ready" : "some need setup")
      }
      if !detail.readyProviders.isEmpty {
        Text("Ready providers: \(detail.readyProviders.map(productProviderName).joined(separator: ", "))")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let suggestedTextRoute = detail.suggestedTextRoute {
        Text("Text route: \(productProviderName(suggestedTextRoute))")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let suggestedStrongRoute = detail.suggestedStrongRoute {
        Text("Strong route: \(productProviderName(suggestedStrongRoute))")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let keyValidationProbed = detail.keyValidationProbed {
        statusChip(keyValidationProbed ? "keys checked" : "check keys")
      }
      if !detail.confirmedValidKeys.isEmpty {
        Text("Confirmed keys: \(detail.confirmedValidKeys.map(productProviderName).joined(separator: ", "))")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      providerRows
      routeRows
      keyRows
      failoverRows
    }
  }

  private var providerRows: some View {
    ForEach(detail.detected) { provider in
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(productProviderName(provider.provider))
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          FridayChip(
            text: provider.authenticated ? "connected" : "connect",
            bg: provider.authenticated ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: provider.authenticated ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
        }
        Text(productProviderDetail(provider.detail))
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 6) {
          statusChip(provider.installed ? "installed" : "install needed")
          statusChip(productTruthLabel(provider.truthLabel))
        }
      }
      .padding(.vertical, 3)
    }
  }

  private var routeRows: some View {
    ForEach(detail.routes) { route in
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(productProviderName(route.providerId))
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          FridayChip(
            text: route.dispatchable ? "ready" : "needs setup",
            bg: route.dispatchable ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: route.dispatchable ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
        }
        Text("\(productProviderName(route.model)) - \(productProviderName(route.modelSize)) - \(productProviderName(route.strength))")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if !route.blockers.isEmpty {
          Text("Needs setup: \(route.blockers.map(productBlockerLabel).joined(separator: ", "))")
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
          FridayChip(
            text: failover.flagEnabled ? "armed" : "not armed",
            bg: failover.flagEnabled ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
            fg: failover.flagEnabled ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
        }
        HStack(spacing: 6) {
          statusChip(failover.canEnable ? "can enable" : "needs setup")
          if !failover.blockers.isEmpty {
            statusChip("setup \(failover.blockers.count)")
          }
        }
      }
      .padding(.vertical, 3)
    }
  }

  private var keyRows: some View {
    ForEach(detail.keyValidations) { key in
      HStack(spacing: 8) {
        Text(productProviderName(key.provider))
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(MobileTheme.textPrimary)
        Spacer()
        FridayChip(
          text: productBlockerLabel(key.label),
          bg: key.isConfirmedValid ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
          fg: key.isConfirmedValid ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
      }
      .padding(.vertical, 3)
    }
  }

  private func statusChip(_ text: String) -> some View {
    FridayChip(text: text, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
  }

  private func productProviderName(_ raw: String) -> String {
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    switch normalized.lowercased() {
    case "codex": return "Codex"
    case "claude", "anthropic": return "Claude"
    case "deepseek": return "DeepSeek"
    case "deepseek_pro", "deepseek-pro": return "DeepSeek Pro"
    case "gpt-5.5", "gpt-5", "openai": return normalized.uppercased()
    case "text", "small": return "fast"
    case "strong", "large": return "strong"
    case "route_validation_not_ok": return "route check needed"
    case "api_key_missing": return "login needed"
    default:
      return productReadable(normalized)
    }
  }

  private func productProviderDetail(_ raw: String) -> String {
    let normalized = raw.lowercased()
    if normalized.contains("api_key_missing") {
      return "Connect this provider before Friday routes work there."
    }
    if normalized.contains("route_disabled") || normalized.contains("route_validation_not_ok") {
      return "This route needs to be enabled and checked before Friday can use it."
    }
    if normalized.contains("authenticated") {
      return "Provider login is available for governed work."
    }
    return productReadable(raw)
  }

  private func productTruthLabel(_ raw: String) -> String {
    let normalized = raw.lowercased()
    if normalized.contains("live") { return "live" }
    if normalized.contains("doctor") { return "checked" }
    if normalized.contains("proof") { return "receipt" }
    return productReadable(raw)
  }

  private func productBlockerLabel(_ raw: String) -> String {
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch normalized {
    case "api_key_missing": return "login needed"
    case "route_validation_not_ok": return "route check needed"
    case "friday_claude_route_disabled": return "enable Claude route"
    case "friday_codex_route_disabled": return "enable Codex route"
    case "friday_deepseek_pro_route_disabled": return "enable DeepSeek Pro route"
    case "blocked": return "needs setup"
    case "off": return "not armed"
    default: return productReadable(raw)
    }
  }

  private func productReadable(_ raw: String) -> String {
    raw
      .replacingOccurrences(of: "_", with: " ")
      .replacingOccurrences(of: "-", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
