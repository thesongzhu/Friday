import Foundation
import Testing
@testable import FridayMobileShellCore

@Test
func pushReadinessDoesNotTreatLocalPermissionAsRemoteDelivery() {
  let readiness = MobilePushNotificationReadiness(settings: MobilePushNotificationSettings(
    authorizationStatus: .authorized,
    alertSettingEnabled: true,
    badgeSettingEnabled: true,
    soundSettingEnabled: false))

  #expect(readiness.localNotificationUsable)
  #expect(!readiness.remotePushReady)
  #expect(readiness.truthLabel == "mobile_push_permission_local_only")
  #expect(readiness.summary.contains("remote APNs delivery is not configured"))
}

@Test
func pushReadinessCanRequestOnlyBeforeSystemDecision() {
  #expect(MobilePushNotificationReadiness(settings: MobilePushNotificationSettings(
    authorizationStatus: .notDetermined,
    alertSettingEnabled: false,
    badgeSettingEnabled: false,
    soundSettingEnabled: false)).canRequestPermission)

  #expect(!MobilePushNotificationReadiness(settings: MobilePushNotificationSettings(
    authorizationStatus: .denied,
    alertSettingEnabled: false,
    badgeSettingEnabled: false,
    soundSettingEnabled: false)).canRequestPermission)
}

@MainActor
@Test
func pushReadinessViewModelRefreshesAndRequestsPermission() async {
  let authorizer = FakePushAuthorizer(settings: MobilePushNotificationSettings(
    authorizationStatus: .notDetermined,
    alertSettingEnabled: false,
    badgeSettingEnabled: false,
    soundSettingEnabled: false))
  let viewModel = PushNotificationReadinessViewModel(authorizer: authorizer)

  await viewModel.refresh()
  #expect(viewModel.state.readiness?.settings.authorizationStatus == .notDetermined)
  #expect(viewModel.state.readiness?.canRequestPermission == true)

  await viewModel.requestPermission()
  #expect(authorizer.requestCount == 1)
  #expect(viewModel.state.readiness?.settings.authorizationStatus == .authorized)
  #expect(viewModel.state.readiness?.localNotificationUsable == true)
  #expect(viewModel.state.readiness?.remotePushReady == false)
  try? writeMobileSettingsActionEvidenceIfRequested(
    readiness: viewModel.state.readiness,
    requestCount: authorizer.requestCount)
}

private func writeMobileSettingsActionEvidenceIfRequested(
  readiness: MobilePushNotificationReadiness?,
  requestCount: Int
) throws {
  guard let rawDir = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_PROJECTION_ACTION_EVIDENCE_DIR"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawDir.isEmpty else {
    return
  }

  let proof: [String: Any] = [
    "truth": "mobile_settings_action_swift_viewmodel_runtime_not_live_hub_not_endbar",
    "status": readiness?.localNotificationUsable == true && requestCount > 0 ? "ready" : "blocked",
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "request_count": requestCount,
    "authorization_status": readiness?.settings.authorizationStatus.rawValue ?? "missing",
    "remote_push_ready": readiness?.remotePushReady ?? false,
    "actions": [
      [
        "surface": "mobile",
        "screen": "settings",
        "action_id": "mobile/settings/push-permission",
        "capability_id": "mobile_settings_push_permission",
        "status": readiness?.localNotificationUsable == true && requestCount > 0 ? "pass" : "blocked",
        "evidence_ref": "swift://mobile/settings/push-permission",
        "source": "ios_push_notification_readiness_viewmodel_runtime",
        "truth_label": "swift_viewmodel_native_permission_runtime_not_remote_push_not_sim_tap",
      ],
    ],
    "caveat": "Partial runtime evidence only: native settings permission request wiring is exercised with a fake authorizer. Remote APNs delivery, simulator/device tap proof, END-BAR, and adoption remain separate.",
  ]

  let dir = URL(fileURLWithPath: rawDir)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let out = dir.appendingPathComponent("mobile-settings-action-evidence.json")
  let data = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: out, options: .atomic)
  print("[mobile-settings-action-evidence] proofOut=\(out.path)")
}

private final class FakePushAuthorizer: MobilePushNotificationAuthorizing, @unchecked Sendable {
  private(set) var requestCount = 0
  private var settings: MobilePushNotificationSettings

  init(settings: MobilePushNotificationSettings) {
    self.settings = settings
  }

  func currentSettings() async throws -> MobilePushNotificationSettings {
    settings
  }

  func requestUserAuthorization() async throws -> Bool {
    requestCount += 1
    settings = MobilePushNotificationSettings(
      authorizationStatus: .authorized,
      alertSettingEnabled: true,
      badgeSettingEnabled: true,
      soundSettingEnabled: true)
    return true
  }
}
