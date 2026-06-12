#if canImport(WebKit) && canImport(AppKit)
import AppKit
import Foundation
import WebKit

/// Env/flag-gated render proof for the `Inspector → Companion` pet (design CLAUDE.md rule 5:
/// "verify with a RENDERED image, not just code/bbox").
///
/// Invoked via `FridayHubConsole --pet-render-proof <out.png>` (or env
/// `FRIDAY_PET_RENDER_PROOF=<out.png>`). It builds the REAL `WKWebView` + `PetSchemeHandler` +
/// bundled engine/assets exactly as the live `CompanionPetView` does, loads the host page,
/// POLLS the silent-failure flags (`window.__petReady` / `window.__petError`), then snapshots the
/// rendered pet to a PNG and exits with a clear status. Proves the whole bundle → scheme handler →
/// engine → `createStage` chain end-to-end, locally, zero token.
///
/// NOT part of the default app launch and NEVER part of the default test suite (needs a GUI +
/// window server). CI never runs it.
@MainActor
enum PetRenderProof {
  /// Returns the requested output PNG path if the proof mode was requested, else nil.
  static func requestedOutputPath() -> String? {
    let args = ProcessInfo.processInfo.arguments
    if let i = args.firstIndex(of: "--pet-render-proof"), i + 1 < args.count {
      return args[i + 1]
    }
    if let env = ProcessInfo.processInfo.environment["FRIDAY_PET_RENDER_PROOF"], !env.isEmpty {
      return env
    }
    return nil
  }

  /// Run the proof, capturing the rendered pet to `outputPath`. Exits the process when done.
  static func run(outputPath: String) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    let stageSize = NSSize(width: 300, height: CompanionPetView.stageHeight)
    let config = WKWebViewConfiguration()
    config.setURLSchemeHandler(PetSchemeHandler(), forURLScheme: PetSchemeHandler.scheme)

    let webView = WKWebView(
      frame: NSRect(origin: .zero, size: stageSize), configuration: config)
    // Opaque background so the snapshot is legible on its own.
    webView.setValue(true, forKey: "drawsBackground")

    // An offscreen window so the WKWebView actually lays out + paints.
    let window = NSWindow(
      contentRect: NSRect(origin: NSPoint(x: -10000, y: -10000), size: stageSize),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = webView
    window.orderFrontRegardless()

    webView.load(URLRequest(url: PetSchemeHandler.hostPageURL))

    let deadline = Date().addingTimeInterval(20)
    pollUntilReady(webView: webView, deadline: deadline) { ready, errorText in
      guard ready else {
        FileHandle.standardError.write(
          Data("[pet-proof] FAILED — pet did not render: \(errorText ?? "timeout")\n".utf8))
        exit(2)
      }
      // Give the engine one extra beat to draw frame 0, then snapshot.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        let snapConfig = WKSnapshotConfiguration()
        webView.takeSnapshot(with: snapConfig) { image, error in
          guard let image, error == nil else {
            FileHandle.standardError.write(
              Data("[pet-proof] FAILED — snapshot error: \(String(describing: error))\n".utf8))
            exit(3)
          }
          if writePNG(image, to: outputPath) {
            FileHandle.standardOutput.write(
              Data("[pet-proof] OK — rendered pet snapshot written to \(outputPath)\n".utf8))
            exit(0)
          } else {
            FileHandle.standardError.write(
              Data("[pet-proof] FAILED — could not write PNG to \(outputPath)\n".utf8))
            exit(4)
          }
        }
      }
    }
    app.run()
    exit(5)  // app.run() should not return before our exit() calls.
  }

  /// Poll `window.__petReady` / `window.__petError` until ready, error, or deadline.
  private static func pollUntilReady(
    webView: WKWebView, deadline: Date,
    completion: @escaping @MainActor @Sendable (Bool, String?) -> Void
  ) {
    webView.evaluateJavaScript("window.__petError") { errVal, _ in
      if let errText = errVal as? String, !errText.isEmpty {
        completion(false, errText)
        return
      }
      webView.evaluateJavaScript("window.__petReady === true") { readyVal, _ in
        if (readyVal as? Bool) == true {
          completion(true, nil)
          return
        }
        if Date() > deadline {
          completion(false, "pet not ready before deadline (createStage never resolved)")
          return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
          pollUntilReady(webView: webView, deadline: deadline, completion: completion)
        }
      }
    }
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
