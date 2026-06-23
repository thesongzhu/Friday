import Foundation
import FridayRustClient

public struct ShareIntakeReceipt: Sendable, Equatable {
  public let missionId: String
  public let workItemId: String?
  public let surfaceThreadId: String
  public let status: String
  public let createdOrReady: Bool
  public let clarificationQuestions: [String]
}

public enum ShareIntakePhase: Sendable, Equatable {
  case idle
  case submitting
  case submitted(ShareIntakeReceipt)
  case blocked(String)
  case unavailable(String)

  public var isBusy: Bool {
    if case .submitting = self { return true }
    return false
  }
}

@MainActor
public final class ShareIntakeViewModel: ObservableObject {
  @Published public var sharedText: String
  @Published public var sharedURL: String
  @Published public private(set) var phase: ShareIntakePhase = .idle

  private let client: (any FridayMissionSpineWriteClient)?
  private let owner: String
  private let newId: () -> String

  public init(
    client: (any FridayMissionSpineWriteClient)?,
    owner: String = liveAgentRunOwnerPrincipal,
    sharedText: String = "",
    sharedURL: String = "",
    newId: @escaping () -> String = { UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "") }
  ) {
    self.client = client
    self.owner = owner
    self.sharedText = sharedText
    self.sharedURL = sharedURL
    self.newId = newId
  }

  public func applyIncomingShare(text: String? = nil, url: URL? = nil) {
    if let text {
      sharedText = text
    }
    if let url {
      sharedURL = url.absoluteString
    }
    phase = .idle
  }

  public func submit() async {
    let intent = Self.intent(sharedText: sharedText, sharedURL: sharedURL)
    guard !intent.isEmpty else {
      phase = .blocked("Add shared text or a URL before submitting.")
      return
    }
    guard let client else {
      phase = .unavailable("Share Intake is unavailable - live mobile write is not enabled.")
      return
    }

    phase = .submitting
    do {
      let result = try await client.submitMissionIntake(Self.request(
        intent: intent,
        owner: owner,
        id: newId()))
      switch result.status {
      case "ready":
        phase = .submitted(ShareIntakeReceipt(
          missionId: result.missionId,
          workItemId: result.workItemId,
          surfaceThreadId: result.surfaceThreadId,
          status: result.status,
          createdOrReady: result.createdOrReady,
          clarificationQuestions: result.clarificationQuestions))
      case "needs_clarification":
        let questions = result.clarificationQuestions.joined(separator: " ")
        phase = .blocked(questions.isEmpty ? "Friday needs more detail before creating this mission." : questions)
      default:
        let blockers = result.blockers.joined(separator: " ")
        phase = .blocked(blockers.isEmpty ? "Friday could not create this shared mission." : blockers)
      }
    } catch {
      phase = .unavailable(FridayChatViewModel.dispatchReason(for: error))
    }
  }

  public func reset() {
    phase = .idle
  }

  static func intent(sharedText: String, sharedURL: String) -> String {
    let text = sharedText.trimmingCharacters(in: .whitespacesAndNewlines)
    let url = sharedURL.trimmingCharacters(in: .whitespacesAndNewlines)
    var lines = ["Process this shared item for the owner."]
    if !url.isEmpty {
      lines.append("url: \(url)")
    }
    if !text.isEmpty {
      lines.append("shared_text: \(text)")
    }
    return lines.count == 1 ? "" : lines.joined(separator: "\n")
  }

  static func request(intent: String, owner: String, id: String) -> MissionIntakeRequestWire {
    MissionIntakeRequestWire(
      fridayConversationId: "fconv_mobile_share_\(id)",
      ownerPrincipal: owner,
      surfaceThreadId: "surface-mobile-share-\(id)",
      surfaceKind: "mobile",
      deliveryRoute: "ios://friday-mobile/share/\(id)",
      visibilityPolicy: "compact",
      missionId: "mission-mobile-share-\(id)",
      workItemId: "work-mobile-share-\(id)",
      title: String(intent.prefix(72)),
      intent: intent,
      lane: "auto")
  }
}
