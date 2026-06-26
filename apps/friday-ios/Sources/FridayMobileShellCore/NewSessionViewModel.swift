import Foundation
import FridayRustClient

public enum NewSessionLaunchState: Sendable, Equatable {
  case idle
  case launching
  case launched(
    summary: String,
    missionId: String,
    workItemId: String,
    surfaceThreadId: String,
    status: String,
    createdOrReady: Bool)
  case blocked(reason: String)
}

@MainActor
public final class NewSessionViewModel: ObservableObject {
  @Published public private(set) var launchState: NewSessionLaunchState = .idle

  private let client: (any FridayMissionSpineWriteClient)?
  private let owner: String
  private let idFactory: () -> String

  public init(
    client: (any FridayMissionSpineWriteClient)?,
    owner: String = "principal:owner-device",
    idFactory: @escaping () -> String = { UUID().uuidString.lowercased() }
  ) {
    self.client = client
    self.owner = owner
    self.idFactory = idFactory
  }

  public func launch(intent: String) async {
    let trimmed = intent.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      launchState = .blocked(reason: "New session requires an owner-visible goal.")
      return
    }
    guard let client else {
      launchState = .blocked(reason: "Write seam not configured.")
      return
    }

    launchState = .launching
    do {
      let result = try await client.submitMissionIntake(Self.request(intent: trimmed, owner: owner, id: idFactory()))
      guard result.status == "ready" || result.status == "created" else {
        launchState = .blocked(reason: "Mission intake not ready - \(result.status)")
        return
      }
      guard let workItemId = result.workItemId, !workItemId.isEmpty else {
        launchState = .blocked(reason: "Mission intake did not return a WorkItem ref.")
        return
      }
      launchState = .launched(
        summary: "\(result.status) · mission=\(result.missionId) · work_item=\(workItemId)",
        missionId: result.missionId,
        workItemId: workItemId,
        surfaceThreadId: result.surfaceThreadId,
        status: result.status,
        createdOrReady: result.createdOrReady)
    } catch {
      launchState = .blocked(reason: Self.reason(for: error))
    }
  }

  public static func request(intent: String, owner: String, id: String) -> MissionIntakeRequestWire {
    MissionIntakeRequestWire(
      fridayConversationId: "fconv_mobile_new_session_\(id)",
      ownerPrincipal: owner,
      surfaceThreadId: "surface-mobile-new-session-\(id)",
      surfaceKind: "mobile",
      deliveryRoute: "ios://friday-mobile/new-session/\(id)",
      visibilityPolicy: "compact",
      missionId: "mission-mobile-new-session-\(id)",
      workItemId: "work-mobile-new-session-\(id)",
      title: String(intent.prefix(72)),
      intent: intent,
      lane: "auto")
  }

  private static func reason(for error: Error) -> String {
    if let write = error as? FridayWriteClientError {
      switch write {
      case .badServerPubkey, .badSessionNonce:
        return "Friday could not establish a trusted connection."
      case let .serverError(code, message):
        return "Friday is unavailable (\(code.rawValue)) - \(message)"
      case let .unexpectedResponse(kind):
        return "Friday returned an unexpected response (\(kind))."
      case let .missingRef(reason):
        return "Friday returned an incomplete launch response - \(reason)"
      case .runControlDisabled:
        return "Run control is not enabled for this launch."
      case .emptySignedBlob:
        return "Launch unavailable - unexpected empty signature state."
      case let .transport(reason):
        return "Friday is offline - \(reason)"
      }
    }
    return "Launch failed - \(error)"
  }
}
