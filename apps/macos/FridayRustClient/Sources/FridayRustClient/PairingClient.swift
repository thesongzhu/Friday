import Foundation

/// Product-facing pairing client for the QR pairing channel.
///
/// This client is intentionally narrow: it can ask for `HubStatus` and send exactly one `Pair`
/// request derived from a scanned QR manifest. It does not mint trust grants, context passports, or
/// signatures; those remain operator ceremonies outside the app/agent key boundary.
public protocol FridayPairingClient: Sendable {
  func fetchHubStatus(manifest: FridayPairingManifest) async throws -> PairingHubStatusWire
  func pairDevice(manifest: FridayPairingManifest, deviceId: String) async throws -> PairingPairAckWire
}

public enum FridayPairingClientError: Error, Equatable {
  case badServerPubkey
  case serverPubkeyMismatch
  case badSessionNonce
  case serverError(code: FridayErrorCode, message: String)
  case unexpectedResponse(kind: String)
  case transport(String)
}

/// Sealed-WS client for `hub_pairing_server`.
public final class SealedWSPairingClient: FridayPairingClient, @unchecked Sendable {
  private let keypair: FridayCrypto.DeviceKeypair
  private let makeTransport: () throws -> SealedWSTransport
  private let now: () -> Int64
  private let newMessageId: () -> String

  public init(
    keypair: FridayCrypto.DeviceKeypair,
    makeTransport: @escaping () throws -> SealedWSTransport,
    now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
    newMessageId: @escaping () -> String = { "pair-\(UUID().uuidString)" }
  ) {
    self.keypair = keypair
    self.makeTransport = makeTransport
    self.now = now
    self.newMessageId = newMessageId
  }

  public func fetchHubStatus(manifest: FridayPairingManifest) async throws -> PairingHubStatusWire {
    let response = try sendPairingMessage(manifest: manifest, message: .hubStatus(PairingHubStatusWire(
      online: true,
      capabilities: [],
      minVersion: manifest.version,
      maxVersion: manifest.version
    )))
    switch response {
    case .hubStatus(let status):
      return status
    case .error(let code, let message):
      throw FridayPairingClientError.serverError(code: code, message: message)
    default:
      throw FridayPairingClientError.unexpectedResponse(kind: pairingKind(response))
    }
  }

  public func pairDevice(manifest: FridayPairingManifest, deviceId: String) async throws -> PairingPairAckWire {
    let proof = try manifest.pairingProof(forDevicePublicKey: keypair.publicKey)
    let response = try sendPairingMessage(manifest: manifest, message: .pair(PairingPairWire(
      deviceId: deviceId,
      devicePubkey: keypair.publicKey,
      pairingProof: proof
    )))
    switch response {
    case .pairAck(let ack):
      return ack
    case .error(let code, let message):
      throw FridayPairingClientError.serverError(code: code, message: message)
    default:
      throw FridayPairingClientError.unexpectedResponse(kind: pairingKind(response))
    }
  }

  private func sendPairingMessage(manifest: FridayPairingManifest, message: FridayMessage) throws -> FridayMessage {
    try manifest.validate(nowMs: now())
    let aad = Array(manifest.aad.utf8)
    let transport = try makeTransport()

    try transport.writeFrame(keypair.publicKey)
    let serverPub = try transport.readFrame()
    guard serverPub.count == FridayCrypto.x25519PublicKeyLen else {
      throw FridayPairingClientError.badServerPubkey
    }
    guard serverPub == (try manifest.hubPublicKey) else {
      throw FridayPairingClientError.serverPubkeyMismatch
    }
    try transport.upgrade()

    let sessionKey: [UInt8]
    do {
      sessionKey = try keypair.agree(peerPublicKey: serverPub)
    } catch {
      throw FridayPairingClientError.transport("session-key agreement failed: \(error)")
    }

    let msgId = newMessageId()
    let env = FridayEnvelope(msgId: msgId, sentAt: now(), message: message)
    try transport.sendMessage(try sealEnvelope(env, sessionKey: sessionKey, aad: aad))

    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      throw FridayPairingClientError.transport("no pairing response (session ended fail-closed): \(error)")
    }
    return try openEnvelope(respBody, sessionKey: sessionKey, aad: aad).message
  }

  private func sealEnvelope(_ env: FridayEnvelope, sessionKey: [UInt8], aad: [UInt8]) throws -> [UInt8] {
    let sealed = try FridayCrypto.seal(key: sessionKey, plaintext: [UInt8](env.encodeJSON()), aad: aad)
    return FridayCrypto.encodeSealed(sealed)
  }

  private func openEnvelope(_ body: [UInt8], sessionKey: [UInt8], aad: [UInt8]) throws -> FridayEnvelope {
    let sealed = try FridayCrypto.decodeSealed(body)
    let pt: [UInt8]
    do {
      pt = try FridayCrypto.open(key: sessionKey, sealed: sealed, aad: aad)
    } catch {
      throw FridayPairingClientError.transport("pairing envelope failed to open (fail-closed): \(error)")
    }
    return try FridayEnvelope.decodeJSON(Data(pt))
  }
}

private func pairingKind(_ message: FridayMessage) -> String {
  switch message {
  case .pair: return "Pair"
  case .pairAck: return "PairAck"
  case .hubStatus: return "HubStatus"
  case .error: return "Error"
  case .unsupported(let kind): return kind
  case .workbenchProjectionRequest: return "WorkbenchProjectionRequest"
  case .workbenchProjectionSnapshot: return "WorkbenchProjectionSnapshot"
  case .runReadbackRequest: return "RunReadbackRequest"
  case .runReadbackSnapshot: return "RunReadbackSnapshot"
  case .providersDoctorRequest: return "ProvidersDoctorRequest"
  case .providersDoctorSnapshot: return "ProvidersDoctorSnapshot"
  case .capabilityDoctorRequest: return "CapabilityDoctorRequest"
  case .capabilityDoctorSnapshot: return "CapabilityDoctorSnapshot"
  case .sessionListRequest: return "SessionListRequest"
  case .sessionListSnapshot: return "SessionListSnapshot"
  case .sessionOpenRequest: return "SessionOpenRequest"
  case .sessionOpenSnapshot: return "SessionOpenSnapshot"
  case .sessionLinkStateRequest: return "SessionLinkStateRequest"
  case .sessionLinkStateSnapshot: return "SessionLinkStateSnapshot"
  case .runFileViewRequest: return "RunFileViewRequest"
  case .runFileViewSnapshot: return "RunFileViewSnapshot"
  case .activityNeedsMeRequest: return "ActivityNeedsMeRequest"
  case .activityNeedsMeSnapshot: return "ActivityNeedsMeSnapshot"
  case .agentRunRequest: return "AgentRunRequest"
  case .agentRunResult: return "AgentRunResult"
  case .agentRunPaused: return "AgentRunPaused"
  case .agentRunResume: return "AgentRunResume"
  case .agentRunCancel: return "AgentRunCancel"
  case .agentRunReject: return "AgentRunReject"
  case .agentRunControlResult: return "AgentRunControlResult"
  case .missionIntakeRequest: return "MissionIntakeRequest"
  case .missionIntakeResult: return "MissionIntakeResult"
  case .memoryDecisionRequest: return "MemoryDecisionRequest"
  case .memoryDecisionResult: return "MemoryDecisionResult"
  case .contextPassportTransferRequest: return "ContextPassportTransferRequest"
  case .contextPassportTransferResult: return "ContextPassportTransferResult"
  case .runOutcomeLearningDecisionRequest: return "RunOutcomeLearningDecisionRequest"
  case .runOutcomeLearningDecisionResult: return "RunOutcomeLearningDecisionResult"
  case .activityMarkDoneRequest: return "ActivityMarkDoneRequest"
  case .activityMarkDoneResult: return "ActivityMarkDoneResult"
  case .workItemStatusRequest: return "WorkItemStatusRequest"
  case .workItemStatusResult: return "WorkItemStatusResult"
  case .providerWorkspaceActionRequest: return "ProviderWorkspaceActionRequest"
  case .providerWorkspaceActionResult: return "ProviderWorkspaceActionResult"
  case .runAnswerBodyRequest: return "RunAnswerBodyRequest"
  case .runAnswerBodySnapshot: return "RunAnswerBodySnapshot"
  }
}
