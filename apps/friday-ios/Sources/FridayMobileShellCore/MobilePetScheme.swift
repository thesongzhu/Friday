#if canImport(WebKit)
import Foundation
import WebKit

/// Serves the bundled pet engine + v9 assets to the `MobilePetView` WKWebView over a custom
/// `friday-pet://` scheme, so the engine's ABSOLUTE `/source/...` fetches resolve same-origin and
/// LOCALLY — no `:8787` design-lab server, no network, zero token.
///
/// This is the MOBILE (iOS) mirror of the desktop D-PR1 `PetSchemeHandler` (#690): the SAME
/// custom-scheme strategy, the SAME verbatim `PetResources/` (engine + v9 assets), serving a
/// mobile `pet-host.html` that calls `createStage(..., surface:"mobile", height:155, ...)`.
///
/// Why a custom scheme (not `loadFileURL`): under `file://`, the engine's absolute
/// `fetch("/source/pet/...")` resolves to `file:///source/pet/...` (filesystem root, outside the
/// app's read-access) and fails. Loaded as `friday-pet://app/pet-host.html`, the page's absolute
/// `/source/...` + `/pet-stage-engine.js` subresource requests become same-origin custom-scheme
/// requests routed here and mapped to the bundle. The pet assets are NEVER modified — served
/// verbatim from `PetResources/` (design CLAUDE.md hard rule 2).
///
/// Lives in the UI-FREE `FridayMobileShellCore` SPM library (NOT the iOS-only app sources) so it
/// resolves `Bundle.module` against the `.copy("PetResources")` resource bundle. The iOS-only
/// `UIViewRepresentable` wrapper is `MobilePetView` in the app sources.
public final class MobilePetScheme: NSObject, WKURLSchemeHandler {
  public static let scheme = "friday-pet"
  /// Constant host so every request is same-origin (no CORS needed).
  static let host = "app"

  /// Root of the bundled pet resources copied verbatim from the design handoff.
  /// `PetResources/` is declared as a `.copy` resource, so it lands as a folder reference in the
  /// bundle and the engine's path layout (`/source/pet/...`) is preserved 1:1.
  private let resourceRoot: URL?

  public override init() {
    self.resourceRoot = Bundle.module.url(forResource: "PetResources", withExtension: nil)
    super.init()
  }

  /// The host page's scheme URL for `WKWebView.load(...)`. We always load via the custom scheme
  /// (never `file://`) so subresource origins match and the engine's absolute fetches resolve here.
  public static var hostPageURL: URL {
    URL(string: "\(scheme)://\(host)/pet-host.html")!
  }

  public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    let url = urlSchemeTask.request.url
    guard let url else {
      urlSchemeTask.didFailWithError(MobilePetSchemeError.badRequest)
      return
    }

    // Map the URL path to a bundled file. Strip the leading "/" and any "?v=" cache-buster
    // (URLComponents.path already drops the query). Reject path traversal.
    let rawPath = url.path
    let relPath = rawPath.hasPrefix("/") ? String(rawPath.dropFirst()) : rawPath
    guard !relPath.contains(".."), let resourceRoot else {
      urlSchemeTask.didFailWithError(MobilePetSchemeError.notFound(rawPath))
      return
    }

    let fileURL = resourceRoot.appendingPathComponent(relPath)
    guard let data = try? Data(contentsOf: fileURL) else {
      urlSchemeTask.didFailWithError(MobilePetSchemeError.notFound(rawPath))
      return
    }

    let response = HTTPURLResponse(
      url: url,
      statusCode: 200,
      httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": Self.contentType(for: fileURL),
        "Content-Length": String(data.count),
        // Same-origin already, but harmless and defensive if the engine ever cross-fetches.
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      ]
    )!
    urlSchemeTask.didReceive(response)
    urlSchemeTask.didReceive(data)
    urlSchemeTask.didFinish()
  }

  public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
    // Synchronous, in-memory reads — nothing to cancel.
  }

  private static func contentType(for url: URL) -> String {
    switch url.pathExtension.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "js": return "text/javascript; charset=utf-8"
    case "json": return "application/json; charset=utf-8"
    case "png": return "image/png"
    default: return "application/octet-stream"
    }
  }
}

public enum MobilePetSchemeError: Error {
  case badRequest
  case notFound(String)
}
#endif
