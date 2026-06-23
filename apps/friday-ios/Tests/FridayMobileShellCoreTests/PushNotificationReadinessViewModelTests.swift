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
