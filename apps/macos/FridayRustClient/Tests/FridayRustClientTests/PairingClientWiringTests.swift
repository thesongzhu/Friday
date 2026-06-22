import XCTest
@testable import FridayRustClient

/// T3 pairing-client wiring tests over an in-memory `hub_pairing_server` facsimile.
///
/// HONEST LABEL: wiring-only. The Rust protocol shapes and HMAC proof are covered by the KATs; this
/// proves the Swift client sequences the sealed pairing session, validates the QR hub key, sends no
/// raw QR secret, and fail-closes outside `PairAck`/`HubStatus`.
final class PairingClientWiringTests: XCTestCase {
  enum ServerMode {
    case status
    case acceptPair
    case denyPair
    case wrongKind
  }

  final class EmulatedPairingServerTransport: SealedWSTransport {
    private let serverKeypair: FridayCrypto.DeviceKeypair
    private let sessionNonce: [UInt8]
    private let aad: [UInt8]
    private let mode: ServerMode

    private var clientPub: [UInt8]?
    private var sessionKey: [UInt8]?
    private var upgraded = false
    private var queuedFromServer: [[UInt8]] = []
    private(set) var receivedPair: PairingPairWire?

    init(
      serverKeypair: FridayCrypto.DeviceKeypair,
      sessionNonce: [UInt8],
      aad: [UInt8],
      mode: ServerMode
    ) {
      self.serverKeypair = serverKeypair
      self.sessionNonce = sessionNonce
      self.aad = aad
      self.mode = mode
    }

    func writeFrame(_ payload: [UInt8]) throws {
      if clientPub == nil {
        clientPub = payload
        queuedFromServer.append(serverKeypair.publicKey)
        queuedFromServer.append(sessionNonce)
      }
    }

    func readFrame() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else {
        throw FridayPairingClientError.transport("no preamble frame queued")
      }
      return queuedFromServer.removeFirst()
    }

    func upgrade() throws {
      guard let clientPub else {
        throw FridayPairingClientError.transport("no client pubkey before upgrade")
      }
      sessionKey = try serverKeypair.agree(peerPublicKey: clientPub)
      upgraded = true
    }

    func sendMessage(_ body: [UInt8]) throws {
      guard upgraded, let sessionKey else {
        throw FridayPairingClientError.transport("not upgraded")
      }
      let env = try FridayEnvelope.decodeJSON(Data(try FridayCrypto.open(
        key: sessionKey,
        sealed: FridayCrypto.decodeSealed(body),
        aad: aad
      )))
      let response: FridayMessage
      switch env.message {
      case .hubStatus:
        response = .hubStatus(PairingHubStatusWire(
          online: true,
          capabilities: ["pairing", "read_seam_enroll"],
          minVersion: 1,
          maxVersion: 13
        ))
      case .pair(let pair):
        receivedPair = pair
        switch mode {
        case .acceptPair:
          response = .pairAck(PairingPairAckWire(accepted: true))
        case .denyPair:
          response = .pairAck(PairingPairAckWire(accepted: false, errorCode: .pairingDenied))
        case .wrongKind:
          response = .agentRunResult(AgentRunResultWire(
            runId: "not-pairing",
            status: "completed",
            answerSha256: String(repeating: "a", count: 64),
            answerLen: 1,
            turns: 1,
            executedTools: 0
          ))
        case .status:
          response = .hubStatus(PairingHubStatusWire(
            online: true,
            capabilities: ["pairing"],
            minVersion: 1,
            maxVersion: 13
          ))
        }
      default:
        response = .error(code: .internal, message: "unsupported pairing message")
      }
      let resp = FridayEnvelope(
        msgId: "\(env.msgId)-response",
        sentAt: 1_780_640_000_000,
        message: response
      ).withCorrelation(env.msgId)
      queuedFromServer.append(try FridayCrypto.encodeSealed(FridayCrypto.seal(
        key: sessionKey,
        plaintext: [UInt8](resp.encodeJSON()),
        aad: aad
      )))
    }

    func recvMessage() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else {
        throw FridayPairingClientError.transport("session ended (no response)")
      }
      return queuedFromServer.removeFirst()
    }
  }

  func testFetchHubStatusValidatesManifestHubKeyAndDecodesStatus() async throws {
    let fixture = try makeFixture(mode: .status)
    let status = try await fixture.client.fetchHubStatus(manifest: fixture.manifest)
    XCTAssertTrue(status.online)
    XCTAssertEqual(status.capabilities, ["pairing", "read_seam_enroll"])
    XCTAssertEqual(status.minVersion, 1)
    XCTAssertEqual(status.maxVersion, 13)
  }

  func testPairDeviceSendsProofAndNeverSendsRawSecret() async throws {
    let fixture = try makeFixture(mode: .acceptPair)
    let ack = try await fixture.client.pairDevice(manifest: fixture.manifest, deviceId: "ios-device-1")
    XCTAssertEqual(ack, PairingPairAckWire(accepted: true))

    let pair = try XCTUnwrap(fixture.transport.receivedPair)
    XCTAssertEqual(pair.deviceId, "ios-device-1")
    XCTAssertEqual(pair.devicePubkey, fixture.clientKeypair.publicKey)
    XCTAssertEqual(pair.pairingProof, try fixture.manifest.pairingProof(forDevicePublicKey: fixture.clientKeypair.publicKey))
    XCTAssertNotEqual(pair.pairingProof, Array(fixture.rawPairingSecret.utf8))
  }

  func testPairDeviceReturnsDeniedAckWithoutPromotingItToSuccess() async throws {
    let fixture = try makeFixture(mode: .denyPair)
    let ack = try await fixture.client.pairDevice(manifest: fixture.manifest, deviceId: "ios-device-1")
    XCTAssertEqual(ack, PairingPairAckWire(accepted: false, errorCode: .pairingDenied))
  }

  func testPairDeviceRejectsManifestServerKeyMismatchBeforeSendingPair() async throws {
    var fixture = try makeFixture(mode: .acceptPair)
    let wrongHub = try FridayCrypto.DeviceKeypair(secretBytes: Array(repeating: 7, count: 32))
    fixture.manifest = try makeManifest(
      hubPublicKey: wrongHub.publicKey,
      pairingSecret: fixture.rawPairingSecret,
      expiresAt: 1_900_000_000_000
    )

    do {
      _ = try await fixture.client.pairDevice(manifest: fixture.manifest, deviceId: "ios-device-1")
      XCTFail("expected server pubkey mismatch")
    } catch {
      XCTAssertEqual(error as? FridayPairingClientError, .serverPubkeyMismatch)
    }
    XCTAssertNil(fixture.transport.receivedPair)
  }

  func testPairDeviceFailsClosedOnUnexpectedResponseKind() async throws {
    let fixture = try makeFixture(mode: .wrongKind)
    do {
      _ = try await fixture.client.pairDevice(manifest: fixture.manifest, deviceId: "ios-device-1")
      XCTFail("expected unexpected response")
    } catch {
      XCTAssertEqual(error as? FridayPairingClientError, .unexpectedResponse(kind: "AgentRunResult"))
    }
  }

  private struct Fixture {
    var manifest: FridayPairingManifest
    let client: SealedWSPairingClient
    let transport: EmulatedPairingServerTransport
    let clientKeypair: FridayCrypto.DeviceKeypair
    let rawPairingSecret: String
  }

  private func makeFixture(mode: ServerMode) throws -> Fixture {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let secret = "qr-secret-1234567890" // pragma: allowlist secret
    let manifest = try makeManifest(
      hubPublicKey: serverKp.publicKey,
      pairingSecret: secret,
      expiresAt: 1_900_000_000_000
    )
    let transport = EmulatedPairingServerTransport(
      serverKeypair: serverKp,
      sessionNonce: try Hex.decode(B1KAT.k3Auth.sessionNonce),
      aad: Array(manifest.aad.utf8),
      mode: mode
    )
    let client = SealedWSPairingClient(
      keypair: clientKp,
      makeTransport: { transport },
      now: { 1_780_640_000_000 },
      newMessageId: { "pair-wiring-1" }
    )
    return Fixture(
      manifest: manifest,
      client: client,
      transport: transport,
      clientKeypair: clientKp,
      rawPairingSecret: secret
    )
  }

  private func makeManifest(
    hubPublicKey: [UInt8],
    pairingSecret: String,
    expiresAt: Int64
  ) throws -> FridayPairingManifest {
    let json = """
      {
        "kind": "friday.pairing.qr.v1",
        "aad": "friday:pairing:ws:j1:qr-pair-session:aad:v1",
        "hub_public_key_hex": "\(Hex.encode(hubPublicKey))",
        "v": 1,
        "hub_id": "hub-local-1",
        "pairing_id": "pair-123",
        "pairing_secret": "\(pairingSecret)",
        "display_name": "Friday Local Hub",
        "transport_hints": [
          {"kind": "websocket", "endpoint": "ws://127.0.0.1:49152", "label": "Local pairing"}
        ],
        "expires_at": \(expiresAt),
        "capabilities_hint": ["pairing", "read_seam_enroll"]
      }
      """
    return try JSONDecoder().decode(FridayPairingManifest.self, from: Data(json.utf8))
  }
}
