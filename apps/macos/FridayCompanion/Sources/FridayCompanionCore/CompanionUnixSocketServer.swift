import Darwin
import Dispatch
import Foundation

public enum CompanionServerError: Error, CustomStringConvertible {
  case socketCreateFailed
  case socketBindFailed(String)
  case socketListenFailed
  case socketPathTooLong
  case invalidRequest

  public var description: String {
    switch self {
    case .socketCreateFailed:
      return "Unable to create unix socket"
    case .socketBindFailed(let path):
      return "Unable to bind unix socket at \(path)"
    case .socketListenFailed:
      return "Unable to listen on unix socket"
    case .socketPathTooLong:
      return "Unix socket path exceeds sockaddr_un capacity"
    case .invalidRequest:
      return "Invalid JSON-RPC request"
    }
  }
}

public typealias CompanionRequestHandler = (_ method: String, _ params: [String: Any]) throws -> Any

public final class CompanionUnixSocketServer: @unchecked Sendable {
  private let socketPath: String
  private let authToken: String
  private let requestHandler: CompanionRequestHandler
  private let acceptQueue = DispatchQueue(label: "FridayCompanion.UnixSocketServer.Accept", qos: .userInitiated)
  private let clientQueue = DispatchQueue(
    label: "FridayCompanion.UnixSocketServer.Client",
    qos: .userInitiated,
    attributes: .concurrent
  )
  private var socketFD: Int32 = -1
  private var running = false

  public init(socketPath: String, authToken: String, requestHandler: @escaping CompanionRequestHandler) {
    self.socketPath = socketPath
    self.authToken = authToken
    self.requestHandler = requestHandler
  }

  public func start() throws {
    guard !running else {
      return
    }

    try FileManager.default.createDirectory(
      atPath: (socketPath as NSString).deletingLastPathComponent,
      withIntermediateDirectories: true
    )
    unlink(socketPath)

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
      throw CompanionServerError.socketCreateFailed
    }
    socketFD = fd

    var value: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &value, socklen_t(MemoryLayout<Int32>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8CString)
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      close(fd)
      socketFD = -1
      throw CompanionServerError.socketPathTooLong
    }

    let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
      let target = UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self)
      target.initialize(repeating: 0, count: pathCapacity)
      for (index, byte) in pathBytes.enumerated() {
        target[index] = byte
      }
    }

    let length = socklen_t(MemoryLayout.size(ofValue: address.sun_family) + pathBytes.count)
    let bindResult = withUnsafePointer(to: &address) { pointer -> Int32 in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, length)
      }
    }
    guard bindResult == 0 else {
      close(fd)
      socketFD = -1
      throw CompanionServerError.socketBindFailed(socketPath)
    }
    guard listen(fd, SOMAXCONN) == 0 else {
      close(fd)
      socketFD = -1
      throw CompanionServerError.socketListenFailed
    }

    running = true
    acceptQueue.async { [weak self] in
      self?.acceptLoop()
    }
  }

  public func stop() {
    guard running else {
      return
    }
    running = false
    if socketFD >= 0 {
      shutdown(socketFD, SHUT_RDWR)
      close(socketFD)
      socketFD = -1
    }
    unlink(socketPath)
  }

  public func handleRequestLine(_ line: String) -> String {
    let id: Any
    do {
      guard
        let data = line.data(using: .utf8),
        let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let jsonrpc = raw["jsonrpc"] as? String,
        jsonrpc == "2.0",
        let method = raw["method"] as? String
      else {
        return encodeResponse([
          "jsonrpc": "2.0",
          "id": NSNull(),
          "error": ["code": -32600, "message": "Invalid Request"],
        ])
      }

      id = raw["id"] ?? NSNull()
      let params = raw["params"] as? [String: Any] ?? [:]
      guard let suppliedToken = params["authToken"] as? String, suppliedToken == authToken else {
        return encodeResponse([
          "jsonrpc": "2.0",
          "id": id,
          "error": ["code": -32001, "message": "Unauthorized"],
        ])
      }

      let result = try requestHandler(method, params)
      return encodeResponse([
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
      ])
    } catch {
      return encodeResponse([
        "jsonrpc": "2.0",
        "id": NSNull(),
        "error": ["code": -32603, "message": error.localizedDescription],
      ])
    }
  }

  private func acceptLoop() {
    while running {
      let clientFD = accept(socketFD, nil, nil)
      if clientFD < 0 {
        if running {
          usleep(50_000)
        }
        continue
      }

      clientQueue.async { [weak self] in
        self?.handleConnection(clientFD)
      }
    }
  }

  private func handleConnection(_ clientFD: Int32) {
    defer {
      shutdown(clientFD, SHUT_RDWR)
      close(clientFD)
    }

    guard let line = readLine(from: clientFD) else {
      return
    }
    let response = handleRequestLine(line) + "\n"
    _ = response.withCString { pointer in
      write(clientFD, pointer, strlen(pointer))
    }
  }

  private func readLine(from fileDescriptor: Int32) -> String? {
    var data = Data()
    var byte = UInt8(0)
    while true {
      let count = Darwin.read(fileDescriptor, &byte, 1)
      if count <= 0 {
        break
      }
      if byte == 0x0A {
        break
      }
      data.append(byte)
    }
    if data.isEmpty {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  private func encodeResponse(_ payload: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
    return String(data: data, encoding: .utf8) ?? "{}"
  }
}
