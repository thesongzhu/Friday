import Darwin
import Foundation
import SQLite3
import Testing
@testable import FridayCompanionCore

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

@Test
func configParsesExpectedEnvironment() throws {
  let config = try CompanionConfig.fromEnvironment([
    "FRIDAY_SYSTEM_COMPANION_ID": "native-companion",
    "FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN": "secret-token",
    "FRIDAY_WORKSPACE_ROOT": "/tmp/friday",
    "FRIDAY_SYSTEM_COMPANION_SOCKET_PATH": "/tmp/friday.sock",
    "FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND": "swift_app",
    "FRIDAY_SYSTEM_OVERLAY_HOTKEY": "cmd+shift+space",
    "FRIDAY_SYSTEM_PANIC_HOTKEY": "cmd+shift+escape",
    "FRIDAY_SYSTEM_COMPANION_HEARTBEAT_MS": "9000",
    "FRIDAY_SYSTEM_NOTIFICATION_DB_PATH": "/tmp/friday-usernoted.db",
    "FRIDAY_SYSTEM_NOTIFICATION_LIMIT": "8",
  ])

  #expect(config.id == "native-companion")
  #expect(config.socketPath == "/tmp/friday.sock")
  #expect(config.workspaceRoot == "/tmp/friday")
  #expect(config.runtimeKind == "swift_app")
  #expect(config.overlayHotkey.displayString == "cmd+shift+space")
  #expect(config.panicHotkey.displayString == "cmd+shift+escape")
  #expect(config.heartbeatIntervalMs == 9000)
  #expect(config.notificationDatabasePath == "/tmp/friday-usernoted.db")
  #expect(config.notificationLimit == 8)
}

@Test
func configReadsAuthTokenFromSharedTokenFile() throws {
  let tempDir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
  defer {
    try? FileManager.default.removeItem(at: tempDir)
  }

  let tokenFile = tempDir.appending(path: "system-companion.auth.token")
  try "shared-secret".write(to: tokenFile, atomically: true, encoding: .utf8)

  let config = try CompanionConfig.fromEnvironment([
    "FRIDAY_WORKSPACE_ROOT": "/tmp/friday",
    "FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE": tokenFile.path(),
  ])

  #expect(config.authToken == "shared-secret")
}

@Test
func notificationStoreTracksReadAndDismissedState() {
  let store = CompanionNotificationStore(nowIso: { "2026-03-06T12:00:00.000Z" })
  let notification = store.record(sourceApp: "Finder", title: "Build finished", body: "Ready")

  #expect(store.listVisible().count == 1)
  #expect(store.act(on: notification.id, action: "mark_read")?.read == true)
  #expect(store.act(on: notification.id, action: "dismiss")?.dismissed == true)
  #expect(store.listVisible().count == 0)
}

@Test
func notificationStorePreservesStateAcrossSnapshotRefresh() {
  let store = CompanionNotificationStore(nowIso: { "2026-03-06T12:00:00.000Z" })
  let seeded = CompanionNotification(
    id: "notif-1",
    sourceApp: "com.openai.codex",
    title: "Build complete",
    body: "All tests passed",
    deepLinkUrl: "codex://thread/1",
    receivedAt: "2026-03-06T12:00:00.000Z",
    read: false
  )

  _ = store.replaceSnapshot([seeded])
  #expect(store.act(on: "notif-1", action: "dismiss")?.dismissed == true)

  let refreshed = store.replaceSnapshot([seeded])
  #expect(refreshed.isEmpty)
  #expect(store.listVisible().isEmpty)
}

@Test
func userNotedReaderParsesNotificationsFromSQLite() throws {
  let tempDir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
  defer {
    try? FileManager.default.removeItem(at: tempDir)
  }

  let databasePath = tempDir.appending(path: "usernoted.db").path()
  try seedNotificationDatabase(at: databasePath)

  let reader = CompanionUserNotedNotificationReader(databasePath: databasePath, maxRecords: 10)
  let notifications = try reader.readNotifications()

  #expect(notifications.count == 1)
  #expect(notifications.first?.id == "com.openai.codex:notification:test-1")
  #expect(notifications.first?.sourceApp == "com.openai.codex")
  #expect(notifications.first?.systemUuidHex == "11111111111111111111111111111111")
  #expect(notifications.first?.title == "Build complete")
  #expect(notifications.first?.body == "All tests passed")
  #expect(notifications.first?.deepLinkUrl == "codex://thread/1")
  #expect(notifications.first?.read == false)
}

@Test
func userNotedReaderIgnoresNotificationsRemovedFromDeliveredList() throws {
  let tempDir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
  defer {
    try? FileManager.default.removeItem(at: tempDir)
  }

  let databasePath = tempDir.appending(path: "usernoted.db").path()
  try seedNotificationDatabase(at: databasePath)
  try updateNotificationUuidList(table: "delivered", at: databasePath, uuids: [])

  let reader = CompanionUserNotedNotificationReader(databasePath: databasePath, maxRecords: 10)
  let notifications = try reader.readNotifications()

  #expect(notifications.isEmpty)
}

@Test
func userNotedMutatorDismissesDeliveredNotification() throws {
  let tempDir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
  defer {
    try? FileManager.default.removeItem(at: tempDir)
  }

  let databasePath = tempDir.appending(path: "usernoted.db").path()
  try seedNotificationDatabase(at: databasePath)
  let mutator = CompanionUserNotedNotificationMutator(databasePath: databasePath)

  let dismissed = try mutator.dismissNotification(
    sourceApp: "com.openai.codex",
    systemUuidHex: "11111111111111111111111111111111"
  )
  let reader = CompanionUserNotedNotificationReader(databasePath: databasePath, maxRecords: 10)
  let notifications = try reader.readNotifications()

  #expect(dismissed == true)
  #expect(notifications.isEmpty)
  #expect(try readNotificationUuidList(table: "delivered", at: databasePath).isEmpty)
  #expect(try readNotificationUuidList(table: "displayed", at: databasePath).isEmpty)
  #expect(try readNotificationUuidList(table: "requests", at: databasePath).isEmpty)
}

@Test
func userNotedMutatorMarksNotificationReadByClearingDisplayedListOnly() throws {
  let tempDir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
  defer {
    try? FileManager.default.removeItem(at: tempDir)
  }

  let databasePath = tempDir.appending(path: "usernoted.db").path()
  try seedNotificationDatabase(at: databasePath)
  let mutator = CompanionUserNotedNotificationMutator(databasePath: databasePath)

  let marked = try mutator.markNotificationRead(
    sourceApp: "com.openai.codex",
    systemUuidHex: "11111111111111111111111111111111"
  )

  #expect(marked == true)
  #expect(try readNotificationUuidList(table: "displayed", at: databasePath).isEmpty)
  #expect(try readNotificationUuidList(table: "delivered", at: databasePath) == ["11111111111111111111111111111111"])
}

@Test
func socketServerRejectsWrongAuthToken() {
  let server = CompanionUnixSocketServer(
    socketPath: "/tmp/friday-test.sock",
    authToken: "secret-token"
  ) { _, _ in
    ["ok": true]
  }

  let response = server.handleRequestLine(
    #"{"jsonrpc":"2.0","id":"1","method":"companion.ping","params":{"authToken":"wrong-token"}}"#
  )

  #expect(response.contains("\"Unauthorized\""))
}

@Test
func socketServerDispatchesAuthorizedMethod() {
  let server = CompanionUnixSocketServer(
    socketPath: "/tmp/friday-test.sock",
    authToken: "secret-token"
  ) { method, params in
    #expect(method == "companion.ping")
    #expect(params["authToken"] as? String == "secret-token")
    return ["ok": true, "serverTime": "2026-03-06T12:00:00.000Z"]
  }

  let response = server.handleRequestLine(
    #"{"jsonrpc":"2.0","id":"1","method":"companion.ping","params":{"authToken":"secret-token"}}"#
  )

  #expect(response.contains("\"ok\":true"))
  #expect(response.contains("\"serverTime\":\"2026-03-06T12:00:00.000Z\""))
}

@Test
func socketServerRespondsOverLiveSocket() async throws {
  let tempDir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
  try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
  defer {
    try? FileManager.default.removeItem(at: tempDir)
  }

  let socketPath = tempDir.appending(path: "friday-live.sock").path()
  let server = CompanionUnixSocketServer(
    socketPath: socketPath,
    authToken: "secret-token"
  ) { _, _ in
    ["ok": true, "serverTime": "2026-03-06T12:00:00.000Z"]
  }

  try server.start()
  defer {
    server.stop()
  }

  try await Task.sleep(for: .milliseconds(100))

  let response = try sendSocketRequest(
    socketPath: socketPath,
    request: #"{"jsonrpc":"2.0","id":"1","method":"companion.ping","params":{"authToken":"secret-token"}}"#
  )

  #expect(response.contains("\"ok\":true"))
  #expect(response.contains("\"serverTime\":\"2026-03-06T12:00:00.000Z\""))
}

private func sendSocketRequest(socketPath: String, request: String) throws -> String {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else {
    throw CompanionServerError.socketCreateFailed
  }
  defer {
    shutdown(fd, SHUT_RDWR)
    close(fd)
  }

  var timeout = timeval(tv_sec: 2, tv_usec: 0)
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let pathBytes = Array(socketPath.utf8CString)
  let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
  withUnsafeMutablePointer(to: &address.sun_path) { pointer in
    let target = UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self)
    target.initialize(repeating: 0, count: pathCapacity)
    for (index, byte) in pathBytes.enumerated() {
      target[index] = byte
    }
  }

  let length = socklen_t(MemoryLayout.size(ofValue: address.sun_family) + pathBytes.count)
  let connectResult = withUnsafePointer(to: &address) { pointer -> Int32 in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, length)
    }
  }
  guard connectResult == 0 else {
    throw CompanionServerError.socketBindFailed(socketPath)
  }

  let payload = request + "\n"
  let writeResult = payload.withCString { pointer in
    Darwin.write(fd, pointer, strlen(pointer))
  }
  guard writeResult > 0 else {
    throw CompanionServerError.invalidRequest
  }

  var data = Data()
  var byte = UInt8(0)
  while true {
    let count = Darwin.read(fd, &byte, 1)
    if count <= 0 {
      break
    }
    if byte == 0x0A {
      break
    }
    data.append(byte)
  }

  guard let response = String(data: data, encoding: .utf8), !response.isEmpty else {
    throw CompanionServerError.invalidRequest
  }
  return response
}

private func seedNotificationDatabase(at path: String) throws {
  var database: OpaquePointer?
  guard sqlite3_open(path, &database) == SQLITE_OK, let database else {
    throw CompanionServerError.socketCreateFailed
  }
  defer {
    sqlite3_close(database)
  }

  let schema = """
    CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier VARCHAR, badge INTEGER NULL);
    CREATE TABLE delivered (app_id INTEGER PRIMARY KEY, list BLOB);
    CREATE TABLE displayed (app_id INTEGER PRIMARY KEY, list BLOB);
    CREATE TABLE requests (app_id INTEGER PRIMARY KEY, list BLOB);
    CREATE TABLE record (
      rec_id INTEGER PRIMARY KEY,
      app_id INTEGER,
      uuid BLOB,
      data BLOB,
      request_date REAL,
      request_last_date REAL,
      delivered_date REAL,
      presented Bool,
      style INTEGER,
      snooze_fire_date REAL
    );
    """
  guard sqlite3_exec(database, schema, nil, nil, nil) == SQLITE_OK else {
    throw CompanionServerError.invalidRequest
  }

  let payload = try PropertyListSerialization.data(
    fromPropertyList: [
      "app": "com.openai.codex",
      "req": [
        "titl": "Build complete",
        "body": "All tests passed",
        "iden": "com.openai.codex:notification:test-1",
        "durl": "codex://thread/1",
      ],
    ],
    format: .binary,
    options: 0
  )
  let deliveredDate = 794_549_257.601622

  var insertApp: OpaquePointer?
  guard sqlite3_prepare_v2(database, "INSERT INTO app (app_id, identifier, badge) VALUES (1, ?, NULL)", -1, &insertApp, nil) == SQLITE_OK, let insertApp else {
    throw CompanionServerError.invalidRequest
  }
  defer {
    sqlite3_finalize(insertApp)
  }
  sqlite3_bind_text(insertApp, 1, ("com.openai.codex" as NSString).utf8String, -1, SQLITE_TRANSIENT)
  guard sqlite3_step(insertApp) == SQLITE_DONE else {
    throw CompanionServerError.invalidRequest
  }

  var insertRecord: OpaquePointer?
  let recordSql = """
    INSERT INTO record (
      app_id,
      uuid,
      data,
      request_date,
      request_last_date,
      delivered_date,
      presented,
      style,
      snooze_fire_date
    ) VALUES (1, ?, ?, ?, ?, ?, 0, 0, NULL)
    """
  guard sqlite3_prepare_v2(database, recordSql, -1, &insertRecord, nil) == SQLITE_OK, let insertRecord else {
    throw CompanionServerError.invalidRequest
  }
  defer {
    sqlite3_finalize(insertRecord)
  }

  let uuidBytes = Array<UInt8>(hex: "11111111111111111111111111111111")
  sqlite3_bind_blob(insertRecord, 1, uuidBytes, Int32(uuidBytes.count), SQLITE_TRANSIENT)
  let bindResult = payload.withUnsafeBytes { buffer in
    sqlite3_bind_blob(insertRecord, 2, buffer.baseAddress, Int32(buffer.count), SQLITE_TRANSIENT)
  }
  guard bindResult == SQLITE_OK else {
    throw CompanionServerError.invalidRequest
  }
  sqlite3_bind_double(insertRecord, 3, deliveredDate)
  sqlite3_bind_double(insertRecord, 4, deliveredDate)
  sqlite3_bind_double(insertRecord, 5, deliveredDate)
  guard sqlite3_step(insertRecord) == SQLITE_DONE else {
    throw CompanionServerError.invalidRequest
  }

  try updateNotificationUuidList(
    table: "delivered",
    database: database,
    uuids: ["11111111111111111111111111111111"]
  )
  try updateNotificationUuidList(
    table: "displayed",
    database: database,
    uuids: ["11111111111111111111111111111111"]
  )
  try updateNotificationUuidList(
    table: "requests",
    database: database,
    uuids: ["11111111111111111111111111111111"]
  )
}

private func readNotificationUuidList(table: String, at path: String) throws -> [String] {
  var database: OpaquePointer?
  guard sqlite3_open(path, &database) == SQLITE_OK, let database else {
    throw CompanionServerError.socketCreateFailed
  }
  defer {
    sqlite3_close(database)
  }
  return try readNotificationUuidList(table: table, database: database)
}

private func readNotificationUuidList(table: String, database: OpaquePointer) throws -> [String] {
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, "SELECT list FROM \(table) WHERE app_id = 1", -1, &statement, nil) == SQLITE_OK, let statement else {
    throw CompanionServerError.invalidRequest
  }
  defer {
    sqlite3_finalize(statement)
  }

  guard sqlite3_step(statement) == SQLITE_ROW else {
    return []
  }
  guard let data = dataValue(statement, index: 0), !data.isEmpty else {
    return []
  }
  return stride(from: 0, to: data.count, by: 16).compactMap { offset in
    guard offset + 16 <= data.count else {
      return nil
    }
    return data.subdata(in: offset..<(offset + 16)).map { String(format: "%02x", $0) }.joined()
  }
}

private func updateNotificationUuidList(table: String, at path: String, uuids: [String]) throws {
  var database: OpaquePointer?
  guard sqlite3_open(path, &database) == SQLITE_OK, let database else {
    throw CompanionServerError.socketCreateFailed
  }
  defer {
    sqlite3_close(database)
  }
  try updateNotificationUuidList(table: table, database: database, uuids: uuids)
}

private func updateNotificationUuidList(table: String, database: OpaquePointer, uuids: [String]) throws {
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(database, "INSERT OR REPLACE INTO \(table) (app_id, list) VALUES (1, ?)", -1, &statement, nil) == SQLITE_OK, let statement else {
    throw CompanionServerError.invalidRequest
  }
  defer {
    sqlite3_finalize(statement)
  }

  if uuids.isEmpty {
    sqlite3_bind_null(statement, 1)
  } else {
    let data = Data(uuids.flatMap { Array<UInt8>(hex: $0) })
    let bindResult = data.withUnsafeBytes { buffer in
      sqlite3_bind_blob(statement, 1, buffer.baseAddress, Int32(buffer.count), SQLITE_TRANSIENT)
    }
    guard bindResult == SQLITE_OK else {
      throw CompanionServerError.invalidRequest
    }
  }
  guard sqlite3_step(statement) == SQLITE_DONE else {
    throw CompanionServerError.invalidRequest
  }
}

private func dataValue(_ statement: OpaquePointer, index: Int32) -> Data? {
  guard let bytes = sqlite3_column_blob(statement, index) else {
    return nil
  }
  let length = Int(sqlite3_column_bytes(statement, index))
  return Data(bytes: bytes, count: length)
}

private extension Array where Element == UInt8 {
  init(hex: String) {
    self = stride(from: 0, to: hex.count, by: 2).compactMap { index in
      let start = hex.index(hex.startIndex, offsetBy: index)
      let end = hex.index(start, offsetBy: 2)
      return UInt8(hex[start..<end], radix: 16)
    }
  }
}
