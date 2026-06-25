import Testing
@testable import FridayHubConsoleCore

@Test
func desktopProductContractCoversSelectedHubConsoleDestinations() {
  let ids = DesktopProductDestinationID.allCases.map(\.rawValue)

  #expect(ids == [
    "operations",
    "chat",
    "session",
    "providerAdmin",
    "parity",
    "pairingProvisioning",
    "workflow",
    "channels",
    "diagnostics",
    "recovery",
    "memory",
    "tokenLedger",
    "skills",
    "media",
    "settings",
    "evidence",
  ])
  #expect(DesktopProductDestinationID.allCases.allSatisfy { $0.contract.routeBuilt })
  #expect(DesktopProductDestinationID.allCases.allSatisfy { $0.contract.selectedDesignLocked })
}

@Test
func desktopProductContractDoesNotTreatNavCoverageAsEndBar() {
  let snapshot = DesktopProductEndBarSnapshot()

  #expect(snapshot.routeCoverageCount == snapshot.totalCount)
  #expect(snapshot.endBarReadyCount == 0)
  #expect(!snapshot.hasAnyEndBarClaim)
  #expect(snapshot.uniqueBlockers.contains { $0.kind == .needsRuntimeEvidence })
}

@Test
func desktopProductContractKeepsChatAndMemoryEvidenceVisible() {
  let chat = DesktopProductDestinationID.chat.contract
  let session = DesktopProductDestinationID.session.contract
  let memory = DesktopProductDestinationID.memory.contract

  #expect(chat.runtimeActionIds.contains("desktop/fridayChat/check"))
  #expect(chat.runtimeActionIds.contains("desktop/fridayChat/act"))
  #expect(session.runtimeActionIds.contains("desktop/session/list"))
  #expect(session.runtimeActionIds.contains("desktop/session/open"))
  #expect(session.runtimeActionIds.contains("desktop/session/link"))
  #expect(memory.runtimeActionIds.contains("desktop/memory/check"))
  #expect(memory.runtimeActionIds.contains("desktop/memory/act"))
  #expect(!chat.isEndBarReady)
  #expect(!session.isEndBarReady)
  #expect(!memory.isEndBarReady)
}

@Test
func desktopProductContractSeparatesShellsFromWorkbenchLoops() {
  let operations = DesktopProductDestinationID.operations.contract
  let workflow = DesktopProductDestinationID.workflow.contract
  let channels = DesktopProductDestinationID.channels.contract
  let provider = DesktopProductDestinationID.providerAdmin.contract

  #expect(operations.tier == .liveWorkbench)
  #expect(workflow.tier == .navigationShell)
  #expect(channels.tier == .navigationShell)
  #expect(provider.tier == .providerAdmin)
  #expect(!operations.isEndBarReady)
  #expect(!workflow.isEndBarReady)
  #expect(!channels.isEndBarReady)
  #expect(!provider.isEndBarReady)
}

@Test
func desktopProductContractTracksRecoveryWritesAsBuiltButRuntimeBlocked() {
  let recovery = DesktopProductDestinationID.recovery.contract

  #expect(recovery.tier == .governedActionGated)
  #expect(recovery.runtimeActionIds == [
    "desktop/recovery/retry",
    "desktop/recovery/cancel",
  ])
  #expect(!recovery.blockers.contains { $0.kind == .needsLiveWrite })
  #expect(recovery.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(!recovery.isEndBarReady)
}
