import XCTest
@testable import FridayMobileShellCore
@testable import FridayRustClient

/// Deterministic X25519 secret fixtures for the wiring tests. These need NOT byte-match the
/// Rust KATs (the package's Rust-anchored KATs own crypto byte-parity); ANY valid 32-byte
/// secret yields a self-consistent client↔emulator session, which is all a WIRING test needs.
enum TestKeys {
  static let clientSecret = "070b0d1113171d1f25292b2f353b3d4347494f53596165676b6d717f83898b95" // pragma: allowlist secret
  static let serverSecret = "020305070b0d1113171d1f25292b2f353b3d4347494f53596165676b6d717f83" // pragma: allowlist secret
  /// 64 ASCII bytes (the read/write servers emit a 64-byte hex-of-32 nonce; the client binds it
  /// VERBATIM, so any 64-byte value works for a wiring round-trip).
  static let sessionNonce = Array("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".utf8) // pragma: allowlist secret
}

/// **View-model-level tests for the Home read surface** — proves the Home wires the PACKAGE's
/// `FridayRustReadClient` (the package's types WIN), surfaces a refs-only `HomeProjection`, and
/// renders honest-unavailable on a dark/offline server (the EXPECTED slice-6 state).
@MainActor
final class HomeViewModelTests: XCTestCase {

  /// A scripted read client — returns a refs-only snapshot or throws (honest-unavailable).
  ///
  /// `@unchecked Sendable`: the package's `FridayRustReadClient` protocol is `Sendable`, but the
  /// scripted `WorkbenchSnapshot` carries a non-`Sendable` `raw: [String: Any]` (the same reason
  /// the package's own `SealedWSReadClient` is `@unchecked Sendable`). This fixture is a single
  /// immutable `let` driven on one actor in the test, so the override is sound.
  final class FakeReadClient: FridayRustReadClient, @unchecked Sendable {
    enum Script { case snapshot(WorkbenchSnapshot); case fail(FridayReadClientError) }
    let script: Script
    init(_ script: Script) { self.script = script }
    func fetchWorkbench() async throws -> WorkbenchSnapshot {
      switch script {
      case .snapshot(let s): return s
      case .fail(let e): throw e
      }
    }
  }

  private func sampleSnapshot() throws -> WorkbenchSnapshot {
    let json = """
    {
      "missionId": "mission-7",
      "fridayConversationId": "conv-7",
      "runtimeFeedStatus": "live_rust_hub_projection",
      "statusLabels": ["stale"],
      "routeDecision": {
        "advisorSummary": "route: deepseek (refs-only)",
        "selectedRoute": "deepseek",
        "alternatives": ["codex", "claude"],
        "truthLabel": "friday_owned"
      },
      "providerReceiptRefs": ["proof://provider/1"],
      "channelReceiptRefs": ["proof://surface/mobile/1"],
      "workItems": [
        { "workItemId": "wi-1", "title": "Draft mission", "state": "ready", "owner": "friday_owned", "done": false },
        { "workItemId": "wi-2", "title": "Needs approval", "state": "waiting", "owner": "linked_only", "proofRef": "proof://wi/2", "done": false }
      ],
      "memoryCandidates": [
        { "id": "cand-1", "preview": "Remember route preference.", "state": "candidate_review_only", "grantsMemoryAuthority": false, "evidenceRef": "proof://memory/1" }
      ],
      "runOutcomeLearningCandidates": [
        { "id": "learn-1", "runId": "run-1", "workItemId": "wi-2", "kind": "preference", "state": "candidate", "summary": "DeepSeek handled the short planning leg well.", "evidenceRef": "proof://learning/1" }
      ],
      "capabilityStates": [
        { "id": "cap-route", "label": "Route advisor", "kind": "advisor", "truthLabel": "friday_owned", "approvalState": "not_required", "dispatchAllowed": true, "summary": "Routes are advisory.", "proofRef": "proof://cap/1" }
      ],
      "transcriptSections": [
        { "id": "sec-1", "title": "Mission", "groupKind": "mission", "missionId": "mission-7", "truthLabel": "friday_owned", "status": "ready", "events": [
          { "id": "evt-1", "missionId": "mission-7", "surface": "mobile", "status": "ready", "truthLabel": "friday_owned", "summary": "Mobile surface read the mission projection.", "capturedAt": "2026-06-21T00:00:00Z" }
        ] }
      ]
    }
    """
    return try WorkbenchSnapshot(projectionJSON: Data(json.utf8), generatedAtMs: 1_780_640_000_000)
  }

  func testRefresh_loadsRefsOnlyProjection() async throws {
    let snapshot = try sampleSnapshot()
    let vm = HomeViewModel(client: FakeReadClient(.snapshot(snapshot)))
    await vm.refresh()
    guard case .loaded(let p) = vm.state else { return XCTFail("expected .loaded, got \(vm.state)") }
    XCTAssertEqual(p.missionId, "mission-7")
    XCTAssertEqual(p.runtimeFeedStatus, "live_rust_hub_projection") // truth label rides AS-IS
    XCTAssertEqual(p.statusLabels, ["stale"])                       // no label upgrade
    XCTAssertEqual(p.workItemIds, ["wi-1", "wi-2"])                 // refs/ids only (INV-5)
    XCTAssertTrue(vm.state.isOnline)
  }

  func testRefresh_liftsConsumerSurfaceProjectionRefs() async throws {
    let vm = HomeViewModel(client: FakeReadClient(.snapshot(try sampleSnapshot())))
    await vm.refresh()
    guard case .loaded(let p) = vm.state else { return XCTFail("expected .loaded") }
    XCTAssertEqual(p.routeSelected, "deepseek")
    XCTAssertEqual(p.routeAlternatives, ["codex", "claude"])
    XCTAssertEqual(p.providerReceiptRefs, ["proof://provider/1"])
    XCTAssertEqual(p.channelReceiptRefs, ["proof://surface/mobile/1"])
    XCTAssertEqual(p.workItems.map(\.title), ["Draft mission", "Needs approval"])
    XCTAssertEqual(p.workItems.filter(\.needsAttention).map(\.id), ["wi-2"])
    XCTAssertEqual(p.memoryCandidates.first?.grantsMemoryAuthority, false)
    XCTAssertEqual(p.runOutcomeLearningCandidates.first?.runId, "run-1")
    XCTAssertEqual(p.capabilityStates.first?.dispatchAllowed, true)
    XCTAssertEqual(p.transcriptEvents.first?.summary, "Mobile surface read the mission projection.")
    XCTAssertEqual(p.needsMeCount, 3)
  }

  func testRefresh_transportFailure_isHonestUnavailable() async {
    let vm = HomeViewModel(client: FakeReadClient(.fail(.transport("connection refused (server dark)"))))
    await vm.refresh()
    guard case .unavailable(let reason) = vm.state else { return XCTFail("expected .unavailable, got \(vm.state)") }
    XCTAssertTrue(reason.contains("offline"), "reason: \(reason)")
    XCTAssertFalse(vm.state.isOnline) // a dark server is NEVER online
  }

  func testRefresh_serverError_isHonestUnavailable_noFakeReady() async {
    let vm = HomeViewModel(client: FakeReadClient(.fail(.serverError(code: .hubOffline, message: "no active mission"))))
    await vm.refresh()
    guard case .unavailable(let reason) = vm.state else { return XCTFail("expected .unavailable") }
    XCTAssertTrue(reason.contains("Friday is unavailable"), "reason: \(reason)")
    XCTAssertNil(vm.state.projection) // never a fabricated ready projection
  }
}

/// **Read-client integration over an in-memory read-server transport** — proves the REAL
/// `SealedWSReadClient` (built via `FridayClientFactory.makeReadClient`) drives the full
/// handshake→owner-authed-request→open-the-owner-sealed-snapshot path against an emulated read
/// server, AND that the DEFAULT (no live transport) factory yields honest-unavailable.
///
/// HONEST LABEL: wiring-only (the emulated server seals with the SAME Swift primitives — see the
/// circular-roundtrip caveat in the package's `WriteClientWiringTests`). Crypto byte-parity is
/// proven by the package's Rust-anchored KATs; the live round-trip is the slice-6 deferred AC.
@MainActor
final class ReadClientFactoryTests: XCTestCase {

  /// The DEFAULT factory has NO live transport wired (the slice-6 deferred AC) — so a fetch
  /// throws and the Home renders honest-unavailable. This is the EXPECTED dark-server state.
  func testDefaultFactory_noLiveTransport_yieldsHonestUnavailable() async throws {
    let kp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.clientSecret))
    let client = FridayClientFactory.makeReadClient(
      keypair: kp,
      endpoint: .init(forwardedPrincipal: "principal:owner"))
    let vm = HomeViewModel(client: client)
    await vm.refresh()
    guard case .unavailable(let reason) = vm.state else { return XCTFail("expected .unavailable, got \(vm.state)") }
    XCTAssertTrue(reason.contains("offline") || reason.contains("not set up"),
                  "reason: \(reason)")
    XCTAssertFalse(vm.state.isOnline)
  }

  /// With an emulated read-server transport injected, the REAL client completes the sealed-WS
  /// read round-trip and the Home loads the refs-only projection.
  func testRealClient_emulatedServer_loadsProjection() async throws {
    let owner = "principal:owner-allowlisted"
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.serverSecret))
    let nonce = TestKeys.sessionNonce

    let transport = EmulatedReadServerTransport(
      serverKeypair: serverKp, sessionNonce: nonce,
      peerAllowlist: [clientKp.publicKey], ownerAllowlist: [owner])
    let client = FridayClientFactory.makeReadClient(
      keypair: clientKp,
      endpoint: .init(forwardedPrincipal: owner),
      makeTransport: { transport })
    let vm = HomeViewModel(client: client)
    await vm.refresh()
    guard case .loaded(let p) = vm.state else { return XCTFail("expected .loaded, got \(vm.state)") }
    XCTAssertEqual(p.missionId, "mission-emulated")
    XCTAssertEqual(p.runtimeFeedStatus, "live_rust_hub_projection")
    XCTAssertEqual(p.workItemIds, ["wi-a"])
  }

  /// A non-allowlisted peer is rejected at the handshake ⇒ honest-unavailable (fail-closed).
  func testRealClient_nonAllowlistedPeer_failsClosed() async throws {
    let owner = "principal:owner-allowlisted"
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.serverSecret))
    let nonce = TestKeys.sessionNonce
    let transport = EmulatedReadServerTransport(
      serverKeypair: serverKp, sessionNonce: nonce,
      peerAllowlist: [serverKp.publicKey], ownerAllowlist: [owner]) // client NOT enrolled
    let client = FridayClientFactory.makeReadClient(
      keypair: clientKp, endpoint: .init(forwardedPrincipal: owner), makeTransport: { transport })
    let vm = HomeViewModel(client: client)
    await vm.refresh()
    guard case .unavailable = vm.state else { return XCTFail("a non-allowlisted peer must be unavailable, got \(vm.state)") }
    XCTAssertFalse(vm.state.isOnline)
  }
}

// MARK: - Emulated read-server transport (mirrors the package's write-server emulator)

/// An in-memory transport playing the Rust read-projection server's half: the cleartext preamble
/// (server pubkey + 64-byte nonce), the S-F peer-allowlist gate, the owner-auth verify on the
/// READ constants, then an owner-sealed `WorkbenchProjectionSnapshot`.
final class EmulatedReadServerTransport: SealedWSTransport {
  private let serverKeypair: FridayCrypto.DeviceKeypair
  private let sessionNonce: [UInt8]
  private let peerAllowlist: [[UInt8]]
  private let ownerAllowlist: [String]

  private var clientPub: [UInt8]?
  private var sessionKey: [UInt8]?
  private var upgraded = false
  private var queued: [[UInt8]] = []

  init(serverKeypair: FridayCrypto.DeviceKeypair, sessionNonce: [UInt8],
       peerAllowlist: [[UInt8]], ownerAllowlist: [String]) {
    self.serverKeypair = serverKeypair
    self.sessionNonce = sessionNonce
    self.peerAllowlist = peerAllowlist
    self.ownerAllowlist = ownerAllowlist
  }

  func writeFrame(_ payload: [UInt8]) throws {
    if clientPub == nil {
      guard peerAllowlist.contains(payload) else {
        throw FridayReadClientError.transport("peer pubkey not in allowlist")
      }
      clientPub = payload
      queued.append(serverKeypair.publicKey)
      queued.append(sessionNonce)
    }
  }

  func readFrame() throws -> [UInt8] {
    guard !queued.isEmpty else { throw FridayReadClientError.transport("no preamble frame queued") }
    return queued.removeFirst()
  }

  func upgrade() throws {
    guard let clientPub else { throw FridayReadClientError.transport("no client pubkey before upgrade") }
    sessionKey = try serverKeypair.agree(peerPublicKey: clientPub)
    upgraded = true
  }

  func sendMessage(_ body: [UInt8]) throws {
    guard upgraded, let sessionKey else { throw FridayReadClientError.transport("not upgraded") }
    let env = try FridayEnvelope.decodeJSON(Data(try FridayCrypto.open(
      key: sessionKey, sealed: FridayCrypto.decodeSealed(body), aad: readSessionAad)))
    guard case .workbenchProjectionRequest(let req) = env.message else {
      throw FridayReadClientError.transport("unexpected inbound on the read session")
    }
    // AUTH — open the auth_proof under the session key with auth_aad(read_aad, principal,
    // request_id); it must equal the READ nonce-bound challenge; principal must be allowlisted.
    let reqAad = FridayCrypto.authAad(readSessionAad, forwardedPrincipal: req.forwardedPrincipal, boundContext: Array(req.requestId.utf8))
    let opened: [UInt8]
    do {
      opened = try FridayCrypto.open(key: sessionKey, sealed: FridayCrypto.decodeSealed(req.authProof), aad: reqAad)
    } catch {
      return // fail-closed: NO snapshot, session ends.
    }
    let expected = FridayCrypto.nonceBoundChallenge(readAuthChallenge, sessionNonce: sessionNonce)
    guard opened == expected, ownerAllowlist.contains(req.forwardedPrincipal) else { return }

    // AUTHENTICATED — owner-seal a refs-only projection and answer.
    let projection = """
    {"missionId":"mission-emulated","fridayConversationId":"conv-emulated",\
    "runtimeFeedStatus":"live_rust_hub_projection","statusLabels":[],\
    "workItems":[{"workItemId":"wi-a"}]}
    """
    let innerSealed = try FridayCrypto.seal(key: sessionKey, plaintext: Array(projection.utf8), aad: readSessionAad)
    let projectionHex = Hex.encode(FridayCrypto.encodeSealed(innerSealed))
    // `WorkbenchProjectionSnapshotWire` has no public memberwise init (the package only
    // synthesizes an internal one); construct it via its `Codable` shape, exactly as the wire
    // carries it.
    let snapJSON = """
    {"request_id":"\(req.requestId)","projection_json":"\(projectionHex)","generated_at_ms":1780640000000}
    """
    let snap = try JSONDecoder().decode(WorkbenchProjectionSnapshotWire.self, from: Data(snapJSON.utf8))
    let resp = FridayEnvelope(msgId: "snap-\(req.requestId)", sentAt: 1_780_640_000_000,
                              message: .workbenchProjectionSnapshot(snap)).withCorrelation(env.msgId)
    queued.append(try FridayCrypto.encodeSealed(try FridayCrypto.seal(
      key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: readSessionAad)))
  }

  func recvMessage() throws -> [UInt8] {
    guard !queued.isEmpty else { throw FridayReadClientError.transport("session ended (no response)") }
    return queued.removeFirst()
  }
}
