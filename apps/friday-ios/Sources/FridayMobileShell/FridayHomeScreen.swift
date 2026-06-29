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
/// server renders AS truth (honest-unavailable), never a fabricated ready Home. Governed recovery
/// actions only appear when the live projection exposes WorkItem retry/cancel affordances.
struct FridayHomeScreen: View {
  @ObservedObject var viewModel: HomeViewModel
  let showPairingProvisioning: Bool
  @State private var pairingQRPayload = ""
  @State private var showingPairingScanner = false
  @State private var pairingTask: Task<Void, Never>?

  init(viewModel: HomeViewModel, showPairingProvisioning: Bool = false) {
    self.viewModel = viewModel
    self.showPairingProvisioning = showPairingProvisioning
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        if showPairingProvisioning {
          devicePairingCard(viewModel.devicePairing, viewModel.state.projection?.t3ProvisioningStatus)
        }

        switch viewModel.state {
        case .idle, .loading:
          designIntro(
            title: greetingTitle,
            subtitle: "Reading Friday's live projection.")
          selectedHomeHero
          loadingView
        case .loaded(let projection):
          loadedContent(projection)
        case let .unavailable(reason):
          designIntro(
            title: greetingTitle,
            subtitle: "Connect Friday to the live Hub to see your current work.")
          selectedHomeHero
          UnavailableView(
            reason: reason,
            title: "Connect Friday",
            detail: "Your Hub view is not connected on this device yet.")
          unavailableQueueSection(
            title: "Needs Me",
            emptyText: "Approvals, memory candidates, and recovery items will appear here after connection.")
          unavailableQueueSection(
            title: "Running",
            emptyText: "Active work and provider progress will appear here after connection.")
        }
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
    designIntro(
      title: greetingTitle,
      subtitle: "Here is what Friday is watching for you.")
    selectedHomeHero

    // Honest status banner — any stale/offline/error label rides AS truth.
    if !projection.statusLabels.isEmpty {
      StatusBanner(labels: projection.statusLabels)
    }

    commandQueueSection(title: "Needs Me", rows: needsRows(projection), emptyText: "No approval, memory, or recovery items need action.")
    commandQueueSection(title: "Running", rows: runningRows(projection), emptyText: "No active Friday work is visible in this projection.")
    evidenceFlowCard(projection)
    if projection.isLoadedEmpty {
      loadedEmptyCard(projection)
    }
    statusCard(projection)
    refsCard(projection)
  }

  /// The selected mobile home starts with a quiet greeting, then the bare Hero Pet stage.
  /// It must not become an engineering diagnostic header; proof/truth details live below.
  private func designIntro(title: String, subtitle: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.system(size: 30, weight: .bold))
        .foregroundStyle(MobileTheme.textPrimary)
      Text(subtitle)
        .font(.callout)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(subtitle)")
    .accessibilityIdentifier("friday.home.selected-design-intro")
  }

  private var selectedHomeHero: some View {
    HeroPet()
      .accessibilityIdentifier("friday.home.selected-hero-pet")
  }

  private var greetingTitle: String {
    let hour = Calendar.current.component(.hour, from: Date())
    switch hour {
    case 5..<12: return "Good morning"
    case 12..<18: return "Good afternoon"
    default: return "Good evening"
    }
  }

  private struct QueueRow: Identifiable, Equatable {
    let id: String
    let icon: String
    let iconBg: Color
    let title: String
    let subtitle: String
    let chip: String
    let urgent: Bool
    let workItem: HomeWorkItem?
  }

  private func needsRows(_ projection: HomeProjection) -> [QueueRow] {
    var rows: [QueueRow] = projection.workItems
      .filter(\.needsAttention)
      .prefix(4)
      .map { item in
        QueueRow(
          id: "work-\(item.id)",
          icon: item.canRetry ? "arrow.clockwise" : "checkmark.shield",
          iconBg: item.canRetry ? MobileTheme.coralSoft : MobileTheme.cyanSoft,
          title: item.title,
          subtitle: item.blockingReason.isEmpty ? "state: \(item.state)" : item.blockingReason,
          chip: item.canRetry ? "needs" : item.state,
          urgent: item.canRetry || item.state == "stale" || item.state == "blocked",
          workItem: item)
      }
    rows.append(contentsOf: projection.memoryCandidates.prefix(2).map { candidate in
      QueueRow(
        id: "memory-\(candidate.id)",
        icon: "cylinder.split.1x2",
        iconBg: Color(red: 0.72, green: 0.45, blue: 0.16).opacity(0.14),
        title: "Review memory candidate",
        subtitle: candidate.preview,
        chip: candidate.grantsMemoryAuthority ? "authority" : "review",
        urgent: false,
        workItem: nil)
    })
    rows.append(contentsOf: projection.runOutcomeLearningCandidates.prefix(2).map { candidate in
      QueueRow(
        id: "learning-\(candidate.id)",
        icon: "brain.head.profile",
        iconBg: MobileTheme.cyanSoft,
        title: candidate.summary,
        subtitle: "candidate: \(candidate.kind) · \(candidate.state)",
        chip: "confirm",
        urgent: false,
        workItem: nil)
    })
    return Array(rows.prefix(6))
  }

  private func runningRows(_ projection: HomeProjection) -> [QueueRow] {
    var rows: [QueueRow] = projection.workItems
      .filter { !$0.done && !$0.needsAttention }
      .prefix(4)
      .map { item in
        QueueRow(
          id: "running-\(item.id)",
          icon: "sparkles",
          iconBg: MobileTheme.cyanSoft,
          title: item.title,
          subtitle: "owner: \(item.owner)",
          chip: item.state,
          urgent: false,
          workItem: nil)
      }
    if let route = projection.routeSelected {
      rows.append(QueueRow(
        id: "route-\(route)",
        icon: "arrow.triangle.branch",
        iconBg: MobileTheme.cyanSoft,
        title: "\(route.capitalized) route",
        subtitle: projection.routeAlternatives.isEmpty
          ? "selected by route advisor"
          : "alternatives: \(projection.routeAlternatives.joined(separator: ", "))",
        chip: "ok",
        urgent: false,
        workItem: nil))
    }
    rows.append(contentsOf: projection.transcriptEvents.prefix(3).map { event in
      QueueRow(
        id: "event-\(event.id)",
        icon: "waveform.path.ecg",
        iconBg: MobileTheme.chipNeutralBG,
        title: event.summary,
        subtitle: "\(event.sectionTitle) · \(event.truthLabel)",
        chip: event.status,
        urgent: false,
        workItem: nil)
    })
    return Array(rows.prefix(6))
  }

  private func commandQueueSection(title: String, rows: [QueueRow], emptyText: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(title.uppercased())
          .font(.caption.weight(.bold))
          .tracking(2)
          .foregroundStyle(MobileTheme.textSecondary.opacity(0.72))
        Spacer()
        if !rows.isEmpty {
          Text("\(rows.count) now")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(MobileTheme.cyan)
        }
      }
      if rows.isEmpty {
        Text(emptyText)
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
          .padding(.vertical, 4)
      } else {
        ForEach(rows) { row in
          commandQueueRow(row)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("friday.home.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
  }

  private func unavailableQueueSection(title: String, emptyText: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text(title.uppercased())
          .font(.caption.weight(.bold))
          .tracking(2)
          .foregroundStyle(MobileTheme.textSecondary.opacity(0.72))
        Spacer()
        StatusChip(text: "connect", bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
      }
      GlassPanel {
        Text(emptyText)
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("friday.home.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
  }

  private func commandQueueRow(_ row: QueueRow) -> some View {
    let recoveryState = row.workItem.flatMap { viewModel.workItemStatusStates[$0.id] }
    return GlassPanel {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 13) {
          ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(row.iconBg)
            Image(systemName: row.icon)
              .font(.system(size: 18, weight: .semibold))
              .foregroundStyle(row.urgent ? MobileTheme.coral : MobileTheme.cyan)
          }
          .frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 4) {
            Text(row.title)
              .font(.headline)
              .foregroundStyle(MobileTheme.textPrimary)
              .lineLimit(2)
            Text(row.subtitle)
              .font(.subheadline)
              .foregroundStyle(MobileTheme.textSecondary)
              .lineLimit(2)
          }
          Spacer(minLength: 8)
          StatusChip(
            text: row.chip,
            bg: row.urgent ? MobileTheme.chipWarnBG : MobileTheme.chipNeutralBG,
            fg: row.urgent ? MobileTheme.chipWarnFG : MobileTheme.chipNeutralFG)
          Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(MobileTheme.textSecondary.opacity(0.55))
        }
        if let item = row.workItem, item.canRetry || item.canCancel {
          workItemRecoveryControls(item, state: recoveryState)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.title). \(row.subtitle). \(row.chip)")
  }

  @ViewBuilder
  private func workItemRecoveryControls(_ item: HomeWorkItem, state: HomeLearningDecisionState?) -> some View {
    HStack(spacing: 8) {
      if item.canRetry {
        Button {
          Task { await viewModel.retryWorkItem(item) }
        } label: {
          Image(systemName: "arrow.clockwise")
            .frame(width: 26, height: 26)
        }
        .buttonStyle(.bordered)
        .disabled(candidateDecisionControlsDisabled(state))
        .accessibilityLabel("Retry WorkItem")
        .accessibilityIdentifier("friday.home.retry-work-item")
      }
      if item.canCancel {
        Button {
          Task { await viewModel.cancelWorkItem(item) }
        } label: {
          Image(systemName: "stop.circle")
            .frame(width: 26, height: 26)
        }
        .buttonStyle(.bordered)
        .disabled(candidateDecisionControlsDisabled(state))
        .accessibilityLabel("Cancel WorkItem")
        .accessibilityIdentifier("friday.home.cancel-work-item")
      }
    }
    candidateDecisionStateView(state, pendingText: "Updating WorkItem...")
  }

  private func candidateDecisionControlsDisabled(_ state: HomeLearningDecisionState?) -> Bool {
    guard let state else { return false }
    return state.isSent || state.isTerminal
  }

  @ViewBuilder
  private func candidateDecisionStateView(_ state: HomeLearningDecisionState?, pendingText: String) -> some View {
    switch state {
    case .sent:
      Text(pendingText)
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

  private func statusCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Status").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: viewModel.isOnline ? "online" : "refresh",
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
    .accessibilityLabel(viewModel.isOnline ? "Friday status online" : "Friday status needs refresh")
    .accessibilityIdentifier("friday.home.status-card")
  }

  private func evidenceFlowCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack(alignment: .firstTextBaseline) {
          Text("Evidence flow")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: projection.timelinePages.isEmpty ? "waiting" : "\(projection.timelinePages.count) pages",
            bg: projection.timelinePages.isEmpty ? MobileTheme.chipNeutralBG : MobileTheme.chipPendingBG,
            fg: projection.timelinePages.isEmpty ? MobileTheme.chipNeutralFG : MobileTheme.chipPendingFG)
        }

        if projection.timelinePages.isEmpty {
          Text("No bounded mission timeline page is projected yet.")
            .font(.footnote)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          ForEach(projection.timelinePages.prefix(3)) { page in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 8) {
                Image(systemName: "point.topleft.down.curvedto.point.bottomright.up")
                  .font(.system(size: 15, weight: .semibold))
                  .foregroundStyle(MobileTheme.cyan)
                  .accessibilityHidden(true)
                Text(page.title)
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(MobileTheme.textPrimary)
                  .lineLimit(1)
                Spacer(minLength: 8)
                StatusChip(text: page.statusText, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
              }
              if !page.summary.isEmpty {
                Text(page.summary)
                  .font(.caption)
                  .foregroundStyle(MobileTheme.textSecondary)
                  .lineLimit(2)
              }
              HStack(spacing: 8) {
                RefPill(label: "cursor", ref: page.cursor ?? "start")
                if let next = page.nextCursor {
                  RefPill(label: "next", ref: next)
                }
                if page.refsCount > 0 {
                  RefPill(label: "refs", ref: "\(page.refsCount)")
                }
              }
            }
            .padding(.vertical, 2)
          }
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      projection.timelinePages.isEmpty
        ? "Evidence flow waiting for bounded mission timeline pages"
        : "Evidence flow shows \(projection.timelinePages.count) bounded mission timeline pages")
    .accessibilityIdentifier("friday.home.evidence-flow")
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
            text: pairingReadinessLabel(readiness),
            bg: pairingReadinessBackground(readiness),
            fg: pairingReadinessForeground(readiness))
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
            text: readiness.readLiveRequested ? "read link ready" : "read link pending",
            bg: readiness.readLiveRequested ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
            fg: readiness.readLiveRequested ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
          StatusChip(
            text: readiness.writeLiveRequested ? "write link ready" : "write link pending",
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
      "Device pairing \(pairingReadinessLabel(readiness)). \(readiness.reason). \(t3Status?.homeSummary ?? "Hub provisioning status is waiting for a live projection.")")
    .accessibilityIdentifier("friday.home.device-pairing-card")
  }

  private func pairingReadinessLabel(_ readiness: DevicePairingReadiness) -> String {
    switch readiness.mode {
    case .disabled:
      return "QR available"
    case .ready:
      return "device key ready"
    case .unavailable:
      return "blocked"
    }
  }

  private func pairingReadinessBackground(_ readiness: DevicePairingReadiness) -> Color {
    switch readiness.mode {
    case .disabled:
      return MobileTheme.chipNeutralBG
    case .ready:
      return MobileTheme.chipPendingBG
    case .unavailable:
      return MobileTheme.chipWarnBG
    }
  }

  private func pairingReadinessForeground(_ readiness: DevicePairingReadiness) -> Color {
    switch readiness.mode {
    case .disabled:
      return MobileTheme.chipNeutralFG
    case .ready:
      return MobileTheme.chipPendingFG
    case .unavailable:
      return MobileTheme.chipWarnFG
    }
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
          startPairing()
        } label: {
          Label("Pair", systemImage: "link.badge.plus")
        }
        .buttonStyle(.borderedProminent)
        .disabled(pairingQRPayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || viewModel.pairingAttempt.mode == .sending)
        .accessibilityIdentifier("friday.home.pair-button")

        if viewModel.pairingAttempt.mode == .unavailable || viewModel.pairingAttempt.mode == .denied {
          Button {
            startPairing()
          } label: {
            Label("Retry", systemImage: "arrow.clockwise")
          }
          .buttonStyle(.bordered)
          .disabled(pairingQRPayload.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityIdentifier("friday.home.pairing-retry-button")
        }

        if viewModel.pairingAttempt.mode == .sending {
          Button {
            cancelPairing()
          } label: {
            Label("Cancel", systemImage: "xmark")
          }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("friday.home.pairing-cancel-button")
        }

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

  private func startPairing() {
    pairingTask?.cancel()
    pairingTask = Task {
      await viewModel.pairScannedQR(pairingQRPayload)
      await MainActor.run {
        pairingTask = nil
      }
    }
  }

  private func cancelPairing() {
    pairingTask?.cancel()
    pairingTask = nil
    viewModel.cancelPairingAttempt()
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
        StatusChip(text: "waiting", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
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
        Text("Connect to the live Hub to see PairAck, trust grant, and context passport status.")
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
  private func refsCard(_ projection: HomeProjection) -> some View {
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
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.circle")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(MobileTheme.chipWarnFG)
        .frame(width: 24, height: 24)
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 6) {
          ForEach(labels, id: \.self) { label in
            StatusChip(text: displayLabel(for: label), bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
          }
        }
        .fixedSize(horizontal: false, vertical: true)
        Text(summary)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .fill(MobileTheme.coralSoft))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday projection needs attention: \(labels.joined(separator: ", ")). \(summary)")
    .accessibilityIdentifier("friday.home.status-banner")
  }

  private var summary: String {
    let normalized = Set(labels.map { $0.lowercased() })
    if normalized.contains("offline") {
      return "Friday can see the Hub, but this device needs a fresh live connection before acting."
    }
    if normalized.contains("stale") {
      return "Friday can see the Hub, but this view should be refreshed before acting."
    }
    if normalized.contains("error") {
      return "Friday can see the Hub, but one item needs attention before it is safe to act."
    }
    return "Friday can see the Hub, with a status note preserved for review."
  }

  private func displayLabel(for rawLabel: String) -> String {
    switch rawLabel.lowercased() {
    case "offline":
      return "connect"
    case "stale":
      return "refresh"
    case "error":
      return "attention"
    default:
      return rawLabel
    }
  }
}

/// Rendered when `fetchWorkbench()` throws (503 / offline / dark server / projection error).
/// The honest "unavailable" state — never a fake-ready Home.
struct UnavailableView: View {
  let reason: String
  var title = "Connect Friday"
  var detail = "A live Hub connection is needed before this screen can show current work."
  var systemImage = "exclamationmark.triangle"
  var identifier = "friday.home.unavailable"

  var body: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack(spacing: 12) {
          Image(systemName: systemImage)
            .font(.system(size: 24, weight: .semibold))
            .foregroundStyle(MobileTheme.coral)
            .frame(width: 34, height: 34)
          VStack(alignment: .leading, spacing: 4) {
            Text(title)
              .font(.headline)
              .foregroundStyle(MobileTheme.textPrimary)
            Text(detail)
              .font(.caption)
              .foregroundStyle(MobileTheme.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer()
          StatusChip(text: "connect", bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
        }
        Text(userFacingReason)
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 8) {
          StatusChip(text: "live only", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
          StatusChip(text: "safe view", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(detail). \(userFacingReason). Friday is showing a live-only safe view.")
    .accessibilityIdentifier(identifier)
  }

  private var userFacingReason: String {
    let normalized = reason.lowercased()
    if normalized.contains("offline") || normalized.contains("connection") || normalized.contains("transport") {
      return "Friday cannot reach the live Hub from this device. Check the connection, then refresh."
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
