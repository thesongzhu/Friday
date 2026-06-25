import Testing
@testable import FridayHubConsoleCore

@Test
func desktopProductContractCoversSelectedHubConsoleDestinations() {
  let ids = DesktopProductDestinationID.allCases.map(\.rawValue)

  #expect(ids == [
    "operations",
    "chat",
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
  #expect(snapshot.uniqueBlockers.contains { $0.kind == .needsLiveWrite })
}

@Test
func desktopProductContractKeepsChatAndMemoryEvidenceVisible() {
  let chat = DesktopProductDestinationID.chat.contract
  let memory = DesktopProductDestinationID.memory.contract

  #expect(chat.runtimeActionIds.contains("desktop/fridayChat/check"))
  #expect(chat.runtimeActionIds.contains("desktop/fridayChat/act"))
  #expect(memory.runtimeActionIds.contains("desktop/memory/check"))
  #expect(memory.runtimeActionIds.contains("desktop/memory/act"))
  #expect(!chat.isEndBarReady)
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
