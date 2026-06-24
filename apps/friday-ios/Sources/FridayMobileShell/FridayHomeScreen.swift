import FridayMobileShellCore
import FridayRustClient
import SwiftUI

/// Friday Home (locked: launch = Home; homeLayout = Status + chat-entry;
/// petProminence = heroPet).
///
/// Home = Status + heroPet, derived from a READ-ONLY refs-only `HomeProjection` read over the
/// sealed-WS read seam (`SealedWSReadClient`). The Friday Chat entry is the top-bar 💬 (wired in
/// `RootView`) — there is NO on-Home chat card and NO composer here.
///
/// Truth rules: the projection is refs-only (counts/labels/ids — never a body); the
/// `runtimeFeedStatus` + `statusLabels` ride AS-IS (never upgraded); a 503 / offline / dark
/// server renders AS truth (honest-unavailable), never a fabricated ready Home. The only action
/// is Refresh (re-read) — there is NO mutating action on this surface.
struct FridayHomeScreen: View {
  @ObservedObject var viewModel: HomeViewModel
  @State private var pairingQRPayload = ""
  @State private var showingPairingScanner = false

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        // The 155px pure-dog Hero Pet card ALWAYS anchors Home (locked: petProminence = heroPet
        // on Friday Home, mobile-gallery.html `heroBlock()`). It is a LOCAL, zero-token mood
        // companion — independent of the read seam — so it renders regardless of read state
        // (loading / loaded / honest-unavailable). It carries NO status text/badges; the honest
        // read-seam status truth lives in the state-driven content below.
        HeroPet().padding(.top, 6)

        switch viewModel.state {
        case .idle, .loading:
          loadingView
        case .loaded(let projection):
          loadedContent(projection)
        case let .unavailable(reason):
          UnavailableView(reason: reason)
        }

        devicePairingCard(viewModel.devicePairing, viewModel.state.projection?.t3ProvisioningStatus)
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
    .sheet(isPresented: $showingPairingScanner) {
      PairingQRScannerView(
        onScan: { payload in
          pairingQRPayload = payload
          viewModel.preflightPairingQR(payload)
          showingPairingScanner = false
        },
        onCancel: {
          showingPairingScanner = false
        })
        .ignoresSafeArea()
    }
  }

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading hub projection…")
        .font(.footnote)
        .foregroundStyle(MobileTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, minHeight: 160)
  }

  /// The state-driven Home content BELOW the always-present Hero Pet card. Refs-only (INV-5);
  /// truth labels ride AS-IS; never a fabricated ready view.
  @ViewBuilder
  private func loadedContent(_ projection: HomeProjection) -> some View {
    // Honest status banner — any stale/offline/error label rides AS truth.
    if !projection.statusLabels.isEmpty {
      StatusBanner(labels: projection.statusLabels)
    }

    statusCard(projection)
    if projection.isLoadedEmpty {
      loadedEmptyCard(projection)
    }
    workItemsCard(projection)
  }

  private func statusCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Status").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: viewModel.isOnline ? "online" : "offline / stale",
            bg: viewModel.isOnline ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: viewModel.isOnline ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
        }
        HStack(spacing: 8) {
          Image(systemName: "antenna.radiowaves.left.and.right")
            .foregroundStyle(MobileTheme.textSecondary).frame(width: 22)
          // The runtime feed status TRUTH label rides AS-IS — never upgraded.
          Text("feed: \(projection.runtimeFeedStatus)")
            .font(.subheadline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
        }
        RefPill(label: "mission_id", ref: projection.missionId)
        if let summary = projection.routeDecisionSummary {
          RefPill(label: "route", ref: summary)
        }
        RefPill(label: "protocol", ref: "v\(fridayCurrentSchemaVersion)")
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(viewModel.isOnline ? "Friday status online" : "Friday status offline or stale")
    .accessibilityIdentifier("friday.home.status-card")
  }

  private func devicePairingCard(
    _ readiness: DevicePairingReadiness,
    _ t3Status: HomeT3ProvisioningStatus?
  ) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Device pairing").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: readiness.mode.rawValue,
            bg: readiness.mode == .ready ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
            fg: readiness.mode == .ready ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
        }
        Text(readiness.reason)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if let publicKeyHex = readiness.publicKeyHex {
          RefPill(label: "device_pubkey", ref: publicKeyHex)
        }
        pairingEntry
        pairingPreflightRows(viewModel.pairingPreflight)
        pairingAttemptRows(viewModel.pairingAttempt)
        hubProvisioningRows(t3Status)
        HStack(spacing: 8) {
          StatusChip(
            text: readiness.readLiveRequested ? "read requested" : "read off",
            bg: readiness.readLiveRequested ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
            fg: readiness.readLiveRequested ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
          StatusChip(
            text: readiness.writeLiveRequested ? "write requested" : "write off",
            bg: readiness.writeLiveRequested ? MobileTheme.chipWarnBG : MobileTheme.chipNeutralBG,
            fg: readiness.writeLiveRequested ? MobileTheme.chipWarnFG : MobileTheme.chipNeutralFG)
        }
        Text(readiness.nextStep)
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "Device pairing \(readiness.mode.rawValue). \(readiness.reason). \(t3Status?.homeSummary ?? "Hub T3 projection is not loaded.")")
    .accessibilityIdentifier("friday.home.device-pairing-card")
  }

  private var pairingEntry: some View {
    VStack(alignment: .leading, spacing: 8) {
      TextField("Paste Hub pairing QR JSON", text: $pairingQRPayload, axis: .vertical)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .lineLimit(2...5)
        .font(.caption)
        .padding(10)
        .background(Color.white.opacity(0.54), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("friday.home.pairing-qr-input")
      HStack(spacing: 8) {
        Button {
          viewModel.preflightPairingQR(pairingQRPayload)
        } label: {
          Label("Check", systemImage: "checkmark.shield")
        }
        .buttonStyle(.bordered)
        .disabled(pairingQRPayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("friday.home.pairing-preflight-button")

        Button {
          Task { await viewModel.pairScannedQR(pairingQRPayload) }
        } label: {
          Label("Pair", systemImage: "link.badge.plus")
        }
        .buttonStyle(.borderedProminent)
        .disabled(pairingQRPayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || viewModel.pairingAttempt.mode == .sending)
        .accessibilityIdentifier("friday.home.pair-button")

        Button {
          showingPairingScanner = true
        } label: {
          Label("Scan", systemImage: "qrcode.viewfinder")
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("friday.home.pairing-scan-button")

        Button {
          pairingQRPayload = ""
          viewModel.clearPairingPreflight()
        } label: {
          Image(systemName: "xmark.circle")
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("Clear pairing QR")
        .accessibilityIdentifier("friday.home.pairing-clear-button")
      }
      .font(.caption)
    }
  }

  @ViewBuilder
  private func pairingPreflightRows(_ preflight: MobilePairingPreflight) -> some View {
    if preflight.mode != .empty {
      Divider().opacity(0.35)
      HStack {
        Text("QR preflight").font(.caption.weight(.semibold)).foregroundStyle(MobileTheme.textPrimary)
        Spacer()
        StatusChip(
          text: preflight.mode.rawValue,
          bg: preflight.mode == .ready ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: preflight.mode == .ready ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
      Text(preflight.reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if let projection = preflight.projection {
        RefPill(label: "hub_id", ref: projection.hubId)
        RefPill(label: "pairing_id", ref: projection.pairingId)
      }
      if let publicKeyHex = preflight.devicePublicKeyHex {
        RefPill(label: "pairing_device_pubkey", ref: publicKeyHex)
      }
      Text(preflight.nextStep)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private func pairingAttemptRows(_ attempt: MobilePairingAttempt) -> some View {
    if attempt.mode != .idle {
      Divider().opacity(0.35)
      HStack {
        Text("PairAck").font(.caption.weight(.semibold)).foregroundStyle(MobileTheme.textPrimary)
        Spacer()
        StatusChip(
          text: attempt.mode.rawValue,
          bg: attempt.mode == .accepted ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: attempt.mode == .accepted ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
      Text(attempt.reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if let hubId = attempt.hubId {
        RefPill(label: "ack_hub_id", ref: hubId)
      }
      if let pairingId = attempt.pairingId {
        RefPill(label: "ack_pairing_id", ref: pairingId)
      }
      if let deviceId = attempt.deviceId {
        RefPill(label: "ack_device_id", ref: deviceId)
      }
      if let errorCode = attempt.errorCode {
        RefPill(label: "ack_error", ref: errorCode)
      }
    }
  }

  @ViewBuilder
  private func hubProvisioningRows(_ status: HomeT3ProvisioningStatus?) -> some View {
    Divider().opacity(0.35)
    HStack {
      Text("Hub provisioning").font(.caption.weight(.semibold)).foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      if let status {
        StatusChip(
          text: status.homeStatusLabel,
          bg: status.isFullyProvisioned ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: status.isFullyProvisioned ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      } else {
        StatusChip(text: "not loaded", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
    if let status {
      Text(status.homeSummary)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if !status.missingOperatorSteps.isEmpty {
        RefPill(label: "missing", ref: status.missingOperatorSteps.joined(separator: ", "))
      }
      if let device = status.latestDevice {
        RefPill(label: "latest_device", ref: device.deviceId)
        RefPill(label: "device_fingerprint", ref: device.pubkeyFingerprint)
      }
      RefPill(label: "device_identity_count", ref: String(status.deviceIdentityCount))
      RefPill(label: "trusted_device_count", ref: String(status.trustedDeviceCount))
      RefPill(label: "active_trusted_device_count", ref: String(status.activeTrustedDeviceCount))
      RefPill(label: "trust_grant_count", ref: String(status.trustGrantCount))
      RefPill(label: "active_trust_grant_count", ref: String(status.activeTrustGrantCount))
      RefPill(label: "context_passport_count", ref: String(status.contextPassportCount))
      RefPill(label: "context_passport_item_count", ref: String(status.contextPassportItemCount))
      RefPill(label: "truth", ref: status.truthLabel)
    } else {
      Text("Open a loaded Hub projection to see PairAck, trust grant, and context passport status.")
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func loadedEmptyCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack(spacing: 8) {
          Image(systemName: "tray")
            .foregroundStyle(MobileTheme.textSecondary)
            .frame(width: 22)
            .accessibilityHidden(true)
          Text("No active Friday work yet")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
        }
        Text("Connected to \(projection.runtimeFeedStatus); this owner has no visible missions, work items, or learning candidates in the current projection.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday is connected, with no active work for this owner")
    .accessibilityIdentifier("friday.home.loaded-empty")
  }

  /// The refs-only work-item view: COUNTS + id refs only (INV-5) — never a body. The read-seam
  /// projection is refs-only, so this surface presents the work-item id refs honestly without
  /// fabricating per-item lifecycle/owner detail the read seam does not surface to this view.
  private func workItemsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Work items").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: "\(projection.workItemIds.count) ref\(projection.workItemIds.count == 1 ? "" : "s")",
            bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
        }
        if projection.workItemIds.isEmpty {
          Text("No work-item refs in this projection.")
            .font(.caption).foregroundStyle(MobileTheme.textSecondary)
        } else {
          Text("refs only — open the Mission Workbench for detail")
            .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
          ForEach(projection.workItemIds, id: \.self) { id in
            RefPill(label: "workItemId", ref: id)
          }
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Work items, \(projection.workItemIds.count) references")
    .accessibilityIdentifier("friday.home.work-items-card")
  }
}

/// Honest banner for stale/offline/error labels. Rendered AS truth, never upgraded. The labels
/// are the projection's raw `statusLabels` strings (ride AS-IS off the read-seam projection).
struct StatusBanner: View {
  let labels: [String]

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.circle").foregroundStyle(MobileTheme.chipWarnFG)
      ForEach(labels, id: \.self) { label in
        StatusChip(text: label.uppercased(), bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
      }
      Text("flagged — rendered as-is")
        .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
      Spacer()
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .fill(MobileTheme.coralSoft))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday projection flagged: \(labels.joined(separator: ", "))")
    .accessibilityIdentifier("friday.home.status-banner")
  }
}

/// Rendered when `fetchWorkbench()` throws (503 / offline / dark server / projection error).
/// The honest "unavailable" state — never a fake-ready Home.
struct UnavailableView: View {
  let reason: String

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 28)).foregroundStyle(MobileTheme.coral)
      Text("Friday is offline")
        .font(.headline).foregroundStyle(MobileTheme.textPrimary)
      Text(reason)
        .font(.footnote).foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
      Text("No cached or fabricated status is shown.")
        .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
    }
    .padding(28)
    .frame(maxWidth: .infinity, minHeight: 200)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday is offline. \(reason). No cached or fabricated status is shown.")
    .accessibilityIdentifier("friday.home.unavailable")
  }
}
