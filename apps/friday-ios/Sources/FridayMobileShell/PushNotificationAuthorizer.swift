import FridayMobileShellCore
import UserNotifications

struct SystemPushNotificationAuthorizer: MobilePushNotificationAuthorizing {
  func currentSettings() async throws -> MobilePushNotificationSettings {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    return MobilePushNotificationSettings(
      authorizationStatus: Self.mapAuthorization(settings.authorizationStatus),
      alertSettingEnabled: Self.isEnabled(settings.alertSetting),
      badgeSettingEnabled: Self.isEnabled(settings.badgeSetting),
      soundSettingEnabled: Self.isEnabled(settings.soundSetting))
  }

  func requestUserAuthorization() async throws -> Bool {
    try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
  }

  private static func mapAuthorization(_ status: UNAuthorizationStatus) -> MobilePushAuthorizationStatus {
    switch status {
    case .notDetermined:
      return .notDetermined
    case .denied:
      return .denied
    case .authorized:
      return .authorized
    case .provisional:
      return .provisional
    case .ephemeral:
      return .ephemeral
    @unknown default:
      return .unknown
    }
  }

  private static func isEnabled(_ setting: UNNotificationSetting) -> Bool {
    setting == .enabled
  }
}
