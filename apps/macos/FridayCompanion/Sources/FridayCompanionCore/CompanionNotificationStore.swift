import Foundation

public struct CompanionNotification: Equatable, Sendable {
  public let id: String
  public let sourceApp: String?
  public let systemUuidHex: String?
  public let title: String
  public let body: String?
  public let deepLinkUrl: String?
  public let receivedAt: String
  public var read: Bool
  public var dismissed: Bool

  public init(
    id: String,
    sourceApp: String?,
    systemUuidHex: String? = nil,
    title: String,
    body: String?,
    deepLinkUrl: String? = nil,
    receivedAt: String,
    read: Bool,
    dismissed: Bool = false
  ) {
    self.id = id
    self.sourceApp = sourceApp
    self.systemUuidHex = systemUuidHex
    self.title = title
    self.body = body
    self.deepLinkUrl = deepLinkUrl
    self.receivedAt = receivedAt
    self.read = read
    self.dismissed = dismissed
  }
}

public final class CompanionNotificationStore: @unchecked Sendable {
  private let nowIso: @Sendable () -> String
  private let lock = NSLock()
  private var notifications: [CompanionNotification] = []

  public init(nowIso: @escaping @Sendable () -> String) {
    self.nowIso = nowIso
  }

  public func record(sourceApp: String?, title: String, body: String?) -> CompanionNotification {
    lock.lock()
    defer { lock.unlock() }
    let notification = CompanionNotification(
      id: UUID().uuidString.lowercased(),
      sourceApp: sourceApp,
      systemUuidHex: nil,
      title: title,
      body: body,
      deepLinkUrl: nil,
      receivedAt: nowIso(),
      read: false
    )
    notifications.insert(notification, at: 0)
    return notification
  }

  @discardableResult
  public func replaceSnapshot(_ snapshot: [CompanionNotification]) -> [CompanionNotification] {
    lock.lock()
    defer { lock.unlock() }
    let previousState = Dictionary(uniqueKeysWithValues: notifications.map { ($0.id, $0) })
    notifications = snapshot.map { notification in
      guard let current = previousState[notification.id] else {
        return notification
      }
      var merged = notification
      merged.read = current.read || notification.read
      merged.dismissed = current.dismissed || notification.dismissed
      return merged
    }
    return notifications.filter { !$0.dismissed }
  }

  public func listVisible() -> [CompanionNotification] {
    lock.lock()
    defer { lock.unlock() }
    return notifications.filter { !$0.dismissed }
  }

  @discardableResult
  public func act(on id: String, action: String) -> CompanionNotification? {
    lock.lock()
    defer { lock.unlock() }
    guard let index = notifications.firstIndex(where: { $0.id == id }) else {
      return nil
    }
    switch action {
    case "open", "mark_read":
      notifications[index].read = true
    case "dismiss":
      notifications[index].read = true
      notifications[index].dismissed = true
    default:
      return nil
    }
    return notifications[index]
  }
}
