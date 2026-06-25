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
  #expect(snapshot.uniqueBlockers.contains { $0.kind == .needsOperatorSignature })
  #expect(snapshot.uniqueBlockers.contains { $0.kind == .needsRuntimeEvidence })
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

  #expect(voice.tier == .readinessOnly)
  #expect(workflows.tier == .navigationShell)
  #expect(provider.tier == .providerWorkspace)
  #expect(!voice.isEndBarReady)
  #expect(!workflows.isEndBarReady)
  #expect(!provider.isEndBarReady)
}
