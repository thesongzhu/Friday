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
  let parity = DesktopProductDestinationID.parity.contract
  let diagnostics = DesktopProductDestinationID.diagnostics.contract
  let tokenLedger = DesktopProductDestinationID.tokenLedger.contract
  let skills = DesktopProductDestinationID.skills.contract
  let media = DesktopProductDestinationID.media.contract
  let settings = DesktopProductDestinationID.settings.contract
  let evidence = DesktopProductDestinationID.evidence.contract

  #expect(operations.tier == .liveWorkbench)
  #expect(operations.runtimeActionIds == [
    "desktop/operations/refresh",
    "desktop/operations/mission-resolve-or-create",
  ])
  #expect(workflow.tier == .governedActionGated)
  #expect(workflow.runtimeActionIds == [
    "desktop/workflow/retry",
    "desktop/workflow/cancel",
  ])
  #expect(!workflow.blockers.contains { $0.kind == .needsNativeSurface })
  #expect(workflow.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(channels.tier == .liveReadProjection)
  #expect(channels.runtimeActionIds == [
    "desktop/channels/receipts",
    "desktop/channels/surface-events",
  ])
  #expect(!channels.blockers.contains { $0.kind == .needsNativeSurface })
  #expect(channels.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(provider.tier == .providerAdmin)
  #expect(provider.runtimeActionIds == ["desktop/providerAdmin/check"])
  #expect(provider.blockers.contains { $0.kind == .needsProviderCredential })
  #expect(parity.runtimeActionIds == ["desktop/parity/route-readiness"])
  #expect(diagnostics.runtimeActionIds == ["desktop/diagnostics/proof-refs"])
  #expect(tokenLedger.runtimeActionIds == ["desktop/tokenLedger/run-readback"])
  #expect(skills.runtimeActionIds == ["desktop/skills/capability-matrix"])
  #expect(media.runtimeActionIds == ["desktop/media/evidence-refs"])
  #expect(!skills.blockers.contains { $0.kind == .needsNativeSurface })
  #expect(!media.blockers.contains { $0.kind == .needsNativeSurface })
  #expect(skills.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(media.blockers.contains { $0.kind == .needsRuntimeEvidence })
  #expect(settings.runtimeActionIds == ["desktop/settings/hub-posture"])
  #expect(evidence.runtimeActionIds == ["desktop/evidence/index-read"])
  #expect(!operations.isEndBarReady)
  #expect(!workflow.isEndBarReady)
  #expect(!channels.isEndBarReady)
  #expect(!provider.isEndBarReady)
  #expect(!parity.isEndBarReady)
  #expect(!diagnostics.isEndBarReady)
  #expect(!tokenLedger.isEndBarReady)
  #expect(!skills.isEndBarReady)
  #expect(!media.isEndBarReady)
  #expect(!settings.isEndBarReady)
  #expect(!evidence.isEndBarReady)
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
