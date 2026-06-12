import FridayMobileShellCore
import SwiftUI

#if canImport(WebKit)
import WebKit

/// The Friday Home hero-card pet — the locked 155px animated v9 mobile companion.
///
/// A `UIViewRepresentable` wrapping a `WKWebView` that loads the bundled mobile `pet-host.html`
/// over the custom `friday-pet://` scheme and runs the EXISTING `pet-stage-engine.js` VERBATIM
/// against the bundled v9 assets. The host page calls the locked design API exactly:
///
///     FridayPetStage.createStage(stage,
///       { surface:"mobile", height:155, behavior:"locked-core-only", ecoAllowlist:[] })
///
/// This is the MOBILE mirror of the desktop D-PR1 `CompanionPetView` (#690) at the mobile size.
///
/// HARD RULES honored: zero token / pure local CSS-JS-canvas (no model calls, images never leave
/// the device), pet assets bundled VERBATIM (never modified/recolored/rescaled), ONE size (155px).
/// The mood animation is NOT a status source of truth — the honest read-seam status truth is shown
/// in the Status card below (so the pet stage itself is bare: no text, no status badges).
struct MobilePetView: UIViewRepresentable {
  /// Fixed locked height for the mobile Home hero card (design handoff: 155px).
  static let stageHeight: CGFloat = 155

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    // Register the local asset handler BEFORE creating the web view, then load the host page
    // THROUGH the custom scheme so the engine's absolute `/source/...` fetches are same-origin.
    configuration.setURLSchemeHandler(MobilePetScheme(), forURLScheme: MobilePetScheme.scheme)
    configuration.suppressesIncrementalRendering = false

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.isOpaque = false                  // transparent so the hero-card bg shows.
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    webView.scrollView.isScrollEnabled = false  // the pet stage is a fixed card, not scrollable.
    webView.load(URLRequest(url: MobilePetScheme.hostPageURL))
    return webView
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {
    // Static host page; nothing to update. The engine self-schedules its animation.
  }
}
#endif
