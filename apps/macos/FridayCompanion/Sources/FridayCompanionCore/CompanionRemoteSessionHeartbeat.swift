import Foundation

public struct CompanionRemoteSessionHeartbeat: Sendable, Equatable {
  public let hubBaseURL: String
  public let sessionId: String

  public init(hubBaseURL: String, sessionId: String) {
    self.hubBaseURL = hubBaseURL
    self.sessionId = sessionId
  }

  public func makeRequest(idempotencyKey: String) throws -> URLRequest {
    guard let url = heartbeatURL() else {
      throw CompanionRemoteSessionHeartbeatError.invalidBaseURL
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["idempotencyKey": idempotencyKey])
    return request
  }

  private func heartbeatURL() -> URL? {
    var base = hubBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
    while base.hasSuffix("/") {
      base.removeLast()
    }
    guard !base.isEmpty else {
      return nil
    }
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    let encodedSessionId = sessionId.addingPercentEncoding(withAllowedCharacters: allowed) ?? sessionId
    return URL(string: "\(base)/v1/system/remote/sessions/\(encodedSessionId)/heartbeat")
  }
}

public enum CompanionRemoteSessionHeartbeatError: Error {
  case invalidBaseURL
}
