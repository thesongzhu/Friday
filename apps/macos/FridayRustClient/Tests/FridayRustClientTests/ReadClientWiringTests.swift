import XCTest
@testable import FridayRustClient

/// **Tier-2 client-wiring tests** — drive `SealedWSReadClient.fetchWorkbench()` end-to-end
/// over an IN-MEMORY transport that emulates the Rust `hub_read_projection_server` flow:
/// the cleartext preamble (server pubkey + 64-byte nonce), the owner-auth verification
/// (the SAME `authenticate_forwarded` chain: open the `auth_proof` under the session key
/// with the read AAD, check it equals the nonce-bound challenge, owner-allowlist), and the
/// OWNER-SEALED refs-only snapshot response.
///
/// HONEST LABEL: this is WIRING-ONLY, NOT a crypto-parity proof. The emulated server seals
/// with the SAME Swift primitives the client uses, so a passing round-trip says nothing the
/// circular-roundtrip trap warns about. The crypto byte-parity is proven SEPARATELY by the
/// Rust-anchored `KATTests`; this test proves the CLIENT correctly sequences the handshake,
/// frames the owner-authed request, and decodes the owner-sealed snapshot into a typed
/// `WorkbenchSnapshot`. The live round-trip against the REAL Rust server is the deferred AC.
final class ReadClientWiringTests: XCTestCase {

  /// An in-memory transport that plays the Rust read server's half of the protocol, in the
  /// same byte sequence `establish_session` + `serve_read_session` use.
  final class EmulatedRustServerTransport: SealedWSTransport {
    private let serverKeypair: FridayCrypto.DeviceKeypair
    private let sessionNonce: [UInt8]
    private let peerAllowlist: [[UInt8]]
    private let ownerAllowlist: [String]
    private let projectionJSON: [UInt8]

    // Handshake state.
    private var clientPub: [UInt8]?
    private var sessionKey: [UInt8]?
    private var upgraded = false
    private var queuedFromServer: [[UInt8]] = []
    private(set) var processed = 0
    private(set) var endedFailClosed = false

    init(serverKeypair: FridayCrypto.DeviceKeypair,
         sessionNonce: [UInt8],
         peerAllowlist: [[UInt8]],
         ownerAllowlist: [String],
         projectionJSON: [UInt8]) {
      self.serverKeypair = serverKeypair
      self.sessionNonce = sessionNonce
      self.peerAllowlist = peerAllowlist
      self.ownerAllowlist = ownerAllowlist
      self.projectionJSON = projectionJSON
    }

    // Phase 1 — preamble. The client writes its pubkey; we (server) reply with our pubkey
    // then the 64-byte session nonce, exactly like `establish_session`.
    func writeFrame(_ payload: [UInt8]) throws {
      if clientPub == nil {
        // (a') S-F peer-allowlist gate FIRST (a non-allowlisted client gets NO session).
        guard peerAllowlist.contains(payload) else {
          endedFailClosed = true
          throw FridayReadClientError.transport("peer pubkey not in allowlist")
        }
        clientPub = payload
        // (b) server pubkey out, (b') fresh nonce out.
        queuedFromServer.append(serverKeypair.publicKey)
        queuedFromServer.append(sessionNonce)
      }
    }

    func readFrame() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else {
        throw FridayReadClientError.transport("no preamble frame queued")
      }
      return queuedFromServer.removeFirst()
    }

    func upgrade() throws {
      guard let clientPub else { throw FridayReadClientError.transport("no client pubkey before upgrade") }
      // (c) derive the session key on the server side (agree is symmetric).
      sessionKey = try serverKeypair.agree(peerPublicKey: clientPub)
      upgraded = true
    }

    // Phase 2 — the client sends a sealed WorkbenchProjectionRequest; we verify auth and
    // reply with the owner-sealed snapshot (or end fail-closed).
    func sendMessage(_ body: [UInt8]) throws {
      guard upgraded, let sessionKey else { throw FridayReadClientError.transport("not upgraded") }
      // Open the envelope under the session key with the read SESSION_AAD.
      let envSealed = try FridayCrypto.decodeSealed(body)
      let envPt = try FridayCrypto.open(key: sessionKey, sealed: envSealed, aad: readSessionAad)
      let env = try FridayEnvelope.decodeJSON(Data(envPt))
      guard case .workbenchProjectionRequest(let req) = env.message else {
        throw FridayReadClientError.transport("expected a WorkbenchProjectionRequest")
      }

      // AUTH — the SAME chain `authenticate_forwarded` runs: open the auth_proof under the
      // session key with auth_aad(read_aad, principal, request_id); it must equal the
      // nonce-bound challenge; principal must be on the owner allowlist.
      let reqAad = FridayCrypto.authAad(readSessionAad,
                                        forwardedPrincipal: req.forwardedPrincipal,
                                        boundContext: Array(req.requestId.utf8))
      let proofSealed = try FridayCrypto.decodeSealed(req.authProof)
      let openedChallenge: [UInt8]
      do {
        openedChallenge = try FridayCrypto.open(key: sessionKey, sealed: proofSealed, aad: reqAad)
      } catch {
        endedFailClosed = true
        return // NO snapshot — session ends fail-closed (the client recv will see EOF).
      }
      let expected = FridayCrypto.nonceBoundChallenge(readAuthChallenge, sessionNonce: sessionNonce)
      guard openedChallenge == expected, ownerAllowlist.contains(req.forwardedPrincipal) else {
        endedFailClosed = true
        return // fail-closed: no snapshot.
      }

      // AUTHENTICATED — owner-seal the refs-only projection JSON under the session key, hex
      // it, and answer with a WorkbenchProjectionSnapshot.
      let inner = try FridayCrypto.seal(key: sessionKey, plaintext: projectionJSON, aad: readSessionAad)
      let sealedHex = Hex.encode(FridayCrypto.encodeSealed(inner))
      let resp = FridayEnvelope(
        msgId: "read-projection-snapshot-\(req.requestId)",
        sentAt: 1_780_640_000_000,
        message: .workbenchProjectionSnapshot(WorkbenchProjectionSnapshotWire(
          requestId: req.requestId,
          projectionJson: sealedHex,
          generatedAtMs: 1_780_640_000_000
        ))
      ).withCorrelation(env.msgId)
      let respSealed = try FridayCrypto.seal(key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: readSessionAad)
      queuedFromServer.append(FridayCrypto.encodeSealed(respSealed))
      processed += 1
    }

    func recvMessage() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else {
        // The server ended the session (fail-closed auth) — the client sees a closed pipe.
        throw FridayReadClientError.transport("session ended (no response)")
      }
      return queuedFromServer.removeFirst()
    }
  }

  // A refs-only projection JSON shaped like the Rust `project_workbench` output.
  private static let refsOnlyProjection = """
  {"missionId":"mission_read_seam_probe_20260611",\
  "fridayConversationId":"fconv_read_seam_probe",\
  "runtimeFeedStatus":"live_rust_hub_projection",\
  "statusLabels":["stale","offline","error"],\
  "routeDecision":{"advisorSummary":"The Workbench must consume Rust Hub Mission truth.",\
  "selectedRoute":"route-decision://redacted/route_read_probe","truthLabel":"friday_owned"},\
  "workItems":[{"workItemId":"work_read_probe_provider","status":"provider_waiting"}]}
  """

  private let owner = "principal:read-owner-allowlisted"

  func testFetchWorkbench_happyPath_decodesOwnerSealedSnapshot() async throws {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce) // a valid 64-byte nonce

    let transport = EmulatedRustServerTransport(
      serverKeypair: serverKp,
      sessionNonce: nonce,
      peerAllowlist: [clientKp.publicKey],
      ownerAllowlist: [owner],
      projectionJSON: Array(Self.refsOnlyProjection.utf8)
    )
    let client = SealedWSReadClient(
      keypair: clientKp,
      forwardedPrincipal: owner,
      makeTransport: { transport },
      now: { 1000 },
      newRequestId: { "req-roundtrip-1" }
    )

    let snapshot = try await client.fetchWorkbench()
    XCTAssertEqual(snapshot.missionId, "mission_read_seam_probe_20260611")
    XCTAssertEqual(snapshot.fridayConversationId, "fconv_read_seam_probe")
    XCTAssertEqual(snapshot.runtimeFeedStatus, "live_rust_hub_projection")
    XCTAssertEqual(snapshot.statusLabels, ["stale", "offline", "error"])
    XCTAssertEqual(snapshot.routeDecisionSummary, "The Workbench must consume Rust Hub Mission truth.")
    XCTAssertEqual(snapshot.workItemIds, ["work_read_probe_provider"])
    XCTAssertEqual(snapshot.generatedAtMs, 1_780_640_000_000)
    XCTAssertEqual(transport.processed, 1)
    // Refs-only: no secret markers leaked into the opened projection.
    let raw = try JSONSerialization.data(withJSONObject: snapshot.raw)
    let rawStr = String(decoding: raw, as: UTF8.self)
    XCTAssertFalse(rawStr.contains("Authorization"))
    XCTAssertFalse(rawStr.contains("Bearer"))
  }

  func testFetchWorkbench_mismatchedPrincipal_endsFailClosed() async throws {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)

    // The server's owner allowlist holds `owner`; the client forwards a DIFFERENT principal.
    let transport = EmulatedRustServerTransport(
      serverKeypair: serverKp,
      sessionNonce: nonce,
      peerAllowlist: [clientKp.publicKey],
      ownerAllowlist: [owner],
      projectionJSON: Array(Self.refsOnlyProjection.utf8)
    )
    let client = SealedWSReadClient(
      keypair: clientKp,
      forwardedPrincipal: "principal:not-the-owner",
      makeTransport: { transport },
      newRequestId: { "req-ownerscope-1" }
    )

    do {
      _ = try await client.fetchWorkbench()
      XCTFail("a mismatched principal must get NO snapshot")
    } catch {
      // The session ends fail-closed: the client's recv sees a closed pipe.
      XCTAssertTrue(transport.endedFailClosed)
      XCTAssertEqual(transport.processed, 0)
    }
  }

  func testFetchWorkbench_nonAllowlistedPeer_rejectedAtHandshake() async throws {
    // A FRESH client keypair whose pubkey is NOT in the server's peer allowlist.
    let clientKp = FridayCrypto.DeviceKeypair()
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let enrolledKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)

    let transport = EmulatedRustServerTransport(
      serverKeypair: serverKp,
      sessionNonce: nonce,
      peerAllowlist: [enrolledKp.publicKey], // the fresh client is NOT here
      ownerAllowlist: [owner],
      projectionJSON: Array(Self.refsOnlyProjection.utf8)
    )
    let client = SealedWSReadClient(
      keypair: clientKp,
      forwardedPrincipal: owner,
      makeTransport: { transport }
    )

    do {
      _ = try await client.fetchWorkbench()
      XCTFail("a non-allowlisted peer must be rejected at the handshake")
    } catch {
      XCTAssertTrue(transport.endedFailClosed)
    }
  }

  /// Envelope JSON round-trips (sanity for the request the client builds). NOT a parity
  /// assertion — the envelope is sealed then serde-parsed (order-agnostic); this just pins
  /// the request shape the client emits.
  func testEnvelopeRoundTrips() throws {
    let req = WorkbenchProjectionRequestWire(
      missionId: nil, forwardedPrincipal: owner, authProof: [1, 2, 3], requestId: "req-x"
    )
    let env = FridayEnvelope(msgId: "msg-x", sentAt: 7, message: .workbenchProjectionRequest(req))
      .withCorrelation("corr-1")
    let data = try env.encodeJSON()
    let back = try FridayEnvelope.decodeJSON(data)
    XCTAssertEqual(back, env)
    // An absent missionId is OMITTED on the wire (matches Rust skip_serializing_if).
    let json = String(decoding: data, as: UTF8.self)
    XCTAssertFalse(json.contains("mission_id"))
    XCTAssertTrue(json.contains("\"kind\":\"WorkbenchProjectionRequest\""))
  }
}
