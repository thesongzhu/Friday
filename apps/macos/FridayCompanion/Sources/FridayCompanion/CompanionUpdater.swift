import AppKit
import Foundation
import ObjectiveC.runtime

@MainActor
protocol CompanionUpdaterProviding: AnyObject {
  var isAvailable: Bool { get }
  func checkForUpdates(_ sender: Any?)
}

@MainActor
final class DisabledCompanionUpdater: CompanionUpdaterProviding {
  let isAvailable = false

  func checkForUpdates(_ sender: Any?) {}
}

private func isDeveloperIDSigned(bundleURL: URL) -> Bool {
  var staticCode: SecStaticCode?
  guard
    SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &staticCode) == errSecSuccess,
    let code = staticCode
  else {
    return false
  }

  var infoCF: CFDictionary?
  guard
    SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF) == errSecSuccess,
    let info = infoCF as? [String: Any],
    let certs = info[kSecCodeInfoCertificates as String] as? [SecCertificate],
    let leaf = certs.first
  else {
    return false
  }

  guard let summary = SecCertificateCopySubjectSummary(leaf) as String? else {
    return false
  }
  return summary.hasPrefix("Developer ID Application:")
}

private func hasSparkleMetadata(bundle: Bundle) -> Bool {
  guard
    let feedUrl = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
    let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
  else {
    return false
  }
  return !feedUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    && !publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

private func loadSparkleFramework(from bundle: Bundle) -> Bundle? {
  guard let frameworksURL = bundle.privateFrameworksURL else {
    return nil
  }
  let frameworkURL = frameworksURL.appendingPathComponent("Sparkle.framework")
  guard let frameworkBundle = Bundle(url: frameworkURL) else {
    return nil
  }
  if !frameworkBundle.isLoaded {
    frameworkBundle.load()
  }
  return frameworkBundle.isLoaded ? frameworkBundle : nil
}

@MainActor
final class SparkleCompanionUpdater: NSObject, CompanionUpdaterProviding {
  private let controller: NSObject
  let isAvailable = true

  init?(bundle: Bundle) {
    guard loadSparkleFramework(from: bundle) != nil else {
      return nil
    }

    guard let controllerClass = NSClassFromString("SPUStandardUpdaterController") else {
      return nil
    }

    let selector = NSSelectorFromString("initWithStartingUpdater:updaterDelegate:userDriverDelegate:")
    guard let rawInstance = class_createInstance(controllerClass, 0) else {
      return nil
    }
    let allocated = unsafeBitCast(rawInstance, to: NSObject.self)
    guard allocated.responds(to: selector) else {
      return nil
    }

    typealias Initializer = @convention(c) (AnyObject, Selector, Bool, AnyObject?, AnyObject?) -> Unmanaged<AnyObject>
    let initializer = unsafeBitCast(allocated.method(for: selector), to: Initializer.self)
    let updaterDelegate: AnyObject? = nil
    let userDriverDelegate: AnyObject? = nil
    self.controller = initializer(
      allocated,
      selector,
      true,
      updaterDelegate,
      userDriverDelegate
    ).takeRetainedValue() as! NSObject
    super.init()
  }

  func checkForUpdates(_ sender: Any?) {
    let selector = NSSelectorFromString("checkForUpdates:")
    guard controller.responds(to: selector) else {
      return
    }
    _ = controller.perform(selector, with: sender)
  }
}

@MainActor
func makeCompanionUpdater(bundle: Bundle = .main) -> CompanionUpdaterProviding {
  let bundleURL = bundle.bundleURL
  guard bundleURL.pathExtension == "app" else {
    return DisabledCompanionUpdater()
  }
  guard hasSparkleMetadata(bundle: bundle) else {
    return DisabledCompanionUpdater()
  }
  guard isDeveloperIDSigned(bundleURL: bundleURL) else {
    return DisabledCompanionUpdater()
  }
  return SparkleCompanionUpdater(bundle: bundle) ?? DisabledCompanionUpdater()
}
