import FridayHubConsoleCore
import FridayRustClient
import SwiftUI

/// Friday Hub Console — the v1 desktop UI shell (D-PR1).
///
/// A read-only operator workbench over Rust Hub Mission truth.
///
/// LAUNCH MODES (LIVE is the DEFAULT — the slice-6 J2/I3/I4 flip):
///   - DEFAULT (LIVE) — the REAL `SealedWSReadClient` (the `FridayRustClient` package) over the
///     read-projection server's loopback seam (127.0.0.1:48751) as the enrolled MASTER-DERIVED
///     peer, authenticating as the LaunchAgent owner `admin-001`. "The app actually reads the
///     live Rust core." A normal run reads live truth.
///   - MOCK (opt-in, design/demo only) — pass launch arg `--use-mock-read-client` (or set env
///     `FRIDAY_CONSOLE_MOCK=1`) to use the in-memory `MockReadClient(.loaded)`. This is for
///     SwiftUI design/demo work without a live read-projection server. It is NEVER selected by a
///     normal launch and never silently substituted for a failed live read.
///
/// HONEST-UNAVAILABLE (the locked design): in the default LIVE mode, if the server is dark / the
/// peer is not enrolled / the host master key is absent, the real client fails closed and the
/// Console renders the HONEST "unavailable" state with the real reason — never a fabricated
/// mock-loaded view, never a silent fall-back to mock data, never a crash.
///
/// NO network at construction: `makeLive()` only derives the master-key peer + builds the client
/// (no socket). The connect + 4s timeout happens later in the shell's async `.task`, so
/// defaulting LIVE does not block app launch.
///
/// COMPAT: the pre-flip live opt-in (`--live-read` / `FRIDAY_CONSOLE_LIVE=1`) is now redundant
/// (live is the default) and is accepted as a documented NO-OP so existing launch configs keep
/// working. Only the MOCK opt-in changes behavior.
@main
struct FridayHubConsoleApp: App {
  init() {
    // Env/flag-gated pet render proof — renders the Companion pet offscreen, snapshots a PNG,
    // and exits BEFORE the normal scene. Never runs in the default launch or in CI.
    #if canImport(WebKit) && canImport(AppKit)
    if let out = PetRenderProof.requestedOutputPath() {
      PetRenderProof.run(outputPath: out)  // never returns
    }
    #endif
    #if canImport(AppKit)
    if let dir = StateRenderProof.requestedOutputDir() {
      StateRenderProof.run(outputDir: dir)  // never returns
    }
    #endif
  }

  var body: some Scene {
    WindowGroup("Friday Hub Console") {
      HubConsoleShell(
        client: Self.readClient,
        writeClient: Self.writeClient,
        missionRunClient: Self.writeClient)
    }
    .windowStyle(.titleBar)
    .defaultSize(width: 1180, height: 720)
  }

  /// `true` when the explicit design/demo MOCK opt-in is set. A normal run is `false` (LIVE).
  private static var useMock: Bool {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    return args.contains("--use-mock-read-client") || env["FRIDAY_CONSOLE_MOCK"] == "1"
  }

  /// The read client the shell uses. DEFAULT = LIVE; MOCK only when explicitly opted in.
  static var readClient: FridayRustReadClient {
    // MOCK is an explicit design/demo opt-in only (re-adopting #682's `--use-mock-read-client`
    // flag, mirrored by an env for arg/env symmetry). A normal run NEVER takes this branch.
    if useMock {
      return MockReadClient(behavior: .loaded)
    }
    // DEFAULT (LIVE): derive the enrolled master-derived peer + target 48751 as `admin-001`. If
    // the host master key is unavailable, surface the truth (honest unavailable) — NEVER fall
    // back to the mock, which would fabricate a ready view the live seam did not produce.
    // (The actual connect happens later in the shell's async refresh; this is non-blocking.)
    do {
      return try RealReadClientFactory.makeLive()
    } catch {
      return RealReadClientFactory.makeHonestlyUnavailable(reason: "\(error)")
    }
  }

  /// The mission-spine WRITE client the shell uses (Lane-D entry-point-A). Mirrors `readClient`:
  /// DEFAULT = LIVE (the enrolled master-derived peer targeting the agent-run WRITE server on
  /// 48750 as `admin-001`), honest-unavailable on master-key failure (NEVER a fabricated confirm).
  ///
  /// In MOCK/design mode there is NO write seam — `nil` — so the compose/confirm controls render
  /// honest-unavailable rather than pretending to write against mock read data. The actual connect
  /// happens only when the operator submits an intake / decides a memory candidate (non-blocking
  /// at launch).
  static var writeClient: FridayMissionSpineDispatchingWriteClient? {
    if useMock { return nil }
    do {
      return try RealWriteClientFactory.makeLiveWrite()
    } catch {
      return RealWriteClientFactory.makeHonestlyUnavailableWrite(reason: "\(error)")
    }
  }
}
