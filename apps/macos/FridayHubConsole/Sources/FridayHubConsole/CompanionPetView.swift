import FridayHubConsoleCore
import SwiftUI

#if canImport(WebKit)
import WebKit

/// The desktop `Inspector → Companion` pet — the locked 176px animated v9 companion.
///
/// An `NSViewRepresentable` wrapping a `WKWebView` that loads the bundled `pet-host.html` over the
/// custom `friday-pet://` scheme and runs the EXISTING `pet-stage-engine.js` verbatim against the
/// bundled v9 assets. The host page calls the locked design API exactly:
///
///     FridayPetStage.createStage(stage,
///       { surface:"desktop", height:176, behavior:"locked-core-only", ecoAllowlist:[] })
///
/// HARD RULES honored: zero token / pure local CSS-JS-canvas (no model calls, images never leave
/// the machine), pet assets bundled VERBATIM (never modified/recolored/rescaled), ONE size (176px).
/// `locked-core-only` + `ecoAllowlist:[]` keep it to the F1/F2/F3 canonical core animations.
struct CompanionPetView: NSViewRepresentable {
  /// Fixed locked height for the desktop companion (design handoff: 176px).
  static let stageHeight: CGFloat = 176

  func makeNSView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    // Register the local asset handler BEFORE creating the web view, then load the host page
    // THROUGH the custom scheme so the engine's absolute `/source/...` fetches are same-origin.
    configuration.setURLSchemeHandler(PetSchemeHandler(), forURLScheme: PetSchemeHandler.scheme)
    // Local-only: no network process traffic is expected; keep it sandboxed to the bundle.
    configuration.suppressesIncrementalRendering = false

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.setValue(false, forKey: "drawsBackground")  // transparent so the glass panel shows.
    webView.load(URLRequest(url: PetSchemeHandler.hostPageURL))
    return webView
  }

  func updateNSView(_ nsView: WKWebView, context: Context) {
    // Static host page; nothing to update. The engine self-schedules its animation.
  }
}

/// The Companion sub-pane shown in the right-docked `ProofInspector`. Renders the live animated
/// pet at the locked 176px, with a tiny health-tinted status dot retained as a secondary accent
/// (the merged `subtleStatus` value remains an honest prominence cue alongside the companion).
struct CompanionPane: View {
  let state: WorkbenchLoadState

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Text("Companion")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(HubTheme.textSecondary)
        Spacer()
      }
      CompanionPetView()
        .frame(height: CompanionPetView.stageHeight)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityLabel("Friday dog companion")
    }
  }
}

#else

/// Fallback when WebKit is unavailable (non-Apple toolchains): no animated pet, honest accent only.
struct CompanionPane: View {
  let state: WorkbenchLoadState
  var body: some View {
    HStack(spacing: 6) {
      PetStatusAccent(state: state)
      Text("Companion (WebKit unavailable)")
        .font(.system(size: 11))
        .foregroundStyle(HubTheme.textSecondary)
    }
  }
}
#endif
