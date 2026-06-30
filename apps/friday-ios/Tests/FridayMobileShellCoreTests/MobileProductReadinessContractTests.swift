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
    "petEditor",
    "proofViewer",
    "entrypoints",
  ])
  #expect(MobileProductDestinationID.allCases.allSatisfy { $0.contract.routeBuilt })
  #expect(MobileProductDestinationID.allCases.allSatisfy { $0.contract.selectedDesignLocked })
}

@Test
func mobileProductContractExcludesInternalProofHarnessFromUserEndBarScope() {
  let snapshot = MobileProductEndBarSnapshot()
  let userFacing = snapshot.contracts.filter { $0.tier != .internalDebug }
  let internalOnly = snapshot.contracts.filter { $0.tier == .internalDebug }

  #expect(snapshot.totalCount == 20)
  #expect(userFacing.count == 18)
  #expect(internalOnly.map(\.id).sorted() == ["entrypoints", "proofViewer"])
  #expect(internalOnly.allSatisfy { $0.blockers.isEmpty })
  #expect(!internalOnly.contains { $0.isEndBarReady })
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
func mobileProductContractSurfacesBuiltReadOnlyProductActions() {
  let missions = MobileProductDestinationID.missions.contract
  let passport = MobileProductDestinationID.contextPassport.contract
  let tokenLedger = MobileProductDestinationID.tokenLedger.contract
  let platform = MobileProductDestinationID.platform.contract
  let provider = MobileProductDestinationID.providerAuth.contract
  let settings = MobileProductDestinationID.settings.contract

  #expect(missions.runtimeActionIds == [
    "mobile/missions/read",
    "mobile/missions/dispatch",
    "mobile/missions/open-chat-loop",
  ])
  #expect(passport.runtimeActionIds == [
    "mobile/passport/checklist",
    "mobile/passport/send",
  ])
  #expect(tokenLedger.runtimeActionIds == [
    "mobile/tokenLedger/refresh",
    "mobile/tokenLedger/run-readback",
  ])
  #expect(provider.runtimeActionIds == [
    "mobile/providerAuth/check",
    "mobile/providerAuth/provider-workspace",
  ])
  #expect(platform.runtimeActionIds == ["mobile/platform/capability-matrix"])
  #expect(settings.runtimeActionIds == ["mobile/settings/push-permission"])
  #expect(missions.tier == .governedActionGated)
  #expect(!missions.blockers.contains { $0.kind == .needsLiveWrite })
  #expect(missions.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(provider.blockers.contains { $0.kind == .needsProviderCredential })
  #expect(provider.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(platform.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(settings.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(!missions.isEndBarReady)
  #expect(!passport.isEndBarReady)
  #expect(!tokenLedger.isEndBarReady)
  #expect(!platform.isEndBarReady)
  #expect(!provider.isEndBarReady)
  #expect(!settings.isEndBarReady)
}

@Test
func mobileProductContractSeparatesReadinessShellsFromProductLoops() {
  let voice = MobileProductDestinationID.voice.contract
  let workflows = MobileProductDestinationID.workflows.contract
  let onboarding = MobileProductDestinationID.onboarding.contract
  let provider = MobileProductDestinationID.providerAuth.contract

  #expect(voice.tier == .nativeDeviceLoop)
  #expect(voice.runtimeActionIds == [
    "mobile/voice/permission",
    "mobile/fridayChat/voice-input",
    "mobile/fridayChat/voice-output",
    "mobile/voice/open-chat-loop",
  ])
  #expect(voice.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(workflows.tier == .governedActionGated)
  #expect(workflows.runtimeActionIds == [
    "mobile/workflow/retry",
    "mobile/workflow/cancel",
  ])
  #expect(!workflows.blockers.contains { $0.kind == .needsNativeSurface })
  #expect(workflows.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(onboarding.tier == .readinessOnly)
  #expect(onboarding.runtimeActionIds == ["mobile/onboarding/open-device-pairing"])
  #expect(onboarding.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(!onboarding.blockers.contains { $0.kind == .needsNativeSurface })
  #expect(provider.tier == .providerWorkspace)
  #expect(!voice.isEndBarReady)
  #expect(!workflows.isEndBarReady)
  #expect(!onboarding.isEndBarReady)
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

@Test
func mobileProductContractTracksSelectedDesignCompanionProofAndEntrypoints() {
  let petEditor = MobileProductDestinationID.petEditor.contract
  let proofViewer = MobileProductDestinationID.proofViewer.contract
  let entrypoints = MobileProductDestinationID.entrypoints.contract

  #expect(petEditor.title == "Pet Editor")
  #expect(petEditor.tier == .readinessOnly)
  #expect(petEditor.runtimeActionIds == ["mobile/pet/state-mapping"])
  #expect(petEditor.blockers.contains { $0.label == "pet state mapping proof" })

  #expect(proofViewer.title == "Proof Viewer")
  #expect(proofViewer.tier == .internalDebug)
  #expect(proofViewer.runtimeActionIds == ["mobile/proof/viewer-open"])
  #expect(proofViewer.blockers.isEmpty)

  #expect(entrypoints.title == "iOS Entrypoints")
  #expect(entrypoints.tier == .internalDebug)
  #expect(entrypoints.runtimeActionIds == ["mobile/entrypoints/readiness"])
  #expect(entrypoints.blockers.isEmpty)

  #expect(!petEditor.isEndBarReady)
  #expect(!proofViewer.isEndBarReady)
  #expect(!entrypoints.isEndBarReady)
}

@Test
func mobileProductContractKeepsDiagnosticsOutOfDefaultCommandSurface() {
  let diagnostics: Set<MobileProductDestinationID> = [
    .pairing,
    .onboarding,
    .settings,
    .petEditor,
    .proofViewer,
    .entrypoints,
  ]

  #expect(diagnostics.allSatisfy { $0.commandSurfaceLane == .diagnostics })
  #expect(MobileProductDestinationID.allCases
    .filter { !diagnostics.contains($0) }
    .allSatisfy { $0.commandSurfaceLane == .product })
  #expect(MobileProductDestinationID.home.commandSurfaceLane == .product)
  #expect(MobileProductDestinationID.newSession.commandSurfaceLane == .product)
  #expect(MobileProductDestinationID.providerAuth.commandSurfaceLane == .product)
}
