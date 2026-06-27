import XCTest
@testable import FridayRustClient

/// **The mission-spine WRITE deliverable — byte-asserted Swift↔Rust parity for the
/// MissionIntake + MemoryDecision + RunOutcomeLearningDecision wire shapes (Lane-D entry-point-A).** These prove the Swift
/// spine-write structs serialize to the EXACT JSON the Rust agent-run WRITE server
/// (`bin/hub_agent_run_server.rs`) decodes under `FRIDAY_MISSION_INTAKE=1` / `FRIDAY_MEMORY_CONFIRM=1`.
///
/// Two load-bearing traps these lock:
///  1. NESTED SHAPE — the `FridayMessage` variants NEST the payload under `request`/`result`
///     (`{"kind":"MissionIntakeRequest","request":{…}}`), the SAME internally-tagged shape as the
///     read `WorkbenchProjection*` variants — NOT the flattened AgentRun* `WriteKey` shape. The
///     Rust test `memory_decision_wire_round_trips_and_uses_the_request_result_wrapper` asserts
///     `"request":{` / `"result":{` and documents that a prior FLAT shape "503'd every call." These
///     KATs reproduce that anti-flat-shape guard on the Swift side.
///  2. NO auth_proof — neither message carries a per-request `auth_proof` field (the sealed session
///     IS the channel auth). These KATs assert the message object's EXACT key set, so a regression
///     that smuggles in an `auth_proof`/`forwarded_principal` is caught at the protocol layer.
///
/// Field-name + value parity is anchored to the Rust `friday_protocol` round-trip test vectors
/// (`lib.rs` ~2061/2137/2169) read at origin/main `ba78fdb7`: owner_principal/surface_kind/etc are
/// the SAME field NAMES the Rust serde struct uses (snake_case CodingKeys), and the values the live
/// desktop sends (`owner_principal:"admin-001"`, `decision:"confirm"`) are the server-accepted ones.
final class MissionSpineWriteKATTests: XCTestCase {

  /// The live desktop owner — equals the write server's `--owner admin-001` (FIX-Q3b cross-check).
  private let owner = "admin-001"

  /// Decode an envelope's `message` object as a key/value map so a KAT can assert the EXACT key set
  /// the message carries (order-agnostic), and the nested `request`/`result` object under it.
  private func messageObject(_ json: String) throws -> [String: Any] {
    let env = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    return try XCTUnwrap(env["message"] as? [String: Any], "envelope has no message object")
  }

  // MARK: MS1 — MissionIntakeRequest wire shape (nested + no auth_proof)

  /// MS1: a `MissionIntakeRequest` rides as `{"kind":"MissionIntakeRequest","request":{…}}` — the
  /// payload NESTED under `request`, NOT flattened. `owner_principal` is `admin-001`,
  /// `includes_sensitive_context` is ALWAYS emitted (even when false), and there is NO `auth_proof`.
  func testMS1_missionIntakeRequestNestedShapeNoAuthProof() throws {
    let req = MissionIntakeRequestWire(
      fridayConversationId: "fconv_desktop_1",
      ownerPrincipal: owner,
      surfaceThreadId: "surface-desktop-1",
      surfaceKind: "desktop",
      deliveryRoute: "desktop://hub-console/operations",
      visibilityPolicy: "compact",
      missionId: "mission-desktop-1",
      workItemId: "work-desktop-1",
      title: "Coordinate Friday work",
      intent: "keep one Mission across every surface",
      lane: "deepseek")
    let env = FridayEnvelope(msgId: "m1", sentAt: 1000, message: .missionIntakeRequest(req))
      .withCorrelation("c1")
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"MissionIntakeRequest\""))
    // The load-bearing anti-flat-shape guard: the payload sits under `"request":{…}`.
    XCTAssertTrue(json.contains("\"request\":{"), "intake must NEST under request, not flatten: \(json)")
    XCTAssertTrue(json.contains("\"owner_principal\":\"admin-001\""))
    XCTAssertTrue(json.contains("\"surface_kind\":\"desktop\""))
    // includes_sensitive_context is ALWAYS emitted (the server itself always serializes it).
    XCTAssertTrue(json.contains("\"includes_sensitive_context\":false"))

    // The message object carries EXACTLY {kind, request} — no auth_proof/forwarded_principal smuggled in.
    let messageObj = try messageObject(json)
    XCTAssertEqual(Set(messageObj.keys), ["kind", "request"])
    XCTAssertNil(messageObj["auth_proof"])
    XCTAssertNil(messageObj["forwarded_principal"])
    let request = try XCTUnwrap(messageObj["request"] as? [String: Any])
    XCTAssertNil(request["auth_proof"], "MissionIntakeRequest carries NO per-request auth_proof")

    // Round-trips back to the same message.
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .missionIntakeRequest(req))
  }

  /// MS1: the 3 optional fields are OMITTED when nil (serde `skip_serializing_if`); present + a
  /// `body_ref`/`target_provider_or_agent`/`capability_id` round-trip when set.
  func testMS1_missionIntakeOptionalsOmittedWhenNil_presentWhenSet() throws {
    let bare = MissionIntakeRequestWire(
      fridayConversationId: "f", ownerPrincipal: owner, surfaceThreadId: "s",
      surfaceKind: "desktop", deliveryRoute: "d", visibilityPolicy: "compact",
      missionId: "m", workItemId: "w", title: "t", intent: "i", lane: "deepseek")
    let bareJson = String(decoding: try JSONEncoder().encode(bare), as: UTF8.self)
    for omitted in ["target_provider_or_agent", "capability_id", "body_ref"] {
      XCTAssertFalse(bareJson.contains(omitted), "a nil optional must be omitted: \(omitted)")
    }

    let full = MissionIntakeRequestWire(
      fridayConversationId: "f", ownerPrincipal: owner, surfaceThreadId: "s",
      surfaceKind: "desktop", deliveryRoute: "d", visibilityPolicy: "compact",
      missionId: "m", workItemId: "w", title: "t", intent: "i", lane: "deepseek",
      targetProviderOrAgent: "deepseek", capabilityId: "ask_friday.deepseek",
      bodyRef: "friday://body/desktop/1", includesSensitiveContext: true)
    let env = FridayEnvelope(msgId: "m", sentAt: 1, message: .missionIntakeRequest(full))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(try env.encodeJSON()).message, .missionIntakeRequest(full))
    let fullJson = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(fullJson.contains("\"includes_sensitive_context\":true"))
    XCTAssertTrue(fullJson.contains("\"body_ref\":\"friday://body/desktop/1\""))
  }

  // MARK: MS2 — MissionIntakeResult decode (incl. the live needs_clarification arm)

  /// MS2: a `status:"ready"` result decodes (the happy path) — work_item_id + created_or_ready true.
  func testMS2_missionIntakeResultReadyDecodes() throws {
    let json = """
      {"schema_version":13,"msg_id":"m1","sent_at":1000,"message":{
        "kind":"MissionIntakeResult","result":{
          "friday_conversation_id":"fconv_desktop_1","mission_id":"mission-desktop-1",
          "work_item_id":"work-desktop-1","surface_thread_id":"surface-desktop-1",
          "status":"ready","blockers":[],"created_or_ready":true}}}
      """
    let env = try FridayEnvelope.decodeJSON(Data(json.utf8))
    guard case .missionIntakeResult(let r) = env.message else { return XCTFail("expected MissionIntakeResult") }
    XCTAssertEqual(r.status, "ready")
    XCTAssertEqual(r.missionId, "mission-desktop-1")
    XCTAssertEqual(r.workItemId, "work-desktop-1")
    XCTAssertTrue(r.createdOrReady)
    XCTAssertTrue(r.clarificationQuestions.isEmpty)
  }

  /// MS2 (the LIVE clarify arm, `FRIDAY_MISSION_INTAKE_CLARIFY=1`): a `needs_clarification` result
  /// with a NON-EMPTY `clarification_questions` + `created_or_ready:false` round-trips — the Swift
  /// result MUST carry the questions so the UI can render them honestly.
  func testMS2_missionIntakeResultNeedsClarificationCarriesQuestions() throws {
    let json = """
      {"schema_version":13,"msg_id":"m1","sent_at":1000,"message":{
        "kind":"MissionIntakeResult","result":{
          "friday_conversation_id":"fconv_x","mission_id":"mission-x",
          "surface_thread_id":"surface-x","status":"needs_clarification","blockers":[],
          "created_or_ready":false,
          "clarification_questions":["What is the deadline?","Which provider should handle it?"]}}}
      """
    let env = try FridayEnvelope.decodeJSON(Data(json.utf8))
    guard case .missionIntakeResult(let r) = env.message else { return XCTFail("expected MissionIntakeResult") }
    XCTAssertEqual(r.status, "needs_clarification")
    XCTAssertFalse(r.createdOrReady)
    XCTAssertNil(r.workItemId, "an under-specified intent writes no WorkItem")
    XCTAssertEqual(r.clarificationQuestions, ["What is the deadline?", "Which provider should handle it?"])
  }

  /// MS2: a `status:"blocked"` result with duplicate ids round-trips (a duplicate-preflight outcome).
  func testMS2_missionIntakeResultBlockedDuplicateRoundTrips() throws {
    let blocked = MissionIntakeResultWire(
      fridayConversationId: "f", missionId: "m", surfaceThreadId: "s",
      status: "blocked", blockers: ["duplicate_mission"],
      duplicateMissionId: "mission-existing", duplicateWorkItemId: "work-existing",
      createdOrReady: false)
    let env = FridayEnvelope(msgId: "m", sentAt: 1, message: .missionIntakeResult(blocked))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(try env.encodeJSON()).message, .missionIntakeResult(blocked))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(json.contains("\"result\":{"))
    XCTAssertTrue(json.contains("\"duplicate_mission_id\":\"mission-existing\""))
    // clarification_questions is skipped when empty.
    XCTAssertFalse(json.contains("clarification_questions"))
  }

  // MARK: MS3 — MemoryDecisionRequest wire shape (nested + no auth_proof + exact decision token)

  /// MS3: a `MemoryDecisionRequest` rides as `{"kind":"MemoryDecisionRequest","request":{…}}` with
  /// `decision:"confirm"` and the nested wrapper — mirroring the Rust
  /// `memory_decision_wire_round_trips_and_uses_the_request_result_wrapper` test exactly.
  func testMS3_memoryDecisionRequestNestedShapeConfirm() throws {
    let req = MemoryDecisionRequestWire(memoryId: "mem-decision-1", ownerPrincipal: owner, decision: "confirm")
    let env = FridayEnvelope(msgId: "mem-dec-req", sentAt: 1000, message: .memoryDecisionRequest(req))
      .withCorrelation("c1")
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"MemoryDecisionRequest\""))
    XCTAssertTrue(json.contains("\"request\":{"), "decision must NEST under request, not flatten: \(json)")
    XCTAssertTrue(json.contains("\"memory_id\":\"mem-decision-1\""))
    XCTAssertTrue(json.contains("\"decision\":\"confirm\""))
    XCTAssertTrue(json.contains("\"owner_principal\":\"admin-001\""))

    // Message object carries EXACTLY {kind, request}; the nested request carries EXACTLY the 3 fields
    // (no auth_proof).
    let messageObj = try messageObject(json)
    XCTAssertEqual(Set(messageObj.keys), ["kind", "request"])
    let request = try XCTUnwrap(messageObj["request"] as? [String: Any])
    XCTAssertEqual(Set(request.keys), ["memory_id", "owner_principal", "decision"])

    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .memoryDecisionRequest(req))
  }

  /// MS3: a `decision:"reject"` request round-trips (the only other valid token).
  func testMS3_memoryDecisionRequestRejectRoundTrips() throws {
    let req = MemoryDecisionRequestWire(memoryId: "mem-2", ownerPrincipal: owner, decision: "reject")
    let env = FridayEnvelope(msgId: "m", sentAt: 1, message: .memoryDecisionRequest(req))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(json.contains("\"decision\":\"reject\""))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .memoryDecisionRequest(req))
  }

  // MARK: MS4 — MemoryDecisionResult decode (confirmed / blocked-with-blocker)

  /// MS4: a `status:"confirmed"` result decodes — `recallable:true`, no blocker. Mirrors the Rust
  /// vector at `lib.rs` ~2144.
  func testMS4_memoryDecisionResultConfirmedDecodes() throws {
    let json = """
      {"schema_version":13,"msg_id":"r","sent_at":1,"message":{
        "kind":"MemoryDecisionResult","result":{
          "memory_id":"mem-1","state":"confirmed","status":"confirmed","recallable":true}}}
      """
    let env = try FridayEnvelope.decodeJSON(Data(json.utf8))
    guard case .memoryDecisionResult(let r) = env.message else { return XCTFail("expected MemoryDecisionResult") }
    XCTAssertEqual(r.status, "confirmed")
    XCTAssertEqual(r.state, "confirmed")
    XCTAssertTrue(r.recallable)
    XCTAssertNil(r.blocker)
  }

  /// MS4 (the synthetic-id reality — see PR Layer-D note): a `status:"blocked"` result carries the
  /// coarse `blocker` and `recallable:false`. This is the EXPECTED outcome today when the UI sends
  /// the synthetic candidate id (the read projection has not yet surfaced the real memory_id), and
  /// the result wrapper carries it so the UI renders the block HONESTLY (not a fake success).
  func testMS4_memoryDecisionResultBlockedCarriesBlocker() throws {
    let blocked = MemoryDecisionResultWire(
      memoryId: "memory_candidate_mission_x_0", state: "unknown", status: "blocked",
      blocker: "unknown_candidate", recallable: false)
    let env = FridayEnvelope(msgId: "r", sentAt: 1, message: .memoryDecisionResult(blocked))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(try env.encodeJSON()).message, .memoryDecisionResult(blocked))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(json.contains("\"result\":{"))
    XCTAssertTrue(json.contains("\"blocker\":\"unknown_candidate\""))
    XCTAssertTrue(json.contains("\"recallable\":false"))
  }

  // MARK: MS4b — ContextPassportTransfer wire shape (nested + no auth_proof)

  /// MS4b: a ContextPassport transfer rides as
  /// `{"kind":"ContextPassportTransferRequest","request":{…}}` with included item rows and no
  /// per-request auth proof. The sealed session is the channel auth, matching MissionIntake and
  /// MemoryDecision.
  func testMS4b_contextPassportTransferRequestNestedShapeNoAuthProof() throws {
    let req = ContextPassportTransferRequestWire(
      passportId: "passport-mobile-1",
      missionId: "mission-mobile-1",
      workItemId: "work-mobile-1",
      destinationLane: "codex",
      destinationTarget: "codex",
      items: [
        ContextPassportItemWire(
          kind: "summary",
          label: "Mobile Chat handoff for mission-mobile-1.",
          included: true,
          sensitive: false),
        ContextPassportItemWire(
          kind: "summary",
          label: "Answer run ref run-1.",
          included: true,
          sensitive: false),
      ],
      approvedSensitive: false)
    let env = FridayEnvelope(msgId: "cp-req", sentAt: 1000, message: .contextPassportTransferRequest(req))
      .withCorrelation("c1")
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"ContextPassportTransferRequest\""))
    XCTAssertTrue(json.contains("\"request\":{"), "context passport transfer must NEST under request: \(json)")
    XCTAssertTrue(json.contains("\"passport_id\":\"passport-mobile-1\""))
    XCTAssertTrue(json.contains("\"destination_lane\":\"codex\""))
    XCTAssertTrue(json.contains("\"approved_sensitive\":false"))

    let messageObj = try messageObject(json)
    XCTAssertEqual(Set(messageObj.keys), ["kind", "request"])
    let request = try XCTUnwrap(messageObj["request"] as? [String: Any])
    XCTAssertNil(request["auth_proof"], "ContextPassportTransferRequest carries NO per-request auth_proof")
    XCTAssertNil(request["forwarded_principal"])
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .contextPassportTransferRequest(req))
  }

  /// MS4b: a confirmed ContextPassport transfer result carries only refs/counts; a blocked result
  /// carries a blocker without fabricating a passport link.
  func testMS4b_contextPassportTransferResultRoundTripsConfirmedAndBlocked() throws {
    let confirmed = ContextPassportTransferResultWire(
      passportId: "passport-mobile-1",
      missionId: "mission-mobile-1",
      workItemId: "work-mobile-1",
      destinationLane: "codex",
      destinationTarget: "codex",
      sharedItemCount: 3,
      missionRefCount: 1,
      linkId: "context-passport-passport-mobile-1-1",
      status: "confirmed")
    let confirmedEnv = FridayEnvelope(msgId: "cp-ok", sentAt: 1, message: .contextPassportTransferResult(confirmed))
    XCTAssertEqual(
      try FridayEnvelope.decodeJSON(try confirmedEnv.encodeJSON()).message,
      .contextPassportTransferResult(confirmed))

    let blocked = ContextPassportTransferResultWire(
      passportId: "passport-mobile-2",
      missionId: "mission-mobile-2",
      destinationLane: "codex",
      sharedItemCount: 0,
      missionRefCount: 0,
      status: "blocked",
      blocker: "mission_not_found")
    let blockedEnv = FridayEnvelope(msgId: "cp-blocked", sentAt: 1, message: .contextPassportTransferResult(blocked))
    let json = String(decoding: try blockedEnv.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(json.contains("\"kind\":\"ContextPassportTransferResult\""))
    XCTAssertTrue(json.contains("\"result\":{"))
    XCTAssertTrue(json.contains("\"blocker\":\"mission_not_found\""))
    XCTAssertEqual(
      try FridayEnvelope.decodeJSON(Data(json.utf8)).message,
      .contextPassportTransferResult(blocked))
  }

  // MARK: MS5 — RunOutcomeLearningDecision wire shape (nested + no auth_proof)

  /// MS5: an A1 run-outcome learning decision rides as
  /// `{"kind":"RunOutcomeLearningDecisionRequest","request":{…}}` with no per-request auth proof.
  func testMS5_runOutcomeLearningDecisionRequestNestedShapeConfirm() throws {
    let req = RunOutcomeLearningDecisionRequestWire(
      candidateId: "a1:run-a1:preference",
      decision: "confirm",
      reason: "operator accepted the refs-only preference candidate")
    let env = FridayEnvelope(msgId: "a1-dec-req", sentAt: 1000, message: .runOutcomeLearningDecisionRequest(req))
      .withCorrelation("c1")
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"RunOutcomeLearningDecisionRequest\""))
    XCTAssertTrue(json.contains("\"request\":{"), "A1 decision must NEST under request, not flatten: \(json)")
    XCTAssertTrue(json.contains("\"candidate_id\":\"a1:run-a1:preference\""))
    XCTAssertTrue(json.contains("\"decision\":\"confirm\""))

    let messageObj = try messageObject(json)
    XCTAssertEqual(Set(messageObj.keys), ["kind", "request"])
    let request = try XCTUnwrap(messageObj["request"] as? [String: Any])
    XCTAssertEqual(Set(request.keys), ["candidate_id", "decision", "reason"])
    XCTAssertNil(request["auth_proof"], "RunOutcomeLearningDecisionRequest carries NO per-request auth_proof")

    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .runOutcomeLearningDecisionRequest(req))
  }

  /// MS5: a nil reason is omitted, matching Rust's optional serde field.
  func testMS5_runOutcomeLearningDecisionReasonOmittedWhenNil() throws {
    let req = RunOutcomeLearningDecisionRequestWire(candidateId: "a1:run-a1:preference", decision: "reject")
    let env = FridayEnvelope(msgId: "a1", sentAt: 1, message: .runOutcomeLearningDecisionRequest(req))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertFalse(json.contains("\"reason\""))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .runOutcomeLearningDecisionRequest(req))
  }

  /// MS6: an A1 `status:"confirmed"` result decodes refs-only candidate/run/kind/state fields.
  func testMS6_runOutcomeLearningDecisionResultConfirmedDecodes() throws {
    let json = """
      {"schema_version":15,"msg_id":"r","sent_at":1,"message":{
        "kind":"RunOutcomeLearningDecisionResult","result":{
          "candidate_id":"a1:run-a1:preference","run_id":"run-a1",
          "kind":"preference","state":"confirmed","status":"confirmed"}}}
      """
    let env = try FridayEnvelope.decodeJSON(Data(json.utf8))
    guard case .runOutcomeLearningDecisionResult(let r) = env.message else {
      return XCTFail("expected RunOutcomeLearningDecisionResult")
    }
    XCTAssertEqual(r.candidateId, "a1:run-a1:preference")
    XCTAssertEqual(r.runId, "run-a1")
    XCTAssertEqual(r.kind, "preference")
    XCTAssertEqual(r.state, "confirmed")
    XCTAssertEqual(r.status, "confirmed")
    XCTAssertNil(r.blocker)
  }

  /// MS6: a blocked A1 decision carries a blocker and stays a returned result, not a success.
  func testMS6_runOutcomeLearningDecisionResultBlockedCarriesBlocker() throws {
    let blocked = RunOutcomeLearningDecisionResultWire(
      candidateId: "a1:missing:preference",
      state: "unknown",
      status: "blocked",
      blocker: "unknown_candidate")
    let env = FridayEnvelope(msgId: "r", sentAt: 1, message: .runOutcomeLearningDecisionResult(blocked))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(try env.encodeJSON()).message, .runOutcomeLearningDecisionResult(blocked))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(json.contains("\"result\":{"))
    XCTAssertTrue(json.contains("\"blocker\":\"unknown_candidate\""))
  }

  // MARK: MS7 — ActivityMarkDone wire shape (nested + refs-only)

  func testMS7_activityMarkDoneRequestNestedShapeRefsOnly() throws {
    let req = ActivityMarkDoneRequestWire(activityId: "activity-1", reason: "owner cleared row")
    let env = FridayEnvelope(msgId: "activity-done", sentAt: 1000, message: .activityMarkDoneRequest(req))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"ActivityMarkDoneRequest\""))
    XCTAssertTrue(json.contains("\"request\":{"))
    XCTAssertTrue(json.contains("\"activity_id\":\"activity-1\""))
    XCTAssertFalse(json.contains("auth_proof"))
    XCTAssertFalse(json.contains("transcript"))
    XCTAssertFalse(json.contains("body"))

    let messageObj = try messageObject(json)
    XCTAssertEqual(Set(messageObj.keys), ["kind", "request"])
    let request = try XCTUnwrap(messageObj["request"] as? [String: Any])
    XCTAssertEqual(Set(request.keys), ["activity_id", "reason"])
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .activityMarkDoneRequest(req))
  }

  func testMS7_activityMarkDoneResultBlockedCarriesBlocker() throws {
    let blocked = ActivityMarkDoneResultWire(
      activityId: "missing-activity",
      state: "unknown",
      status: "blocked",
      blocker: "unknown_activity")
    let env = FridayEnvelope(msgId: "activity-result", sentAt: 1, message: .activityMarkDoneResult(blocked))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(try env.encodeJSON()).message, .activityMarkDoneResult(blocked))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(json.contains("\"result\":{"))
    XCTAssertTrue(json.contains("\"blocker\":\"unknown_activity\""))
  }

  // MARK: MS8 — ProviderWorkspaceAction wire shape (nested + refs-only guard receipt)

  func testMS8_providerWorkspaceActionRequestNestedShapeNoAuthProof() throws {
    let ctx = ProviderWorkspaceMissionContextWire(
      fridayConversationId: "fconv_provider_workspace",
      missionId: "mission-provider-workspace",
      workItemId: "work-provider-workspace")
    let req = ProviderWorkspaceActionRequestWire(
      requestId: "provider-action-1",
      fridaySessionId: "friday-codex-1",
      provider: "codex",
      action: "send_turn",
      capabilityId: "provider.codex.send_turn",
      payloadRef: "friday://body/user-message/1",
      missionContext: ctx)
    let env = FridayEnvelope(msgId: "provider-action", sentAt: 1000, message: .providerWorkspaceActionRequest(req))
      .withCorrelation("c1")
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)

    XCTAssertTrue(json.contains("\"kind\":\"ProviderWorkspaceActionRequest\""))
    XCTAssertTrue(json.contains("\"request\":{"), "provider action must NEST under request: \(json)")
    XCTAssertTrue(json.contains("\"capability_id\":\"provider.codex.send_turn\""))
    XCTAssertTrue(json.contains("\"mission_id\":\"mission-provider-workspace\""))
    XCTAssertFalse(json.contains("auth_proof"))
    XCTAssertFalse(json.contains("forwarded_principal"))
    XCTAssertFalse(json.contains("raw user prompt"))

    let messageObj = try messageObject(json)
    XCTAssertEqual(Set(messageObj.keys), ["kind", "request"])
    let request = try XCTUnwrap(messageObj["request"] as? [String: Any])
    XCTAssertNil(request["auth_proof"], "ProviderWorkspaceActionRequest carries NO per-request auth_proof")
    XCTAssertEqual(try FridayEnvelope.decodeJSON(Data(json.utf8)).message, .providerWorkspaceActionRequest(req))
  }

  func testMS8_providerWorkspaceActionResultBlockedCarriesGuardTruth() throws {
    let ctx = ProviderWorkspaceMissionContextWire(
      fridayConversationId: "fconv_provider_workspace",
      missionId: "mission-provider-workspace",
      workItemId: "work-provider-workspace")
    let result = ProviderWorkspaceActionResultWire(
      requestId: "provider-action-1",
      fridaySessionId: "friday-codex-1",
      provider: "codex",
      action: "send_turn",
      accepted: false,
      routed: false,
      status: "blocked",
      truthLabel: "provider_workspace_action_guard_blocked",
      blocker: "capability_not_verified",
      missionContext: ctx)
    let env = FridayEnvelope(msgId: "provider-result", sentAt: 1, message: .providerWorkspaceActionResult(result))
    XCTAssertEqual(try FridayEnvelope.decodeJSON(try env.encodeJSON()).message, .providerWorkspaceActionResult(result))
    let json = String(decoding: try env.encodeJSON(), as: UTF8.self)
    XCTAssertTrue(json.contains("\"result\":{"))
    XCTAssertTrue(json.contains("\"accepted\":false"))
    XCTAssertTrue(json.contains("\"routed\":false"))
    XCTAssertTrue(json.contains("\"blocker\":\"capability_not_verified\""))
  }
}
