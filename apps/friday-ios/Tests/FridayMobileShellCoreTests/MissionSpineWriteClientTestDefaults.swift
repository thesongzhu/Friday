import Foundation
@testable import FridayRustClient

extension FridayMissionSpineWriteClient {
  func submitProviderWorkspaceAction(
    _ request: ProviderWorkspaceActionRequestWire
  ) async throws -> ProviderWorkspaceActionResultWire {
    ProviderWorkspaceActionResultWire(
      requestId: request.requestId,
      fridaySessionId: request.fridaySessionId,
      provider: request.provider,
      action: request.action,
      accepted: false,
      routed: false,
      status: "blocked",
      truthLabel: "ios_test_provider_workspace_action_default_blocked",
      blocker: "test fake does not exercise provider workspace action",
      missionContext: request.missionContext)
  }
}
