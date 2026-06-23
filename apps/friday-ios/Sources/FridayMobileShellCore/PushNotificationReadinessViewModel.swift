import Foundation

public enum MobilePushAuthorizationStatus: String, Sendable, Equatable {
  case notDetermined = "not_determined"
  case denied
  case authorized
  case provisional
  case ephemeral
  case unknown
}

public struct MobilePushNotificationSettings: Sendable, Equatable {
  public let authorizationStatus: MobilePushAuthorizationStatus
  public let alertSettingEnabled: Bool
  public let badgeSettingEnabled: Bool
  public let soundSettingEnabled: Bool

  public init(
    authorizationStatus: MobilePushAuthorizationStatus,
    alertSettingEnabled: Bool,
    badgeSettingEnabled: Bool,
    soundSettingEnabled: Bool
  ) {
    self.authorizationStatus = authorizationStatus
    self.alertSettingEnabled = alertSettingEnabled
    self.badgeSettingEnabled = badgeSettingEnabled
    self.soundSettingEnabled = soundSettingEnabled
  }
}

public protocol MobilePushNotificationAuthorizing: Sendable {
  func currentSettings() async throws -> MobilePushNotificationSettings
  func requestUserAuthorization() async throws -> Bool
}

public struct MobilePushNotificationReadiness: Sendable, Equatable {
  public let settings: MobilePushNotificationSettings
  public let remoteDeliveryConfigured: Bool
  public let truthLabel: String

  public init(
    settings: MobilePushNotificationSettings,
    remoteDeliveryConfigured: Bool = false,
    truthLabel: String = "mobile_push_permission_local_only"
  ) {
    self.settings = settings
    self.remoteDeliveryConfigured = remoteDeliveryConfigured
    self.truthLabel = truthLabel
  }

  public var canRequestPermission: Bool {
    settings.authorizationStatus == .notDetermined
  }

  public var localNotificationUsable: Bool {
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral:
      return settings.alertSettingEnabled || settings.badgeSettingEnabled || settings.soundSettingEnabled
    case .notDetermined, .denied, .unknown:
      return false
    }
  }

  public var remotePushReady: Bool {
    localNotificationUsable && remoteDeliveryConfigured
  }

  public var summary: String {
    if remotePushReady {
      return "Remote push is configured and notification permission is usable."
    }
    if localNotificationUsable {
      return "Notification permission is usable; remote APNs delivery is not configured in this build."
    }
    switch settings.authorizationStatus {
    case .notDetermined:
      return "Notification permission has not been requested."
    case .denied:
      return "Notification permission is denied in iOS Settings."
    case .unknown:
      return "Notification permission state is unavailable."
    case .authorized, .provisional, .ephemeral:
      return "Notification permission exists, but alert, badge, and sound delivery are disabled."
    }
  }
}

public enum MobilePushNotificationReadinessState: Sendable, Equatable {
  case idle
  case loading
  case loaded(MobilePushNotificationReadiness)
  case unavailable(String)

  public var readiness: MobilePushNotificationReadiness? {
    if case let .loaded(readiness) = self { return readiness }
    return nil
  }
}

@MainActor
public final class PushNotificationReadinessViewModel: ObservableObject {
  @Published public private(set) var state: MobilePushNotificationReadinessState = .idle

  private let authorizer: any MobilePushNotificationAuthorizing
  private let remoteDeliveryConfigured: Bool
  private let truthLabel: String

  public init(
    authorizer: any MobilePushNotificationAuthorizing,
    remoteDeliveryConfigured: Bool = false,
    truthLabel: String = "mobile_push_permission_local_only"
  ) {
    self.authorizer = authorizer
    self.remoteDeliveryConfigured = remoteDeliveryConfigured
    self.truthLabel = truthLabel
  }

  public func refresh() async {
    state = .loading
    do {
      let settings = try await authorizer.currentSettings()
      state = .loaded(MobilePushNotificationReadiness(
        settings: settings,
        remoteDeliveryConfigured: remoteDeliveryConfigured,
        truthLabel: truthLabel))
    } catch {
      state = .unavailable("\(error)")
    }
  }

  public func requestPermission() async {
    state = .loading
    do {
      _ = try await authorizer.requestUserAuthorization()
      let settings = try await authorizer.currentSettings()
      state = .loaded(MobilePushNotificationReadiness(
        settings: settings,
        remoteDeliveryConfigured: remoteDeliveryConfigured,
        truthLabel: truthLabel))
    } catch {
      state = .unavailable("\(error)")
    }
  }
}
