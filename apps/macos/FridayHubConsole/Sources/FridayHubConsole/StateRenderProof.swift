#if canImport(AppKit)
import AppKit
import FridayHubConsoleCore
import SwiftUI

/// Env/flag-gated visual-QA proof for the honest desktop states: Operations Overview's loaded /
/// unavailable paths plus every projection-backed nav destination in the loaded mock state.
///
/// Invoked via `FridayHubConsole --state-render-proof <outdir>`. Renders ONLY the center
/// `OperationsOverviewScreen` (not the right pane) via `ImageRenderer` — deliberately excluding
/// the Companion `WKWebView`, which does NOT paint in an offscreen bitmap (its canonical render is
/// the separate `--pet-render-proof` snapshot). Each state's view model is materialized (its mock
/// `refresh()` is awaited) BEFORE rasterizing, so we never capture a loading spinner.
///
/// NOT part of the default launch or the default test suite. CI never runs it.
@MainActor
enum StateRenderProof {
  static func requestedOutputDir() -> String? {
    let args = ProcessInfo.processInfo.arguments
    if let i = args.firstIndex(of: "--state-render-proof"), i + 1 < args.count {
      return args[i + 1]
    }
    return nil
  }

  static func run(outputDir: String) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    // A REPRESENTATIVE honest empty-state render: the mock throws
    // `.projectionUnavailable("no active mission found")` so the screenshot shows the
    // "no active mission found" honest-unavailable view. NOTE the on-screen prefix differs from
    // the LIVE path: the real server returns a typed `Error(HUB_OFFLINE)` which the view model
    // maps to "Hub unavailable — server error hubOffline: no active mission found". The
    // AUTHORITATIVE live empty-state proof is the C1 round-trip (env-gated `Live…` tests), NOT
    // this screenshot — this just confirms the view renders the empty case honestly.
    let cases: [(String, HubDestination, MockReadClient.Behavior)] = [
      ("operations-loaded-mock", .operations, .loaded),
      ("chat-loaded-mock", .chat, .loaded),
      ("provider-admin-loaded-mock", .providerAdmin, .loaded),
      ("provider-parity-loaded-mock", .parity, .loaded),
      ("workflow-loaded-mock", .workflow, .loaded),
      ("channels-loaded-mock", .channels, .loaded),
      ("evidence-loaded-mock", .evidence, .loaded),
      ("operations-unavailable-503", .operations, .unavailable(.hubUnavailable(statusCode: 503))),
      ("operations-offline", .operations, .unavailable(.offline)),
      (
        "operations-no-active-mission",
        .operations,
        .unavailable(.projectionUnavailable(reason: "no active mission found"))
      ),
    ]

    Task { @MainActor in
      try? FileManager.default.createDirectory(
        atPath: outputDir, withIntermediateDirectories: true)
      var failures = 0
      for (name, destination, behavior) in cases {
        let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: behavior))
        await vm.refresh()  // mock is instant → materialize the target state.
        let outPath = "\(outputDir)/\(name).png"
        // For the LOADED state, rasterize the card stack directly (not inside the screen's
        // `ScrollView`, which `ImageRenderer` leaves blank). The unavailable states have no
        // scroll content, so the whole screen rasterizes faithfully.
        let renderer: ImageRenderer<AnyView>
        if case .loaded = vm.state, let snapshot = vm.state.snapshot {
          let loaded: AnyView
          switch destination {
          case .operations:
            loaded = AnyView(OperationsOverviewScreen(viewModel: vm).loadedContent(snapshot))
          case .chat:
            loaded = AnyView(DesktopChatScreen(viewModel: vm).loadedContent(snapshot))
          default:
            loaded = AnyView(DesktopProjectionScreen(destination: destination, viewModel: vm).loadedContent(snapshot))
          }
          let content =
            VStack(alignment: .leading, spacing: 0) {
              loaded
            }
            .frame(width: 760)
            .background(HubTheme.backgroundWarmOffWhite)
          renderer = ImageRenderer(content: AnyView(content))
        } else {
          let view =
            OperationsOverviewScreen(viewModel: vm)
            .frame(width: 760, height: 720)
          renderer = ImageRenderer(content: AnyView(view))
        }
        renderer.scale = 2
        if let nsImage = renderer.nsImage, writePNG(nsImage, to: outPath) {
          FileHandle.standardOutput.write(Data("[state-proof] OK — \(outPath)\n".utf8))
        } else {
          FileHandle.standardError.write(
            Data("[state-proof] FAILED — could not render \(name)\n".utf8))
          failures += 1
        }
      }
      exit(failures == 0 ? 0 : 6)
    }
    app.run()
    exit(7)
  }

  private static func writePNG(_ image: NSImage, to path: String) -> Bool {
    guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:])
    else { return false }
    return (try? png.write(to: URL(fileURLWithPath: path))) != nil
  }
}
#endif
