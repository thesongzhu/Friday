import Foundation
import SQLite3

public enum CompanionUserNotedNotificationReaderError: Error, CustomStringConvertible {
  case databaseOpenFailed(String)
  case statementPrepareFailed
  case invalidPropertyList

  public var description: String {
    switch self {
    case .databaseOpenFailed(let path):
      return "Unable to open usernoted database at \(path)"
    case .statementPrepareFailed:
      return "Unable to prepare usernoted notification query"
    case .invalidPropertyList:
      return "Unable to decode notification payload from usernoted"
    }
  }
}

public final class CompanionUserNotedNotificationReader: @unchecked Sendable {
  private let databasePath: String
  private let maxRecords: Int32
  private let fileManager: FileManager

  public init(
    databasePath: String = CompanionUserNotedNotificationReader.defaultDatabasePath(),
    maxRecords: Int = 64,
    fileManager: FileManager = .default
  ) {
    self.databasePath = databasePath
    self.maxRecords = Int32(max(1, maxRecords))
    self.fileManager = fileManager
  }

  public static func defaultDatabasePath(homeDirectory: String = NSHomeDirectory()) -> String {
    "\(homeDirectory)/Library/Group Containers/group.com.apple.usernoted/db2/db"
  }

  public func readNotifications() throws -> [CompanionNotification] {
    guard fileManager.fileExists(atPath: databasePath) else {
      return []
    }

    var database: OpaquePointer?
    guard sqlite3_open_v2(databasePath, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let database else {
      throw CompanionUserNotedNotificationReaderError.databaseOpenFailed(databasePath)
    }
    defer {
      sqlite3_close(database)
    }

    let sql = """
      SELECT lower(hex(record.uuid)), record.uuid, app.identifier, record.delivered_date, record.data, delivered.app_id, delivered.list
      FROM record
      JOIN app ON app.app_id = record.app_id
      LEFT JOIN delivered ON delivered.app_id = record.app_id
      ORDER BY record.delivered_date DESC
      LIMIT ?
      """
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw CompanionUserNotedNotificationReaderError.statementPrepareFailed
    }
    defer {
      sqlite3_finalize(statement)
    }

    sqlite3_bind_int(statement, 1, maxRecords)

    var notifications: [CompanionNotification] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      guard
        let uuidHex = stringValue(statement, index: 0),
        let uuidData = dataValue(statement, index: 1),
        let payloadData = dataValue(statement, index: 4)
      else {
        continue
      }
      let deliveredAppId = sqlite3_column_type(statement, 5) == SQLITE_NULL ? nil : sqlite3_column_int64(statement, 5)
      let deliveredList = dataValue(statement, index: 6)
      if deliveredAppId != nil && (deliveredList == nil || !uuidListContains(deliveredList!, uuidData: uuidData)) {
        continue
      }
      let appIdentifier = stringValue(statement, index: 2)
      let deliveredDate = sqlite3_column_double(statement, 3)
      if let notification = try parseNotification(
        uuidHex: uuidHex,
        appIdentifier: appIdentifier,
        deliveredDate: deliveredDate,
        payloadData: payloadData
      ) {
        notifications.append(notification)
      }
    }

    return notifications
  }

  private func parseNotification(
    uuidHex: String,
    appIdentifier: String?,
    deliveredDate: Double,
    payloadData: Data
  ) throws -> CompanionNotification? {
    guard
      let propertyList = try PropertyListSerialization.propertyList(from: payloadData, options: [], format: nil) as? [String: Any]
    else {
      throw CompanionUserNotedNotificationReaderError.invalidPropertyList
    }

    let request = propertyList["req"] as? [String: Any] ?? [:]
    guard
      let title = firstNonEmptyString(
        request["titl"] as? String,
        request["subt"] as? String,
        propertyList["app"] as? String,
        appIdentifier
      )
    else {
      return nil
    }

    let sourceApp = firstNonEmptyString(appIdentifier, propertyList["app"] as? String)
    let notificationId = firstNonEmptyString(request["iden"] as? String) ?? uuidHex.lowercased()
    let receivedAt = formatIsoDate(timeIntervalSinceReferenceDate: deliveredDate)

    return CompanionNotification(
      id: notificationId,
      sourceApp: sourceApp,
      systemUuidHex: uuidHex.lowercased(),
      title: title,
      body: firstNonEmptyString(request["body"] as? String),
      deepLinkUrl: firstNonEmptyString(request["durl"] as? String),
      receivedAt: receivedAt,
      read: false
    )
  }
}

private func stringValue(_ statement: OpaquePointer, index: Int32) -> String? {
  guard let value = sqlite3_column_text(statement, index) else {
    return nil
  }
  return String(cString: value)
}

private func dataValue(_ statement: OpaquePointer, index: Int32) -> Data? {
  guard let bytes = sqlite3_column_blob(statement, index) else {
    return nil
  }
  let length = Int(sqlite3_column_bytes(statement, index))
  return Data(bytes: bytes, count: length)
}

private func uuidListContains(_ listData: Data, uuidData: Data) -> Bool {
  guard !listData.isEmpty, !uuidData.isEmpty, listData.count >= uuidData.count else {
    return false
  }
  var offset = 0
  while offset + uuidData.count <= listData.count {
    if listData.subdata(in: offset..<(offset + uuidData.count)) == uuidData {
      return true
    }
    offset += uuidData.count
  }
  return false
}

private func firstNonEmptyString(_ values: String?...) -> String? {
  for value in values {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      continue
    }
    return trimmed
  }
  return nil
}

private func formatIsoDate(timeIntervalSinceReferenceDate: Double) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: Date(timeIntervalSinceReferenceDate: timeIntervalSinceReferenceDate))
}
