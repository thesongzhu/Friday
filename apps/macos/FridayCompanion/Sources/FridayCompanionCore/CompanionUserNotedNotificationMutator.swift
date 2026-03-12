import Foundation
import SQLite3

public enum CompanionUserNotedNotificationMutatorError: Error, CustomStringConvertible {
  case databaseOpenFailed(String)
  case missingAppIdentifier
  case missingUuid
  case appNotFound(String)
  case statementPrepareFailed
  case statementExecutionFailed

  public var description: String {
    switch self {
    case .databaseOpenFailed(let path):
      return "Unable to open usernoted database at \(path)"
    case .missingAppIdentifier:
      return "Notification mutation requires a source app identifier"
    case .missingUuid:
      return "Notification mutation requires a system UUID"
    case .appNotFound(let appIdentifier):
      return "Notification app not found in usernoted: \(appIdentifier)"
    case .statementPrepareFailed:
      return "Unable to prepare usernoted mutation statement"
    case .statementExecutionFailed:
      return "Unable to execute usernoted mutation statement"
    }
  }
}

public final class CompanionUserNotedNotificationMutator: @unchecked Sendable {
  private let databasePath: String
  private let fileManager: FileManager

  public init(
    databasePath: String = CompanionUserNotedNotificationReader.defaultDatabasePath(),
    fileManager: FileManager = .default
  ) {
    self.databasePath = databasePath
    self.fileManager = fileManager
  }

  @discardableResult
  public func dismissNotification(sourceApp: String?, systemUuidHex: String?) throws -> Bool {
    let target = try resolveTarget(sourceApp: sourceApp, systemUuidHex: systemUuidHex)
    guard let database = try openDatabase() else {
      return false
    }
    defer {
      sqlite3_close(database)
    }

    let deliveredChanged = try removeUuid(uuidData: target.uuidData, fromTable: "delivered", appId: target.appId, database: database)
    let displayedChanged = try removeUuid(uuidData: target.uuidData, fromTable: "displayed", appId: target.appId, database: database)
    let requestsChanged = try removeUuid(uuidData: target.uuidData, fromTable: "requests", appId: target.appId, database: database)
    return deliveredChanged || displayedChanged || requestsChanged
  }

  @discardableResult
  public func markNotificationRead(sourceApp: String?, systemUuidHex: String?) throws -> Bool {
    let target = try resolveTarget(sourceApp: sourceApp, systemUuidHex: systemUuidHex)
    guard let database = try openDatabase() else {
      return false
    }
    defer {
      sqlite3_close(database)
    }

    return try removeUuid(uuidData: target.uuidData, fromTable: "displayed", appId: target.appId, database: database)
  }

  private func openDatabase() throws -> OpaquePointer? {
    guard fileManager.fileExists(atPath: databasePath) else {
      return nil
    }

    var database: OpaquePointer?
    guard sqlite3_open_v2(databasePath, &database, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
      throw CompanionUserNotedNotificationMutatorError.databaseOpenFailed(databasePath)
    }
    return database
  }

  private func resolveTarget(sourceApp: String?, systemUuidHex: String?) throws -> (appId: Int64, uuidData: Data) {
    guard let sourceApp = nonEmptyTrimmed(sourceApp) else {
      throw CompanionUserNotedNotificationMutatorError.missingAppIdentifier
    }
    guard let uuidHex = nonEmptyTrimmed(systemUuidHex), let uuidData = Data(hexString: uuidHex) else {
      throw CompanionUserNotedNotificationMutatorError.missingUuid
    }
    guard let database = try openDatabase() else {
      throw CompanionUserNotedNotificationMutatorError.appNotFound(sourceApp)
    }
    defer {
      sqlite3_close(database)
    }
    guard let appId = try fetchAppId(identifier: sourceApp, database: database) else {
      throw CompanionUserNotedNotificationMutatorError.appNotFound(sourceApp)
    }
    return (appId: appId, uuidData: uuidData)
  }

  private func fetchAppId(identifier: String, database: OpaquePointer) throws -> Int64? {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, "SELECT app_id FROM app WHERE identifier = ?", -1, &statement, nil) == SQLITE_OK, let statement else {
      throw CompanionUserNotedNotificationMutatorError.statementPrepareFailed
    }
    defer {
      sqlite3_finalize(statement)
    }
    sqlite3_bind_text(statement, 1, (identifier as NSString).utf8String, -1, SQLITE_TRANSIENT)
    guard sqlite3_step(statement) == SQLITE_ROW else {
      return nil
    }
    return sqlite3_column_int64(statement, 0)
  }

  private func removeUuid(
    uuidData: Data,
    fromTable table: String,
    appId: Int64,
    database: OpaquePointer
  ) throws -> Bool {
    let existingList = try fetchUuidList(fromTable: table, appId: appId, database: database)
    guard !existingList.isEmpty else {
      return false
    }
    let filteredList = existingList.filter { $0 != uuidData }
    guard filteredList.count != existingList.count else {
      return false
    }
    try updateUuidList(filteredList, inTable: table, appId: appId, database: database)
    return true
  }

  private func fetchUuidList(fromTable table: String, appId: Int64, database: OpaquePointer) throws -> [Data] {
    var statement: OpaquePointer?
    let sql = "SELECT list FROM \(table) WHERE app_id = ?"
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw CompanionUserNotedNotificationMutatorError.statementPrepareFailed
    }
    defer {
      sqlite3_finalize(statement)
    }

    sqlite3_bind_int64(statement, 1, appId)
    guard sqlite3_step(statement) == SQLITE_ROW else {
      return []
    }

    guard let data = dataValue(statement, index: 0), !data.isEmpty else {
      return []
    }
    return decodeUuidList(data)
  }

  private func updateUuidList(
    _ list: [Data],
    inTable table: String,
    appId: Int64,
    database: OpaquePointer
  ) throws {
    var statement: OpaquePointer?
    let sql = "UPDATE \(table) SET list = ? WHERE app_id = ?"
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw CompanionUserNotedNotificationMutatorError.statementPrepareFailed
    }
    defer {
      sqlite3_finalize(statement)
    }

    if list.isEmpty {
      sqlite3_bind_null(statement, 1)
    } else {
      let data = encodeUuidList(list)
      let bindResult = data.withUnsafeBytes { buffer in
        sqlite3_bind_blob(statement, 1, buffer.baseAddress, Int32(buffer.count), SQLITE_TRANSIENT)
      }
      guard bindResult == SQLITE_OK else {
        throw CompanionUserNotedNotificationMutatorError.statementExecutionFailed
      }
    }
    sqlite3_bind_int64(statement, 2, appId)
    guard sqlite3_step(statement) == SQLITE_DONE else {
      throw CompanionUserNotedNotificationMutatorError.statementExecutionFailed
    }
  }
}

private func decodeUuidList(_ data: Data) -> [Data] {
  guard !data.isEmpty else {
    return []
  }
  var uuids: [Data] = []
  var offset = 0
  while offset + 16 <= data.count {
    uuids.append(data.subdata(in: offset..<(offset + 16)))
    offset += 16
  }
  return uuids
}

private func encodeUuidList(_ list: [Data]) -> Data {
  var combined = Data()
  for item in list {
    combined.append(item)
  }
  return combined
}

private func nonEmptyTrimmed(_ value: String?) -> String? {
  guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return nil
  }
  return trimmed
}

private extension Data {
  init?(hexString: String) {
    let normalized = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
    guard normalized.count.isMultiple(of: 2) else {
      return nil
    }
    var bytes = Data(capacity: normalized.count / 2)
    var index = normalized.startIndex
    while index < normalized.endIndex {
      let next = normalized.index(index, offsetBy: 2)
      guard let byte = UInt8(normalized[index..<next], radix: 16) else {
        return nil
      }
      bytes.append(byte)
      index = next
    }
    self = bytes
  }
}

private func dataValue(_ statement: OpaquePointer, index: Int32) -> Data? {
  guard let bytes = sqlite3_column_blob(statement, index) else {
    return nil
  }
  let length = Int(sqlite3_column_bytes(statement, index))
  return Data(bytes: bytes, count: length)
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
