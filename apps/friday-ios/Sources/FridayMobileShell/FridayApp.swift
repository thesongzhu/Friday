// Friday — native iOS app shell (the v1 mobile UI), now wired to the REAL Rust clients.
//
// LOCKED mobile baseline (friday-design-handoff-20260602/saved/mobile-selection.json):
//   launch = Home; homeLayout = Status + chat-entry (the chat entry is the top-bar
//   💬 — NO on-Home chat card; the composer lives in a separate full-screen
//   pet-centered Friday Chat surface); platformLayout = cardsQueues; menuModel =
//   commandSheet (full-screen grid launcher from top-left); petProminence = heroPet;
//   palette = cyanCoral; background = warmOffWhite; form = glassNative; theme = light.
//
// This shell now consumes the PACKAGE's real sealed-WS clients (`FridayRustClient`): the
// Home reads the refs-only Mission Workbench projection over `SealedWSReadClient`; the
// Friday Chat surface drives the read-WRITE / S6 loop over `SealedWSWriteClient` + the
// `OperatorSigner` relay seam. The shipped default signer fail-closes until the real desktop
// signer relay is configured; tests/previews may inject the mock signer explicitly.
// The live `NWConnection` transport is the DEFERRED slice-6 AC, so every surface renders
// honest-unavailable while the Rust servers are DARK — the EXPECTED state. Truth rules
// (refs-only, truth labels never upgraded, 503/stale/offline AS truth, no key on the app,
// a mutation ONLY via operator approval) are enforced in `FridayMobileShellCore`.

import FridayMobileShellCore
import FridayRustClient
import Foundation
import SwiftUI

#if targetEnvironment(simulator)
private struct SimulatorFileDeviceKeypairBackend: DeviceKeypairBackend {
  private let url: URL
  private let publicKeyURL: URL

  init(fileManager: FileManager = .default) {
    let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? fileManager.temporaryDirectory
    let directory = base.appendingPathComponent("FridayShellSimulatorProof", isDirectory: true)
    try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    self.url = directory.appendingPathComponent("device-keypair-v1.bin")
    self.publicKeyURL = directory.appendingPathComponent("device-pubkey-v1.txt")
  }

  func loadSecret() throws -> [UInt8]? {
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let secret = [UInt8](try Data(contentsOf: url))
    writePublicKeySidecar(for: secret)
    return secret
  }

  func storeSecret(_ secret: [UInt8]) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true)
    try Data(secret).write(to: url, options: [.atomic])
    writePublicKeySidecar(for: secret)
  }

  private func writePublicKeySidecar(for secret: [UInt8]) {
    guard let keypair = try? FridayCrypto.DeviceKeypair(secretBytes: secret) else { return }
    try? Hex.encode(keypair.publicKey).write(to: publicKeyURL, atomically: true, encoding: .utf8)
  }
}
#endif

/// The app's real-client wiring: the device X25519 transport keypair + the REAL sealed-WS
/// read/write clients (built via `FridayClientFactory`) + the operator-signer RELAY seam.
/// This is the single place the iOS app binds to the all-Rust core.
///
/// INV-1: the device keypair is the X25519 SESSION keypair (transport identity) — it is NOT a
/// signing key and CANNOT mint an approval. The operator's Ed25519 signing key lives ONLY in
/// the desktop signer's isolated SecureStore (PR #671); on the phone the signer is an injected
/// relay seam. The shipped default is `UnavailableOperatorSigner`, which returns no signature.
///
/// The live network transport (a `NWConnection`-backed `SealedWSTransport`) is the DEFERRED
/// slice-6 AC; until it is wired the default factory transport throws and every surface renders
/// honest-unavailable — the EXPECTED state while the Rust servers are DARK.
@MainActor
final class FridaySession: ObservableObject {
  /// DEFAULT-OFF run-control (the S6 pause/approve/resume). Flipping this ON in production is
  /// part of the slice-6 operator gate; OFF ⇒ the chat loop is read-only (a pause fails closed).
  let runControlEnabled: Bool

  let readClient: FridayRustReadClient
  let writeClient: FridayRustWriteClient
  let missionClient: FridayMobileMissionDispatchingWriteClient?
  let devicePairing: DevicePairingReadiness
  let deviceKeypairBackend: DeviceKeypairBackend
  let makePairingClient: (DeviceKeypair) -> FridayPairingClient?
  /// The operator-signing RELAY. The shipped default fail-closes until the real desktop signer
  /// (PR #671) is reachable. The phone holds NO signing key (INV-1).
  let signer: OperatorSigner

  /// - Parameter preview: when `true`, the Home read client is the labeled `PreviewReadClient`
  ///   (a static sample projection) so SwiftUI previews + UI iteration render a populated Home
  ///   without a live Hub. DEFAULT `false` ⇒ the REAL `SealedWSReadClient` (honest-unavailable
  ///   while the servers are dark). A real build NEVER passes `preview: true`.
  init(preview: Bool = false) {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    let designProofSample = preview || Self.designProofSampleRequested(args: args, env: env)
    self.runControlEnabled = designProofSample ? false : Self.runControlRequested(args: args, env: env)
    let selectedDeviceKeypairBackend: DeviceKeypairBackend = designProofSample
      ? KeychainDeviceKeypairBackend()
      : Self.defaultDeviceKeypairBackend(args: args, env: env)
    self.deviceKeypairBackend = selectedDeviceKeypairBackend

    // SINGLE-PEER-TRAP SAFETY: the DEFAULT read client mints NO X25519 keypair, opens NO socket,
    // and touches NO SecureStore — it is the no-key `HonestlyUnavailableReadClient`, which always
    // renders the honest dark-server state. This deliberately does NOT generate a fresh peer key:
    // the live read-projection store enrolls EXACTLY the master-derived peer (count=1), so minting
    // any other key here would be wrong, and flipping the SHIPPED default to live at all is the
    // slice-6 operator FREEZE gate. The master-derived LIVE read path is the iOS I4 mirror of the
    // desktop `RealReadClientFactory.makeLive` / `MasterKeyPeer` derivation; it is now BUILT and
    // wired here behind an OPT-IN env/arg gate (`FRIDAY_MOBILE_LIVE_READ=1` / `--live-read`,
    // mirroring the desktop `FRIDAY_CONSOLE_LIVE`). The DEFAULT (gate OFF) stays the honest-
    // unavailable client — this PR does NOT flip the shipped default (that is the slice-6 gate).
    self.readClient = designProofSample
      ? PreviewReadClient()
      : Self.defaultReadClient(deviceKeypairBackend: selectedDeviceKeypairBackend)
    self.devicePairing = designProofSample
      ? .evaluate(deviceKeypairRequested: false, readLiveRequested: false, writeLiveRequested: false)
      : Self.defaultDevicePairingReadiness(deviceKeypairBackend: selectedDeviceKeypairBackend)
    self.makePairingClient = designProofSample || !Self.livePairingRequested(args: args, env: env)
      ? { _ in nil }
      : Self.defaultPairingClient

    // The write client (Friday Chat read-WRITE / S6 surface). DEFAULT (gate OFF) = the throwing
    // `liveTransportNotWired` factory transport ⇒ honest-unavailable, with an ephemeral X25519
    // SESSION key (transport identity only, NOT a signing key — INV-1) that NEVER reaches the live
    // store because no socket is opened. The master-derived LIVE write path (the iOS J2 mirror of
    // the read seam's `RealReadClientFactory.makeLive`) is now BUILT and wired behind an OPT-IN
    // env/arg gate (`FRIDAY_MOBILE_LIVE_WRITE=1` / `--live-write`, mirroring `FRIDAY_MOBILE_LIVE_READ`).
    // A separate device-keypair live path is additive and explicitly opted in with
    // `FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR=1` / `--live-device-keypair`; the shipped default still
    // touches no keychain, opens no socket, and remains honest-unavailable.
    if designProofSample {
      self.writeClient = Self.honestUnavailableWriteClient()
      self.missionClient = nil
    } else {
      let liveWrite = Self.defaultLiveWriteClient(
        runControlEnabled: runControlEnabled,
        deviceKeypairBackend: selectedDeviceKeypairBackend)
      self.writeClient = liveWrite ?? Self.honestUnavailableWriteClient(runControlEnabled: runControlEnabled)
      self.missionClient = liveWrite
    }
    self.signer = preview
      ? MockOperatorSigner()
      : UnavailableOperatorSigner(error: .signerUnavailable)
  }

  /// The DEFAULT (non-preview) Home read client. DEFAULT = the no-key honest-unavailable client;
  /// LIVE only when explicitly opted in via env `FRIDAY_MOBILE_LIVE_READ=1` or launch arg
  /// `--live-read` (the iOS mirror of the desktop `FRIDAY_CONSOLE_LIVE`). This PR does NOT flip
  /// the shipped default — the live path is opt-in, gated, and never on by default (slice-6 gate).
  ///
  /// LIVE: derive the enrolled master-derived peer (`MasterKeyPeer`), target 48751 as `admin-001`,
  /// over the real `SealedWSReadClient` (the iOS `RealReadClientFactory.makeLive`). If the host
  /// master key is unavailable (e.g. a real phone — the J2 pairing problem), surface the TRUTH
  /// (honest unavailable) — NEVER fall back to the preview sample, which would fabricate a ready
  /// view the live seam did not produce.
  static func defaultReadClient(
    deviceKeypairBackend: DeviceKeypairBackend = KeychainDeviceKeypairBackend()
  ) -> FridayRustReadClient {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    let useLive = liveReadRequested(args: args, env: env)
    guard useLive else {
      // SHIPPED DEFAULT — unchanged: no key, no socket, no SecureStore touch.
      return HonestlyUnavailableReadClient()
    }
    do {
      let config = try liveReadConfig(args: args, env: env)
      let missionId = MobileRuntimeGates.liveReadMissionIdOverride(args: args, env: env)
      if useDeviceKeypair(args: args, env: env) {
        let device = try DeviceKeypairStore.loadOrGenerate(backend: deviceKeypairBackend)
        return RealReadClientFactory.makeLive(
          deviceKeypair: device,
          config: config,
          missionId: missionId)
      }
      return try RealReadClientFactory.makeLive(config: config, missionId: missionId)
    } catch {
      return RealReadClientFactory.makeHonestlyUnavailable(reason: "\(error)")
    }
  }

  /// The DEFAULT (non-preview) Friday Chat WRITE client. DEFAULT = the throwing
  /// `liveTransportNotWired` factory transport (honest-unavailable, no socket, no SecureStore
  /// touch); LIVE only when explicitly opted in via env `FRIDAY_MOBILE_LIVE_WRITE=1` or launch arg
  /// `--live-write` (the WRITE-seam mirror of `--live-read`). This PR does NOT flip the shipped
  /// default — the live write transport is opt-in, gated, and never on by default (slice-6 gate);
  /// `runControlEnabled` (the S6 pause/approve/resume) is a SEPARATE operator gate, default-off.
  ///
  /// LIVE: derive the enrolled master-derived peer (`MasterKeyPeer`), target 48750 as `admin-001`,
  /// over the real `SealedWSWriteClient` (`RealWriteClientFactory.makeLive`). If the host master key
  /// is unavailable (e.g. a real phone — the J2 pairing problem), fall back to the throwing default
  /// (honest unavailable) — NEVER fabricate a ready chat surface the live seam did not produce.
  static func defaultWriteClient(runControlEnabled: Bool, sessionId: String? = nil) -> FridayRustWriteClient {
    defaultLiveWriteClient(runControlEnabled: runControlEnabled, sessionId: sessionId)
      ?? honestUnavailableWriteClient(runControlEnabled: runControlEnabled, sessionId: sessionId)
  }

  static func defaultLiveWriteClient(
    runControlEnabled: Bool,
    deviceKeypairBackend: DeviceKeypairBackend = KeychainDeviceKeypairBackend(),
    sessionId: String? = nil
  ) -> FridayMobileMissionDispatchingWriteClient? {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    let useLive = liveWriteRequested(args: args, env: env)
    guard useLive else {
      return nil
    }
    do {
      let config = try liveWriteConfig(args: args, env: env)
      if useDeviceKeypair(args: args, env: env) {
        let device = try DeviceKeypairStore.loadOrGenerate(backend: deviceKeypairBackend)
        return RealWriteClientFactory.makeLive(
          deviceKeypair: device,
          config: config,
          sessionId: sessionId,
          agentRunControlViaRust: runControlEnabled)
      }
      return try RealWriteClientFactory.makeLive(
        config: config,
        sessionId: sessionId,
        agentRunControlViaRust: runControlEnabled)
    } catch {
      // Master/device key unavailable or corrupt: no mission-capable client. The caller falls back
      // to the throwing honest-unavailable write client; never fabricate a ready chat surface.
      return nil
    }
  }

  static func useDeviceKeypair(args: [String], env: [String: String]) -> Bool {
    MobileRuntimeGates.useDeviceKeypair(args: args, env: env)
      || productLiveLoopbackDefaultRequested(args: args, env: env)
  }

  static func designProofSampleRequested(args: [String], env: [String: String]) -> Bool {
    MobileRuntimeGates.designProofSampleRequested(args: args, env: env)
  }

  static func defaultDeviceKeypairBackend(args: [String], env: [String: String]) -> DeviceKeypairBackend {
    #if targetEnvironment(simulator)
    if MobileRuntimeGates.simulatorFileDeviceKeypairRequested(args: args, env: env)
      || productLiveLoopbackDefaultRequested(args: args, env: env) {
      return SimulatorFileDeviceKeypairBackend()
    }
    #endif
    return KeychainDeviceKeypairBackend()
  }

  static func productLiveLoopbackDefaultRequested(args: [String], env: [String: String]) -> Bool {
    #if targetEnvironment(simulator)
    let isSimulator = true
    #else
    let isSimulator = false
    #endif
    return MobileRuntimeGates.productLiveLoopbackDefaultRequested(
      args: args,
      env: env,
      isSimulator: isSimulator)
  }

  static func liveReadRequested(args: [String], env: [String: String]) -> Bool {
    MobileRuntimeGates.liveReadRequested(args: args, env: env)
      || productLiveLoopbackDefaultRequested(args: args, env: env)
  }

  static func liveReadConfig(args: [String], env: [String: String]) throws -> ReadProjectionServerConfig {
    let host = MobileRuntimeGates.liveReadHostOverride(args: args, env: env)
      ?? ReadProjectionServerConfig.liveLoopback.host
    switch MobileRuntimeGates.liveReadPortOverride(args: args, env: env) {
    case .absent:
      return ReadProjectionServerConfig(
        host: host,
        port: ReadProjectionServerConfig.liveLoopback.port)
    case let .value(port):
      return ReadProjectionServerConfig(host: host, port: port)
    case let .invalid(raw):
      throw FridayReadClientError.transport("invalid live read port override \(raw)")
    }
  }

  static func liveWriteRequested(args: [String], env: [String: String]) -> Bool {
    MobileRuntimeGates.liveWriteRequested(args: args, env: env)
      || productLiveLoopbackDefaultRequested(args: args, env: env)
  }

  static func liveWriteConfig(args: [String], env: [String: String]) throws -> AgentRunServerConfig {
    let host = MobileRuntimeGates.liveWriteHostOverride(args: args, env: env)
      ?? AgentRunServerConfig.liveLoopback.host
    switch MobileRuntimeGates.liveWritePortOverride(args: args, env: env) {
    case .absent:
      return AgentRunServerConfig(
        host: host,
        port: AgentRunServerConfig.liveLoopback.port)
    case let .value(port):
      return AgentRunServerConfig(host: host, port: port)
    case let .invalid(raw):
      throw FridayReadClientError.transport("invalid live write port override \(raw)")
    }
  }

  static func livePairingRequested(args: [String], env: [String: String]) -> Bool {
    MobileRuntimeGates.livePairingRequested(args: args, env: env)
      || productLiveLoopbackDefaultRequested(args: args, env: env)
  }

  static func runControlRequested(args: [String], env: [String: String]) -> Bool {
    MobileRuntimeGates.runControlRequested(args: args, env: env)
  }

  static func defaultPairingClient(deviceKeypair: DeviceKeypair) -> FridayPairingClient? {
    // Explicit QR pairing is a user-initiated enrollment ceremony, not a shipped live-read/write
    // flip. The network PairAck leg is wired only when `FRIDAY_MOBILE_LIVE_PAIRING=1` /
    // `--live-pairing` selects this factory; otherwise Home can still scan/preflight a QR but
    // `pairScannedQR` reports "Pairing channel is not configured for this launch." It still fails
    // closed through manifest proof validation, PairingServerConfig's loopback/private-LAN
    // allowlist, and the Hub's PairAck. Read, write, run-control, signing, and trust minting remain
    // on their separate gates.
    return RealPairingClientFactory.makeLive(deviceKeypair: deviceKeypair)
  }

  static func defaultDevicePairingReadiness(
    deviceKeypairBackend: DeviceKeypairBackend = KeychainDeviceKeypairBackend()
  ) -> DevicePairingReadiness {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    return DevicePairingReadiness.evaluate(
      deviceKeypairRequested: useDeviceKeypair(args: args, env: env),
      readLiveRequested: liveReadRequested(args: args, env: env),
      writeLiveRequested: liveWriteRequested(args: args, env: env),
      backend: deviceKeypairBackend)
  }

  /// The honest-unavailable WRITE client: the shared `FridayClientFactory.makeWriteClient` with its
  /// DEFAULT throwing `liveTransportNotWired` transport + an ephemeral session keypair that opens no
  /// socket. This is the SHIPPED default and the preview/no-master-key fallback.
  static func honestUnavailableWriteClient(
    runControlEnabled: Bool = false,
    sessionId: String? = nil
  ) -> FridayRustWriteClient {
    let writeKeypair = FridayCrypto.DeviceKeypair()
    let endpoint = FridayClientFactory.Endpoint(
      forwardedPrincipal: "principal:owner-device",
      sessionId: sessionId,
      agentRunControlViaRust: runControlEnabled)
    return FridayClientFactory.makeWriteClient(keypair: writeKeypair, endpoint: endpoint)
  }

  #if DEBUG
  /// A preview/debug session whose Home renders a labeled sample projection (no live Hub).
  static let preview = FridaySession(preview: true)
  #endif
}

/// The app shell: a NavigationStack with the top-left Command Sheet launcher and the
/// top-bar 💬 Friday Chat entry. Launch screen = Home (locked).
struct RootView: View {
  @StateObject private var homeVM: HomeViewModel
  @StateObject private var sessionContinuationVM: SessionContinuationViewModel
  @StateObject private var shareIntakeVM: ShareIntakeViewModel
  @StateObject private var newSessionVM: NewSessionViewModel
  @StateObject private var voiceVM: VoiceReadinessViewModel
  private let session: FridaySession
  @State private var destination: MobileDestination = .home
  @State private var commandOpen = false
  @State private var chatOpen = false
  @State private var pendingChatLaunchContext: ChatLaunchContext?

  init(session: FridaySession) {
    self.session = session
    let initialDestination = Self.initialDestinationFromLaunch()
    _destination = State(initialValue: initialDestination)
    _homeVM = StateObject(wrappedValue: HomeViewModel(
      client: session.readClient,
      writeClient: session.missionClient,
      devicePairing: session.devicePairing,
      deviceKeypairBackend: session.deviceKeypairBackend,
      makePairingClient: session.makePairingClient))
    _sessionContinuationVM = StateObject(wrappedValue: SessionContinuationViewModel(
      client: session.readClient,
      writeClient: session.writeClient,
      makeSessionWriteClient: { sessionId in
        FridaySession.defaultLiveWriteClient(
          runControlEnabled: session.runControlEnabled,
          deviceKeypairBackend: session.deviceKeypairBackend,
          sessionId: sessionId)
          ?? FridaySession.honestUnavailableWriteClient(
            runControlEnabled: session.runControlEnabled,
            sessionId: sessionId)
      },
      signer: session.signer,
      runControlEnabled: session.runControlEnabled))
    _shareIntakeVM = StateObject(wrappedValue: ShareIntakeViewModel(client: session.missionClient))
    _newSessionVM = StateObject(wrappedValue: NewSessionViewModel(client: session.missionClient))
    _voiceVM = StateObject(wrappedValue: VoiceReadinessViewModel(
      authorizer: SystemVoiceReadinessAuthorizer()))
  }

  var body: some View {
    NavigationStack {
      Group {
        switch destination {
        case .home:
          FridayHomeScreen(viewModel: homeVM)
        case .session:
          FridaySessionDetailScreen(homeViewModel: homeVM, viewModel: sessionContinuationVM)
        case .contextPassport:
          FridayContextPassportScreen(viewModel: homeVM)
        case .tokenLedger:
          FridayTokenLedgerScreen(viewModel: homeVM)
        case .shareIntake:
          FridayShareIntakeScreen(viewModel: shareIntakeVM) { receipt in
            pendingChatLaunchContext = receipt.chatLaunchContext
            chatOpen = true
          }
        case .newSession:
          FridayNewSessionScreen(viewModel: newSessionVM) { context in
            pendingChatLaunchContext = context
            chatOpen = true
          }
        case .voice:
          FridayVoiceScreen(viewModel: voiceVM) {
            pendingChatLaunchContext = nil
            chatOpen = true
          }
        case .pairing:
          FridayHomeScreen(viewModel: homeVM, showPairingProvisioning: true)
        case .providerAuth:
          FridayProviderAuthScreen(viewModel: homeVM)
        case .onboarding:
          FridayProjectionScreen(
            destination: destination,
            viewModel: homeVM,
            missionClient: session.missionClient,
            onOpenFridayChat: { context in
              pendingChatLaunchContext = context
              chatOpen = true
            },
            onOpenPairing: {
              destination = .pairing
            })
        case .missions, .needsMe, .memory, .platform, .activity, .workflows, .settings,
             .petEditor, .proofViewer, .entrypoints:
          FridayProjectionScreen(
            destination: destination,
            viewModel: homeVM,
            missionClient: session.missionClient,
            onOpenFridayChat: { context in
              pendingChatLaunchContext = context
              chatOpen = true
            })
        }
      }
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        // Top-LEFT: the Command Sheet launcher (locked: commandSheet from top-left).
        ToolbarItem(placement: .topBarLeading) {
          Button {
            commandOpen = true
          } label: {
            Image(systemName: "line.3.horizontal")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(MobileTheme.textSecondary)
          }
          .accessibilityLabel("Open Command Sheet")
          .accessibilityIdentifier("friday.mobile.toolbar.command-sheet")
        }
        ToolbarItem(placement: .principal) {
          VStack(spacing: 1) {
            Text(destination == .home ? "Friday" : destination.title)
              .font(.headline.weight(.semibold))
              .foregroundStyle(MobileTheme.textPrimary)
            Text(destination == .home ? "Private command center" : "Friday surface")
              .font(.caption2)
              .foregroundStyle(MobileTheme.textSecondary)
          }
          .accessibilityElement(children: .combine)
          .accessibilityLabel(destination == .home ? "Friday. Private command center." : "\(destination.title). Friday surface.")
        }
        ToolbarItem(placement: .topBarTrailing) {
          HStack(spacing: 8) {
            Button {
              Task { await homeVM.refresh() }
            } label: {
              FridayChip(
                text: homeVM.isOnline ? "Hub live" : "Hub",
                bg: homeVM.isOnline ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
                fg: homeVM.isOnline ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Refresh Hub status")
            .accessibilityIdentifier("friday.mobile.toolbar.hub-status")
            .disabled(homeVM.state.isLoading)

            // Top-BAR 💬: the Friday Chat entry (locked: the ONLY chat entry — no card).
            Button {
              pendingChatLaunchContext = nil
              chatOpen = true
            } label: {
              Image(systemName: "bubble")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(MobileTheme.textSecondary)
            }
            .accessibilityLabel("Open Friday Chat")
            .accessibilityIdentifier("friday.mobile.toolbar.chat")
          }
        }
      }
      .navigationDestination(isPresented: $chatOpen) {
        // The Friday Chat read-WRITE / S6 surface, driven by the session's REAL write client
        // + the operator-signer relay.
        FridayChatScreen(session: session, launchContext: pendingChatLaunchContext)
      }
    }
    .tint(MobileTheme.cyan)
    .sheet(isPresented: $commandOpen) {
      CommandSheet(destination: $destination, isOpen: $commandOpen)
    }
    .onOpenURL { url in
      applyShareURL(url)
    }
    .task {
      // Initial read on launch (dark server ⇒ honest-unavailable).
      if case .idle = homeVM.state {
        await homeVM.refresh()
      }
    }
  }

  private static func initialDestinationFromLaunch(
    args: [String] = ProcessInfo.processInfo.arguments,
    env: [String: String] = ProcessInfo.processInfo.environment
  ) -> MobileDestination {
    let envValue = env["FRIDAY_MOBILE_INITIAL_DESTINATION"]?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let envValue, let destination = MobileDestination(rawValue: envValue) {
      return destination
    }

    for (index, arg) in args.enumerated() {
      if arg.hasPrefix("--initial-destination=") {
        let rawValue = String(arg.dropFirst("--initial-destination=".count))
        if let destination = MobileDestination(rawValue: rawValue) {
          return destination
        }
      }
      if arg == "--initial-destination", args.indices.contains(index + 1) {
        let rawValue = args[index + 1]
        if let destination = MobileDestination(rawValue: rawValue) {
          return destination
        }
      }
    }

    return .home
  }

  private func applyShareURL(_ url: URL) {
    guard url.scheme == "friday", url.host == "share" else { return }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let text = components?.queryItems?.first(where: { $0.name == "text" })?.value
    let rawURL = components?.queryItems?.first(where: { $0.name == "url" })?.value
    shareIntakeVM.applyIncomingShare(
      text: text,
      url: rawURL.flatMap(URL.init(string:)))
    destination = .shareIntake
  }
}

@main
struct FridayApp: App {
  @StateObject private var session = FridaySession()

  var body: some Scene {
    WindowGroup {
      // The shell wires the REAL clients via the session; the live transport is the slice-6
      // deferred AC, so the surfaces render honest-unavailable while the Rust servers are dark.
      RootView(session: session)
    }
  }
}

// MARK: - Previews

#if DEBUG
#Preview("Home · preview sample (labeled)") {
  RootView(session: .preview)
}

#Preview("Home · live client (dark ⇒ honest-unavailable)") {
  RootView(session: FridaySession())
}
#endif
