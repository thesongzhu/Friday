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
    private(set) var fetchWorkbenchCount = 0
    private(set) var requestedDetails: [String] = []
    init(_ script: Script) { self.script = script }
    func fetchWorkbench() async throws -> WorkbenchSnapshot {
      fetchWorkbenchCount += 1
      switch script {
      case .snapshot(let s): return s
      case .fail(let e): throw e
      }
    }

    func fetchProvidersDoctor(probe: String?) async throws -> ReadProjectionSnapshot {
      requestedDetails.append("providers:\(probe ?? "")")
      return try capabilityDoctorSnapshot()
    }

    func fetchCapabilityDoctor(validateKeys: Bool) async throws -> ReadProjectionSnapshot {
      requestedDetails.append("capabilities:\(validateKeys)")
      return try capabilityDoctorSnapshot()
    }

    private func capabilityDoctorSnapshot() throws -> ReadProjectionSnapshot {
      if case .fail(let error) = script {
        throw error
      }
      let raw: [String: Any] = [
        "truth_label": "rust_capability_doctor",
        "proof_only": true,
        "ok": true,
        "cli_detected": [
          [
            "provider": "codex",
            "installed": true,
            "authenticated": true,
            "detail": "codex cli authenticated",
            "truthLabel": "linked_only",
          ],
          [
            "provider": "claude",
            "installed": true,
            "authenticated": false,
            "detail": "claude auth missing",
            "truthLabel": "linked_only",
          ],
        ],
        "cli_logged_in": ["codex"],
        "key_validation_probed": true,
        "key_validation": [
          ["provider": "deepseek", "label": "valid"],
          ["provider": "anthropic", "label": "credential_missing"],
        ],
        "confirmed_valid_keys": ["deepseek"],
        "route_readiness": [
          [
            "provider_id": "codex",
            "model": "gpt-5.5",
            "model_size": "frontier",
            "strength": "strong",
            "dispatchable": true,
            "blockers": [],
          ],
          [
            "provider_id": "claude",
            "model": "claude-opus",
            "model_size": "frontier",
            "strength": "strong",
            "dispatchable": false,
            "blockers": [["code": "auth_missing"]],
          ],
        ],
        "failover_readiness": [
          [
            "direction": "deepseek_to_claude",
            "flag_enabled": true,
            "can_enable": false,
            "blockers": [["code": "fallback_route_not_dispatchable"]],
          ],
        ],
        "suggested_text_route": "codex",
        "suggested_strong_route": "codex",
      ]
      let data = try JSONSerialization.data(withJSONObject: raw)
      return try ReadProjectionSnapshot(projectionJSON: data, generatedAtMs: 1_780_640_000_123)
    }

    func fetchSessionList() async throws -> ReadProjectionSnapshot {
      requestedDetails.append("sessions")
      return try detailSnapshot(kind: "sessions", status: "ready", proofRef: "proof://session/list")
    }

    func fetchSessionOpen(agentSessionId: String) async throws -> ReadProjectionSnapshot {
      requestedDetails.append("session-open:\(agentSessionId)")
      return try detailSnapshot(kind: "session-open", status: "open", proofRef: "proof://session/open/\(agentSessionId)")
    }

    func fetchSessionLinkState(agentSessionId: String) async throws -> ReadProjectionSnapshot {
      requestedDetails.append("session-link:\(agentSessionId)")
      return try detailSnapshot(kind: "session-link", status: "connected", proofRef: "proof://session/link/\(agentSessionId)")
    }

    func fetchRunReadback(runId: String) async throws -> ReadProjectionSnapshot {
      requestedDetails.append("run:\(runId)")
      return try detailSnapshot(kind: "run", status: "complete", runId: runId, proofRef: "proof://run/\(runId)")
    }

    func fetchRunFileView(runId: String) async throws -> ReadProjectionSnapshot {
      requestedDetails.append("run-files:\(runId)")
      return try detailSnapshot(kind: "run-files", status: "ready", runId: runId, proofRef: "proof://run-files/\(runId)")
    }

    func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot {
      requestedDetails.append("needs-me:\(runId)")
      return try detailSnapshot(kind: "needs-me", status: "waiting", runId: runId, proofRef: "proof://needs/\(runId)")
    }

    private func detailSnapshot(
      kind: String,
      status: String,
      runId: String? = nil,
      proofRef: String,
      extra: [String: Any] = [:]
    ) throws -> ReadProjectionSnapshot {
      if case .fail(let error) = script {
        throw error
      }
      var raw: [String: Any] = [
        "missionId": "mission-7",
        "status": status,
        "proofRef": proofRef,
        "evidenceRefs": ["proof://evidence/\(kind)"],
      ]
      if extra["truth_label"] == nil && extra["truthLabel"] == nil {
        raw["truthLabel"] = "friday_owned"
      }
      if let runId { raw["runId"] = runId }
      for (key, value) in extra {
        raw[key] = value
      }
      let data = try JSONSerialization.data(withJSONObject: raw)
      return try ReadProjectionSnapshot(projectionJSON: data, generatedAtMs: 1_780_640_000_123)
    }
  }

  final class FakeMissionWriteClient: FridayMissionSpineWriteClient, @unchecked Sendable {
    enum LearningScript {
      case result(RunOutcomeLearningDecisionResultWire)
      case fail(Error)
    }
    enum MemoryScript {
      case result(MemoryDecisionResultWire)
      case fail(Error)
    }
    enum ActivityScript {
      case result(ActivityMarkDoneResultWire)
      case fail(Error)
    }

    let learningScript: LearningScript?
    let memoryScript: MemoryScript?
    let activityScript: ActivityScript?
    private(set) var memoryRequests: [MemoryDecisionRequestWire] = []
    private(set) var learningRequests: [RunOutcomeLearningDecisionRequestWire] = []
    private(set) var activityMarkDoneRequests: [ActivityMarkDoneRequestWire] = []
    private(set) var workItemStatusRequests: [WorkItemStatusRequestWire] = []

    init(
      learningScript: LearningScript? = nil,
      memoryScript: MemoryScript? = nil,
      activityScript: ActivityScript? = nil
    ) {
      self.learningScript = learningScript
      self.memoryScript = memoryScript
      self.activityScript = activityScript
    }

    func submitMissionIntake(_ request: MissionIntakeRequestWire) async throws -> MissionIntakeResultWire {
      throw NSError(domain: "unused", code: 1)
    }

    func submitMemoryDecision(_ request: MemoryDecisionRequestWire) async throws -> MemoryDecisionResultWire {
      memoryRequests.append(request)
      guard let memoryScript else { throw NSError(domain: "unused", code: 1) }
      switch memoryScript {
      case .result(let result): return result
      case .fail(let error): throw error
      }
    }

    func submitRunOutcomeLearningDecision(
      _ request: RunOutcomeLearningDecisionRequestWire
    ) async throws -> RunOutcomeLearningDecisionResultWire {
      learningRequests.append(request)
      guard let learningScript else { throw NSError(domain: "unused", code: 1) }
      switch learningScript {
      case .result(let result): return result
      case .fail(let error): throw error
      }
    }

    func submitActivityMarkDone(_ request: ActivityMarkDoneRequestWire) async throws -> ActivityMarkDoneResultWire {
      activityMarkDoneRequests.append(request)
      guard let activityScript else { throw NSError(domain: "unused", code: 1) }
      switch activityScript {
      case .result(let result): return result
      case .fail(let error): throw error
      }
    }

    func submitWorkItemStatus(_ request: WorkItemStatusRequestWire) async throws -> WorkItemStatusResultWire {
      workItemStatusRequests.append(request)
      return WorkItemStatusResultWire(
        workItemId: request.workItemId,
        missionId: "unused",
        previousStatus: "unknown",
        status: request.targetStatus,
        actorRef: request.actorRef,
        reason: request.reason,
        proofReceiptCount: request.proofReceipt == nil ? 0 : 1,
        updatedAtMs: 0)
    }
  }

  private func sampleSnapshot() throws -> WorkbenchSnapshot {
    let json = """
    {
      "missionId": "mission-7",
      "fridayConversationId": "conv-7",
      "runtimeFeedStatus": "live_rust_hub_projection",
      "statusLabels": ["stale"],
      "agentSessionId": "session-1",
      "routeDecision": {
        "advisorSummary": "route: deepseek (refs-only)",
        "selectedRoute": "deepseek",
        "alternatives": ["codex", "claude"],
        "truthLabel": "friday_owned"
      },
      "providerReceiptRefs": ["proof://provider/1"],
      "channelReceiptRefs": ["proof://surface/mobile/1"],
      "workItems": [
        { "workItemId": "wi-1", "title": "Draft mission", "state": "ready", "owner": "friday_owned", "done": false, "blockingReason": "ready for dispatch; no recovery action required", "recoveryKind": "dispatchable", "canRetry": false, "canCancel": true },
        { "workItemId": "wi-2", "title": "Needs approval", "state": "stale", "owner": "linked_only", "proofRef": "proof://wi/2", "done": false, "blockingReason": "failed retryable; operator may retry by returning the WorkItem to ready_to_dispatch", "recoveryKind": "retryable", "canRetry": true, "canCancel": true }
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
      "t3ProvisioningStatus": {
        "truthLabel": "rust_hub_t3_provisioning_read_only_no_mint",
        "paired": true,
        "deviceIdentityCount": 1,
        "trustedDeviceCount": 1,
        "activeTrustedDeviceCount": 1,
        "trustGrantCount": 1,
        "activeTrustGrantCount": 1,
        "contextPassportCount": 1,
        "contextPassportItemCount": 2,
        "latestDevice": {
          "deviceId": "proof://device/paired-ios-1",
          "label": "operator phone",
          "pairedAt": 1780640000000,
          "revokedAt": null,
          "keyRotatedAt": null,
          "pubkeyFingerprint": "abcd1234:dcba4321"
        }
      },
      "transcriptSections": [
        { "id": "sec-1", "title": "Mission", "groupKind": "mission", "missionId": "mission-7", "truthLabel": "friday_owned", "status": "ready", "events": [
          { "id": "evt-1", "missionId": "mission-7", "surface": "mobile", "status": "ready", "truthLabel": "friday_owned", "summary": "Mobile surface read the mission projection.", "capturedAt": "2026-06-21T00:00:00Z" }
        ] }
      ]
    }
    """
    return try WorkbenchSnapshot(projectionJSON: Data(json.utf8), generatedAtMs: 1_780_640_000_000)
  }

  private func emptySnapshot() throws -> WorkbenchSnapshot {
    let json = """
    {
      "missionId": "mission-empty",
      "fridayConversationId": "conv-empty",
      "runtimeFeedStatus": "live_rust_hub_projection",
      "statusLabels": [],
      "workItems": [],
      "providerReceiptRefs": [],
      "channelReceiptRefs": [],
      "memoryCandidates": [],
      "runOutcomeLearningCandidates": [],
      "capabilityStates": [],
      "transcriptSections": []
    }
    """
    return try WorkbenchSnapshot(projectionJSON: Data(json.utf8), generatedAtMs: 1_780_640_010_000)
  }

  func testRefresh_loadsRefsOnlyProjection() async throws {
    let snapshot = try sampleSnapshot()
    let vm = HomeViewModel(client: FakeReadClient(.snapshot(snapshot)))
    await vm.refresh()
    guard case .loaded(let p) = vm.state else { return XCTFail("expected .loaded, got \(vm.state)") }
    XCTAssertEqual(p.missionId, "mission-7")
    XCTAssertEqual(p.runtimeFeedStatus, "live_rust_hub_projection") // truth label rides AS-IS
    XCTAssertEqual(p.statusLabels, ["stale"])                       // no label upgrade
    XCTAssertEqual(p.agentSessionId, "session-1")
    XCTAssertEqual(p.workItemIds, ["wi-1", "wi-2"])                 // refs/ids only (INV-5)
    XCTAssertTrue(vm.state.isOnline)
  }

  func testHomeViewModelCarriesInjectedDevicePairingReadiness() async throws {
    let readiness = DevicePairingReadiness(
      mode: .ready,
      publicKeyHex: String(repeating: "a", count: 64),
      readLiveRequested: true,
      writeLiveRequested: false,
      reason: "Device public key is ready for operator enrollment.",
      nextStep: "Enroll this public key on the Hub.")
    let vm = HomeViewModel(
      client: FakeReadClient(.snapshot(try sampleSnapshot())),
      devicePairing: readiness)

    await vm.refresh()

    XCTAssertEqual(vm.devicePairing, readiness)
    XCTAssertEqual(vm.devicePairing.publicKeyHex, String(repeating: "a", count: 64))
    XCTAssertTrue(vm.devicePairing.readLiveRequested)
    XCTAssertFalse(vm.devicePairing.writeLiveRequested)
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
    XCTAssertEqual(p.workItems.filter(\.needsAttention).map(\.id), ["wi-1", "wi-2"])
    XCTAssertEqual(p.workItems.last?.recoveryKind, "retryable")
    XCTAssertEqual(p.workItems.last?.canRetry, true)
    XCTAssertEqual(p.workItems.last?.blockingReason, "failed retryable; operator may retry by returning the WorkItem to ready_to_dispatch")
    XCTAssertEqual(p.memoryCandidates.first?.grantsMemoryAuthority, false)
    XCTAssertEqual(p.runOutcomeLearningCandidates.first?.runId, "run-1")
    XCTAssertEqual(p.tokenLedgerRunId, "run-1")
    XCTAssertEqual(p.capabilityStates.first?.dispatchAllowed, true)
    XCTAssertEqual(p.t3ProvisioningStatus?.truthLabel, "rust_hub_t3_provisioning_read_only_no_mint")
    XCTAssertEqual(p.t3ProvisioningStatus?.paired, true)
    XCTAssertEqual(p.t3ProvisioningStatus?.latestDevice?.deviceId, "proof://device/paired-ios-1")
    XCTAssertEqual(p.t3ProvisioningStatus?.latestDevice?.pubkeyFingerprint, "abcd1234:dcba4321")
    XCTAssertEqual(p.t3ProvisioningStatus?.isFullyProvisioned, true)
    XCTAssertEqual(p.t3ProvisioningStatus?.homeStatusLabel, "fully provisioned")
    XCTAssertEqual(
      p.t3ProvisioningStatus?.homeSummary,
      "Hub projection shows 1 device identity, 1 active trusted device, 1 active trust grant, 1 context passport, and 2 passport items.")
    XCTAssertEqual(p.t3ProvisioningStatus?.missingOperatorSteps, [])
    XCTAssertEqual(p.t3ProvisioningStatus?.checklistRows.map(\.id), [
      "pairack", "trust-grant", "context-passport", "passport-items",
    ])
    XCTAssertEqual(p.t3ProvisioningStatus?.checklistRows.map(\.satisfied), [
      true, true, true, true,
    ])
    XCTAssertEqual(p.t3ProvisioningStatus?.checklistRows.last?.statusText, "shared")
    XCTAssertEqual(p.transcriptEvents.first?.summary, "Mobile surface read the mission projection.")
    XCTAssertEqual(p.needsMeCount, 4)
  }

  func testT3ProvisioningHomeSummarySurfacesOperatorGapsWithoutClaimingReady() throws {
    let data = Data("""
    {
      "missionId": "mission-t3",
      "fridayConversationId": "conv-t3",
      "runtimeFeedStatus": "live_rust_hub_projection",
      "statusLabels": [],
      "t3ProvisioningStatus": {
        "truthLabel": "rust_hub_t3_provisioning_read_only_no_mint",
        "paired": true,
        "deviceIdentityCount": 1,
        "trustedDeviceCount": 1,
        "activeTrustedDeviceCount": 1,
        "trustGrantCount": 0,
        "activeTrustGrantCount": 0,
        "contextPassportCount": 0,
        "contextPassportItemCount": 0,
        "latestDevice": {
          "deviceId": "proof://device/paired-ios-1",
          "label": "operator phone",
          "pairedAt": 1780640000000,
          "pubkeyFingerprint": "abcd1234:dcba4321"
        }
      }
    }
    """.utf8)
    let snapshot = try WorkbenchSnapshot(projectionJSON: data, generatedAtMs: 1_780_640_000_000)
    let projection = HomeProjection(snapshot)

    XCTAssertEqual(projection.t3ProvisioningStatus?.isFullyProvisioned, false)
    XCTAssertEqual(projection.t3ProvisioningStatus?.homeStatusLabel, "operator action needed")
    XCTAssertEqual(projection.t3ProvisioningStatus?.missingOperatorSteps, ["trust grant", "context passport"])
    XCTAssertEqual(
      projection.t3ProvisioningStatus?.homeSummary,
      "Paired device is visible in the Hub (1 active trusted device); missing trust grant, context passport.")
    XCTAssertEqual(projection.t3ProvisioningStatus?.checklistRows.map(\.satisfied), [
      true, false, false, false,
    ])
    XCTAssertEqual(projection.t3ProvisioningStatus?.checklistRows.map(\.statusText), [
      "paired", "needed", "needed", "needed",
    ])
  }

  func testRefresh_loadedEmptyIsConnectedEmptyNotUnavailable() async throws {
    let vm = HomeViewModel(client: FakeReadClient(.snapshot(try emptySnapshot())))
    await vm.refresh()
    guard case .loaded(let p) = vm.state else { return XCTFail("expected loaded empty projection, got \(vm.state)") }
    XCTAssertEqual(p.missionId, "mission-empty")
    XCTAssertTrue(p.isLoadedEmpty)
    XCTAssertNil(p.tokenLedgerRunId)
    XCTAssertTrue(vm.state.isOnline)
    XCTAssertNil(vm.state.projection?.statusLabels.first)
  }

  func testRefresh_nonEmptyProjectionIsNotLoadedEmpty() async throws {
    let vm = HomeViewModel(client: FakeReadClient(.snapshot(try sampleSnapshot())))
    await vm.refresh()
    guard case .loaded(let p) = vm.state else { return XCTFail("expected loaded projection") }
    XCTAssertFalse(p.isLoadedEmpty)
    XCTAssertTrue(vm.state.isOnline)
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

  func testLoadDetail_callsProviderDoctorReadArm() async throws {
    let client = FakeReadClient(.snapshot(try sampleSnapshot()))
    let vm = HomeViewModel(client: client)
    await vm.loadDetail(.providersDoctor(probe: "anthropic"))
    guard case let .loaded(detail) = vm.detailState else {
      return XCTFail("expected detail .loaded, got \(vm.detailState)")
    }
    XCTAssertEqual(client.requestedDetails, ["capabilities:true"])
    XCTAssertEqual(detail.title, "Provider doctor")
    XCTAssertEqual(detail.summary, "truth=rust_capability_doctor")
    XCTAssertEqual(detail.refs, [])
    XCTAssertEqual(detail.providerReadiness?.truthLabel, "rust_capability_doctor")
    XCTAssertEqual(detail.providerReadiness?.proofOnly, true)
    XCTAssertEqual(detail.providerReadiness?.ok, true)
    XCTAssertEqual(detail.providerReadiness?.readyProviders, ["codex"])
    XCTAssertEqual(detail.providerReadiness?.anyAuthenticated, true)
    XCTAssertEqual(detail.providerReadiness?.allAuthenticated, false)
    XCTAssertEqual(detail.providerReadiness?.detected.map(\.provider), ["codex", "claude"])
    XCTAssertEqual(detail.providerReadiness?.detected.first?.authenticated, true)
    XCTAssertEqual(detail.providerReadiness?.detected.last?.detail, "claude auth missing")
    XCTAssertEqual(detail.providerReadiness?.detected.last?.truthLabel, "linked_only")
    XCTAssertEqual(detail.providerReadiness?.routes.map(\.providerId), ["codex", "claude"])
    XCTAssertEqual(detail.providerReadiness?.routes.first?.dispatchable, true)
    XCTAssertEqual(detail.providerReadiness?.routes.last?.blockers, ["auth_missing"])
    XCTAssertEqual(detail.providerReadiness?.failovers.first?.direction, "deepseek_to_claude")
    XCTAssertEqual(detail.providerReadiness?.failovers.first?.flagEnabled, true)
    XCTAssertEqual(detail.providerReadiness?.failovers.first?.canEnable, false)
    XCTAssertEqual(detail.providerReadiness?.failovers.first?.blockers, ["fallback_route_not_dispatchable"])
    XCTAssertEqual(detail.providerReadiness?.suggestedTextRoute, "codex")
    XCTAssertEqual(detail.providerReadiness?.suggestedStrongRoute, "codex")
    XCTAssertEqual(detail.providerReadiness?.keyValidationProbed, true)
  }

  func testProviderReadinessRequiresProviderDoctorTruthLabel() throws {
    let raw: [String: Any] = [
      "truth_label": "not_provider_doctor",
      "detected": [
        ["provider": "codex", "installed": true, "authenticated": true, "detail": "logged_in", "truthLabel": "linked_only"],
      ],
    ]
    let data = try JSONSerialization.data(withJSONObject: raw)
    let snapshot = try ReadProjectionSnapshot(projectionJSON: data, generatedAtMs: 1_780_640_000_123)
    let detail = HomeReadDetail(title: "Non-provider detail", snapshot: snapshot)

    XCTAssertNil(detail.providerReadiness)
  }

  func testLoadDetail_callsRunAndNeedsMeReadArms() async throws {
    let client = FakeReadClient(.snapshot(try sampleSnapshot()))
    let vm = HomeViewModel(client: client)
    await vm.loadDetail(.runReadback(runId: "run-1"))
    await vm.loadDetail(.activityNeedsMe(runId: "run-1"))
    XCTAssertEqual(client.requestedDetails, ["run:run-1", "needs-me:run-1"])
    guard case let .loaded(detail) = vm.detailState else {
      return XCTFail("expected detail .loaded, got \(vm.detailState)")
    }
    XCTAssertEqual(detail.title, "Needs-me activity")
    XCTAssertTrue(detail.refs.contains("proof://needs/run-1"))
  }

  func testLoadDetail_callsSessionAndRunFileReadArms() async throws {
    let client = FakeReadClient(.snapshot(try sampleSnapshot()))
    let vm = HomeViewModel(client: client)
    await vm.loadDetail(.sessionOpen(agentSessionId: "session-1"))
    await vm.loadDetail(.sessionLinkState(agentSessionId: "session-1"))
    await vm.loadDetail(.runFileView(runId: "run-1"))
    XCTAssertEqual(client.requestedDetails, [
      "session-open:session-1",
      "session-link:session-1",
      "run-files:run-1",
    ])
    guard case let .loaded(detail) = vm.detailState else {
      return XCTFail("expected detail .loaded, got \(vm.detailState)")
    }
    XCTAssertEqual(detail.title, "Run files")
    XCTAssertTrue(detail.refs.contains("proof://run-files/run-1"))
  }

  func testLoadDetail_transportFailureIsHonestUnavailable() async {
    let vm = HomeViewModel(client: FakeReadClient(.fail(.transport("server dark"))))
    await vm.loadDetail(.sessionOpen(agentSessionId: "session-1"))
    guard case let .unavailable(title, reason) = vm.detailState else {
      return XCTFail("expected detail .unavailable, got \(vm.detailState)")
    }
    XCTAssertEqual(title, "Session open")
    XCTAssertTrue(reason.contains("offline"), "reason: \(reason)")
  }

  func testDecideRunOutcomeLearningConfirmRendersConfirmedAndRefreshes() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient(learningScript: .result(
      RunOutcomeLearningDecisionResultWire(
        candidateId: "learn-1",
        runId: "run-1",
        kind: "preference",
        state: "confirmed",
        status: "confirmed")))
    let vm = HomeViewModel(client: read, writeClient: write)

    await vm.decideRunOutcomeLearning(candidateId: "learn-1", confirm: true)

    XCTAssertEqual(write.learningRequests, [
      RunOutcomeLearningDecisionRequestWire(candidateId: "learn-1", decision: "confirm"),
    ])
    XCTAssertEqual(read.fetchWorkbenchCount, 1)
    XCTAssertEqual(
      vm.runOutcomeLearningDecisionStates["learn-1"],
      .confirmed(summary: "confirmed · state=confirmed · kind=preference"))
  }

  func testDecideRunOutcomeLearningBlockedRendersErrorNotConfirmed() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient(learningScript: .result(
      RunOutcomeLearningDecisionResultWire(
        candidateId: "learn-1",
        state: "unknown",
        status: "blocked",
        blocker: "candidate missing")))
    let vm = HomeViewModel(client: read, writeClient: write)

    await vm.decideRunOutcomeLearning(candidateId: "learn-1", confirm: false)

    XCTAssertEqual(write.learningRequests, [
      RunOutcomeLearningDecisionRequestWire(candidateId: "learn-1", decision: "reject"),
    ])
    XCTAssertEqual(read.fetchWorkbenchCount, 0)
    XCTAssertEqual(
      vm.runOutcomeLearningDecisionStates["learn-1"],
      .error(reason: "Learning decision blocked — candidate missing"))
  }

  func testDecideRunOutcomeLearningWithoutWriteClientIsUnavailable() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let vm = HomeViewModel(client: read)

    await vm.decideRunOutcomeLearning(candidateId: "learn-1", confirm: true)

    XCTAssertEqual(read.fetchWorkbenchCount, 0)
    XCTAssertEqual(
      vm.runOutcomeLearningDecisionStates["learn-1"],
      .error(reason: "Write seam not configured."))
  }

  func testMarkActivityDoneRendersConfirmedAndRefreshes() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient(activityScript: .result(
      ActivityMarkDoneResultWire(activityId: "activity-1", state: "done", status: "done")))
    let vm = HomeViewModel(client: read, writeClient: write)

    await vm.markActivityDone(activityId: "activity-1")

    XCTAssertEqual(write.activityMarkDoneRequests, [
      ActivityMarkDoneRequestWire(activityId: "activity-1", reason: "owner cleared activity"),
    ])
    XCTAssertEqual(read.fetchWorkbenchCount, 1)
    XCTAssertEqual(
      vm.activityMarkDoneStates["activity-1"],
      .confirmed(summary: "done · activity_id=activity-1"))
  }

  func testMarkActivityDoneBlockedRendersErrorNotConfirmed() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient(activityScript: .result(
      ActivityMarkDoneResultWire(
        activityId: "missing-activity",
        state: "unknown",
        status: "blocked",
        blocker: "unknown_activity")))
    let vm = HomeViewModel(client: read, writeClient: write)

    await vm.markActivityDone(activityId: "missing-activity")

    XCTAssertEqual(read.fetchWorkbenchCount, 0)
    XCTAssertEqual(
      vm.activityMarkDoneStates["missing-activity"],
      .error(reason: "Activity mark done blocked — unknown_activity"))
  }

  func testRetryWorkItemSendsLifecycleWriteAndRefreshes() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient()
    let vm = HomeViewModel(client: read, writeClient: write, writeOwnerPrincipal: "owner-ios")
    let item = try XCTUnwrap(HomeProjection(try sampleSnapshot()).workItems.last)

    await vm.retryWorkItem(item)

    XCTAssertEqual(write.workItemStatusRequests, [
      WorkItemStatusRequestWire(
        workItemId: "wi-2",
        targetStatus: "ready_to_dispatch",
        actorRef: "mobile:owner-ios",
        reason: "operator retries WorkItem from mobile recovery surface"),
    ])
    XCTAssertEqual(read.fetchWorkbenchCount, 1)
    XCTAssertEqual(
      vm.workItemStatusStates["wi-2"],
      .confirmed(summary: "ready_to_dispatch · work_item_id=wi-2 · previous=unknown"))
  }

  func testCancelWorkItemSendsLifecycleWriteAndRefreshes() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient()
    let vm = HomeViewModel(client: read, writeClient: write, writeOwnerPrincipal: "owner-ios")
    let item = try XCTUnwrap(HomeProjection(try sampleSnapshot()).workItems.last)

    await vm.cancelWorkItem(item)

    XCTAssertEqual(write.workItemStatusRequests, [
      WorkItemStatusRequestWire(
        workItemId: "wi-2",
        targetStatus: "cancelled",
        actorRef: "mobile:owner-ios",
        reason: "operator cancels WorkItem from mobile recovery surface"),
    ])
    XCTAssertEqual(read.fetchWorkbenchCount, 1)
    XCTAssertEqual(
      vm.workItemStatusStates["wi-2"],
      .confirmed(summary: "cancelled · work_item_id=wi-2 · previous=unknown"))
  }

  func testRetryWorkItemGuardDoesNotWriteWhenProjectionSaysNotRetryable() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient()
    let vm = HomeViewModel(client: read, writeClient: write, writeOwnerPrincipal: "owner-ios")
    let item = try XCTUnwrap(HomeProjection(try sampleSnapshot()).workItems.first)

    await vm.retryWorkItem(item)

    XCTAssertTrue(write.workItemStatusRequests.isEmpty)
    XCTAssertEqual(read.fetchWorkbenchCount, 0)
    XCTAssertEqual(vm.workItemStatusStates["wi-1"], .error(reason: "This WorkItem is not retryable."))
  }

  func testCancelWorkItemGuardDoesNotWriteWhenProjectionSaysNotCancellable() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient()
    let vm = HomeViewModel(client: read, writeClient: write, writeOwnerPrincipal: "owner-ios")
    var item = try XCTUnwrap(HomeProjection(try sampleSnapshot()).workItems.last)
    item = HomeWorkItem(
      id: item.id,
      title: item.title,
      state: item.state,
      owner: item.owner,
      proofRef: item.proofRef,
      done: item.done,
      blockingReason: item.blockingReason,
      recoveryKind: item.recoveryKind,
      canRetry: item.canRetry,
      canCancel: false)

    await vm.cancelWorkItem(item)

    XCTAssertTrue(write.workItemStatusRequests.isEmpty)
    XCTAssertEqual(read.fetchWorkbenchCount, 0)
    XCTAssertEqual(vm.workItemStatusStates["wi-2"], .error(reason: "This WorkItem is not cancellable."))
  }

  func testDecideMemoryConfirmRendersConfirmedAndRefreshes() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient(memoryScript: .result(
      MemoryDecisionResultWire(
        memoryId: "cand-1",
        state: "confirmed",
        status: "confirmed",
        recallable: true)))
    let vm = HomeViewModel(
      client: read,
      writeClient: write,
      writeOwnerPrincipal: "owner-ios")

    await vm.decideMemory(candidateId: "cand-1", confirm: true)

    XCTAssertEqual(write.memoryRequests, [
      MemoryDecisionRequestWire(
        memoryId: "cand-1",
        ownerPrincipal: "owner-ios",
        decision: "confirm"),
    ])
    XCTAssertEqual(read.fetchWorkbenchCount, 1)
    XCTAssertEqual(
      vm.memoryDecisionStates["cand-1"],
      .confirmed(summary: "confirmed · state=confirmed · recallable=true"))
  }

  func testDecideMemoryBlockedRendersErrorNotConfirmed() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let write = FakeMissionWriteClient(memoryScript: .result(
      MemoryDecisionResultWire(
        memoryId: "cand-1",
        state: "unknown",
        status: "blocked",
        blocker: "unknown_candidate",
        recallable: false)))
    let vm = HomeViewModel(
      client: read,
      writeClient: write,
      writeOwnerPrincipal: "owner-ios")

    await vm.decideMemory(candidateId: "cand-1", confirm: false)

    XCTAssertEqual(write.memoryRequests, [
      MemoryDecisionRequestWire(
        memoryId: "cand-1",
        ownerPrincipal: "owner-ios",
        decision: "reject"),
    ])
    XCTAssertEqual(read.fetchWorkbenchCount, 0)
    XCTAssertEqual(
      vm.memoryDecisionStates["cand-1"],
      .error(reason: "Memory decision blocked — unknown_candidate"))
  }

  func testDecideMemoryWithoutWriteClientIsUnavailable() async throws {
    let read = FakeReadClient(.snapshot(try sampleSnapshot()))
    let vm = HomeViewModel(client: read)

    await vm.decideMemory(candidateId: "cand-1", confirm: true)

    XCTAssertEqual(read.fetchWorkbenchCount, 0)
    XCTAssertEqual(
      vm.memoryDecisionStates["cand-1"],
      .error(reason: "Write seam not configured."))
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
    XCTAssertEqual(p.routeSelected, "codex")
    XCTAssertEqual(p.routeAlternatives, ["claude"])
    XCTAssertEqual(p.providerReceiptRefs, ["proof://provider/emulated"])
    XCTAssertEqual(p.channelReceiptRefs, ["proof://surface/mobile/emulated"])
    XCTAssertEqual(p.workItems.map(\.title), ["Rendered answer-ready work item"])
    XCTAssertEqual(p.workItems.first?.owner, "friday_owned")
    XCTAssertEqual(p.memoryCandidates.first?.grantsMemoryAuthority, false)
    XCTAssertEqual(p.runOutcomeLearningCandidates.first?.evidenceRef, "proof://learning/emulated")
    XCTAssertEqual(p.capabilityStates.first?.dispatchAllowed, false)
    XCTAssertEqual(p.transcriptEvents.first?.summary, "Mobile UI consumed the owner-gated projection.")
    XCTAssertEqual(p.needsMeCount, 3)
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

  /// A peer can be enrolled but still fail the owner-gate. The UI must render unavailable, not a
  /// loaded-empty or stale cached snapshot.
  func testRealClient_mismatchedOwnerPrincipal_failsClosed() async throws {
    let owner = "principal:owner-allowlisted"
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.serverSecret))
    let nonce = TestKeys.sessionNonce
    let transport = EmulatedReadServerTransport(
      serverKeypair: serverKp, sessionNonce: nonce,
      peerAllowlist: [clientKp.publicKey], ownerAllowlist: [owner])
    let client = FridayClientFactory.makeReadClient(
      keypair: clientKp,
      endpoint: .init(forwardedPrincipal: "principal:not-the-owner"),
      makeTransport: { transport })
    let vm = HomeViewModel(client: client)

    await vm.refresh()

    guard case .unavailable = vm.state else {
      return XCTFail("a mismatched owner principal must be unavailable, got \(vm.state)")
    }
    XCTAssertNil(vm.state.projection)
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
    "routeDecision":{"advisorSummary":"Use Codex first, then Claude when needed.",\
    "selectedRoute":"codex","alternatives":["claude"],"truthLabel":"friday_owned"},\
    "providerReceiptRefs":["proof://provider/emulated"],\
    "channelReceiptRefs":["proof://surface/mobile/emulated"],\
    "workItems":[{"workItemId":"wi-a","title":"Rendered answer-ready work item",\
    "state":"waiting","owner":"friday_owned","proofRef":"proof://wi/a","done":false,\
    "blockingReason":"waiting on operator input or preflight resolution",\
    "recoveryKind":"needs_operator","canRetry":false,"canCancel":true}],\
    "memoryCandidates":[{"id":"mem-a","preview":"Remember the preferred routing shape.",\
    "state":"candidate_review_only","grantsMemoryAuthority":false,\
    "evidenceRef":"proof://memory/emulated"}],\
    "runOutcomeLearningCandidates":[{"id":"learn-a","runId":"run-a","workItemId":"wi-a",\
    "kind":"preference","state":"candidate","summary":"Codex handled the first leg.",\
    "evidenceRef":"proof://learning/emulated"}],\
    "capabilityStates":[{"id":"cap-route","label":"Route advisor","kind":"advisor",\
    "truthLabel":"friday_owned","approvalState":"not_required","dispatchAllowed":false,\
    "summary":"Advisory only","proofRef":"proof://cap/route"}],\
    "transcriptSections":[{"id":"sec-a","title":"Mission","groupKind":"mission",\
    "missionId":"mission-emulated","truthLabel":"friday_owned","status":"waiting",\
    "events":[{"id":"evt-a","missionId":"mission-emulated","surface":"mobile",\
    "status":"waiting","truthLabel":"friday_owned",\
    "summary":"Mobile UI consumed the owner-gated projection.",\
    "proofRef":"proof://event/a","capturedAt":"2026-06-22T00:00:00Z"}]}]}
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
    queued.append(FridayCrypto.encodeSealed(try FridayCrypto.seal(
      key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: readSessionAad)))
  }

  func recvMessage() throws -> [UInt8] {
    guard !queued.isEmpty else { throw FridayReadClientError.transport("session ended (no response)") }
    return queued.removeFirst()
  }
}
