import Testing
@testable import FridayMobileShellCore

@Test
func mobileProductContractCoversOperatorSelectedDestinations() {
  let ids = MobileProductDestinationID.allCases.map(\.rawValue)

  #expect(ids == [
    "home",
    "missions",
    "session",
    "contextPassport",
    "tokenLedger",
    "shareIntake",
    "voice",
    "pairing",
    "newSession",
    "needsMe",
    "memory",
    "platform",
    "providerAuth",
    "activity",
    "workflows",
    "onboarding",
    "settings",
  ])
  #expect(MobileProductDestinationID.allCases.allSatisfy { $0.contract.routeBuilt })
  #expect(MobileProductDestinationID.allCases.allSatisfy { $0.contract.selectedDesignLocked })
}

@Test
func mobileProductContractDoesNotTreatRouteCoverageAsEndBar() {
  let snapshot = MobileProductEndBarSnapshot()

  #expect(snapshot.routeCoverageCount == snapshot.totalCount)
  #expect(snapshot.endBarReadyCount == 0)
  #expect(!snapshot.hasAnyEndBarClaim)
  #expect(snapshot.contracts.allSatisfy { $0.tier != .liveWriteRead })
  #expect(snapshot.uniqueBlockers.contains { $0.kind == .needsOperatorSignature })
  #expect(snapshot.uniqueBlockers.contains { $0.kind == .needsRuntimeEvidence })
}

@Test
func mobileProductContractKeepsHomeReadProjectionSeparateFromChatWriteLoop() {
  let home = MobileProductDestinationID.home.contract

  #expect(home.tier == .liveReadProjection)
  #expect(home.runtimeActionIds == ["mobile/home/refresh"])
  #expect(home.blockers.contains { $0.id == "chat-write-action-proof" })
  #expect(home.productReadinessSummary.contains("same-run mobile+desktop user proof"))
  #expect(!home.productReadinessSummary.contains("Real read/write loop exists"))
  #expect(!home.isEndBarReady)
}

@Test
func mobileProductContractKeepsApprovalSignatureVisible() {
  let needsMe = MobileProductDestinationID.needsMe.contract
  let session = MobileProductDestinationID.session.contract

  #expect(needsMe.runtimeActionIds.contains("mobile/approval/check"))
  #expect(needsMe.runtimeActionIds.contains("mobile/approval/reject"))
  #expect(needsMe.blockers.contains { $0.kind == .needsOperatorSignature })
  #expect(session.blockers.contains { $0.kind == .needsOperatorSignature })
  #expect(!needsMe.isEndBarReady)
  #expect(!session.isEndBarReady)
}

@Test
func mobileProductContractSeparatesReadinessShellsFromProductLoops() {
  let voice = MobileProductDestinationID.voice.contract
  let workflows = MobileProductDestinationID.workflows.contract
  let provider = MobileProductDestinationID.providerAuth.contract

  #expect(voice.tier == .nativeDeviceLoop)
  #expect(voice.runtimeActionIds == [
    "mobile/voice/permission",
    "mobile/fridayChat/voice-input",
    "mobile/fridayChat/voice-output",
    "mobile/voice/open-chat-loop",
  ])
  #expect(voice.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(workflows.tier == .navigationShell)
  #expect(provider.tier == .providerWorkspace)
  #expect(!voice.isEndBarReady)
  #expect(!workflows.isEndBarReady)
  #expect(!provider.isEndBarReady)
}

@Test
func mobileProductContractTracksActivityMarkDoneAsBuiltButRuntimeBlocked() {
  let activity = MobileProductDestinationID.activity.contract

  #expect(activity.tier == .liveReadProjection)
  #expect(activity.runtimeActionIds == ["mobile/activity/mark-done"])
  #expect(!activity.blockers.contains { $0.kind == .needsLiveWrite })
  #expect(activity.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(!activity.isEndBarReady)
}

@Test
func mobileProductContractTracksShareIntakeWriteAsBuiltButRuntimeBlocked() {
  let share = MobileProductDestinationID.shareIntake.contract

  #expect(share.tier == .governedActionGated)
  #expect(share.runtimeActionIds == ["mobile/share/send", "mobile/share/open-chat-loop"])
  #expect(!share.blockers.contains { $0.kind == .needsLiveWrite })
  #expect(share.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(!share.isEndBarReady)
}

@Test
func mobileProductContractTracksNewSessionLaunchIntoChatButRuntimeBlocked() {
  let newSession = MobileProductDestinationID.newSession.contract

  #expect(newSession.tier == .governedActionGated)
  #expect(newSession.runtimeActionIds == ["mobile/newSession/play", "mobile/newSession/open-chat-loop"])
  #expect(!newSession.blockers.contains { $0.kind == .needsLiveWrite })
  #expect(newSession.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(!newSession.isEndBarReady)
}
